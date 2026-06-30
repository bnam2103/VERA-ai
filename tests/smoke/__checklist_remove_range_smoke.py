"""Smoke tests for checklist bulk remove: first/last N visible items."""

from __future__ import annotations

import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

from actions import multi_action_planner as P  # noqa: E402
from actions.checklist import (  # noqa: E402
    apply_checklist_action,
    extract_checklist_ordinal_range,
    parse_checklist_command,
    visible_flattened_rows,
)

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"
PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


def ids(rows: list[dict]) -> list[str]:
    return [str(r.get("id") or "") for r in rows]


def make_six_rows() -> list[dict]:
    return [
        {"id": f"r{i}", "text": f"Item {i}", "done": False, "parent_id": None}
        for i in range(1, 7)
    ]


def make_hierarchy_bc() -> list[dict]:
    """Parent A + 2 subs, Parent B, Parent C."""
    return [
        {"id": "pa", "text": "Parent A", "done": False, "parent_id": None},
        {"id": "a1", "text": "Subitem A1", "done": False, "parent_id": "pa"},
        {"id": "a2", "text": "Subitem A2", "done": False, "parent_id": "pa"},
        {"id": "pb", "text": "Parent B", "done": False, "parent_id": None},
        {"id": "pc", "text": "Parent C", "done": False, "parent_id": None},
    ]


def make_hierarchy_b_only() -> list[dict]:
    return [
        {"id": "pa", "text": "Parent A", "done": False, "parent_id": None},
        {"id": "a1", "text": "Subitem A1", "done": False, "parent_id": "pa"},
        {"id": "a2", "text": "Subitem A2", "done": False, "parent_id": "pa"},
        {"id": "pb", "text": "Parent B", "done": False, "parent_id": None},
    ]


section("Parse — ordinal range detection")
r1 = extract_checklist_ordinal_range("remove the last 4 items")
ok(r1 and r1.get("direction") == "last" and r1.get("count") == 4, "last 4 items parsed")
r2 = extract_checklist_ordinal_range("remove the first four checklist items")
ok(r2 and r2.get("direction") == "first" and r2.get("count") == 4, "first four checklist items")
r3 = extract_checklist_ordinal_range("remove last 4")
ok(r3 and r3.get("count") == 4, "remove last 4 bare")
p_last1 = parse_checklist_command(None, "remove the last item", "checklist.remove_item")
ok(p_last1.get("target_mode") != "count_from_end", "singular last item not bulk range")
ok(bool(p_last1.get("target_relative_ordinals")), "singular last item keeps relative ordinal")

section("Remove last 4 from 6 visible rows")
rows6 = make_six_rows()
parsed = parse_checklist_command(None, "remove the last 4 items", "checklist.remove_item")
ok(parsed.get("target_mode") == "count_from_end", "target_mode count_from_end", detail=str(parsed))
next_rows, reply, changed = apply_checklist_action(
    rows6, "checklist.remove_item", parsed, user_text="remove the last 4 items"
)
ok(changed, "changed true")
ok(ids(next_rows) == ["r1", "r2"], "last 4 removed from 6 rows", detail=str(ids(next_rows)))
ok("Removed the last 4 items" in reply, "reply mentions last 4", detail=reply)

section("Remove first 4 from 6 visible rows")
parsed_f = parse_checklist_command(None, "remove the first 4 items", "checklist.remove_item")
next_f, reply_f, changed_f = apply_checklist_action(
    rows6, "checklist.remove_item", parsed_f, user_text="remove the first 4 items"
)
ok(changed_f, "first 4 changed")
ok(ids(next_f) == ["r5", "r6"], "first 4 removed", detail=str(ids(next_f)))

section("Remove last 4 when only 2 exist")
rows2 = make_six_rows()[:2]
parsed_over = parse_checklist_command(None, "remove the last 4 items", "checklist.remove_item")
next2, reply2, changed2 = apply_checklist_action(
    rows2, "checklist.remove_item", parsed_over, user_text="remove the last 4 items"
)
ok(changed2 and len(next2) == 0, "both rows removed")
ok("only 2" in reply2.lower(), "honest partial reply", detail=reply2)

section("Hierarchy — last 2 removes Parent B and C")
rows_h = make_hierarchy_bc()
parsed_h = parse_checklist_command(None, "remove the last 2 items", "checklist.remove_item")
next_h, _, changed_h = apply_checklist_action(
    rows_h, "checklist.remove_item", parsed_h, user_text="remove the last 2 items"
)
ok(changed_h, "hierarchy last 2 changed")
ok(ids(next_h) == ["pa", "a1", "a2"], "Parent B and C removed", detail=str(ids(next_h)))

section("Hierarchy — last 2 removes Subitem A2 and Parent B")
rows_h2 = make_hierarchy_b_only()
parsed_h2 = parse_checklist_command(None, "remove the last 2 items", "checklist.remove_item")
next_h2, _, changed_h2 = apply_checklist_action(
    rows_h2, "checklist.remove_item", parsed_h2, user_text="remove the last 2 items"
)
ok(changed_h2, "hierarchy A2+B changed")
ok(ids(next_h2) == ["pa", "a1"], "Subitem A2 and Parent B removed", detail=str(ids(next_h2)))

section("Singular regressions")
p_first = parse_checklist_command(None, "remove the first item", "checklist.remove_item")
rows_s = make_six_rows()
next_s, reply_s, changed_s = apply_checklist_action(
    rows_s, "checklist.remove_item", p_first, user_text="remove the first item"
)
ok(changed_s and ids(next_s) == ["r2", "r3", "r4", "r5", "r6"], "first item singular", detail=str(ids(next_s)))
p_last = parse_checklist_command(None, "remove the last item", "checklist.remove_item")
next_l, _, changed_l = apply_checklist_action(
    rows_s, "checklist.remove_item", p_last, user_text="remove the last item"
)
ok(changed_l and ids(next_l) == ["r1", "r2", "r3", "r4", "r5"], "last item singular", detail=str(ids(next_l)))

section("Multi-action planner")
plan1 = P.plan_user_actions("remove the first 4 items and play lofi")
types1 = [a.get("type") for a in (plan1.get("actions") or [])]
ok("checklist.remove" in types1 and "music.play" in types1, "first 4 + lofi", detail=str(types1))
cp = next(a for a in (plan1.get("actions") or []) if a.get("type") == "checklist.remove")
targets1 = (cp.get("payload") or {}).get("targets") or []
ok(any(t.get("kind") == "ordinal_range" for t in targets1 if isinstance(t, dict)), "planner ordinal_range target")

plan2 = P.plan_user_actions("remove the last 4 items and pause the music")
types2 = [a.get("type") for a in (plan2.get("actions") or [])]
ok("checklist.remove" in types2 and "music.pause" in types2, "last 4 + pause", detail=str(types2))

print(f"\n{'=' * 60}")
print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
if FAIL:
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
print(f"{GREEN}All checklist remove range smoke tests passed.{RESET}")
