"""Smoke: Phase A grounded voice final brief helpers.

Run:  py -3 tests/smoke/__voice_final_brief_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import app  # noqa: E402
from CHAT_REASONING import ReasoningAI  # noqa: E402
from cost_logging.credits import classify_credit_action, compute_credits  # noqa: E402

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
            print(f"         {detail[:600]}")


section("scope validation")

ok(
    app._validate_voice_final_brief_scope(
        turn_id="wm-1",
        lane_id="atlas",
        stream_lane_id="atlas",
        panel_markdown="# Derivative\n\nThe derivative is **6x² + 4x**.",
    )[0],
    "matching lane + markdown passes",
)
ok(
    not app._validate_voice_final_brief_scope(
        turn_id="wm-1",
        lane_id="atlas",
        stream_lane_id="echo",
        panel_markdown="# Derivative\n\nThe derivative is **6x² + 4x**.",
    )[0],
    "lane mismatch fails",
    detail=str(
        app._validate_voice_final_brief_scope(
            turn_id="wm-1",
            lane_id="atlas",
            stream_lane_id="echo",
            panel_markdown="# Derivative\n\nThe derivative is **6x² + 4x**.",
        )
    ),
)
ok(
    not app._validate_voice_final_brief_scope(
        turn_id="",
        lane_id="atlas",
        stream_lane_id="atlas",
        panel_markdown="short",
    )[0],
    "missing turn_id fails",
)

section("sanitize voice final brief")

san = ReasoningAI._sanitize_voice_final_brief(
    "The derivative is **6x² + 4x**. The key step was applying the power rule."
)
ok("6x" in san and "power rule" in san.lower(), "markdown stripped from brief")
ok(
    not ReasoningAI._sanitize_voice_final_brief("I worked through it in the reasoning panel."),
    "generic handoff stripped",
)

section("empty panel fallback (no API)")

ok(
    "couldn't" in (
        "I couldn't pull a clear conclusion from the panel yet — "
        "check Work Mode for what's there so far."
    ).lower(),
    "empty panel fallback copy present",
)

section("credit classification")

action, _reason = classify_credit_action(
    mode="work_mode",
    request_type="reasoning",
    extras={"http_path": "/work_mode/voice_final_brief"},
    events=[{"provider": "openai", "output_tokens": 40}],
)
ok(action == "work_mode_voice_summary", "voice_final_brief maps to work_mode_voice_summary", detail=action)
ok(compute_credits("work_mode_voice_summary") == 2, "voice summary costs 2 credits")

section("summary")
print(f"\n{PASS} passed, {FAIL} failed")
if FAILED:
    print(f"{RED}Failed:{RESET}", ", ".join(FAILED))
    sys.exit(1)
print(f"{GREEN}All smoke checks passed.{RESET}")
