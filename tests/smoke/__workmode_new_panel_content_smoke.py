"""Smoke tests for Work Mode "new panel + content task" routing.

Run: py -3 tests/smoke/__workmode_new_panel_content_smoke.py
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
            "panel_count": 1,
            "max_panels": 8,
            "panels": [{"index": 0, "label": "Panel 1"}],
        },
    }


def _plan(text: str) -> dict:
    return P.plan_user_actions(text, vera=None)


def _actions(plan: dict) -> list[dict]:
    return list(plan.get("actions") or [])


def _types(plan: dict) -> list[str]:
    return [a.get("type") or "" for a in _actions(plan)]


def _reasoning_text(plan: dict) -> str:
    for action in _actions(plan):
        if action.get("type") == "reasoning.request":
            return str((action.get("payload") or {}).get("text") or "")
    return ""


def _payload_ops_for(text: str) -> tuple[list[str], list[str]]:
    plan = _plan(text)
    _reply, _elapsed, result = app.execute_planned_actions(
        plan=plan,
        session_id="__smoke_workmode_new_panel",
        history=[],
        client_context_snapshot=_snapshot(),
    )
    payloads = [p for p in (result or {}).get("ui_payloads") or [] if isinstance(p, dict)]
    return [str(p.get("op") or "") for p in payloads], [str(p.get("prompt") or "") for p in payloads]


def _payloads_for(text: str) -> list[dict]:
    plan = _plan(text)
    _reply, _elapsed, result = app.execute_planned_actions(
        plan=plan,
        session_id="__smoke_workmode_new_panel_payloads",
        history=[],
        client_context_snapshot=_snapshot(),
    )
    return [p for p in (result or {}).get("ui_payloads") or [] if isinstance(p, dict)]


def _result_for(text: str) -> tuple[str, dict]:
    plan = _plan(text)
    reply, _elapsed, result = app.execute_planned_actions(
        plan=plan,
        session_id="__smoke_workmode_new_panel_reply",
        history=[],
        client_context_snapshot=_snapshot(),
    )
    return str(reply or ""), result or {}


def _has_duplicate_ack(reply: str) -> bool:
    low = str(reply or "").lower()
    return "opening a new reasoning" in low and "opening a reasoning panel" in low


def assert_content_case(text: str, expected_task: str, name: str) -> None:
    plan = _plan(text)
    ok(plan.get("is_multi_action") is True, f"{name}: planner uses multi-action")
    ok(_types(plan) == ["panel.open", "reasoning.request"], f"{name}: panel.open then reasoning.request", detail=str(_types(plan)))
    ok(_reasoning_text(plan) == expected_task, f"{name}: cleaned content task", detail=_reasoning_text(plan))
    ops, prompts = _payload_ops_for(text)
    ok(ops[:2] == ["open_new", "open_and_stream"], f"{name}: ordered panel + stream payloads", detail=str(ops))
    ok(expected_task in prompts, f"{name}: stream prompt carries task", detail=str(prompts))
    payloads = _payloads_for(text)
    open_payloads = [p for p in payloads if p.get("op") == "open_new"]
    stream_payloads = [p for p in payloads if p.get("op") == "open_and_stream"]
    ok(len(open_payloads) == 1, f"{name}: exactly one open_new payload", detail=str(payloads))
    ok(len(stream_payloads) == 1, f"{name}: exactly one open_and_stream payload", detail=str(payloads))
    open_req = str((open_payloads[0] if open_payloads else {}).get("panel_open_request_id") or "")
    stream_req = str((stream_payloads[0] if stream_payloads else {}).get("new_panel_request_id") or "")
    ok(bool(open_req), f"{name}: open payload has request id")
    ok(open_req == stream_req, f"{name}: stream is bound to same request id", detail=f"open={open_req} stream={stream_req}")
    ok((stream_payloads[0] if stream_payloads else {}).get("target_panel") == "new", f"{name}: stream targets newly opened panel")
    ok((stream_payloads[0] if stream_payloads else {}).get("target_panel_index_1based") is None, f"{name}: no synthetic future numeric target")
    reply, result = _result_for(text)
    ok(not _has_duplicate_ack(reply), f"{name}: no duplicate Work Mode acknowledgement", detail=reply)
    ok(reply.count("Opening a new reasoning panel.") <= 1, f"{name}: one new-panel acknowledgement max", detail=reply)
    ok(result.get("spoken_reply") == reply, f"{name}: result spoken_reply matches composed reply")


def main() -> int:
    assert_content_case(
        "can you explain the vietnam war in a new panel?",
        "explain the vietnam war",
        "explain Vietnam War in new panel",
    )
    repeat_a = _payloads_for("explain the vietnam war in a new panel")
    repeat_b = _payloads_for("explain the vietnam war in a new panel")
    repeat_a_opens = [p for p in repeat_a if p.get("op") == "open_new"]
    repeat_b_opens = [p for p in repeat_b if p.get("op") == "open_new"]
    repeat_a_req = str((repeat_a_opens[0] if repeat_a_opens else {}).get("panel_open_request_id") or "")
    repeat_b_req = str((repeat_b_opens[0] if repeat_b_opens else {}).get("panel_open_request_id") or "")
    ok(len(repeat_a_opens) == 1 and len(repeat_b_opens) == 1, "repeat turns: exactly one open per plan")
    ok(bool(repeat_a_req and repeat_b_req and repeat_a_req != repeat_b_req), "repeat turns: distinct panel-open request ids")

    panel_only = _plan("open a new panel")
    ok(panel_only.get("is_multi_action") is False, "open-only stays single-action")
    ok(_types(panel_only) == ["panel.open"], "open-only creates only panel.open", detail=str(_types(panel_only)))
    panel_only_reply, _panel_only_result = _result_for("open a new panel")
    ok(panel_only_reply == "Opening a new reasoning panel.", "open-only has exactly one acknowledgement", detail=panel_only_reply)

    assert_content_case(
        "create a new panel and summarize World War II",
        "summarize World War II",
        "create panel and summarize",
    )
    assert_content_case(
        "in a new panel, compare BFS and DFS",
        "compare BFS and DFS",
        "prefix new panel compare",
    )
    assert_content_case(
        "Open a reasoning panel and write a one-sentence status update for my test project.",
        "write a one-sentence status update for my test project",
        "open reasoning panel and write status update",
    )
    assert_content_case(
        "Open a reasoning panel and make a one-sentence status update for my test project.",
        "make a one-sentence status update for my test project",
        "open reasoning panel and make status update",
    )

    print(f"\n{PASS} passed, {FAIL} failed")
    if FAIL:
        print("Failures: " + ", ".join(FAILED))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
