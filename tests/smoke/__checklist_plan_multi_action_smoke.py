"""Smoke tests for checklist.plan as a first-class multi-action."""

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
from actions.checklist_plan import checklist_plan_intent_matches  # noqa: E402

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


def types_for(text: str) -> list[str]:
    plan = P.plan_user_actions(text)
    return [a.get("type") for a in (plan.get("actions") or [])]


section("Intent detection")
ok(checklist_plan_intent_matches("plan using the checklist"), "plan using the checklist")
ok(checklist_plan_intent_matches("can you plan using the checklist"), "can you plan using the checklist")
ok(not checklist_plan_intent_matches("sync the plan"), "sync the plan is not checklist.plan")

section("Single action — plan using the checklist")
t1 = types_for("plan using the checklist")
ok(t1 == ["checklist.plan"], "plan using the checklist → checklist.plan", detail=str(t1))

section("Compound — plan + lofi")
t2 = types_for("can you plan using the checklist and play the lofi mix?")
ok("checklist.plan" in t2, "compound has checklist.plan", detail=str(t2))
ok("music.play" in t2, "compound has music.play", detail=str(t2))
ok(len(t2) >= 2, "compound is multi-action", detail=str(t2))

section("Compound — plan + timer")
t3 = types_for("plan my checklist and start a 10-minute timer")
ok("checklist.plan" in t3, "plan + timer has checklist.plan", detail=str(t3))
ok("timer.set" in t3, "plan + timer has timer.set", detail=str(t3))

section("Compound — plan + rain + panel")
t4 = types_for("plan using the checklist, play rain sounds, and switch to panel 2")
ok("checklist.plan" in t4, "triple has checklist.plan", detail=str(t4))
ok("music.play" in t4, "triple has music.play", detail=str(t4))
ok("panel.navigate" in t4, "triple has panel.navigate", detail=str(t4))

section("Sync stays separate")
t5 = types_for("sync the plan and play lofi")
ok("checklist.sync" in t5, "sync the plan → checklist.sync", detail=str(t5))
ok("checklist.plan" not in t5, "sync the plan not checklist.plan", detail=str(t5))

section("Payload shape")
plan = P.plan_user_actions("plan using the checklist")
cp = next(a for a in (plan.get("actions") or []) if a.get("type") == "checklist.plan")
ok((cp.get("payload") or {}).get("source") == "voice", "payload source voice")
ok((cp.get("payload") or {}).get("max_main_items") == 5, "payload max_main_items 5")

section("Backend dispatch — limit and ui_payload")
import types  # noqa: E402

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
import app  # noqa: E402

def _dispatch_plan(ctx: dict):
    action = {
        "type": "checklist.plan",
        "span": "plan using the checklist",
        "payload": {"source": "voice", "max_main_items": 5, "raw": "plan using the checklist"},
    }
    return app._dispatch_planned_action_directly(
        action, session_id="test_sess", client_context_snapshot=ctx
    )

over = _dispatch_plan({"mode": "work", "checklist": {"main_count": 6, "subitem_count": 1}})
ok(over is not None, "dispatch returns for 6 mains")
if over:
    _reply, _t, ar = over
    ok("5 main" in (_reply or "").lower(), "limit message spoken", detail=_reply)
    ok(ar.get("ui_payload") is None, "no ui_payload when over limit")

ok_ctx = _dispatch_plan({"mode": "work", "checklist": {"main_count": 2, "subitem_count": 1}})
if ok_ctx:
    _reply2, _t2, ar2 = ok_ctx
    up = ar2.get("ui_payload") or {}
    ok(up.get("panel_type") == "checklist_plan" and up.get("op") == "run", "valid ui_payload", detail=str(up))

print()
print("=" * 60)
if FAIL == 0:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    print(f"{GREEN}All checklist.plan multi-action smoke tests passed.{RESET}")
    sys.exit(0)
else:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
