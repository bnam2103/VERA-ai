"""Smoke for explicit Work Mode toggle intent detection (2026-06-21).

Ensures descriptive mentions of Work Mode do not flip mode, while explicit
toggle commands still match.

Run:  py -3 tests/smoke/__work_mode_toggle_intent_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import app  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []

SNAP_WORK = {"mode": "work"}
SNAP_IDLE = {"mode": "idle"}


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
            print(f"         {detail[:600]}")


def intent(text: str, snapshot: dict | None = SNAP_WORK) -> str | None:
    return app._work_mode_toggle_intent(text, "vera", snapshot)


section("should NOT toggle — descriptive / incidental phrasing")

NO_TOGGLE = [
    (
        "I'm building Jarvis, a local voice assistant with a Voice UI, Work Mode reasoning panels, "
        "music actions, routing, and Docker deployment. Right now I'm trying to Dockerize it so I can "
        "run it on RunPod."
    ),
    (
        "I'm building Jarvis with Work Mode reasoning panels and I want to run it in RunPod."
    ),
    "My app has Work Mode reasoning panels.",
    "Explain Work Mode.",
    "Deploy this on RunPod with Work Mode panels.",
    "Focus on Work Mode panel design.",
    "Work Mode is a feature in my app.",
]

for text in NO_TOGGLE:
    got = intent(text)
    ok(got is None, f"no intent: {text[:72]}{'…' if len(text) > 72 else ''}", detail=f"got={got!r}")

section("should toggle ON")

ON_CASES = [
    "Turn on Work Mode.",
    "Turn Work Mode on.",
    "Enable Work Mode.",
    "Activate Work Mode.",
    "Switch to Work Mode.",
    "Enter Work Mode.",
    "Open Work Mode.",
    "Work Mode on.",
]

for text in ON_CASES:
    got = intent(text)
    ok(got == "on", f"on: {text}", detail=f"got={got!r}")

section("should toggle OFF")

OFF_CASES = [
    "Turn off Work Mode.",
    "Turn Work Mode off.",
    "Disable Work Mode.",
    "Exit Work Mode.",
    "Leave Work Mode.",
    "Work Mode off.",
]

for text in OFF_CASES:
    got = intent(text)
    ok(got == "off", f"off: {text}", detail=f"got={got!r}")

section("reply when already in work mode")

action, reply = app._work_mode_toggle_reply("on", SNAP_WORK)
ok(action == "work_mode_on" and reply == "Work mode is already on.", "already-on reply preserved")

section("non-vera client ignored")

ok(intent("Turn on Work Mode.", SNAP_WORK) == "on", "vera client matches")
ok(app._work_mode_toggle_intent("Turn on Work Mode.", "other", SNAP_WORK) is None, "other client ignored")

print(f"\n{YELLOW}Summary:{RESET} {PASS} passed, {FAIL} failed")
if FAILED:
    print(f"{RED}Failed:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
print(f"{GREEN}All tests passed.{RESET}")
