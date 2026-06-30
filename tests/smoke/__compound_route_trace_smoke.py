"""Smoke test for the ``[compound_route_trace]`` / hard-warning helpers in
``app.py`` (2026-05-29 spec PART 2).

We extract ``_INFO_INTENT_DETECTORS``, ``_detect_info_intent_families``
and ``_emit_compound_route_trace`` from app.py *by source slicing* so we
don't trigger the heavy model imports that running ``import app`` would.
This mirrors the source-slice pattern used by other lightweight smoke tests.

What the smoke asserts:
  1. _detect_info_intent_families correctly identifies info intents in a
     wide range of transcripts (time / weather / news / finance / sports
     / product / location / search).
  2. _emit_compound_route_trace ALWAYS prints exactly one
     [compound_route_trace] line per call, including when there is no
     action result.
  3. The [planner_should_have_run_but_did_not] warning fires when:
       should_trigger_planner_result=True AND final_action_type!="multi_action"
     AND the gate diag shows 2+ distinct planned families OR a connector
     plus an info intent.
  4. The [info_clause_dropped] warning fires when the transcript matches
     an info-intent pattern but planner_actions has no info.* / voice.answer
     family and the gate diag has none either.
  5. None of these warnings fire on benign single-action utterances.

Run with:
    py -3 tests/smoke/__compound_route_trace_smoke.py
"""

from __future__ import annotations

import io
import json
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_SRC = (ROOT / "app.py").read_text(encoding="utf-8")

# ---------------------------------------------------------------------------
# Pull the helper block out of app.py source. We slice from the start of
# the ``# 2026-05-29 spec PART 2 — info-intent detector`` banner through
# the next ``def log_req_start`` definition.
# ---------------------------------------------------------------------------
START_MARK = (
    "# 2026-05-29 spec PART 2 — info-intent detector for "
    "``[info_clause_dropped]``."
)
END_MARK = "def log_req_start("

start_idx = APP_SRC.find(START_MARK)
end_idx = APP_SRC.find(END_MARK)
if start_idx < 0 or end_idx < 0 or end_idx <= start_idx:
    print(
        "[FAIL] Could not locate [compound_route_trace] helper block in app.py.\n"
        f"       start_idx={start_idx} end_idx={end_idx}"
    )
    sys.exit(1)

helper_src = APP_SRC[start_idx:end_idx]

# Provide the minimal globals the slice references.
exec_globals: dict = {
    "__name__": "__compound_route_trace_smoke__",
    "re": re,
    "json": json,
}
exec(helper_src, exec_globals)

_INFO_INTENT_DETECTORS = exec_globals["_INFO_INTENT_DETECTORS"]
_detect_info_intent_families = exec_globals["_detect_info_intent_families"]
_emit_compound_route_trace = exec_globals["_emit_compound_route_trace"]


# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(condition: bool, name: str, *, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        suffix = f"\n         {detail}" if detail else ""
        print(f"  {RED}FAIL{RESET}  {name}{suffix}")


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


def capture(callable_, **kwargs) -> str:
    buf = io.StringIO()
    with redirect_stdout(buf):
        callable_(**kwargs)
    return buf.getvalue()


def find_lines(output: str, tag: str) -> list[dict]:
    """Return parsed JSON dicts for every line starting with ``[tag] ``."""
    prefix = f"[{tag}] "
    rows: list[dict] = []
    for raw in output.splitlines():
        if not raw.startswith(prefix):
            continue
        try:
            rows.append(json.loads(raw[len(prefix):]))
        except Exception:
            continue
    return rows


# ---------------------------------------------------------------------------
# 1. Info-intent detector coverage
# ---------------------------------------------------------------------------
section("Info-intent detector — family coverage")

cases = [
    ("what time is it in Tokyo", "info.time"),
    ("tell me the weather in Irvine", "info.weather"),
    ("what's VGT trading at", "info.finance"),
    ("latest news on the election", "info.news"),
    ("did the Lakers win", "info.sports"),
    ("best wireless earbuds", "info.product"),
    ("coffee shops near me", "info.location"),
    ("did the merger announce yesterday", "info.search"),
]
for transcript, expected in cases:
    hits = _detect_info_intent_families(transcript)
    ok(expected in hits,
       f"detector picks up {expected!r} for {transcript!r}",
       detail=f"got={hits}")

# Negative case: benign single-action utterance has no info intent.
ok(_detect_info_intent_families("play lo-fi") == [],
   "no info intent for 'play lo-fi'",
   detail=str(_detect_info_intent_families("play lo-fi")))

ok(_detect_info_intent_families("") == [],
   "empty transcript yields []")


# ---------------------------------------------------------------------------
# 2. [compound_route_trace] always prints one line
# ---------------------------------------------------------------------------
section("[compound_route_trace] — single line per call")

