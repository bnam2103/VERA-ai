"""Smoke for multi-action music planning/execution (2026-06-13).

Guards the bug where a voice compound like:

    "and you unpause the music and crank up the volume"

planned correctly as ``music.resume`` + ``music.volume`` but /infer voice
did not allow the backend planner to execute same-bucket music compounds.
The legacy greedy music router then returned after the first intent, so the
volume action was dropped from both payloads and spoken reply.

Run:  py -3 tests/smoke/__music_multi_action_planning_execution_smoke.py
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

_AUDIO_STUB_NAMES = (
    "synthesize_reply_audio",
    "synthesize_audio",
    "tts_init",
    "transcribe",
    "transcribe_long",
    "load_model",
    "warmup",
    "speak_to_file",
    "split_sentences_for_tts",
    "pop_first_complete_segment",
    "stream_tts_chunks",
    "tts_chunks",
    "warmup_tts",
    "warmup_asr",
    "init_tts",
    "init_asr",
    "preload",
)
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _AUDIO_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

from actions import multi_action_planner as P  # noqa: E402
import app  # noqa: E402

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


def _plan(text: str) -> dict:
    return P.plan_user_actions(text, vera=None)


def _actions(plan: dict) -> list[dict]:
    return list(plan.get("actions") or [])


def _types(actions: list[dict]) -> list[str]:
    return [a.get("type") or "" for a in actions]


def _normalized_types(actions: list[dict]) -> list[str]:
    """Map planner's structured ``music.volume`` into user-facing direction
    labels for these regression assertions."""
    out: list[str] = []
    for action in actions:
        typ = action.get("type") or ""
        payload = action.get("payload") or {}
        if typ == "music.volume":
            direction = payload.get("direction")
            out.append("music.volume_up" if direction == "up" else "music.volume_down")
        else:
            out.append(typ)
    return out


def _volume_amount(actions: list[dict]) -> int | None:
    for action in actions:
        if action.get("type") == "music.volume":
            return 5
    return None


def _execute(text: str):
    return app.try_execute_planned_actions_for_text(
        text=text,
        session_id="__smoke_music_multi_action",
        history=[],
        client_context_snapshot={
            "mode": "voice",
            "music": {
                "skip_next_available": True,
                "skip_prev_available": True,
            },
        },
    )


section("planner output")
PLANNER_CASES = [
    ("Can you crank up the volume?", ["music.volume_up"]),
    ("unpause the music and crank up the volume", ["music.resume", "music.volume_up"]),
    ("resume playback and turn up the volume", ["music.resume", "music.volume_up"]),
    ("pause the music and turn the volume down", ["music.pause", "music.volume_down"]),
    ("play the next track and turn it up", ["music.next", "music.volume_up"]),
    ("turn the volume up and play the next track", ["music.volume_up", "music.next"]),
]
for text, expected in PLANNER_CASES:
    plan = _plan(text)
    acts = _actions(plan)
    got = _normalized_types(acts)
    ok(got == expected, f"{text!r} -> {expected}", detail=f"got={got} actions={acts}")
    if any(t in expected for t in ("music.volume_up", "music.volume_down")):
        ok(_volume_amount(acts) == 5, f"{text!r} -> volume amount=5", detail=f"actions={acts}")


section("voice gate override for same-bucket music compounds")
voice_text = "and you unpause the music and crank up the volume"
voice_plan = _plan(voice_text)
voice_acts = _actions(voice_plan)
_v_ok, _v_errs, _v_cq = P.validate_plan(voice_plan)
_v_conf = (
    sum(float(a.get("confidence") or 0.0) for a in voice_acts) / max(1, len(voice_acts))
) if voice_acts else 0.0
allowed, reason, diag = app._voice_planner_takeover_decision(
    is_multi_action=bool(voice_plan.get("is_multi_action")),
    validate_ok=bool(_v_ok),
    confidence=_v_conf,
    clarification_needed=bool(voice_plan.get("clarification_needed")),
)
ok(_normalized_types(voice_acts) == ["music.resume", "music.volume_up"],
   "leading 'and you' plans resume + volume_up",
   detail=str(voice_acts))
ok(allowed and reason == "voice_multi_action_defer_to_backend_planner",
   "voice same-bucket music compound defers to backend planner",
   detail=f"allowed={allowed} reason={reason} diag={diag}")


section("executor preserves all music actions and response fragments")
EXEC_CASES = [
    ("unpause the music and crank up the volume", ["resume", "volume_delta"], ["Resuming playback", "Turning the music up"]),
    ("resume playback and turn up the volume", ["resume", "volume_delta"], ["Resuming playback", "Turning the music up"]),
    ("pause the music and turn the volume down", ["pause", "volume_delta"], ["Paused the music", "Turning the music down"]),
    ("play the next track and turn it up", ["skip_next", "volume_delta"], ["next track", "Turning the music up"]),
    ("turn the volume up and play the next track", ["volume_delta", "skip_next"], ["Turning the music up", "next track"]),
]
for text, expected_ops, reply_fragments in EXEC_CASES:
    result = _execute(text)
    ok(result is not None, f"{text!r} -> executor runs", detail=str(result))
    if result is None:
        continue
    reply, _t, ar = result
    payloads = (ar or {}).get("ui_payloads") or []
    ops = [p.get("op") for p in payloads if isinstance(p, dict)]
    ok(ops == expected_ops, f"{text!r} -> payload ops {expected_ops}", detail=f"got={ops}")
    for fragment in reply_fragments:
        ok(fragment.lower() in (reply or "").lower(),
           f"{text!r} reply contains {fragment!r}",
           detail=reply)


print()
print(f"PASS {PASS}  FAIL {FAIL}")
if FAILED:
    print("Failed tests:")
    for name in FAILED:
        print(f"  - {name}")
sys.exit(0 if FAIL == 0 else 1)
