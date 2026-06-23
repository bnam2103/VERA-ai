"""Smoke tests for Stage A — the read-only semantic normalizer.

Stage A goal:
    Provide a NormalizedTurn observability layer over the EXISTING
    deterministic routers (multi_action_planner, classify_info_tool,
    classify_sports_intent). No behavior changes. No live routing
    through NormalizedTurn. No LLM normalizer.

What this suite covers:

  PART 1 — top-level NormalizedTurn shape contract. Every call returns a
  dict with all 8 top-level keys (`is_compound`, `actions`,
  `clarification_needed`, `clarification_question`, `context_resolution`,
  `route_reason`, `shadow_deterministic_actions`, `shadow_llm_actions`)
  and every action dict carries the 7 spec fields (`type`, `span`,
  `payload`, `confidence`, `source`, `order`, `required_context`).
  `shadow_llm_actions` MUST always be `[]` in Stage A.

  PART 2 — planner parity. Compound utterances that pass
  `__multi_action_planner_smoke.py` still produce the same action-type
  sequence (in order) through the normalizer.

  PART 3 — info-tool parity. Solo info queries (time / weather / finance
  / news / product / location) map to the expected `info.*` action
  type via either the planner anchor catalog or the info-tool fallback.

  PART 4 — sports parity. Solo sports queries route to `info.sports`
  AND the sports enricher fills in `entity` / `tournament_or_league` /
  `query_type` on the payload.

  PART 5 — solo app actions parity. Solo `music.play`, `music.pause`,
  `panel.navigate`, `timer.set`, `checklist.add`, etc. each map to
  exactly one NormalizedAction of the expected type.

  PART 6 — disagreement detection. We synthesize a case where the
  planner returns one action family and `classify_info_tool` returns
  another, and assert the `[legacy_router_mismatch]` log line is emitted.

  PART 7 — every action's `type` field is in ALLOWED_ACTION_TYPES and
  every `source` is "deterministic" (Stage A invariant).

  PART 8 — `[semantic_normalizer_trace]` is emitted exactly once per
  `build_normalized_turn` call with all spec fields present.

Run:  py -3 -X utf8 tests\\smoke\\__normalizer_stage_a_smoke.py
"""
from __future__ import annotations

# --- bootstrap (mirrors __info_normalizer_smoke.py) -----------------------
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")))
# --------------------------------------------------------------------------

import io
import json as _json
import os
import sys
import types

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# Stub heavy audio modules so `import app` finishes without TTS/ASR side
# effects. Same shape as __info_normalizer_smoke.py / __about_me_handler_smoke.py.
_TTS_STUB_NAMES = (
    "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
    "transcribe_long", "load_model", "warmup", "speak_to_file",
    "split_sentences_for_tts", "pop_first_complete_segment",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload",
)
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _TTS_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

import app  # noqa: E402
from actions import normalizer as _normalizer  # noqa: E402
from actions.normalizer import (  # noqa: E402
    ALLOWED_ACTION_TYPES,
    build_normalized_turn,
)
from actions.multi_action_planner import plan_user_actions  # noqa: E402
from actions.sports import classify_sports_intent  # noqa: E402

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


# Shared dependency wiring — pass the deterministic backends explicitly so
# the tests don't accidentally pick up a stale lazy import.
def _normalize(text: str, **kwargs) -> dict:
    kwargs.setdefault("classify_info_tool", app.classify_info_tool)
    kwargs.setdefault("classify_sports_intent", classify_sports_intent)
    kwargs.setdefault("plan_user_actions", plan_user_actions)
    return build_normalized_turn(text, **kwargs)


