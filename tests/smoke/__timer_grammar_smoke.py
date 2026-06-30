"""Smoke tests for the timer-START grammar fix (2026-06-13).

Root cause this guards against: the timer DURATION parser
(``actions.timer_duration.parse_timer_duration_seconds``) already handled
"10 minute", "1 hour", "1 hour and 30 minute", etc. — but the timer INTENT
classifiers only matched the timer NOUN immediately after the verb/article
("set a timer ..."). Duration-before-noun ("start a 10 minute timer") and
countdown wording ("count down 10 minutes") were never classified as a timer
at all, so the duration parser was never reached and no work_mode_timer
payload was created.

This suite verifies BOTH layers agree on the same grammar:

  1. Planner  — ``multi_action_planner.plan_user_actions`` emits a
     ``timer.set`` action with the correct ``duration_seconds``.
  2. Timer core — ``app._try_work_mode_timer_core`` returns a confirmed
     ``work_mode_timer`` payload (and a concrete spoken confirmation, not a
     vague "I can help with timers").

Run:  py -3 tests/smoke/__timer_grammar_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
import time
import types

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

# Stub heavy audio modules so importing ``app`` stays cheap/offline.
_TTS_STUB_NAMES = (
    "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
    "transcribe_long", "load_model", "warmup", "speak_to_file",
    "split_sentences_for_tts", "pop_first_complete_segment",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload",
)
for _modname in ("TTS", "STT", "ASR"):
    if _modname not in sys.modules:
        _stub = types.ModuleType(_modname)
        for _name in _TTS_STUB_NAMES:
            setattr(_stub, _name, lambda *a, **kw: b"")
        sys.modules[_modname] = _stub

from actions import multi_action_planner as P  # noqa: E402
import app  # noqa: E402

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


# The 8 spec inputs: (utterance, expected_duration_seconds).
TIMER_CASES = [
    ("Can you set a timer for 10 minutes?", 600),
    ("Can you start a 10 minute timer?", 600),
    ("Start timer for 10 minutes", 600),
    ("Set a 30 second timer", 30),
    ("Start a 1 hour timer", 3600),
    ("Start a 1 hour and 30 minute timer", 5400),
    ("Set 10 minute timer", 600),
    ("Count down 10 minutes", 600),
    # Hyphenated compound-adjective forms (2026-06-21)
    ("start a timer for 10 minutes", 600),
    ("start a 10-minute timer", 600),
    ("start 10 minute timer", 600),
    ("begin a 5-minute timer", 300),
    ("create a one-hour timer", 3600),
    ("create a 30-second timer", 30),
]

MULTI_TIMER_CASES = [
    (
        "start a 10-minute timer and switch to second panel",
        600,
        ["timer.set", "panel.navigate"],
    ),
]


# ---------------------------------------------------------------------------
# Layer 1 — planner emits timer.set + correct duration_seconds
# ---------------------------------------------------------------------------
section("Planner — timer.set classification + duration_seconds")
for utt, expected in TIMER_CASES:
    plan = P.plan_user_actions(utt)
    types_ = [a.get("type") for a in (plan.get("actions") or [])]
    ts = next((a for a in (plan.get("actions") or []) if a.get("type") == "timer.set"), None)
    ok("timer.set" in types_, f"{utt!r} → timer.set", detail=str(types_))
    ok(ts is not None and (ts.get("payload") or {}).get("duration_seconds") == expected,
       f"{utt!r} → duration_seconds == {expected}",
       detail=str(ts.get("payload") if ts else types_))


# ---------------------------------------------------------------------------
# Layer 2 — timer core builds a confirmed work_mode_timer payload
# ---------------------------------------------------------------------------
section("Timer core — _try_work_mode_timer_core creates work_mode_timer")
WORK_CTX = {"mode": "work"}
for utt, expected in TIMER_CASES:
    now = time.time()
    out = app._try_work_mode_timer_core("smoke-timer-sess", utt, WORK_CTX, "vera")
    is_dict = isinstance(out, dict)
    wm = (out or {}).get("work_mode_timer") if is_dict else None
    reply = str((out or {}).get("reply") or "") if is_dict else ""
    ok(isinstance(wm, dict) and "fire_at_epoch_ms" in wm,
       f"{utt!r} → work_mode_timer payload created",
       detail=str(out))
    # The fire time should be ~expected seconds out (sub-3s durations get
    # clamped to a 3s floor, which doesn't affect any case here).
    if isinstance(wm, dict) and "fire_at_epoch_ms" in wm:
        delta = wm["fire_at_epoch_ms"] / 1000.0 - now
        ok(abs(delta - expected) <= 5.0,
           f"{utt!r} → fires in ~{expected}s",
           detail=f"delta={delta:.1f}s expected={expected}s")
    ok(bool(reply) and "i can help" not in reply.lower(),
       f"{utt!r} → concrete confirmation reply",
       detail=repr(reply))


# ---------------------------------------------------------------------------
# Guard: timers stay Work-Mode-only and cancel wording is untouched
# ---------------------------------------------------------------------------
section("Timer core — non-work-mode declines gracefully, cancel still works")
no_wm = app._try_work_mode_timer_core("smoke-timer-sess2", "start a 10 minute timer", {"mode": "voice"}, "vera")
ok(isinstance(no_wm, dict) and no_wm.get("work_mode_timer") is None,
   "non-work-mode → no timer payload (graceful)",
   detail=str(no_wm))

cancel = app._try_work_mode_timer_core("smoke-timer-sess3", "cancel the timer", WORK_CTX, "vera")
ok(isinstance(cancel, dict)
   and isinstance(cancel.get("work_mode_timer"), dict)
   and cancel["work_mode_timer"].get("cancel") is True,
   "cancel the timer → cancel payload",
   detail=str(cancel))


# ---------------------------------------------------------------------------
# Multi-action — timer + panel (hyphenated duration)
# ---------------------------------------------------------------------------
section("Planner — multi-action timer + panel")
for utt, expected, expected_types in MULTI_TIMER_CASES:
    plan = P.plan_user_actions(utt)
    types_ = [a.get("type") for a in (plan.get("actions") or [])]
    ok(types_ == expected_types, f"{utt!r} → action types", detail=str(types_))
    ts = next((a for a in (plan.get("actions") or []) if a.get("type") == "timer.set"), None)
    ok(ts is not None and (ts.get("payload") or {}).get("duration_seconds") == expected,
       f"{utt!r} → timer duration_seconds == {expected}",
       detail=str(ts.get("payload") if ts else types_))


# ---------------------------------------------------------------------------
print(f"\n{'='*60}")
if FAIL == 0:
    print(f"{GREEN}ALL {PASS} TIMER GRAMMAR CHECKS PASSED{RESET}")
else:
    print(f"{RED}{FAIL} FAILED{RESET} / {PASS + FAIL} total")
    for f in FAILED:
        print(f"  {RED}- {f}{RESET}")
sys.exit(1 if FAIL else 0)
