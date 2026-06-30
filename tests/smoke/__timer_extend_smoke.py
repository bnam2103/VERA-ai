"""Smoke tests for timer.extend Phase 1 (explicit phrases only).

Run: py -3 tests/smoke/__timer_extend_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
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
from actions.timer_extend import (  # noqa: E402
    parse_timer_extend_request,
    timer_extend_intent_matches,
)
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


def _work_ctx(*, active: bool, expired: bool = False, fire_at_ms: int | None = None, timer_id: str = "t1"):
    remaining = 0
    if active and fire_at_ms is not None:
        remaining = max(0, (fire_at_ms - 1_700_000_000_000) // 1000)
    return {
        "mode": "work",
        "timer": {
            "active": active,
            "expired": expired,
            "fire_at_epoch_ms": fire_at_ms,
            "remaining_seconds": remaining,
            "timer_id": timer_id if (active or expired) else None,
        },
    }


ACTIVE_FIRE_MS = 1_700_000_180_000  # arbitrary future ms


section("Explicit extend phrases — planner emits timer.extend")
EXTEND_CASES = [
    ("add 3 minutes to the timer", 180),
    ("extend the timer by 2 minutes", 120),
    ("increase the timer by 30 seconds", 30),
    ("make the timer 5 minutes longer", 300),
    ("give the timer 5 more minutes", 300),
    ("add 30 seconds to my timer", 30),
]
for utt, expected in EXTEND_CASES:
    plan = P.plan_user_actions(utt)
    types_ = [a.get("type") for a in (plan.get("actions") or [])]
    ext = next((a for a in (plan.get("actions") or []) if a.get("type") == "timer.extend"), None)
    ok("timer.extend" in types_, f"{utt!r} → timer.extend", detail=str(types_))
    ok(
        ext and (ext.get("payload") or {}).get("duration_delta_seconds") == expected,
        f"{utt!r} delta={expected}",
        detail=str(ext.get("payload") if ext else None),
    )

section("Blocklist — must NOT be timer.extend")
BLOCK_CASES = [
    ("add 3 minutes to the checklist", "checklist.add"),
    ("set a timer for 3 minutes", "timer.set"),
    ("start a 3-minute timer", "timer.set"),
]
for utt, expected_type in BLOCK_CASES:
    plan = P.plan_user_actions(utt)
    types_ = [a.get("type") for a in (plan.get("actions") or [])]
    ok("timer.extend" not in types_, f"{utt!r} not timer.extend", detail=str(types_))
    ok(expected_type in types_, f"{utt!r} → {expected_type}", detail=str(types_))

ok(not timer_extend_intent_matches("add 3 minutes"), "bare add 3 minutes rejected")
ok(not timer_extend_intent_matches("give me 5 more minutes"), "vague give me 5 more minutes rejected")
ok(not timer_extend_intent_matches("add another minute"), "vague add another minute rejected")
ok(not parse_timer_extend_request("play 3 minutes of rain sounds"), "play rain sounds rejected")

section("Extend core — active timer")
active_ctx = _work_ctx(active=True, fire_at_ms=ACTIVE_FIRE_MS, timer_id="abc123")
out = app._try_work_mode_timer_extend_core(
    "sess1", "add 3 minutes to the timer", active_ctx, "vera"
)
wm = (out or {}).get("work_mode_timer") or {}
ok(isinstance(out, dict) and "Added 3 minutes" in (out.get("reply") or ""), "active extend spoken confirm")
ok(wm.get("extend") is True, "payload extend flag")
ok(wm.get("duration_delta_seconds") == 180, "payload delta seconds")
ok(wm.get("fire_at_epoch_ms") == ACTIVE_FIRE_MS + 180_000, "new fire_at = old + delta")
ok(wm.get("id") == "abc123", "same timer id preserved")

section("Extend core — no active timer")
no_timer_ctx = _work_ctx(active=False, expired=False, fire_at_ms=None, timer_id="")
out_none = app._try_work_mode_timer_extend_core(
    "sess1", "add 3 minutes to the timer", no_timer_ctx, "vera"
)
ok(
    "isn't an active timer" in (out_none.get("reply") or "").lower(),
    "no active timer message",
    detail=str(out_none.get("reply")),
)
ok(
    "start a 3-minute timer" in (out_none.get("reply") or "").lower()
    or "3 minute" in (out_none.get("reply") or "").lower(),
    "no active timer offers start",
    detail=str(out_none.get("reply")),
)
ok(out_none.get("work_mode_timer") is None, "no payload when no active timer")

section("Extend core — expired timer")
expired_ctx = _work_ctx(active=False, expired=True, fire_at_ms=ACTIVE_FIRE_MS - 60_000, timer_id="exp1")
out_exp = app._try_work_mode_timer_extend_core(
    "sess1", "extend the timer by 3 minutes", expired_ctx, "vera"
)
ok(
    "already finished" in (out_exp.get("reply") or "").lower(),
    "expired timer message",
    detail=str(out_exp.get("reply")),
)
ok(out_exp.get("work_mode_timer") is None, "no payload when expired")

section("Multi-action — extend + rain sounds")
multi = P.plan_user_actions("add 3 minutes to the timer and play rain sounds")
types_multi = [a.get("type") for a in (multi.get("actions") or [])]
ok("timer.extend" in types_multi, "multi has timer.extend", detail=str(types_multi))
ok(
    "music.play" in types_multi,
    "multi has music.play for rain sounds",
    detail=str(types_multi),
)
ext_multi = next((a for a in (multi.get("actions") or []) if a.get("type") == "timer.extend"), None)
ok(ext_multi is not None, "multi extend action present")
ok((ext_multi.get("payload") or {}).get("duration_delta_seconds") == 180, "multi extend delta 180")

print()
print("=" * 60)
if FAIL == 0:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    print(f"{GREEN}All timer extend smoke tests passed.{RESET}")
    sys.exit(0)
else:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    print(f"{RED}Failures:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
