"""Smoke for voice /infer planner takeover generalization (2026-06-13, item 1).

Background: voice /infer used to allow backend planner takeover only for a
fragile bucket-specific allowlist (cross-bucket compounds, plus same-bucket
music or info). Valid same-bucket compounds (checklist+checklist, panel+panel,
timer+timer) were blocked and fell to the legacy greedy single-action router,
which executed only the first action.

Item 1 generalizes the gate: voice /infer now mirrors /text and allows
takeover for ANY plan that is multi-action, validates clean, clears the
confidence floor (0.6), and needs no clarification. All other safety gates
(should_trigger_planner, confidence threshold, validation.ok, clarification,
fastpath exclusions) are unchanged. Partial-validity behavior is intentionally
NOT changed: an invalid mixed plan (e.g. timer with no duration) still blocks
takeover (validate_plan.ok == False).

This suite asserts BOTH layers:
  * the voice takeover decision (_voice_planner_takeover_decision), and
  * the structured executor dispatching every planned action (same code path
    voice /infer reaches once takeover is allowed).

Run:  py -3 tests/smoke/__voice_planner_takeover_smoke.py
"""
from __future__ import annotations

import contextlib
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
    "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
    "transcribe_long", "load_model", "warmup", "speak_to_file",
    "split_sentences_for_tts", "pop_first_complete_segment",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload",
)
for _modname in ("TTS", "STT", "ASR"):
    if _modname not in sys.modules:
        _stub = types.ModuleType(_modname)
        for _name in _AUDIO_STUB_NAMES:
            setattr(_stub, _name, lambda *a, **kw: b"")
        sys.modules[_modname] = _stub

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


CTX = {
    "mode": "work",
    "music": {"skip_next_available": True, "skip_prev_available": True},
    "checklist": {
        "items": [
            {"id": "a", "text": "buy milk", "done": False},
            {"id": "b", "text": "walk dog", "done": False},
            {"id": "c", "text": "pay bills", "done": False},
        ]
    },
}


def _voice_decision(text: str):
    """Reproduce the voice /infer override decision for ``text``."""
    plan = P.plan_user_actions(text, vera=None)
    acts = [a for a in (plan.get("actions") or []) if a.get("type")]
    ok_v, errs_v, _cq = P.validate_plan(plan)
    conf = (
        sum(float(a.get("confidence") or 0.0) for a in acts) / max(1, len(acts))
    ) if acts else 0.0
    allowed, reason, diag = app._voice_planner_takeover_decision(
        is_multi_action=bool(plan.get("is_multi_action")),
        validate_ok=bool(ok_v),
        confidence=conf,
        clarification_needed=bool(plan.get("clarification_needed")),
    )
    return plan, acts, allowed, reason, diag, ok_v, errs_v


def _dispatched_types(text: str):
    """What the structured executor (the path voice reaches once takeover is
    allowed) actually dispatches. Silence internal diagnostics."""
    f = io.StringIO()
    with contextlib.redirect_stdout(f):
        out = app.try_execute_planned_actions_for_text(
            text=text, session_id="__voice_takeover_smoke", history=[],
            client_context_snapshot=CTX,
        )
    if out is None:
        return None, None
    reply, _t, ar = out
    return reply, (ar or {}).get("planner_actions")


# ---------------------------------------------------------------------------
# Cases that SHOULD now be allowed on voice and dispatch every action.
# ---------------------------------------------------------------------------
section("voice takeover ALLOWED + full dispatch")
ALLOWED_CASES = [
    # name, text, expected planner families (in order)
    ("checklist + checklist",
     "remove the first item and mark the second complete",
     ["checklist.remove", "checklist.complete"]),
    ("panel + panel",
     "open a new panel and switch to panel 2",
     ["panel.open", "panel.navigate"]),
    ("timer + timer",
     "start a 10 minute timer and then start a 5 minute timer",
     ["timer.set", "timer.set"]),
    ("music + music",
     "unpause the music and crank up the volume",
     ["music.resume", "music.volume"]),
    ("cross-bucket timer + music",
     "start a 10 minute timer and play music",
     ["timer.set", "music.play"]),
]
for name, text, expected_types in ALLOWED_CASES:
    plan, acts, allowed, reason, diag, okv, errs = _voice_decision(text)
    got_types = [a.get("type") for a in acts]
    ok(allowed, f"{name}: voice takeover ALLOWED", detail=f"reason={reason} diag={diag} errs={errs}")
    ok(reason == "voice_multi_action_defer_to_backend_planner",
       f"{name}: reason is generalized validity rule", detail=f"reason={reason}")
    ok(got_types == expected_types, f"{name}: planner types {expected_types}", detail=f"got={got_types}")
    reply, dispatched = _dispatched_types(text)
    ok(dispatched == expected_types,
       f"{name}: executor dispatched all actions {expected_types}",
       detail=f"dispatched={dispatched} reply={reply!r}")


# ---------------------------------------------------------------------------
# Invalid mixed plan: behavior intentionally UNCHANGED (item 2 not done yet).
# ---------------------------------------------------------------------------
section("invalid mixed plan still blocked (no partial-execution change)")
plan, acts, allowed, reason, diag, okv, errs = _voice_decision(
    "mark the first item complete and start a timer"
)
ok(okv is False, "validate_plan.ok == False for timer-missing-duration", detail=f"errs={errs}")
ok(allowed is False and reason == "validation_failed",
   "voice takeover BLOCKED on invalid plan (unchanged behavior)",
   detail=f"allowed={allowed} reason={reason}")
reply, dispatched = _dispatched_types("mark the first item complete and start a timer")
ok(dispatched is None,
   "executor returns None (legacy fallthrough) — no partial execution",
   detail=f"dispatched={dispatched}")


# ---------------------------------------------------------------------------
# Single-action voice stays on the legacy path (not multi-action).
# ---------------------------------------------------------------------------
section("single action is NOT taken over")
for text in ("crank up the volume", "pause the music"):
    plan, acts, allowed, reason, diag, okv, errs = _voice_decision(text)
    ok(allowed is False and reason == "not_multi_action",
       f"{text!r}: single action stays on legacy path",
       detail=f"allowed={allowed} reason={reason}")


# ---------------------------------------------------------------------------
# /infer (voice) and /text agreement for valid multi-action plans.
# /text always offers the plan to the same executor; voice now does too.
# ---------------------------------------------------------------------------
section("/infer voice and /text agree for valid multi-action plans")
for name, text, expected_types in ALLOWED_CASES:
    _p, _a, allowed, _r, _d, _okv, _errs = _voice_decision(text)
    _reply, dispatched = _dispatched_types(text)  # this IS the /text path
    ok(allowed and dispatched == expected_types,
       f"{name}: voice allowed AND text dispatch match",
       detail=f"allowed={allowed} dispatched={dispatched}")


print()
print(f"PASS {PASS}  FAIL {FAIL}")
if FAILED:
    print("Failed tests:")
    for n in FAILED:
        print(f"  - {n}")
sys.exit(0 if FAIL == 0 else 1)
