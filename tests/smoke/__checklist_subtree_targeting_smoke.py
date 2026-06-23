"""Smoke tests for the 2026-06-01 checklist subtree-targeting patch.

Covers two issues:

  Issue 1 — Top-level remove/complete must cascade to sub-items.
  When the user says "remove the first item" / "mark the first item
  complete" and that top-level item has children, the children must be
  removed/completed too. They must NOT be orphan-promoted to top-level.

  Issue 2 — "the last item" ordinal must resolve to the actual last
  TOP-LEVEL row. Same for "the second to last item", "the final task",
  "the very last bullet", etc.

  Sub-items targeted directly (label OR sub_item ordinal phrasing) must
  still be single-row operations; the cascade applies only when the
  resolved row is top-level.

Run:  py -3 -X utf8 tests\\smoke\\__checklist_subtree_targeting_smoke.py
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
    _detect_removal_scope,
    _extract_relative_ordinals,
    _has_checklist_ordinal_phrase,
    apply_checklist_action,
    is_checklist_action_request,
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


# Helper to build a fresh fixture for each scenario (callers mutate the
# returned list in-place via apply_checklist_action).
def _make_fixture_two_groups_with_subitems() -> list[dict]:
    """Mirrors the spec example:

        1. Apply to internships
           - update resume
           - write cover letter
           - submit application
        2. Buy groceries
    """
    return [
        {"id": "a1", "text": "Apply to internships", "done": False, "parent_id": None},
        {"id": "a2", "text": "update resume", "done": False, "parent_id": "a1"},
        {"id": "a3", "text": "write cover letter", "done": False, "parent_id": "a1"},
        {"id": "a4", "text": "submit application", "done": False, "parent_id": "a1"},
        {"id": "b1", "text": "Buy groceries", "done": False, "parent_id": None},
    ]


def _make_fixture_two_groups_both_with_subitems() -> list[dict]:
    """
        1. Apply to internships
           - update resume
           - write cover letter
        2. Buy groceries
           - milk
           - eggs
    """
    return [
        {"id": "a1", "text": "Apply to internships", "done": False, "parent_id": None},
        {"id": "a2", "text": "update resume", "done": False, "parent_id": "a1"},
        {"id": "a3", "text": "write cover letter", "done": False, "parent_id": "a1"},
        {"id": "b1", "text": "Buy groceries", "done": False, "parent_id": None},
        {"id": "b2", "text": "milk", "done": False, "parent_id": "b1"},
        {"id": "b3", "text": "eggs", "done": False, "parent_id": "b1"},
    ]


def _ids(rows: list[dict]) -> list[str]:
    return [str(r.get("id") or "") for r in rows]


def _done_ids(rows: list[dict]) -> set[str]:
    return {str(r.get("id") or "") for r in rows if bool(r.get("done"))}


# =========================================================================
# PART 0 — helper-level sanity checks
# =========================================================================
section("PART 0 - helper sanity checks")

ok(_detect_removal_scope("remove the first item") == ("auto", None),
   "default scope is now 'auto' (was 'parent_only')")
ok(_detect_removal_scope("remove the whole first section") == ("whole_section", None),
   "explicit 'whole section' still maps to 'whole_section'")
ok(_detect_removal_scope("remove the entire first item")[0] == "whole_section",
   "'the entire first item' maps to 'whole_section'")
ok(
    _detect_removal_scope("remove the second sub-item under revise")[0] == "sub_item",
    "'second sub-item under X' maps to 'sub_item'",
)

ok(_extract_relative_ordinals("the last item") == ["last"],
   "'the last item' extracted as relative 'last'")
ok(_extract_relative_ordinals("the very last task") == ["last"],
   "'the very last task' extracted as relative 'last'")
ok(_extract_relative_ordinals("the final bullet") == ["last"],
   "'the final bullet' extracted as relative 'last'")
ok(_extract_relative_ordinals("the second to last item") == ["second_to_last"],
   "'second to last item' extracted as relative 'second_to_last'")
ok(_extract_relative_ordinals("the next to last bullet") == ["second_to_last"],
   "'next to last bullet' extracted as relative 'second_to_last'")
ok(_extract_relative_ordinals("the penultimate item") == ["second_to_last"],
   "'penultimate item' extracted as relative 'second_to_last'")
ok(_extract_relative_ordinals("the first item") == [],
   "'the first item' has no relative ordinal")

ok(
    _has_checklist_ordinal_phrase("remove the last item"),
    "'remove the last item' passes the ordinal-phrase gate",
)
ok(
    is_checklist_action_request("Remove the last item") == "checklist.remove_item",
    "is_checklist_action_request routes 'Remove the last item' to remove_item",
)
ok(
    is_checklist_action_request("Mark the last item complete") == "checklist.complete_item",
    "is_checklist_action_request routes 'Mark the last item complete' to complete_item",
)


# =========================================================================
# Acceptance test 1 — "Remove the first item" cascades to sub-items.
# =========================================================================
section("Acceptance 1 - 'Remove the first item' cascades to sub-items")

items = _make_fixture_two_groups_with_subitems()
parsed = parse_checklist_command(None, "Remove the first item", "checklist.remove_item")
ok(
    parsed.get("scope") == "auto",
    "parsed scope is 'auto' (default cascade)",
    detail=str(parsed),
)
ok(
    parsed.get("target_count") == 1 or 1 in (parsed.get("target_indices") or []),
    "parsed targets the first top-level item",
    detail=str(parsed),
)

new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the first item",
)
remaining_ids = _ids(new_rows)
ok(remaining_ids == ["b1"],
   "only 'Buy groceries' remains (parent a1 + all 3 sub-items removed)",
   detail=str(remaining_ids))
ok(changed, "mutation reported as changed")
ok("first" in reply.lower() and "remove" in reply.lower(),
   "reply confirms removal of the first item",
   detail=reply)


# =========================================================================
# Acceptance test 2 — "Mark the first item complete" cascades.
# =========================================================================
section("Acceptance 2 - 'Mark the first item complete' cascades")

items = _make_fixture_two_groups_with_subitems()
parsed = parse_checklist_command(None, "Mark the first item complete", "checklist.complete_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark the first item complete",
)
done = _done_ids(new_rows)
ok(done == {"a1", "a2", "a3", "a4"},
   "all four rows of the first group are done; group 2 untouched",
   detail=f"done={sorted(done)}")
ok({"b1"} & done == set(),
   "the second top-level row 'Buy groceries' is NOT done")
ok(changed, "mutation reported as changed")
ok("first" in reply.lower() and "complete" in reply.lower(),
   "reply confirms first-item completion", detail=reply)


# =========================================================================
# Acceptance test 3 — "Remove the last item" targets the LAST top-level row.
# =========================================================================
section("Acceptance 3 - 'Remove the last item' targets last top-level")

items = _make_fixture_two_groups_with_subitems()
parsed = parse_checklist_command(None, "Remove the last item", "checklist.remove_item")
ok(
    "last" in (parsed.get("target_relative_ordinals") or []),
    "parsed carries relative ordinal 'last'",
    detail=str(parsed),
)
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the last item",
)
remaining_ids = _ids(new_rows)
ok(remaining_ids == ["a1", "a2", "a3", "a4"],
   "removed only the last top-level row 'Buy groceries' (no children)",
   detail=str(remaining_ids))
ok(changed, "mutation reported as changed")
ok(
    "second" in reply.lower()
    or "last" in reply.lower()
    or "buy groceries" in reply.lower(),
   "reply mentions the last/second item that was removed",
   detail=reply)

# Issue 2 example variant: 2026-06-02 spec change — "the last item" now
# resolves against the FULL visible flattened list (which includes
# sub-items), not just the top-level subset. On this fixture the last
# visible row is the sub-item "eggs", so only that sub-item is removed.
# The "remove a whole last group" intent must use explicit cascade
# phrasing ("the whole last section") to opt back into cascade.
items = _make_fixture_two_groups_both_with_subitems()
parsed = parse_checklist_command(None, "Remove the last item", "checklist.remove_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the last item",
)
remaining_ids = _ids(new_rows)
ok(remaining_ids == ["a1", "a2", "a3", "b1", "b2"],
   "'last item' targets the last VISIBLE row (eggs); only that sub-item is removed",
   detail=str(remaining_ids))


# =========================================================================
# Acceptance test 4 — "Mark the last item complete" cascades.
# =========================================================================
section("Acceptance 4 - 'Mark the last item complete' cascades")

items = _make_fixture_two_groups_both_with_subitems()
parsed = parse_checklist_command(None, "Mark the last item complete", "checklist.complete_item")
new_rows, reply, changed = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark the last item complete",
)
done = _done_ids(new_rows)
# 2026-06-02: "last item" = last VISIBLE row. On this fixture the last
# visible row is "eggs" (b3), a sub-item, so only that sub-item is
# marked complete.
ok(done == {"b3"},
   "'last item' targets only the last visible sub-item (eggs)",
   detail=f"done={sorted(done)}")
ok(changed, "mutation reported as changed")


# =========================================================================
# Acceptance test 5 — Sub-item targeting stays single-row.
# =========================================================================
section("Acceptance 5 - direct sub-item ops stay single-row")

# 5.a Removing a sub-item by label removes only that sub-item.
items = _make_fixture_two_groups_with_subitems()
parsed = parse_checklist_command(None, "Remove write cover letter", "checklist.remove_item")
new_rows, reply, _ = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove write cover letter",
)
remaining_ids = _ids(new_rows)
ok(
    set(remaining_ids) == {"a1", "a2", "a4", "b1"},
    "label-targeted sub-item removed; parent + siblings + group 2 preserved",
    detail=str(remaining_ids),
)

# 5.b Completing a sub-item by label completes only that sub-item.
items = _make_fixture_two_groups_with_subitems()
parsed = parse_checklist_command(None, "Mark write cover letter complete", "checklist.complete_item")
new_rows, _, _ = apply_checklist_action(
    items, "checklist.complete_item", parsed,
    vera=None, user_text="Mark write cover letter complete",
)
done = _done_ids(new_rows)
ok(done == {"a3"},
   "label-targeted sub-item is the only row marked done",
   detail=f"done={sorted(done)}")

# 5.c "sub_item" scope phrasing also stays single-row.
items = _make_fixture_two_groups_with_subitems()
parsed = parse_checklist_command(
    None,
    "Remove the second sub-item under Apply to internships",
    "checklist.remove_item",
)
ok(parsed.get("scope") == "sub_item",
   "explicit 'sub-item under X' parses as scope='sub_item'",
   detail=str(parsed))
new_rows, _, _ = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the second sub-item under Apply to internships",
)
remaining_ids = _ids(new_rows)
# Second sub-item of the parent group is "write cover letter" (a3).
ok(
    set(remaining_ids) == {"a1", "a2", "a4", "b1"},
    "sub_item-scope removal only removed 'write cover letter'",
    detail=str(remaining_ids),
)


# =========================================================================
# PART 6 — explicit cascade phrases ("the whole first item") still work
# =========================================================================
section("PART 6 - explicit cascade phrases unchanged")

items = _make_fixture_two_groups_with_subitems()
parsed = parse_checklist_command(None, "Remove the whole first section", "checklist.remove_item")
ok(parsed.get("scope") == "whole_section",
   "'remove the whole first section' parses as whole_section",
   detail=str(parsed))
new_rows, reply, _ = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the whole first section",
)
ok(_ids(new_rows) == ["b1"],
   "'whole first section' removes parent + descendants",
   detail=_ids(new_rows))
ok("whole" in reply.lower(),
   "reply uses 'whole' wording when scope is whole_section",
   detail=reply)


# =========================================================================
# PART 7 — "Remove the first 2 items" cascades both top-level groups
# =========================================================================
section("PART 7 - 'first N items' cascades all N top-level groups")

items = _make_fixture_two_groups_both_with_subitems()
parsed = parse_checklist_command(None, "Remove the first 2 items", "checklist.remove_item")
new_rows, _, _ = apply_checklist_action(
    items, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the first 2 items",
)
# 2026-06-02: "first 2 items" addresses the FLAT visible list — that's
# visible row 1 (Apply, top-level) + visible row 2 (update resume, a
# sub-item of Apply). The top-level row cascades to its descendants and
# the sub-item row is deduped because it's already in the cascade. So
# the whole first group goes away but the SECOND top-level group
# (Buy groceries + milk + eggs) survives intact.
ok(_ids(new_rows) == ["b1", "b2", "b3"],
   "'first 2 items' removes the first top-level GROUP only "
   "(sub-item ordinal 2 is deduped inside that group's cascade)",
   detail=str(_ids(new_rows)))


# =========================================================================
# PART 8 — Out-of-range "last" on empty checklist
# =========================================================================
section("PART 8 - 'last item' on empty checklist")

empty: list[dict] = []
parsed = parse_checklist_command(None, "Remove the last item", "checklist.remove_item")
new_rows, reply, changed = apply_checklist_action(
    empty, "checklist.remove_item", parsed,
    vera=None, user_text="Remove the last item",
)
ok(_ids(new_rows) == [],
   "empty checklist stays empty",
   detail=str(_ids(new_rows)))
ok(not changed, "no mutation reported on empty checklist")
ok(
    "could not find" in reply.lower() or "no" in reply.lower(),
    "reply explains there's nothing to remove",
    detail=reply,
)


# =========================================================================
# Summary
# =========================================================================
print(f"\n{YELLOW}-- summary --{RESET}")
print(f"  passed: {PASS}")
print(f"  failed: {FAIL}")
if FAIL:
    print(f"  failures: {', '.join(FAILED)}")
sys.exit(0 if FAIL == 0 else 1)
