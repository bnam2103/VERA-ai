"""Smoke tests for checklist voice vocabulary — check/tick/uncheck phrasing.

Run:  py -3 -X utf8 tests\\smoke\\__checklist_voice_vocab_smoke.py
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


def _hello_fixture(*, done: bool = False) -> list[dict]:
    return [{"id": "h1", "text": "hello", "done": done, "parent_id": None}]


section("intent routing")
cases_complete = [
    "check the first item in the checklist",
    "check off the first item",
    "tick the first item",
    "mark the first item done",
    "mark the first item as done",
    "complete the first item",
    "mark complete the first item",
    "mark the first item complete",
]
for utt in cases_complete:
    action = is_checklist_action_request(utt)
    ok(action == "checklist.complete_item", f"complete intent: {utt!r}", detail=str(action))

ok(
    is_checklist_action_request("uncheck the first item") == "checklist.uncomplete_item",
    "uncomplete intent: uncheck the first item",
)
ok(
    is_checklist_action_request("mark the first item incomplete") == "checklist.uncomplete_item",
    "uncomplete intent: mark the first item incomplete",
)

status_review = [
    "check the checklist",
    "check my checklist",
    "check if there are checklist items",
]
for utt in status_review:
    action = is_checklist_action_request(utt)
    ok(action is None, f"status review (not complete): {utt!r}", detail=str(action))

section("apply complete — check phrasing")
items = _hello_fixture()
parsed = parse_checklist_command(None, "check the first item in the checklist", "checklist.complete_item")
next_items, reply, changed = apply_checklist_action(
    items, "checklist.complete_item", parsed, vera=None, user_text="check the first item in the checklist"
)
ok(changed, "check first item mutates checklist")
ok(next_items[0].get("done") is True, "hello marked done", detail=str(next_items))

section("apply uncomplete")
items_done = _hello_fixture(done=True)
parsed_unc = parse_checklist_command(None, "uncheck the first item", "checklist.uncomplete_item")
next_items2, reply2, changed2 = apply_checklist_action(
    items_done, "checklist.uncomplete_item", parsed_unc, vera=None, user_text="uncheck the first item"
)
ok(changed2, "uncheck first item mutates checklist")
ok(next_items2[0].get("done") is False, "hello marked incomplete", detail=str(next_items2))

print(f"\n{YELLOW}Results:{RESET} {PASS} passed, {FAIL} failed")
if FAILED:
    print(f"{RED}Failed:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
print(f"{GREEN}All tests passed.{RESET}")
