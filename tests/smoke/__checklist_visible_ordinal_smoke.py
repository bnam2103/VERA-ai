"""Smoke tests for the 2026-06-02 visible-ordinal checklist patch.

Spec:
    Ordinal references like "first item", "second item", "third item"
    must address the FULL visible flattened checklist order (top-level
    rows AND sub-items), not just top-level rows. The cascade decision
    is per resolved row: top-level rows pull in their descendants;
    sub-item rows stay single-row. Ranges like "first two items" use
    the same flat order and deduplicate descendants caught by an
    earlier top-level cascade. "The last item" means the last visible
    row.

Run:  py -3 -X utf8 tests\\smoke\\__checklist_visible_ordinal_smoke.py
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
    _resolve_first_count_indices,
    apply_checklist_action,
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


def _make_spec_fixture() -> list[dict]:
    """The spec's canonical fixture:

        1. Apply to internships          (visible 1, top-level)
           - update resume               (visible 2, sub of 1)
           - write cover letter          (visible 3, sub of 1)
           - submit application          (visible 4, sub of 1)
        2. Buy groceries                 (visible 5, top-level, no subs)
    """
    return [
        {"id": "a1", "text": "Apply to internships", "done": False, "parent_id": None},
        {"id": "a2", "text": "update resume", "done": False, "parent_id": "a1"},
        {"id": "a3", "text": "write cover letter", "done": False, "parent_id": "a1"},
        {"id": "a4", "text": "submit application", "done": False, "parent_id": "a1"},
        {"id": "b1", "text": "Buy groceries", "done": False, "parent_id": None},
    ]


def _ids(rows: list[dict]) -> list[str]:
    return [str(r.get("id") or "") for r in rows]


def _done_ids(rows: list[dict]) -> set[str]:
    return {str(r.get("id") or "") for r in rows if bool(r.get("done"))}


# =========================================================================
# PART 0 — visible flatten contract
# =========================================================================
section("PART 0 - visible flatten contract")

flat = visible_flattened_rows(_make_spec_fixture())
ok(len(flat) == 5, "visible flatten has exactly 5 rows", detail=str([r["id"] for r in flat]))
ok(
    [r["id"] for r in flat] == ["a1", "a2", "a3", "a4", "b1"],
    "visible flatten preserves parent-first depth-first order",
    detail=str([r["id"] for r in flat]),
)
ok(
    [int(r["depth"]) for r in flat] == [0, 1, 1, 1, 0],
    "visible flatten exposes depth so callers can decide cascade per row",
    detail=str([int(r["depth"]) for r in flat]),
)


# =========================================================================
# Acceptance test 1 — "Remove the second item" (sub-item, single-row)
# =========================================================================
section("Acceptance 1 - 'Remove the second item' -> single sub-item")

items = _make_spec_fixture()
parsed = parse_checklist_command(None, "Remove the second item", "checklist.remove_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the second item",
)
ok(
    _ids(new_rows) == ["a1", "a3", "a4", "b1"],
    "only 'update resume' (visible row 2) is removed",
    detail=str(_ids(new_rows)),
)
ok(changed, "remove reports as changed")
ok(
    "update resume" in reply.lower() or "second" in reply.lower(),
    "reply names the row that was removed",
    detail=reply,
)


# =========================================================================
# Acceptance test 2 — "Remove the first item" cascades the whole group
# =========================================================================
section("Acceptance 2 - 'Remove the first item' cascades the whole group")

items = _make_spec_fixture()
parsed = parse_checklist_command(None, "Remove the first item", "checklist.remove_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the first item",
)
ok(
    _ids(new_rows) == ["b1"],
    "parent a1 + all three sub-items removed; only 'Buy groceries' remains",
    detail=str(_ids(new_rows)),
)
ok(changed, "remove reports as changed")


# =========================================================================
# Acceptance test 3 — "Mark the third item complete" only marks the sub-item
# =========================================================================
section("Acceptance 3 - 'Mark the third item complete' -> single sub-item")

items = _make_spec_fixture()
parsed = parse_checklist_command(
    None, "Mark the third item complete", "checklist.complete_item"
)
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark the third item complete",
)
ok(
    _done_ids(new_rows) == {"a3"},
    "only 'write cover letter' (visible row 3) is marked done",
    detail=str(sorted(_done_ids(new_rows))),
)
ok(changed, "complete reports as changed")


# =========================================================================
# Acceptance test 4 — "Mark the first item complete" cascades the group
# =========================================================================
section("Acceptance 4 - 'Mark the first item complete' cascades")

items = _make_spec_fixture()
parsed = parse_checklist_command(
    None, "Mark the first item complete", "checklist.complete_item"
)
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark the first item complete",
)
ok(
    _done_ids(new_rows) == {"a1", "a2", "a3", "a4"},
    "parent + all three sub-items marked done; 'Buy groceries' untouched",
    detail=str(sorted(_done_ids(new_rows))),
)
ok(changed, "complete reports as changed")


# =========================================================================
# Acceptance test 5 — "Remove the first two items" deduplicates inside cascade
# =========================================================================
section("Acceptance 5 - 'Remove the first two items' dedup cascade")

items = _make_spec_fixture()
parsed = parse_checklist_command(None, "Remove the first two items", "checklist.remove_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the first two items",
)
ok(
    _ids(new_rows) == ["b1"],
    "first two visible rows (a1 + a2) collapse into one cascade -> whole group gone",
    detail=str(_ids(new_rows)),
)
ok(changed, "remove reports as changed")


# =========================================================================
# Acceptance test 6 — "Mark the first two items complete" dedup cascade
# =========================================================================
section("Acceptance 6 - 'Mark the first two items complete' dedup cascade")

items = _make_spec_fixture()
parsed = parse_checklist_command(
    None, "Mark the first two items complete", "checklist.complete_item"
)
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark the first two items complete",
)
ok(
    _done_ids(new_rows) == {"a1", "a2", "a3", "a4"},
    "first top-level group fully done; group 2 untouched",
    detail=str(sorted(_done_ids(new_rows))),
)
ok(changed, "complete reports as changed")


# =========================================================================
# Acceptance test 7 — "Remove the last item" = last visible row
# =========================================================================
section("Acceptance 7 - 'Remove the last item' targets last visible row")

items = _make_spec_fixture()
parsed = parse_checklist_command(None, "Remove the last item", "checklist.remove_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the last item",
)
ok(
    _ids(new_rows) == ["a1", "a2", "a3", "a4"],
    "the last visible row 'Buy groceries' (top-level, no subs) is removed",
    detail=str(_ids(new_rows)),
)
ok(changed, "remove reports as changed")


# =========================================================================
# Bonus — last-visible-row resolution on a fixture whose last row IS a sub-item
# =========================================================================
section("Bonus - 'last item' lands on a sub-item when that's the last visible row")

bonus_items = [
    {"id": "a1", "text": "Apply to internships", "done": False, "parent_id": None},
    {"id": "a2", "text": "update resume", "done": False, "parent_id": "a1"},
    {"id": "a3", "text": "write cover letter", "done": False, "parent_id": "a1"},
    {"id": "b1", "text": "Buy groceries", "done": False, "parent_id": None},
    {"id": "b2", "text": "milk", "done": False, "parent_id": "b1"},
    {"id": "b3", "text": "eggs", "done": False, "parent_id": "b1"},
]
parsed = parse_checklist_command(None, "Remove the last item", "checklist.remove_item")
new_rows, _, _ = apply_checklist_action(
    bonus_items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the last item",
)
ok(
    _ids(new_rows) == ["a1", "a2", "a3", "b1", "b2"],
    "'last item' = visible row 6 (eggs); only that sub-item removed",
    detail=str(_ids(new_rows)),
)


# =========================================================================
# Bonus — sub-item ordinal does NOT cascade siblings
# =========================================================================
section("Bonus - sub-item ordinal is single-row, never cascades siblings")

items = _make_spec_fixture()
parsed = parse_checklist_command(None, "Mark the fourth item complete", "checklist.complete_item")
new_rows, _, _ = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark the fourth item complete",
)
ok(
    _done_ids(new_rows) == {"a4"},
    "only the fourth visible row (submit application, sub-item) is marked done",
    detail=str(sorted(_done_ids(new_rows))),
)


# =========================================================================
# Bonus — top-level sibling without subs stays single-row
# =========================================================================
section("Bonus - 'fifth item' resolves to top-level with no subs")

items = _make_spec_fixture()
parsed = parse_checklist_command(None, "Mark the fifth item complete", "checklist.complete_item")
new_rows, _, _ = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark the fifth item complete",
)
ok(
    _done_ids(new_rows) == {"b1"},
    "only 'Buy groceries' (visible row 5, top-level, no subs) is marked done",
    detail=str(sorted(_done_ids(new_rows))),
)


# =========================================================================
# Bonus — out-of-range ordinal speaks against visible row count
# =========================================================================
section("Bonus - out-of-range error references visible row count")

items = _make_spec_fixture()
parsed = parse_checklist_command(None, "Remove the tenth item", "checklist.remove_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the tenth item",
)
ok(_ids(new_rows) == ["a1", "a2", "a3", "a4", "b1"],
   "no rows removed when ordinal is out of range",
   detail=str(_ids(new_rows)))
ok(
    "5 visible" in reply or "5 items" in reply.lower(),
    "error message references the visible row count (5)",
    detail=reply,
)


# =========================================================================
# Bonus — _resolve_first_count_indices direct contract
# =========================================================================
section("Bonus - _resolve_first_count_indices addresses flat order")

items = _make_spec_fixture()
# count=1 -> visible row 1 (a1, top-level) -> cascade a1+a2+a3+a4
idxs, err = _resolve_first_count_indices(items, 1)
ok(err is None, "count=1 produces no error")
got_ids = sorted({str(items[i].get("id") or "") for i in idxs})
ok(got_ids == ["a1", "a2", "a3", "a4"],
   "count=1 cascades the first top-level group",
   detail=str(got_ids))

# count=2 -> visible row 1 (top, cascade) + visible row 2 (sub of 1, dedup)
idxs, err = _resolve_first_count_indices(items, 2)
got_ids = sorted({str(items[i].get("id") or "") for i in idxs})
ok(got_ids == ["a1", "a2", "a3", "a4"],
   "count=2 picks rows 1+2 from flat; sub-item ordinal is deduped inside cascade",
   detail=str(got_ids))

# count=5 -> all visible rows; second top-level group cascades into itself (empty subs)
idxs, err = _resolve_first_count_indices(items, 5)
got_ids = sorted({str(items[i].get("id") or "") for i in idxs})
ok(got_ids == ["a1", "a2", "a3", "a4", "b1"],
   "count=5 selects every visible row",
   detail=str(got_ids))


# =========================================================================
# Bonus — explicit "whole_section" still forces cascade on a sub-item
# =========================================================================
section("Bonus - 'the whole second item' cascades even when picked row is a sub-item")

items = _make_spec_fixture()
parsed = parse_checklist_command(
    None, "Remove the whole second item", "checklist.remove_item"
)
ok(
    str(parsed.get("scope") or "").lower() == "whole_section",
    "'whole second item' parses with scope='whole_section'",
    detail=str(parsed),
)
# Under the new semantics visible row 2 is "update resume" (sub of a1).
# whole_section forces cascade — but the sub-item has no descendants, so
# only that sub-item is removed. This documents that the scope flag does
# not invent siblings.
new_rows, _, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the whole second item",
)
ok(_ids(new_rows) == ["a1", "a3", "a4", "b1"],
   "whole_section on a leaf sub-item still removes only that row",
   detail=str(_ids(new_rows)))


# =========================================================================
# Summary
# =========================================================================
print(f"\n{YELLOW}-- summary --{RESET}")
print(f"  passed: {PASS}")
print(f"  failed: {FAIL}")
if FAIL:
    print(f"  failures: {', '.join(FAILED)}")
sys.exit(0 if FAIL == 0 else 1)
