"""Smoke test for the narrow Work Mode conversational / check-in guard.

Covers ``CHAT_REASONING.ReasoningAI._detect_conversational_check`` and the
deterministic ``classify_route_reasoning`` short-circuit added 2026-06-13.

The guard must:
  * route obvious greetings / acks / presence-or-hearing checks to Voice UI
    (reason="conversational_check"), never the reasoning panel;
  * NEVER swallow real "can you ..." task requests;
  * NEVER override an explicit panel / work-mode request.

We instantiate ``ReasoningAI`` via ``object.__new__`` so the OpenAI client is
never constructed. Every assertion below exercises ONLY the deterministic
branches (conversational / explicit-panel), so the LLM fallback is never hit.

Run with:
    py -3 tests/smoke/__workmode_conversational_guard_smoke.py
"""

from __future__ import annotations

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from CHAT_REASONING import ReasoningAI

_AI = object.__new__(ReasoningAI)  # skip __init__ / OpenAI() — pure regex only

_pass = 0
_fail = 0


def ok(cond: bool, label: str) -> None:
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  PASS  {label}")
    else:
        _fail += 1
        print(f"  FAIL  {label}")


def _route(text: str) -> dict:
    # Silence the [reasoning_gate]/[workmode_conversational_short_circuit]
    # prints during the bulk assertions.
    buf = io.StringIO()
    with redirect_stdout(buf):
        return _AI.classify_route_reasoning(text)


# ---------------------------------------------------------------------------
# 1) False-positive guard — must NOT enter reasoning.
# ---------------------------------------------------------------------------
print("[1] conversational false-positive guard -> voice_ui / conversational_check")
false_positives = [
    "hello",
    "hi",
    "hey",
    "can you hear me?",
    "hello hello can you hear me?",
    "Hello, hello, hello. Can you hear me?",
    "are you there?",
    "testing",
    "test test",
    "can you read me?",
    "do you hear me?",
    "what's up?",
    "thank you",
    "thanks",
    "okay",
    "ok",
    "got it",
]
for phrase in false_positives:
    detected = _AI._detect_conversational_check(phrase)
    ok(detected, f"detector True: {phrase!r}")
    res = _route(phrase)
    ok(res.get("route") == "voice_ui", f"route=voice_ui: {phrase!r} (got {res.get('route')})")
    ok(
        res.get("reason") == "conversational_check",
        f"reason=conversational_check: {phrase!r} (got {res.get('reason')})",
    )
    ok(res.get("prompt_reasoning") is False, f"prompt_reasoning False: {phrase!r}")


# ---------------------------------------------------------------------------
# 2) Logging — the short-circuit emits the required diagnostic line.
# ---------------------------------------------------------------------------
print("\n[2] [workmode_conversational_short_circuit] log emitted")
log_buf = io.StringIO()
with redirect_stdout(log_buf):
    _AI.classify_route_reasoning("can you hear me?")
log_text = log_buf.getvalue()
ok(
    "[workmode_conversational_short_circuit]" in log_text,
    "log prefix present",
)
ok('"reason": "conversational_check"' in log_text, "log carries reason")
ok('"route": "voice_ui"' in log_text, "log carries route")


# ---------------------------------------------------------------------------
# 3) Explicit Work Mode requests still win (reasoning_panel, NOT swallowed).
# ---------------------------------------------------------------------------
print("\n[3] explicit Work Mode requests still route to reasoning_panel")
explicit_reasoning = [
    "explain the Vietnam War in a new panel",
    "can you explain the Vietnam War in a new panel?",
    "compare BFS and DFS in panel 2",
    "use work mode to outline this project",
    "plan my study schedule in the reasoning panel",
    "open a new panel and explain dynamic programming",
]
for phrase in explicit_reasoning:
    ok(
        not _AI._detect_conversational_check(phrase),
        f"NOT conversational: {phrase!r}",
    )
    res = _route(phrase)
    ok(
        res.get("route") == "reasoning_panel",
        f"route=reasoning_panel: {phrase!r} (got {res.get('route')})",
    )


# ---------------------------------------------------------------------------
# 4) Real "can you ..." requests must NOT be swallowed by the guard.
#    (We assert ONLY the guard verdict; full routing for these is the LLM's
#    job and is intentionally NOT exercised here.)
# ---------------------------------------------------------------------------
print("\n[4] real requests NOT classified as conversational_check")
real_requests = [
    "can you solve this?",
    "can you explain the Vietnam War?",
    "can you make a plan?",
    "can you write an essay outline?",
    "can you compare BFS and DFS?",
    "can you add milk to my checklist?",
    "can you start a 10 minute timer?",
    "can you play music?",
    "can you turn up the volume?",
    "can you open a new panel?",
]
for phrase in real_requests:
    ok(
        not _AI._detect_conversational_check(phrase),
        f"NOT conversational: {phrase!r}",
    )


print(f"\n{_pass} passed, {_fail} failed")
sys.exit(1 if _fail else 0)
