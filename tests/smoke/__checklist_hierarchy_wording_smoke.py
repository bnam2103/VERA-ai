"""Smoke tests for the 2026-06-13 hierarchical checklist response-summary
wording patch.

Spec:
    Checklist remove/complete confirmations must describe what was actually
    changed using the VISIBLE hierarchy:
      - top-level (depth 0) rows read "main item"
      - nested (depth >= 1) rows read "subitem"
    The user-facing ordinal is preserved when the user counted at that
    level; otherwise the item text disambiguates so we never echo a
    misleading post-mutation ordinal (the old "Removed the second item."
    bug when the user said "the fifth item").

    Explicit level phrasing resolves against the right subset:
      - "the second main item"  -> 2nd top-level row
      - "the first subitem"     -> 1st nested row (no parent reference needed)

Run:  py -3 -X utf8 tests\\smoke\\__checklist_hierarchy_wording_smoke.py
"""
from __future__ import annotations

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")))

import io
import os
import sys

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

from actions.checklist import (  # noqa: E402
    apply_checklist_action,
    parse_checklist_command,
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


def fixture() -> list[dict]:
    """Two main items, each with sub-items (visible order):
        1  Main item A          (depth 0, top-level 1)
        2  Subitem A1           (depth 1, child of A)
        3  Subitem A2           (depth 1, child of A)
        4  Main item B          (depth 0, top-level 2)
        5  Subitem B1           (depth 1, child of B)
    """
    return [
        {"id": "a1", "text": "Main item A", "done": False, "parent_id": None},
        {"id": "a2", "text": "Subitem A1", "done": False, "parent_id": "a1"},
        {"id": "a3", "text": "Subitem A2", "done": False, "parent_id": "a1"},
        {"id": "b1", "text": "Main item B", "done": False, "parent_id": None},
        {"id": "b2", "text": "Subitem B1", "done": False, "parent_id": "b1"},
    ]


def run(cmd: str, action: str):
    items = fixture()
    parsed = parse_checklist_command(None, cmd, action)
    rows, reply, changed = apply_checklist_action(
        items, action, parsed, vera=None, user_text=cmd
    )
    return rows, reply, changed


def ids(rows: list[dict]) -> list[str]:
    return [str(r.get("id") or "") for r in rows]


def done_ids(rows: list[dict]) -> set[str]:
    return {str(r.get("id") or "") for r in rows if bool(r.get("done"))}


# =========================================================================
# Test 1 — top-level removal reads "main item"
# =========================================================================
section("Test 1 - 'remove the first item' -> top-level / 'main item'")
rows, reply, changed = run("remove the first item", "checklist.remove_item")
ok(changed, "removal reported as changed")
ok("a1" not in ids(rows), "Main item A removed", detail=str(ids(rows)))
ok("main item" in reply.lower(), "reply calls it a main item", detail=reply)
ok(
    "first main item" in reply.lower() or "main item a" in reply.lower(),
    "reply preserves the 'first' ordinal or names Main item A",
    detail=reply,
)
ok("second" not in reply.lower(), "reply does not invent a wrong ordinal", detail=reply)


# =========================================================================
# Test 2 — nested removal by visible ordinal reads "subitem" + text
# =========================================================================
section("Test 2 - 'remove the third item' -> nested / 'subitem'")
rows, reply, changed = run("remove the third item", "checklist.remove_item")
ok(changed, "removal reported as changed")
ok("a3" not in ids(rows), "Subitem A2 (visible row 3) removed", detail=str(ids(rows)))
ok("subitem" in reply.lower(), "reply calls it a subitem", detail=reply)
ok("subitem a2" in reply.lower(), "reply names the removed subitem", detail=reply)


# =========================================================================
# Test 3 — "remove the fifth item" never echoes a changed ordinal
# =========================================================================
section("Test 3 - 'remove the fifth item' -> no misleading ordinal")
rows, reply, changed = run("remove the fifth item", "checklist.remove_item")
ok(changed, "removal reported as changed")
ok("b2" not in ids(rows), "Subitem B1 (visible row 5) removed", detail=str(ids(rows)))
ok(
    "subitem b1" in reply.lower(),
    "reply names the removed item rather than a shifted ordinal",
    detail=reply,
)
ok(
    "second item" not in reply.lower(),
    "reply does NOT say 'second item' for a 'fifth item' command",
    detail=reply,
)


# =========================================================================
# Test 4 — "mark the second main item complete"
# =========================================================================
section("Test 4 - 'mark the second main item complete'")
rows, reply, changed = run("mark the second main item complete", "checklist.complete_item")
ok(changed, "completion reported as changed")
ok("b1" in done_ids(rows), "2nd main item (Main item B) marked done", detail=str(sorted(done_ids(rows))))
ok(
    reply.lower() == "marked the second main item complete.",
    "reply reads exactly 'Marked the second main item complete.'",
    detail=reply,
)


# =========================================================================
# Test 5 — "mark the first subitem complete"
# =========================================================================
section("Test 5 - 'mark the first subitem complete'")
rows, reply, changed = run("mark the first subitem complete", "checklist.complete_item")
ok(changed, "completion reported as changed")
ok(done_ids(rows) == {"a2"}, "1st subitem (Subitem A1) marked done", detail=str(sorted(done_ids(rows))))
ok("first subitem complete" in reply.lower(), "reply preserves 'first subitem'", detail=reply)
ok("subitem a1" in reply.lower(), "reply names the completed subitem", detail=reply)


# =========================================================================
# Test 6 — explicit "remove the second main item" hits the 2nd top-level row
# =========================================================================
section("Test 6 - 'remove the second main item' resolves to 2nd main row")
rows, reply, changed = run("remove the second main item", "checklist.remove_item")
ok(changed, "removal reported as changed")
ok("b1" not in ids(rows), "Main item B (2nd top-level) removed", detail=str(ids(rows)))
ok("a1" in ids(rows), "Main item A (1st top-level) preserved", detail=str(ids(rows)))
ok(
    reply.lower() == "removed the second main item.",
    "reply reads exactly 'Removed the second main item.'",
    detail=reply,
)


# =========================================================================
# Test 7 — label-based completion of a sub-item names it as a subitem
# =========================================================================
section("Test 7 - 'mark Subitem A1 complete' (label) -> subitem wording")
rows, reply, changed = run("mark Subitem A1 complete", "checklist.complete_item")
ok(changed, "completion reported as changed")
ok(done_ids(rows) == {"a2"}, "only Subitem A1 marked done", detail=str(sorted(done_ids(rows))))
ok("subitem complete: subitem a1" in reply.lower(), "reply names the subitem by text", detail=reply)


# =========================================================================
# Test 8 — flat checklist keeps the plain "Nth item" wording (no regression)
# =========================================================================
section("Test 8 - flat checklist keeps plain 'item' wording")
flat = [
    {"id": "f1", "text": "alpha", "done": False, "parent_id": None},
    {"id": "f2", "text": "beta", "done": False, "parent_id": None},
    {"id": "f3", "text": "gamma", "done": False, "parent_id": None},
]
parsed = parse_checklist_command(None, "remove the second item", "checklist.remove_item")
rows, reply, changed = apply_checklist_action(
    flat, "checklist.remove_item", parsed, vera=None, user_text="remove the second item"
)
ok(changed, "removal reported as changed")
ok(reply.lower() == "removed the second item.", "flat list -> 'Removed the second item.'", detail=reply)
ok("main item" not in reply.lower(), "flat list does not add 'main item' wording", detail=reply)


# =========================================================================
# Summary
# =========================================================================
print(f"\n{YELLOW}-- summary --{RESET}")
print(f"  passed: {PASS}")
print(f"  failed: {FAIL}")
if FAIL:
    print(f"  failures: {', '.join(FAILED)}")
sys.exit(0 if FAIL == 0 else 1)
