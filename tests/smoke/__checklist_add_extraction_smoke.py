"""Smoke for single-action checklist add-item extraction (2026-06-21).

Verifies _route_checklist_multi_command strips destination tails like
``to my checklist`` before splitting on ``and``/commas.

Run:  py -3 tests/smoke/__checklist_add_extraction_smoke.py
"""
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
from actions.checklist import _route_checklist_multi_command  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


def ok(cond: bool, name: str, *, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}")
        if detail:
            print(f"         {detail[:800]}")


def _single_add_items(text: str) -> list[str]:
    parsed = _route_checklist_multi_command(text, "checklist.add_item")
    return list(parsed.get("item_texts") or [])


def _planner_add_items(text: str) -> list[str]:
    plan = P.plan_user_actions(text, vera=None)
    for action in plan.get("actions") or []:
        if action.get("type") == "checklist.add":
            return list((action.get("payload") or {}).get("items") or [])
    return []


section("single-action _route_checklist_multi_command")
CASES = [
    ("Can you add milk and eggs to my checklist?", ["milk", "eggs"]),
    ("add milk, eggs, and bread to my list", ["milk", "eggs", "bread"]),
    ("add talk to Alex to my checklist", ["talk to Alex"]),
    ("add homework due tomorrow to my checklist", ["homework due tomorrow"]),
    ("add eggs to my checklist?", ["eggs"]),
    ("Add milk and eggs to the checklist", ["milk", "eggs"]),
]
for text, expected in CASES:
    got = _single_add_items(text)
    ok(got == expected, f"{text!r} -> {expected!r}", detail=f"got={got!r}")


section("planner vs single-action parity")
PARITY_TEXT = "Can you add milk and eggs to my checklist?"
planner_items = _planner_add_items(PARITY_TEXT)
single_items = _single_add_items(PARITY_TEXT)
ok(planner_items == ["milk", "eggs"], f"planner -> {planner_items!r}")
ok(single_items == ["milk", "eggs"], f"single-action -> {single_items!r}")
ok(
    planner_items == single_items,
    "planner and single-action extraction match",
    detail=f"planner={planner_items!r} single={single_items!r}",
)


section("multi-action compound — checklist portion (optional)")
compound = "add milk to my checklist and open the music panel"
checklist_items = _planner_add_items(compound)
ok(checklist_items == ["milk"], f"compound checklist items stay {checklist_items!r}")


print()
print(f"PASS {PASS}  FAIL {FAIL}")
if FAILED:
    print("Failed tests:")
    for name in FAILED:
        print(f"  - {name}")
sys.exit(0 if FAIL == 0 else 1)