out = capture(
    _emit_compound_route_trace,
    request_id="req_test01",
    transcript="play lo-fi",
    endpoint="/infer",
    input_source="text",
    typed=True,
    use_browser_asr=False,
    planner_execution_allowed=True,
    should_trigger_planner_result=False,
    planner_trigger_reason="single_action_or_no_connector",
    planner_gate_called=False,
    planner_executed=False,
    gate_diag=None,
    action_result=None,
    legacy_router_called=True,
    legacy_router_selected="",
    final_action_type="music",
    final_reply="Playing the built-in lo-fi mix.",
    path="non_stream",
)
traces = find_lines(out, "compound_route_trace")
ok(len(traces) == 1,
   "single benign call emits exactly one [compound_route_trace] line",
   detail=f"got {len(traces)} lines")
if traces:
    t = traces[0]
    ok(t["request_id"] == "req_test01", "trace carries request_id")
    ok(t["transcript"] == "play lo-fi", "trace carries transcript")
    ok(t["final_action_type"] == "music", "trace carries final_action_type")
    ok(t["planner_executed"] is False, "trace carries planner_executed=false")
    ok(t["info_intent_families_detected"] == [],
       "trace shows empty info_intent_families_detected for 'play lo-fi'")
    ok(t["info_clause_dropped"] is False,
       "trace shows info_clause_dropped=false for 'play lo-fi'")
    # Should NOT emit the secondary warnings on a benign single-action call.
    psr = find_lines(out, "planner_should_have_run_but_did_not")
    icd = find_lines(out, "info_clause_dropped")
    ok(psr == [],
       "no [planner_should_have_run_but_did_not] for benign single-action call",
       detail=str(psr))
    ok(icd == [],
       "no [info_clause_dropped] for benign single-action call",
       detail=str(icd))


# ---------------------------------------------------------------------------
# 3. [planner_should_have_run_but_did_not] — fires on bypassed compounds
# ---------------------------------------------------------------------------
section("[planner_should_have_run_but_did_not] — compound bypass")

bypass_out = capture(
    _emit_compound_route_trace,
    request_id="req_bypass1",
    transcript="play lo-fi and turn down the volume",
    endpoint="/infer",
    input_source="text",
    typed=True,
    use_browser_asr=False,
    planner_execution_allowed=True,
    should_trigger_planner_result=True,
    planner_trigger_reason="connector_with_action_verb_rhs",
    planner_gate_called=True,
    planner_executed=False,
    gate_diag={
        "validation_ok": True,
        "validation_errors": [],
        "planner_json": {
            "actions": [
                {"type": "music.play", "span": "play lo-fi", "payload": {"query": "lo-fi"}},
                {"type": "music.volume", "span": "turn down the volume", "payload": {"direction": "down"}},
            ]
        },
        "planner_returned_none_reason": "",
    },
    action_result=None,
    legacy_router_called=True,
    legacy_router_selected="music.play",
    final_action_type="music",
    final_reply="Playing lo-fi.",
    path="non_stream",
)
psr = find_lines(bypass_out, "planner_should_have_run_but_did_not")
ok(len(psr) == 1,
   "compound bypass fires [planner_should_have_run_but_did_not] once",
   detail=f"got {len(psr)}: {psr}")
if psr:
    w = psr[0]
    ok(w["expected"] == "multi_action", "warning expected=multi_action")
    ok(w["final_action_type"] == "music",
       "warning carries actual final_action_type")
    ok("music" in w["distinct_planned_families"],
       "warning carries distinct_planned_families with 'music'",
       detail=str(w["distinct_planned_families"]))


# Single-family heuristic — also fires when info intent + app-action
# connector even if accepted_anchors has only one family.
bypass2_out = capture(
    _emit_compound_route_trace,
    request_id="req_bypass2",
    transcript="what time is it in Tokyo and pause the music",
    endpoint="/infer",
    input_source="text",
    typed=True,
    use_browser_asr=False,
    planner_execution_allowed=True,
    should_trigger_planner_result=True,
    planner_trigger_reason="connector_with_action_verb_rhs",
    planner_gate_called=True,
    planner_executed=False,
    gate_diag={
        "validation_ok": True,
        "validation_errors": [],
        "planner_json": {
            # simulate planner only anchored music.pause and dropped the
            # info clause — exactly the regression we want to surface.
            "actions": [
                {"type": "music.pause", "span": "pause the music", "payload": {}},
            ]
        },
        "planner_returned_none_reason": "",
    },
    action_result=None,
    legacy_router_called=True,
    legacy_router_selected="music.pause",
    final_action_type="music",
    final_reply="Paused the music.",
    path="non_stream",
)
psr2 = find_lines(bypass2_out, "planner_should_have_run_but_did_not")
ok(len(psr2) == 1,
   "info+app bypass fires [planner_should_have_run_but_did_not]",
   detail=str(psr2))

