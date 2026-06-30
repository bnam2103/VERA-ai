"""Smoke tests for Work Mode explicit-panel-destination routing precedence.

Priority rule under test: when the user gives an explicit panel destination
("explain tennis in panel 1", "... in a new panel"), the content task must be
routed into that panel as a reasoning.request (carrying
``explicit_panel_destination=True``) even when the bare task would otherwise
qualify as a simple Voice-UI answer. Plain "explain tennis" (no destination)
must stay a single-action turn that the Voice-UI path can answer.

Run: py -3 tests/smoke/__workmode_explicit_panel_destination_smoke.py
"""

from __future__ import annotations

import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


def _install_runtime_stubs() -> None:
    for modname in ("TTS", "STT", "ASR"):
        if modname in sys.modules:
            continue
        mod = types.ModuleType(modname)
        for name in (
            "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
            "transcribe_long", "load_model", "warmup", "speak_to_file",
            "split_sentences_for_tts", "pop_first_complete_segment", "stream_tts_chunks",
            "tts_chunks", "warmup_tts", "warmup_asr", "init_tts", "init_asr", "preload",
        ):
            setattr(mod, name, lambda *args, **kwargs: b"")
        sys.modules[modname] = mod


_install_runtime_stubs()

from actions import multi_action_planner as P  # noqa: E402
import app  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


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


def _snapshot() -> dict:
    return {
        "mode": "work",
        "app": "vera",
        "reasoning": {
            "panel_count": 2,
            "max_panels": 8,
            "panels": [{"index": 0, "label": "Panel 1"}, {"index": 1, "label": "Panel 2"}],
        },
    }


def _plan(text: str) -> dict:
    return P.plan_user_actions(text, vera=None)


def _actions(plan: dict) -> list[dict]:
    return list(plan.get("actions") or [])


def _types(plan: dict) -> list[str]:
    return [a.get("type") or "" for a in _actions(plan)]


def _reasoning_payload(plan: dict) -> dict:
    for action in _actions(plan):
        if action.get("type") == "reasoning.request":
            return dict(action.get("payload") or {})
    return {}


def _stream_payload_for(text: str) -> dict:
    plan = _plan(text)
    _reply, _elapsed, result = app.execute_planned_actions(
        plan=plan,
        session_id="__smoke_explicit_panel_dest",
        history=[],
        client_context_snapshot=_snapshot(),
    )
    for p in (result or {}).get("ui_payloads") or []:
        if isinstance(p, dict) and p.get("op") == "open_and_stream":
            return p
    return {}


def assert_numbered(text: str, idx: int, task: str, name: str) -> None:
    plan = _plan(text)
    ok(plan.get("is_multi_action") is True, f"{name}: multi-action plan")
    ok("reasoning.request" in _types(plan), f"{name}: emits reasoning.request (not chat)", detail=str(_types(plan)))
    rp = _reasoning_payload(plan)
    ok(rp.get("explicit_panel_destination") is True, f"{name}: explicit_panel_destination=True", detail=str(rp))
    ok(rp.get("panel_target") == idx, f"{name}: panel_target={idx}", detail=str(rp.get("panel_target")))
    ok((rp.get("target") or {}).get("index") == idx, f"{name}: target index={idx}", detail=str(rp.get("target")))
    ok(rp.get("text") == task, f"{name}: cleaned task='{task}'", detail=str(rp.get("text")))
    ok(rp.get("content_task") == task, f"{name}: content_task='{task}'", detail=str(rp.get("content_task")))
    sp = _stream_payload_for(text)
    ok(sp.get("explicit_panel_destination") is True, f"{name}: stream payload explicit_panel_destination=True", detail=str(sp))
    ok(sp.get("target_panel_index_1based") == idx, f"{name}: stream target_panel_index_1based={idx}", detail=str(sp.get("target_panel_index_1based")))
    ok(sp.get("prompt") == task, f"{name}: stream prompt='{task}'", detail=str(sp.get("prompt")))


def assert_new_panel(text: str, task: str, name: str) -> None:
    plan = _plan(text)
    ok(_types(plan) == ["panel.open", "reasoning.request"], f"{name}: panel.open then reasoning.request", detail=str(_types(plan)))
    rp = _reasoning_payload(plan)
    ok(rp.get("explicit_panel_destination") is True, f"{name}: explicit_panel_destination=True", detail=str(rp))
    ok(rp.get("panel_target") == "new", f"{name}: panel_target='new'", detail=str(rp.get("panel_target")))
    ok(rp.get("text") == task, f"{name}: cleaned task='{task}'", detail=str(rp.get("text")))
    sp = _stream_payload_for(text)
    ok(sp.get("explicit_panel_destination") is True, f"{name}: stream payload explicit_panel_destination=True", detail=str(sp))
    ok(sp.get("target_panel") == "new", f"{name}: stream targets new panel", detail=str(sp.get("target_panel")))
    ok(sp.get("prompt") == task, f"{name}: stream prompt='{task}'", detail=str(sp.get("prompt")))


def main() -> int:
    # Test 1 — no destination: simple explanation stays single-action (Voice UI allowed).
    plain = _plan("explain tennis")
    ok(plain.get("is_multi_action") is False, "Test1 'explain tennis': single-action (Voice UI allowed)", detail=str(_types(plain)))
    ok(_reasoning_payload(plain).get("explicit_panel_destination") in (None, False),
       "Test1 'explain tennis': no explicit_panel_destination", detail=str(_reasoning_payload(plain)))

    # Test 2 — explicit numbered panel.
    assert_numbered("explain tennis in panel 1", 1, "explain tennis", "Test2 'explain tennis in panel 1'")
    # Test 3 — same, with polite wrapper + question mark.
    assert_numbered("can you explain tennis in panel 1?", 1, "explain tennis", "Test3 'can you explain tennis in panel 1?'")
    # Test 6 — compare task in panel 2.
    assert_numbered("compare BFS and DFS in panel 2", 2, "compare BFS and DFS", "Test6 'compare BFS and DFS in panel 2'")

    # Test 5 — new panel.
    assert_new_panel("explain tennis in a new panel", "explain tennis", "Test5 'explain tennis in a new panel'")

    # Test 4 — "in the current panel" is a single-action turn handled by the
    # frontend reasoning gate (isExplicitReasoningPanelReference force-route),
    # so the backend planner must NOT split it into a chat answer. We assert
    # the planner does not wrongly turn it into a multi-action chat split.
    cur = _plan("explain tennis in the current panel")
    ok(cur.get("is_multi_action") is False,
       "Test4 'explain tennis in the current panel': single-action (frontend gate routes to active panel)",
       detail=str(_types(cur)))

    print(f"\n{PASS} passed, {FAIL} failed")
    if FAIL:
        print("Failures: " + ", ".join(FAILED))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