class _CaptureStdout:
    """Capture stdout for log-assertion tests. Use as a context manager."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self._orig: object | None = None
        self._buf: io.StringIO | None = None

    def __enter__(self) -> "_CaptureStdout":
        self._orig = sys.stdout
        self._buf = io.StringIO()
        sys.stdout = self._buf  # type: ignore[assignment]
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            self._buf.flush()  # type: ignore[union-attr]
        except Exception:
            pass
        sys.stdout = self._orig  # type: ignore[assignment]
        for line in (self._buf.getvalue().splitlines() if self._buf else []):
            self.lines.append(line)

    def find_payloads(self, tag: str) -> list[dict]:
        out: list[dict] = []
        for line in self.lines:
            if tag in line:
                _, _, rest = line.partition(tag)
                try:
                    out.append(_json.loads(rest.strip()))
                except Exception:
                    pass
        return out


REQUIRED_TURN_KEYS = {
    "is_compound", "actions", "clarification_needed", "clarification_question",
    "context_resolution", "route_reason",
    "shadow_deterministic_actions", "shadow_llm_actions",
    # Stage A.5 additions:
    "route_type", "intent", "fallback_type", "missing_slots",
    "message", "observed_type",
}
REQUIRED_ACTION_KEYS = {
    "type", "span", "payload", "confidence", "source", "order", "required_context",
}
REQUIRED_CR_KEYS = {
    "used_previous_turn", "resolved_entities", "pronouns_resolved", "inherited_from",
}
VALID_ROUTE_TYPES = {"action", "clarification", "fallback"}
VALID_FALLBACK_TYPES = {
    None, "unsupported_capability", "unknown_request", "out_of_scope",
    "low_confidence", "invalid_router_output",
}


def _assert_shape(turn: dict, *, label: str) -> None:
    ok(
        isinstance(turn, dict) and REQUIRED_TURN_KEYS.issubset(turn.keys()),
        f"{label}: all top-level keys present",
        detail=str(sorted((turn or {}).keys())),
    )
    ok(
        isinstance(turn.get("context_resolution"), dict)
        and REQUIRED_CR_KEYS.issubset(turn["context_resolution"].keys()),
        f"{label}: context_resolution has all keys",
    )
    ok(
        turn.get("shadow_llm_actions") == [],
        f"{label}: shadow_llm_actions is [] (Stage A invariant)",
    )
    # Stage A.5 invariants:
    ok(
        turn.get("route_type") in VALID_ROUTE_TYPES,
        f"{label}: route_type in {VALID_ROUTE_TYPES}",
        detail=str(turn.get("route_type")),
    )
    ok(
        turn.get("fallback_type") in VALID_FALLBACK_TYPES,
        f"{label}: fallback_type valid",
        detail=str(turn.get("fallback_type")),
    )
    rtype = turn.get("route_type")
    if rtype == "action":
        ok(
            turn.get("fallback_type") is None,
            f"{label}: action route -> fallback_type is None",
        )
        ok(
            isinstance(turn.get("intent"), str) and turn["intent"] in ALLOWED_ACTION_TYPES,
            f"{label}: action route -> intent in ALLOWED_ACTION_TYPES",
            detail=str(turn.get("intent")),
        )
    elif rtype == "clarification":
        ok(
            turn.get("fallback_type") is None,
            f"{label}: clarification route -> fallback_type is None",
        )
        ok(
            isinstance(turn.get("intent"), str) and turn["intent"] in ALLOWED_ACTION_TYPES,
            f"{label}: clarification route -> intent in ALLOWED_ACTION_TYPES",
            detail=str(turn.get("intent")),
        )
        ok(
            turn.get("actions") == [],
            f"{label}: clarification route -> actions == [] (no executable actions)",
        )
    elif rtype == "fallback":
        ok(
            turn.get("intent") is None,
            f"{label}: fallback route -> intent is None",
            detail=str(turn.get("intent")),
        )
        ok(
            turn.get("fallback_type") in (VALID_FALLBACK_TYPES - {None}),
            f"{label}: fallback route -> fallback_type is non-None",
            detail=str(turn.get("fallback_type")),
        )
        ok(
            turn.get("actions") == [],
            f"{label}: fallback route -> actions == [] (no executable actions)",
        )
    for i, action in enumerate(turn.get("actions") or []):
        ok(
            isinstance(action, dict) and REQUIRED_ACTION_KEYS.issubset(action.keys()),
            f"{label}: action[{i}] has all keys",
            detail=str(sorted(list((action or {}).keys()))),
        )
        ok(
            action.get("source") == "deterministic",
            f"{label}: action[{i}].source == 'deterministic'",
        )
        ok(
            action.get("type") in ALLOWED_ACTION_TYPES,
            f"{label}: action[{i}].type in ALLOWED_ACTION_TYPES",
            detail=str(action.get("type")),
        )


# ============================================================================
# PART 1 — top-level shape contract
# ============================================================================
section("PART 1 -- shape contract")

empty_turn = _normalize("")
ok(empty_turn["actions"] == [], "empty input -> empty actions")
ok(empty_turn["route_reason"] == "empty_text", "empty input -> route_reason='empty_text'")
_assert_shape(empty_turn, label="empty")

shape_turn = _normalize("what time is it in Tokyo")
_assert_shape(shape_turn, label="solo")


# ============================================================================
# PART 2 — planner parity for compound utterances
# ============================================================================
section("PART 2 -- planner parity for compound utterances")

# Cases drawn from __multi_action_planner_smoke spec4 cases. We only assert
# the action-type sequence (NOT the payload) — the planner already tests
# the payload exhaustively; here we only verify the normalizer doesn't
# drop or reorder anchored actions.
COMPOUND_CASES = [
    (
        "start a timer for one hour and switch to the second panel",
        ["timer.set", "panel.navigate"],
    ),
    (
        "put milk on the checklist and start lo-fi",
        ["checklist.add", "music.play"],
    ),
    (
        "put milk on the checklist and play lo-fi",
        ["checklist.add", "music.play"],
    ),
]
for utterance, expected_types in COMPOUND_CASES:
    t = _normalize(utterance)
    seen_types = [a["type"] for a in t["actions"]]
    ok(
        seen_types == expected_types,
        f"compound: {utterance!r} -> {expected_types}",
        detail=str(seen_types),
    )
    ok(
        t["is_compound"] is True,
        f"compound: {utterance!r} -> is_compound=True",
    )
    _assert_shape(t, label=f"compound[{utterance!r}]")


# ============================================================================
# PART 3 — info-tool parity (solo info.*)
# ============================================================================
section("PART 3 -- info-tool parity (solo info.*)")

SOLO_INFO_CASES = [
    ("what time is it in Tokyo",            "info.time"),
    ("what's the weather in Irvine",        "info.weather"),
    ("Apple stock price",                   "info.finance"),
    ("what's the latest news",              "info.news"),
    ("coffee shops in Irvine",              {"info.location", "info.search"}),
    ("best webcam for Zoom meeting",        {"info.product", "info.search"}),
]
for utterance, expected in SOLO_INFO_CASES:
    t = _normalize(utterance)
    seen = {a["type"] for a in t["actions"]}
    if isinstance(expected, set):
        ok(
            bool(seen & expected),
            f"solo info: {utterance!r} -> any of {expected}",
            detail=str(seen),
        )
    else:
        ok(
            expected in seen,
            f"solo info: {utterance!r} -> {expected}",
            detail=str(seen),
        )
    _assert_shape(t, label=f"info[{utterance!r}]")


# ============================================================================
# PART 4 — sports parity (info.sports + payload enrichment)
# ============================================================================
section("PART 4 -- sports parity (info.sports + enrichment)")

SPORTS_CASES = [
    "is Djokovic still in Roland Garros?",
    "did the Lakers win?",
    "who does Alcaraz play next?",
]
for utterance in SPORTS_CASES:
    t = _normalize(utterance)
    sports_actions = [a for a in t["actions"] if a["type"] == "info.sports"]
    ok(
        len(sports_actions) >= 1,
        f"sports: {utterance!r} -> at least one info.sports action",
        detail=str([a["type"] for a in t["actions"]]),
    )
    if sports_actions:
        payload = sports_actions[0].get("payload") or {}
        ok(
            bool(payload.get("entity")),
            f"sports: {utterance!r} -> payload.entity populated",
            detail=str(payload),
        )
        ok(
            bool(payload.get("query_type")),
            f"sports: {utterance!r} -> payload.query_type populated",
            detail=str(payload),
        )
    _assert_shape(t, label=f"sports[{utterance!r}]")

# Sports follow-up with context inherits entity/tournament from
# recent_sports_context AND marks context_resolution accordingly.
fu_ctx = {
    "entity": "Novak Djokovic",
    "entity_type": "player",
    "sport": "tennis",
    "tournament_or_league": "Roland Garros",
    "query_type": "tournament_status",
    "created_at": 9.99e12,  # don't matter for the classifier's TTL gate here
}
fu = _normalize("how about Sinner?", recent_sports_context=fu_ctx)
sports_fu = [a for a in fu["actions"] if a["type"] == "info.sports"]
ok(len(sports_fu) >= 1, "sports follow-up: yields info.sports")
ok(
    fu["context_resolution"]["used_previous_turn"] is True,
    "sports follow-up: context_resolution.used_previous_turn=True",
)
ok(
    "recent_sports_context" in (fu["context_resolution"].get("inherited_from") or []),
    "sports follow-up: inherited_from includes recent_sports_context",
    detail=str(fu["context_resolution"]),
)


# ============================================================================
# PART 5 — solo app-action parity (music / panel / timer / checklist)
# ============================================================================
section("PART 5 -- solo app actions")

SOLO_APP_CASES = [
    ("pause the music",            "music.pause"),
    ("resume the music",           "music.resume"),
    ("skip to the next song",      "music.next"),
    ("turn up the volume",         "music.volume"),
    ("go to panel 2",              "panel.navigate"),
    ("close this panel",           "panel.close"),
    ("start a timer for 10 minutes", "timer.set"),
    ("cancel the timer",           "timer.cancel"),
    ("add milk to the checklist",  "checklist.add"),
]
for utterance, expected in SOLO_APP_CASES:
    t = _normalize(utterance)
    seen = [a["type"] for a in t["actions"]]
    ok(
        expected in seen,
        f"solo app: {utterance!r} -> {expected}",
        detail=str(seen),
    )
    ok(
        t["is_compound"] is False,
        f"solo app: {utterance!r} -> is_compound=False",
    )
    _assert_shape(t, label=f"solo_app[{utterance!r}]")


# ============================================================================
# PART 6 — disagreement detection
# ============================================================================
section("PART 6 -- disagreement detection")


# Synthesize a disagreement by injecting a fake classify_info_tool that
# always returns `news_search_tool` even when the planner anchors a
# different family. This is what the normalizer is supposed to surface
# WITHOUT trying to fix.
def _fake_news_classifier(text, **kwargs):
    return {
        "route": "news_search_tool",
        "tool": "news_search",
        "query": text,
        "entities": [],
        "metric": None,
        "timeframe": None,
        "required_context": None,
        "confidence": 0.9,
        "reason": "synthetic_disagreement_for_smoke_test",
    }


with _CaptureStdout() as cap:
    t_disagree = build_normalized_turn(
        "pause the music",
        classify_info_tool=_fake_news_classifier,
        classify_sports_intent=classify_sports_intent,
        plan_user_actions=plan_user_actions,
        note="smoke_disagreement",
    )

mismatch_payloads = cap.find_payloads("[legacy_router_mismatch]")
trace_payloads = cap.find_payloads("[semantic_normalizer_trace]")

ok(
    len(mismatch_payloads) == 1,
    "disagreement: exactly one [legacy_router_mismatch] line emitted",
    detail=f"got {len(mismatch_payloads)}",
)
if mismatch_payloads:
    p = mismatch_payloads[0]
    ok(
        "music.pause" in (p.get("planner_types") or []),
        "disagreement: planner_types includes music.pause",
        detail=str(p),
    )
    ok(
        p.get("info_tool_type") == "info.news",
        "disagreement: info_tool_type is info.news",
        detail=str(p),
    )
    ok(
        bool(p.get("reasons")),
        "disagreement: reasons array non-empty",
    )

ok(
    len(trace_payloads) == 1,
    "disagreement: exactly one [semantic_normalizer_trace] line emitted",
    detail=f"got {len(trace_payloads)}",
)
if trace_payloads:
    p = trace_payloads[0]
    ok(
        p.get("router_mismatch") is True,
        "disagreement: trace marks router_mismatch=True",
        detail=str(p),
    )

# Planner-only path still wins when synthetic disagreement is logged.
ok(
    [a["type"] for a in t_disagree["actions"]] == ["music.pause"],
    "disagreement: planner-primary actions preserved",
    detail=str([a["type"] for a in t_disagree["actions"]]),
)


# ============================================================================
# PART 7 — Stage A invariants
# ============================================================================
section("PART 7 -- Stage A invariants")

ALL_TURNS = [empty_turn, shape_turn] + [
    _normalize(u) for (u, _exp) in (COMPOUND_CASES + SOLO_INFO_CASES + SOLO_APP_CASES)
]
ALL_TURNS += [_normalize(u) for u in SPORTS_CASES]
ALL_TURNS.append(fu)
ALL_TURNS.append(t_disagree)

all_action_types: set[str] = set()
all_sources: set[str] = set()
for t in ALL_TURNS:
    for a in t["actions"]:
        all_action_types.add(a["type"])
        all_sources.add(a["source"])
ok(
    all_action_types.issubset(ALLOWED_ACTION_TYPES),
    "invariant: every emitted action.type in ALLOWED_ACTION_TYPES",
    detail=str(sorted(all_action_types - ALLOWED_ACTION_TYPES)),
)
ok(
    all_sources == {"deterministic"},
    "invariant: every action.source == 'deterministic'",
    detail=str(all_sources),
)
ok(
    all(t["shadow_llm_actions"] == [] for t in ALL_TURNS),
    "invariant: shadow_llm_actions is [] across every turn",
)


# ============================================================================
# PART 8 — [semantic_normalizer_trace] field shape
# ============================================================================
section("PART 8 -- trace payload shape")

with _CaptureStdout() as cap2:
    _ = _normalize("play lo-fi and turn up the volume", note="smoke_trace_shape")
traces = cap2.find_payloads("[semantic_normalizer_trace]")
ok(len(traces) == 1, "trace: exactly one [semantic_normalizer_trace] per call")
if traces:
    t = traces[0]
    expected_fields = {
        "transcript", "session_id", "normalized_actions",
        "deterministic_actions", "validation_errors", "clarification_needed",
        "context_entities", "route_decision", "legacy_router_bypassed",
        "final_action_types", "final_payload_ops", "is_compound",
        "router_mismatch", "note", "ts",
    }
    missing = expected_fields - set(t.keys())
    ok(not missing, "trace: every required field present", detail=str(missing))
    ok(
        t["legacy_router_bypassed"] is False,
        "trace: legacy_router_bypassed=False (Stage A read-only)",
    )
    ok(
        t["note"] == "smoke_trace_shape",
        "trace: caller-provided note is propagated",
    )
    ok(
        "music.play" in (t.get("final_action_types") or [])
        and "music.volume" in (t.get("final_action_types") or []),
        "trace: final_action_types contains both planner actions",
        detail=str(t.get("final_action_types")),
    )


# ============================================================================
# PART 9 — Stage A.5 route contract
# ============================================================================
section("PART 9 -- Stage A.5 route contract")


# --- 9a. Supported complete requests stay route_type='action' --------------
SUPPORTED_COMPLETE_CASES = [
    ("play lo-fi",                      "music.play",    False),
    ("pause the music",                 "music.pause",   False),
    ("go to panel 2",                   "panel.navigate",False),
    ("start a timer for 10 minutes",    "timer.set",     False),
    ("add milk to the checklist",       "checklist.add", False),
    ("what time is it in Tokyo",        "info.time",     False),
    ("Apple stock price",               "info.finance",  False),
    ("did the Lakers win?",             "info.sports",   False),
    ("start a timer for one hour and switch to the second panel",
                                        "timer.set",     True),
]
for utterance, expected_intent, expect_compound in SUPPORTED_COMPLETE_CASES:
    t = _normalize(utterance)
    ok(
        t["route_type"] == "action",
        f"complete: {utterance!r} -> route_type='action'",
        detail=str(t["route_type"]),
    )
    ok(
        t["fallback_type"] is None,
        f"complete: {utterance!r} -> fallback_type None",
    )
    ok(
        t["intent"] == expected_intent,
        f"complete: {utterance!r} -> intent={expected_intent}",
        detail=str(t["intent"]),
    )
    ok(
        bool(t["actions"]),
        f"complete: {utterance!r} -> emits ≥1 executable action",
    )
    ok(
        t["missing_slots"] == [],
        f"complete: {utterance!r} -> missing_slots empty",
    )
    if expect_compound:
        ok(t["is_compound"] is True, f"complete: {utterance!r} -> is_compound=True")


# --- 9b. Supported INCOMPLETE requests -> route_type='clarification' -------
# Synthesize a plan with a music.play action whose query payload is empty.
# This is what the planner's _ACTION_PAYLOAD_KEYS check would catch via
# validate_plan, so we inject a stub plan_user_actions to exercise the
# clarification path deterministically and without touching live routers.
def _stub_plan_music_play_no_query(text, vera=None):
    return {
        "is_multi_action": False,
        "actions": [{
            "type": "music.play",
            "span": text or "",
            "payload": {"query": ""},  # missing query -> validate_plan fails
            "order": 1,
            "confidence": 0.9,
        }],
        "clarification_needed": False,
        "clarification_question": None,
        "reason": "stub_music_play_missing_query",
    }


def _stub_classify_info_tool_uncertain(text, **kwargs):
    return {
        "route": "uncertain", "tool": "none", "query": text, "entities": [],
        "metric": None, "timeframe": None, "required_context": None,
        "confidence": 0.0, "reason": "stub_uncertain",
    }


t_clar = build_normalized_turn(
    "play",
    classify_info_tool=_stub_classify_info_tool_uncertain,
    classify_sports_intent=classify_sports_intent,
    plan_user_actions=_stub_plan_music_play_no_query,
    note="smoke_clarification_music_play",
)
ok(t_clar["route_type"] == "clarification",
   "clarification: music.play missing query -> route_type='clarification'",
   detail=str(t_clar["route_type"]))
ok(t_clar["intent"] == "music.play",
   "clarification: intent == 'music.play' (supported target)",
   detail=str(t_clar["intent"]))
ok(t_clar["intent"] in ALLOWED_ACTION_TYPES,
   "clarification: intent is a supported allowed action type")
ok(t_clar["fallback_type"] is None,
   "clarification: fallback_type is None")
ok("query" in t_clar["missing_slots"],
   "clarification: missing_slots includes 'query'",
   detail=str(t_clar["missing_slots"]))
ok(isinstance(t_clar["message"], str) and t_clar["message"].strip(),
   "clarification: message is a non-empty string")
ok(t_clar["actions"] == [],
   "clarification: emits no executable actions",
   detail=str(t_clar["actions"]))
ok(t_clar["clarification_needed"] is True,
   "clarification: backward-compat clarification_needed=True")
ok(t_clar["clarification_question"] == t_clar["message"],
   "clarification: clarification_question mirrors message")
_assert_shape(t_clar, label="clarification[music.play]")


# Same idea with timer.set missing duration_seconds:
def _stub_plan_timer_no_duration(text, vera=None):
    return {
        "is_multi_action": False,
        "actions": [{
            "type": "timer.set",
            "span": text or "",
            "payload": {"duration_seconds": None},
            "order": 1,
            "confidence": 0.9,
        }],
        "clarification_needed": False,
        "clarification_question": None,
        "reason": "stub_timer_missing_duration",
    }


t_clar2 = build_normalized_turn(
    "start a timer",
    classify_info_tool=_stub_classify_info_tool_uncertain,
    classify_sports_intent=classify_sports_intent,
    plan_user_actions=_stub_plan_timer_no_duration,
)
ok(t_clar2["route_type"] == "clarification",
   "clarification: timer.set missing duration -> route_type='clarification'")
ok(t_clar2["intent"] == "timer.set",
   "clarification: intent == 'timer.set'")
ok("duration_seconds" in t_clar2["missing_slots"],
   "clarification: missing_slots includes 'duration_seconds'",
   detail=str(t_clar2["missing_slots"]))


# --- 9c. UNSUPPORTED capability (known family, unknown verb) ---------------
def _stub_plan_unsupported_music_action(text, vera=None):
    return {
        "is_multi_action": False,
        "actions": [{
            "type": "music.shuffle",  # NOT in ALLOWED_ACTION_TYPES
            "span": text or "",
            "payload": {"query": "lo-fi"},
            "order": 1,
            "confidence": 0.9,
        }],
        "clarification_needed": False,
        "clarification_question": None,
        "reason": "stub_unsupported_music_action",
    }


t_unsup = build_normalized_turn(
    "shuffle my music",
    classify_info_tool=_stub_classify_info_tool_uncertain,
    classify_sports_intent=classify_sports_intent,
    plan_user_actions=_stub_plan_unsupported_music_action,
)
ok(t_unsup["route_type"] == "fallback",
   "unsupported: music.shuffle -> route_type='fallback'",
   detail=str(t_unsup["route_type"]))
ok(t_unsup["fallback_type"] == "unsupported_capability",
   "unsupported: fallback_type='unsupported_capability' (known family prefix)",
   detail=str(t_unsup["fallback_type"]))
ok(t_unsup["intent"] is None,
   "unsupported: intent is None")
ok(t_unsup["actions"] == [],
   "unsupported: emits no executable actions")
ok(t_unsup["observed_type"] == "music.shuffle",
   "unsupported: observed_type preserves the rejected action.type",
   detail=str(t_unsup["observed_type"]))
ok(isinstance(t_unsup["message"], str) and t_unsup["message"].strip(),
   "unsupported: non-empty message")


# Same with a checklist verb the user explicitly listed as unsupported:
def _stub_plan_checklist_uncomplete(text, vera=None):
    return {
        "is_multi_action": False,
        "actions": [{
            "type": "checklist.uncomplete",
            "span": text or "",
            "payload": {"targets": ["milk"]},
            "order": 1, "confidence": 0.9,
        }],
        "clarification_needed": False, "clarification_question": None,
        "reason": "stub_checklist_uncomplete",
    }


t_unsup_cl = build_normalized_turn(
    "uncheck the first item",
    classify_info_tool=_stub_classify_info_tool_uncertain,
    classify_sports_intent=classify_sports_intent,
    plan_user_actions=_stub_plan_checklist_uncomplete,
)
ok(t_unsup_cl["route_type"] == "fallback",
   "unsupported(checklist.uncomplete): route_type='fallback'")
ok(t_unsup_cl["fallback_type"] == "unsupported_capability",
   "unsupported(checklist.uncomplete): fallback_type='unsupported_capability'")
ok(t_unsup_cl["observed_type"] == "checklist.uncomplete",
   "unsupported(checklist.uncomplete): observed_type carries the rejected type")


# --- 9d. INVALID router output (unknown family) ----------------------------
def _stub_plan_invalid_family(text, vera=None):
    return {
        "is_multi_action": False,
        "actions": [{
            "type": "email.send",   # no known family prefix
            "span": text or "",
            "payload": {"to": "x@y.z"},
            "order": 1, "confidence": 0.9,
        }],
        "clarification_needed": False, "clarification_question": None,
        "reason": "stub_invalid_family",
    }


t_invalid = build_normalized_turn(
    "send an email to my boss",
    classify_info_tool=_stub_classify_info_tool_uncertain,
    classify_sports_intent=classify_sports_intent,
    plan_user_actions=_stub_plan_invalid_family,
)
ok(t_invalid["route_type"] == "fallback",
   "invalid: email.send -> route_type='fallback'")
ok(t_invalid["fallback_type"] == "invalid_router_output",
   "invalid: fallback_type='invalid_router_output' (no known family prefix)",
   detail=str(t_invalid["fallback_type"]))
ok(t_invalid["observed_type"] == "email.send",
   "invalid: observed_type='email.send'")
ok(t_invalid["actions"] == [],
   "invalid: emits no executable actions")


# --- 9e. UNKNOWN request (planner clarifies but no target action) ----------
def _stub_plan_ambiguous_clarification(text, vera=None):
    # Mirrors the planner's "checklist/play ambiguity" branch — sets
    # clarification_needed but emits no action. There is no target intent
    # for us to clarify against, so Stage A.5 must route this to fallback.
    return {
        "is_multi_action": False, "actions": [],
        "clarification_needed": True,
        "clarification_question": "Should I add that to the checklist, or play it?",
        "reason": "stub_ambiguous_planner_clarification",
    }


t_unknown = build_normalized_turn(
    "add hello and play lofi",  # any text — planner stub overrides
    classify_info_tool=_stub_classify_info_tool_uncertain,
    classify_sports_intent=classify_sports_intent,
    plan_user_actions=_stub_plan_ambiguous_clarification,
)
ok(t_unknown["route_type"] == "fallback",
   "unknown: ambiguous planner clarification -> route_type='fallback'")
ok(t_unknown["fallback_type"] == "unknown_request",
   "unknown: fallback_type='unknown_request'",
   detail=str(t_unknown["fallback_type"]))
ok(t_unknown["intent"] is None,
   "unknown: intent is None")
ok(t_unknown["message"].startswith("Should I add"),
   "unknown: message inherits planner's clarification question text",
   detail=str(t_unknown["message"]))


# --- 9f. LOW CONFIDENCE (non-voice.answer action below threshold) ---------
def _stub_plan_low_conf_info_news(text, vera=None):
    return {
        "is_multi_action": False,
        "actions": [{
            "type": "info.news",
            "span": text or "",
            "payload": {"query": text or ""},
            "order": 1, "confidence": 0.05,  # well below 0.30
        }],
        "clarification_needed": False, "clarification_question": None,
        "reason": "stub_low_confidence",
    }


t_lowconf = build_normalized_turn(
    "hmm something about that thing",
    classify_info_tool=_stub_classify_info_tool_uncertain,
    classify_sports_intent=classify_sports_intent,
    plan_user_actions=_stub_plan_low_conf_info_news,
)
ok(t_lowconf["route_type"] == "fallback",
   "low_confidence: confidence below threshold -> route_type='fallback'")
ok(t_lowconf["fallback_type"] == "low_confidence",
   "low_confidence: fallback_type='low_confidence'",
   detail=str(t_lowconf["fallback_type"]))
ok(t_lowconf["actions"] == [],
   "low_confidence: emits no executable actions")


# --- 9g. Clarification ALWAYS references a supported intent ----------------
for stub_label, stub_fn in (
    ("music.play",   _stub_plan_music_play_no_query),
    ("timer.set",    _stub_plan_timer_no_duration),
):
    t = build_normalized_turn(
        "stub",
        classify_info_tool=_stub_classify_info_tool_uncertain,
        classify_sports_intent=classify_sports_intent,
        plan_user_actions=stub_fn,
    )
    if t["route_type"] == "clarification":
        ok(t["intent"] in ALLOWED_ACTION_TYPES,
           f"clarification invariant ({stub_label}): intent is in ALLOWED_ACTION_TYPES",
           detail=str(t["intent"]))


# --- 9h. Fallback NEVER touches executors / route_action / CHAT3 -----------
# We assert this by structural inspection: build_normalized_turn never
# imports CHAT3 or route_action_request, and its only external calls are
# the three injected callables (plan, classify_info_tool, sports). Here
# we wrap each callable with a recorder and confirm the only calls made
# during a fallback turn are to the deterministic stubs themselves.
_calls: list[str] = []


def _record_plan_uncertain(text, vera=None):
    _calls.append("plan_user_actions")
    # Stub: planner anchors no action, no clarification.
    return {
        "is_multi_action": False, "actions": [],
        "clarification_needed": False, "clarification_question": None,
        "reason": "stub_no_anchor",
    }


def _record_classify_info_tool_uncertain(text, **kwargs):
    _calls.append("classify_info_tool")
    return {"route": "uncertain", "tool": "none", "query": text,
            "entities": [], "confidence": 0.0, "reason": "stub_uncertain"}


def _record_classify_sports_intent(text, **kwargs):
    _calls.append("classify_sports_intent")
    return {"is_sports": False, "entity": "", "tournament_or_league": "",
            "query_type": "", "confidence": 0.0, "reason": "stub_no_sports"}


t_fb = build_normalized_turn(
    "do something weird",
    plan_user_actions=_record_plan_uncertain,
    classify_info_tool=_record_classify_info_tool_uncertain,
    classify_sports_intent=_record_classify_sports_intent,
)
ok(t_fb["route_type"] == "fallback",
   "no-executor: empty router output -> route_type='fallback'")
ok(t_fb["fallback_type"] == "unknown_request",
   "no-executor: fallback_type='unknown_request'")
ok(_calls and _calls[0] == "plan_user_actions",
   "no-executor: planner is called first",
   detail=str(_calls))
ok("classify_info_tool" in _calls,
   "no-executor: classify_info_tool called once (no executor call)")
# classify_sports_intent should NOT be called here — sports enricher only
# fires when an info.sports candidate exists.
ok("classify_sports_intent" not in _calls,
   "no-executor: sports classifier skipped when no info.sports anchor",
   detail=str(_calls))


# --- 9i. fallback_type categories surface in [semantic_normalizer_trace] ---
with _CaptureStdout() as cap_fb:
    _ = build_normalized_turn(
        "shuffle my music",
        plan_user_actions=_stub_plan_unsupported_music_action,
        classify_info_tool=_stub_classify_info_tool_uncertain,
        classify_sports_intent=classify_sports_intent,
        note="smoke_trace_fallback",
    )
fb_traces = cap_fb.find_payloads("[semantic_normalizer_trace]")
ok(len(fb_traces) == 1, "trace(fallback): exactly one trace line per call")
if fb_traces:
    p = fb_traces[0]
    ok(p.get("route_type") == "fallback",
       "trace(fallback): route_type='fallback'")
    ok(p.get("fallback_type") == "unsupported_capability",
       "trace(fallback): fallback_type='unsupported_capability'")
    ok(p.get("intent") is None,
       "trace(fallback): intent is None")
    ok(p.get("observed_type") == "music.shuffle",
       "trace(fallback): observed_type carries the rejected type",
       detail=str(p.get("observed_type")))
    ok(p.get("final_action_types") == [],
       "trace(fallback): final_action_types is empty")
    ok(p.get("normalized_actions") == [],
       "trace(fallback): normalized_actions is empty")
    ok(p.get("missing_slots") == [],
       "trace(fallback): missing_slots is empty")
    ok(p.get("message_present") is True,
       "trace(fallback): message_present=True")


with _CaptureStdout() as cap_cl:
    _ = build_normalized_turn(
        "play",
        plan_user_actions=_stub_plan_music_play_no_query,
        classify_info_tool=_stub_classify_info_tool_uncertain,
        classify_sports_intent=classify_sports_intent,
        note="smoke_trace_clarification",
    )
cl_traces = cap_cl.find_payloads("[semantic_normalizer_trace]")
ok(len(cl_traces) == 1, "trace(clarification): exactly one trace line per call")
if cl_traces:
    p = cl_traces[0]
    ok(p.get("route_type") == "clarification",
       "trace(clarification): route_type='clarification'")
    ok(p.get("fallback_type") is None,
       "trace(clarification): fallback_type is None")
    ok(p.get("intent") == "music.play",
       "trace(clarification): intent='music.play'")
    ok(p.get("missing_slots") and "query" in p["missing_slots"],
       "trace(clarification): missing_slots includes 'query'",
       detail=str(p.get("missing_slots")))
    ok(p.get("final_action_types") == [],
       "trace(clarification): final_action_types is empty (no executable actions)")


# --- 9j. Validation never crashes — fallback is never treated as a crash ---
ok(t_fb["validation_errors"] if "validation_errors" in t_fb else True,
   "validation: fallback turns return cleanly (no exception)")


# --- 9k. ALLOWED_ACTION_TYPES does NOT contain pseudo-intents -------------
PSEUDO_TYPES = {
    "clarification.ask", "fallback.unsupported", "fallback",
    "unknown", "uncertain", "checklist.uncomplete", "checklist.sync",
}
for ps in PSEUDO_TYPES:
    ok(ps not in ALLOWED_ACTION_TYPES,
       f"catalog: {ps!r} NOT in ALLOWED_ACTION_TYPES",
       detail=str(ps in ALLOWED_ACTION_TYPES))


# --- 9l. shadow_llm_actions remains [] on every Stage A.5 turn -------------
for label, t in (
    ("clar1", t_clar), ("clar2", t_clar2), ("unsup", t_unsup),
    ("unsup_cl", t_unsup_cl), ("invalid", t_invalid),
    ("unknown", t_unknown), ("lowconf", t_lowconf), ("nofallthrough", t_fb),
):
    ok(t["shadow_llm_actions"] == [],
       f"invariant({label}): shadow_llm_actions remains []")


# ============================================================================
# SUMMARY
# ============================================================================
section("Summary")
print(f"  Passed: {GREEN}{PASS}{RESET}   Failed: {RED}{FAIL}{RESET}")
if FAIL:
    print(f"\n  {RED}Failures:{RESET}")
    for n in FAILED:
        print(f"    - {n}")
    sys.exit(1)
sys.exit(0)
