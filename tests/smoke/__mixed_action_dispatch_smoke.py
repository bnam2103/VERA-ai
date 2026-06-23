"""Smoke for the mixed panel + reasoning + music dispatch path.

Covers the 2026-05-29 structural fix:

  PART 1 — _dispatch_planned_action_directly("reasoning.request") emits
           a work_mode_reasoning open_and_stream ui_payload carrying ONLY
           the cleaned reasoning span and the resolved (1- + 0-based)
           target panel index.
  PART 6 — _compute_work_mode_voice_quote picks the cleaned span override
           on multi_action turns and falls back to the raw transcript
           otherwise.

This file does NOT import ``app.py`` because that triggers a large
FastAPI bootstrap. We monkey-patch the minimal pieces by re-implementing
``_dispatch_planned_action_directly`` only when impossible to import —
otherwise we exercise the real function with stub deps.

Run:  py -3 tests/smoke/__mixed_action_dispatch_smoke.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


# --------------------------------------------------------------------------
# Tiny ANSI test harness
# --------------------------------------------------------------------------
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


# --------------------------------------------------------------------------
# Import only the two helpers we want to test from app.py, bypassing the
# full module-level FastAPI bootstrap. We do this by reading the source
# and exec'ing the helper functions in a sandbox namespace with only the
# names they reference.
# --------------------------------------------------------------------------
APP_PY_PATH = os.path.join(ROOT, "app.py")


def _extract_function_source(src: str, start_marker: str, end_marker: str) -> str:
    """Slice ``src`` from the first ``start_marker`` line through (but
    NOT including) the first line that exactly equals ``end_marker``.

    Raises if either marker is missing — keeps the test honest about
    upstream renames.
    """
    if start_marker not in src:
        raise RuntimeError(f"start_marker not found: {start_marker!r}")
    start = src.index(start_marker)
    after_start = src[start:]
    if end_marker not in after_start:
        raise RuntimeError(f"end_marker not found: {end_marker!r}")
    end_offset = after_start.index(end_marker)
    return after_start[:end_offset]


def _load_helpers_from_app_py() -> tuple[object, object]:
    """Return (_dispatch_planned_action_directly, _compute_work_mode_voice_quote).

    Both helpers are isolated by source extraction so we don't pay the
    full app.py import cost (which spins up FastAPI, MediaPipe, …).
    """
    with open(APP_PY_PATH, "r", encoding="utf-8") as f:
        src = f.read()

    # Helper 1: _compute_work_mode_voice_quote
    vq_src = _extract_function_source(
        src,
        "def _compute_work_mode_voice_quote(transcript: str, action_result) -> tuple[str, str]:",
        "async def iter_infer_tts_ndjson_stream(",
    )
    # Helper 2: _dispatch_planned_action_directly
    disp_src = _extract_function_source(
        src,
        "def _dispatch_planned_action_directly(",
        "def execute_planned_actions(",
    )

    # Minimal sandbox: imports the helpers reference.
    import json as _json
    import re as _re
    from time import perf_counter as _perf_counter
    from typing import Any as _Any

    def _fake_handle_checklist_action(*_a, **_kw):
        return {
            "spoken_reply": "Added.",
            "action_type": "checklist",
            "data": {"changed": True},
            "ui_payload": {"panel_type": "checklist_control", "op": "checklist.add_item", "items": ["x"]},
        }

    def _fake_try_work_mode_timer_core(*_a, **_kw):
        return None

    def _fake_clean_location_text(text):
        return str(text or "").strip()

    def _fake_get_recent_news_context(_session_id):
        return None

    def _fake_classify_info_tool(text, **_kw):
        low = str(text or "").lower()
        if "vgt" in low:
            return {"route": "finance_quote_tool", "tool": "finance_quote", "query": str(text)}
        if "lakers" in low:
            return {"route": "general_web_search_tool", "tool": "web_search", "query": str(text)}
        return {"route": "uncertain", "tool": "", "query": str(text)}

    def _fake_build_route_from_info_tool(text, classification, session_id=""):
        route = classification.get("route")
        if route == "finance_quote_tool":
            return {
                "domain": "finance",
                "is_action_request": True,
                "action_name": "finance.quote",
                "slots": {"query": text, "user_text": text},
                "needs_followup": False,
                "missing_slot": None,
            }
        if route == "general_web_search_tool":
            return {
                "domain": "web",
                "is_action_request": True,
                "action_name": "web.search",
                "slots": {"query": text, "user_text": text},
                "needs_followup": False,
                "missing_slot": None,
            }
        return None

    def _fake_execute_structured_action(session_id, text, route, filler_generation=None, client_context_snapshot=None):
        action_name = route.get("action_name")
        slots = route.get("slots") or {}
        if action_name == "time.current":
            loc = slots.get("location") or "local time"
            return {
                "spoken_reply": f"It's 12:30 PM in {loc}.",
                "action_type": "time",
                "data": {"place_name": loc},
                "ui_payload": None,
            }, 0.01
        if action_name == "weather.current":
            loc = slots.get("location") or ""
            return {
                "spoken_reply": f"It's sunny in {loc}.",
                "action_type": "weather",
                "data": {"place_name": loc},
                "ui_payload": None,
            }, 0.01
        if action_name == "finance.quote":
            return {
                "spoken_reply": "VGT is trading at $300.",
                "action_type": "finance",
                "data": {"query": slots.get("query")},
                "ui_payload": None,
            }, 0.01
        if action_name == "web.search":
            return {
                "spoken_reply": "The Lakers won.",
                "action_type": "web_search",
                "data": {"query": slots.get("query")},
                "ui_payload": None,
            }, 0.01
        return None, 0.0

    sandbox: dict = {
        "__name__": "app_sandbox",
        "__builtins__": __builtins__,
        "json": _json,
        "re": _re,
        "perf_counter": _perf_counter,
        "Any": _Any,
        "_handle_checklist_action": _fake_handle_checklist_action,
        "_try_work_mode_timer_core": _fake_try_work_mode_timer_core,
        "clean_location_text": _fake_clean_location_text,
        "get_recent_news_context": _fake_get_recent_news_context,
        "get_recent_sports_context": lambda _session_id: None,
        "classify_info_tool": _fake_classify_info_tool,
        "build_route_from_info_tool": _fake_build_route_from_info_tool,
        "execute_structured_action": _fake_execute_structured_action,
        # 2026-06-01 — Priority-order patch: the planner dispatcher now
        # consults looks_like_supported_app_action(info_span) to defer
        # info.search dispatches for clear music / checklist / timer /
        # panel intents. The smoke's existing cases ("did Lakers happen")
        # are NOT supported app actions, so a `return False` stub is
        # behaviorally faithful.
        "looks_like_supported_app_action": lambda _t: False,
    }
    # The dispatcher references parse_music_play_intent lazily (`from
    # actions.music_intent import parse_music_play_intent`) inside the
    # music.play branch — we don't exercise music.play here, so the
    # import never fires under this smoke. Still, install the module's
    # alias defensively.
    try:
        from actions.music_intent import parse_music_play_intent as _pmpi  # noqa: F401
    except Exception:
        pass

    exec(vq_src, sandbox)
    exec(disp_src, sandbox)
    return (
        sandbox["_dispatch_planned_action_directly"],
        sandbox["_compute_work_mode_voice_quote"],
    )


dispatch, compute_voice_quote = _load_helpers_from_app_py()


# --------------------------------------------------------------------------
# PART 1 — _dispatch_planned_action_directly("reasoning.request")
# --------------------------------------------------------------------------
section("Reasoning.request direct dispatcher — clean span + numeric target")

action = {
    "type": "reasoning.request",
    "span": "explain the Vietnam War",
    "payload": {
        "text": "explain the Vietnam War",
        "target": {"index": 2},
        "raw": "explain the Vietnam War",
    },
}
result = dispatch(action, session_id="s1", client_context_snapshot={})
ok(result is not None, "reasoning.request returns a result (not falling through to process_user_input)")
if result is not None:
    reply, _t, ar = result
    ok(isinstance(ar, dict), "action_result is a dict", detail=type(ar).__name__)
    ok(ar.get("action_type") == "work_mode_reasoning",
       "action_type == 'work_mode_reasoning'",
       detail=str(ar.get("action_type")))
    up = ar.get("ui_payload") or {}
    ok(up.get("panel_type") == "work_mode_reasoning",
       "ui_payload.panel_type == 'work_mode_reasoning'",
       detail=str(up))
    ok(up.get("op") == "open_and_stream",
       "ui_payload.op == 'open_and_stream'",
       detail=str(up.get("op")))
    ok(up.get("prompt") == "explain the Vietnam War",
       "prompt is the clean span only (no transcript leakage)",
       detail=str(up.get("prompt")))
    ok(up.get("target_panel_index_1based") == 2,
       "target_panel_index_1based == 2",
       detail=str(up.get("target_panel_index_1based")))
    ok(up.get("target_panel_index_0based") == 1,
       "target_panel_index_0based == 1 (1-based → 0-based at the boundary)",
       detail=str(up.get("target_panel_index_0based")))
    ok("Panel 2" in (reply or ""),
       "spoken stub mentions 'Panel 2'",
       detail=reply)

section("Reasoning.request — no target → spoken stub falls back")
action_no_target = {
    "type": "reasoning.request",
    "span": "explain the Vietnam War",
    "payload": {"text": "explain the Vietnam War", "raw": "explain the Vietnam War"},
}
result = dispatch(action_no_target, session_id="s1", client_context_snapshot={})
ok(result is not None, "still returns a result without a target")
if result is not None:
    reply, _t, ar = result
    up = (ar or {}).get("ui_payload") or {}
    ok(up.get("target_panel_index_1based") is None and up.get("target_panel_index_0based") is None,
       "both target indices stay None",
       detail=str(up))
    ok("reasoning panel" in (reply or "").lower(),
       "spoken stub says 'reasoning panel' when no target",
       detail=reply)

section("Reasoning.request — contamination warning fires")
# A planner that forgot to clean the prompt — the dispatcher must still
# log the warning but produce a payload (no crash).
action_dirty = {
    "type": "reasoning.request",
    "span": "explain the Vietnam War and play lo-fi",
    "payload": {
        "text": "explain the Vietnam War and play lo-fi",
        "target": {"index": 2},
        "raw": "explain the Vietnam War and play lo-fi",
    },
}
result = dispatch(action_dirty, session_id="s1", client_context_snapshot={})
ok(result is not None, "dirty prompt still returns a result")
if result is not None:
    _r, _t, ar = result
    up = (ar or {}).get("ui_payload") or {}
    markers = (ar.get("data") or {}).get("prompt_contamination_markers") or []
    ok("play_lofi" in markers,
       "prompt_contamination_markers includes 'play_lofi'",
       detail=str(markers))
    ok(up.get("prompt") == "explain the Vietnam War and play lo-fi",
       "dispatcher does NOT silently mutate the dirty prompt",
       detail=str(up.get("prompt")))

section("Info actions — direct dispatcher calls existing structured handlers")
info_cases = [
    (
        {
            "type": "info.time",
            "span": "what time is it in Tokyo",
            "payload": {"text": "what time is it in Tokyo", "query": "Tokyo", "location": "Tokyo"},
        },
        "time",
        "12:30 PM in Tokyo",
    ),
    (
        {
            "type": "info.weather",
            "span": "tell me the weather in Irvine",
            "payload": {"text": "tell me the weather in Irvine", "query": "Irvine", "location": "Irvine"},
        },
        "weather",
        "sunny in Irvine",
    ),
    (
        {
            "type": "info.finance",
            "span": "what's VGT trading at",
            "payload": {"query": "what's VGT trading at", "text": "what's VGT trading at"},
        },
        "finance",
        "VGT is trading",
    ),
    (
        {
            "type": "info.search",
            "span": "did the Lakers win",
            "payload": {"query": "did the Lakers win", "text": "did the Lakers win"},
        },
        "web_search",
        "Lakers won",
    ),
]
for action_info, expected_action_type, expected_reply_substr in info_cases:
    result = dispatch(action_info, session_id="s1", client_context_snapshot={})
    ok(result is not None,
       f"{action_info['type']} returns direct dispatch result")
    if result is not None:
        reply, _t, ar = result
        ok((ar or {}).get("action_type") == expected_action_type,
           f"{action_info['type']} action_type == {expected_action_type}",
           detail=str(ar))
        ok(expected_reply_substr.lower() in (reply or "").lower(),
           f"{action_info['type']} spoken reply includes handler output",
           detail=str(reply))
        ok((ar or {}).get("ui_payload") is None,
           f"{action_info['type']} may return no ui_payload without being dropped",
           detail=str(ar))


# --------------------------------------------------------------------------
# PART 6 — _compute_work_mode_voice_quote
# --------------------------------------------------------------------------
section("Voice quote — multi_action uses cleaned span override")
ar_multi = {
    "action_type": "multi_action",
    "planner_actions": ["panel.navigate", "reasoning.request", "music.play"],
    "voice_quote_override": "go to panel 2, explain the Vietnam War, play the lo-fi mix",
}
quote, src = compute_voice_quote(
    "Can you go to panel 2, explain the Vietnam War and play the lo-fi mix?",
    ar_multi,
)
ok(quote == "go to panel 2, explain the Vietnam War, play the lo-fi mix",
   "voice_quote = cleaned span override",
   detail=quote)
ok(src == "cleaned_span", "quote_source == 'cleaned_span'", detail=src)

section("Voice quote — single-action falls back to raw transcript")
ar_single = {"action_type": "music", "voice_quote_override": ""}
quote, src = compute_voice_quote("play the lo-fi mix", ar_single)
ok(quote == "play the lo-fi mix",
   "voice_quote = raw transcript for single-action",
   detail=quote)
ok(src == "raw_transcript", "quote_source == 'raw_transcript'", detail=src)

section("Voice quote — no action_result keeps raw transcript")
quote, src = compute_voice_quote("explain X", None)
ok(quote == "explain X", "raw transcript when action_result is None", detail=quote)
ok(src == "raw_transcript", "quote_source == 'raw_transcript'", detail=src)


# --------------------------------------------------------------------------
# Final tally
# --------------------------------------------------------------------------
print(f"\n{'=' * 60}")
print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
if FAILED:
    print("\nFailing tests:")
    for n in FAILED:
        print(f"  - {n}")
    sys.exit(1)
sys.exit(0)