# Multi-action realized → must NOT fire the bypass warning.
realized_out = capture(
    _emit_compound_route_trace,
    request_id="req_real1",
    transcript="play lo-fi and turn down the volume",
    endpoint="/infer",
    input_source="text",
    typed=True,
    use_browser_asr=False,
    planner_execution_allowed=True,
    should_trigger_planner_result=True,
    planner_trigger_reason="connector_with_action_verb_rhs",
    planner_gate_called=True,
    planner_executed=True,
    gate_diag={
        "validation_ok": True,
        "validation_errors": [],
        "planner_json": {
            "actions": [
                {"type": "music.play", "span": "play lo-fi", "payload": {"query": "lo-fi"}},
                {"type": "music.volume", "span": "turn down the volume", "payload": {"direction": "down"}},
            ]
        },
        "planner_returned_none_reason": "",
    },
    action_result={
        "action_type": "multi_action",
        "ui_payloads": [
            {"panel_type": "music_control", "op": "play_track"},
            {"panel_type": "music_control", "op": "volume_delta"},
        ],
        "planner_actions": ["music.play", "music.volume"],
    },
    legacy_router_called=False,
    legacy_router_selected="",
    final_action_type="multi_action",
    final_reply="Playing lo-fi. Volume down.",
    path="non_stream",
)
ok(find_lines(realized_out, "planner_should_have_run_but_did_not") == [],
   "no bypass warning when planner did execute multi_action")


# ---------------------------------------------------------------------------
# 4. [info_clause_dropped] — info intent in transcript, no info action
# ---------------------------------------------------------------------------
section("[info_clause_dropped] — info intent missing from plan")

dropped_out = capture(
    _emit_compound_route_trace,
    request_id="req_infodrop1",
    transcript="what time is it in Tokyo and pause the music",
    endpoint="/infer",
    input_source="text",
    typed=True,
    use_browser_asr=False,
    planner_execution_allowed=True,
    should_trigger_planner_result=True,
    planner_trigger_reason="connector_with_action_verb_rhs",
    planner_gate_called=True,
    planner_executed=False,
    gate_diag={
        "planner_json": {
            "actions": [
                {"type": "music.pause", "span": "pause the music", "payload": {}},
            ]
        }
    },
    action_result=None,
    legacy_router_called=True,
    legacy_router_selected="music.pause",
    final_action_type="music",
    final_reply="Paused the music.",
    path="non_stream",
)
icd = find_lines(dropped_out, "info_clause_dropped")
ok(len(icd) == 1,
   "info clause dropped → [info_clause_dropped] fires once",
   detail=str(icd))
if icd:
    w = icd[0]
    ok("info.time" in w["info_intent_families_detected"],
       "warning carries info.time as detected family")

# Info present in plan → must NOT fire.
covered_out = capture(
    _emit_compound_route_trace,
    request_id="req_covered1",
    transcript="what time is it in Tokyo and pause the music",
    endpoint="/infer",
    input_source="text",
    typed=True,
    use_browser_asr=False,
    planner_execution_allowed=True,
    should_trigger_planner_result=True,
    planner_trigger_reason="connector_with_action_verb_rhs",
    planner_gate_called=True,
    planner_executed=True,
    gate_diag={
        "planner_json": {
            "actions": [
                {"type": "info.time", "span": "what time is it in Tokyo",
                 "payload": {"text": "in Tokyo"}},
                {"type": "music.pause", "span": "pause the music", "payload": {}},
            ]
        }
    },
    action_result={
        "action_type": "multi_action",
        "planner_actions": ["info.time", "music.pause"],
        "ui_payloads": [{"panel_type": "music_control", "op": "pause"}],
    },
    legacy_router_called=False,
    legacy_router_selected="",
    final_action_type="multi_action",
    final_reply="It's 1:30 PM in Tokyo. Paused the music.",
    path="non_stream",
)
ok(find_lines(covered_out, "info_clause_dropped") == [],
   "no [info_clause_dropped] when info.* is in planner_actions")

# Voice.answer also counts as coverage.
voice_covered = capture(
    _emit_compound_route_trace,
    request_id="req_voice1",
    transcript="what time is it in Tokyo and pause the music",
    endpoint="/infer",
    input_source="text",
    typed=True,
    use_browser_asr=False,
    planner_execution_allowed=True,
    should_trigger_planner_result=True,
    planner_trigger_reason="connector_with_action_verb_rhs",
    planner_gate_called=True,
    planner_executed=True,
    gate_diag={
        "planner_json": {
            "actions": [
                {"type": "voice.answer", "span": "what time is it in Tokyo", "payload": {}},
                {"type": "music.pause", "span": "pause the music", "payload": {}},
            ]
        }
    },
    action_result={
        "action_type": "multi_action",
        "planner_actions": ["voice.answer", "music.pause"],
        "ui_payloads": [{"panel_type": "music_control", "op": "pause"}],
    },
    legacy_router_called=False,
    legacy_router_selected="",
    final_action_type="multi_action",
    final_reply="...",
    path="non_stream",
)
ok(find_lines(voice_covered, "info_clause_dropped") == [],
   "voice.answer also counts as info coverage")


# ---------------------------------------------------------------------------
# 5. Final tally
# ---------------------------------------------------------------------------
print(f"\n{'=' * 60}")
print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
if FAILED:
    print("\nFailing tests:")
    for n in FAILED:
        print(f"  - {n}")
    sys.exit(1)
print("All [compound_route_trace] smoke tests passed.")
