"""Smoke tests for the adaptive mini-LLM search planner (2026-05-31).

Covers:
  * ``should_use_search_planner`` decision matrix — skips simple direct
    routes (time / weather / finance / explicit news with topic / places)
    AND fires on follow-up tokens, low-confidence, sports follow-ups,
    product recommendations, news deictic follow-ups.
  * ``_parse_planner_json`` — strips fences, parses, normalizes
    intent_type, clamps normalized_queries to <=3, coerces confidence.
  * ``apply_search_plan`` — overwrites query for non-sports routes,
    PRESERVES deterministic queries for high-confidence sports turns,
    upgrades route only when deterministic was "uncertain", stamps
    ``news_pre_normalized=True`` for news.topic intent, routes
    planner sports.* away from sports_tool when deterministic
    sports_intent is empty.
  * End-to-end via a fake vera that returns a canned JSON plan.

Run:  py -3 -X utf8 tests/smoke/__search_planner_smoke.py
"""
from __future__ import annotations

import io
import json
import os
import sys
import types

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# Heavy modules stub — same pattern as the other smoke tests.
_TTS_STUB_NAMES = (
    "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
    "transcribe_long", "load_model", "warmup", "speak_to_file",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload",
)
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for fn in _TTS_STUB_NAMES:
            setattr(stub, fn, lambda *a, **kw: None)
        sys.modules[modname] = stub

from actions.search_planner import (
    ALLOWED_INTENT_TYPES,
    apply_search_plan,
    log_search_planner_decision,
    run_search_planner,
    should_use_search_planner,
    _parse_planner_json,
)

passes = 0
fails = 0


def ok(cond: bool, label: str, detail: str = "") -> None:
    global passes, fails
    if cond:
        passes += 1
        print(f"  \033[32mPASS\033[0m  {label}")
    else:
        fails += 1
        print(f"  \033[31mFAIL\033[0m  {label}  -- {detail}")


def section(title: str) -> None:
    print(f"\n\033[33m-- {title} --\033[0m")


# ---------------------------------------------------------------------------
# should_use_search_planner — skip simple direct routes
# ---------------------------------------------------------------------------
section("Skip — simple direct routes (no planner)")

use, reason = should_use_search_planner(
    "what time is it in Tokyo?",
    {"route": "time_tool", "confidence": 0.95, "reason": "time_intent_explicit_location"},
)
ok(use is False, "time.current skipped", reason)
ok(reason == "fast_path_time", "skip reason=fast_path_time", reason)

use, reason = should_use_search_planner(
    "weather in Irvine",
    {"route": "weather_tool", "confidence": 0.95, "reason": "weather_intent_with_location"},
)
ok(use is False, "weather.current skipped", reason)
ok(reason == "fast_path_weather", "skip reason=fast_path_weather", reason)

use, reason = should_use_search_planner(
    "Apple stock price",
    {"route": "finance_tool", "confidence": 0.92, "reason": "finance_intent_ticker"},
)
ok(use is False, "finance.quote skipped", reason)
ok(reason == "fast_path_finance", "skip reason=fast_path_finance", reason)

use, reason = should_use_search_planner(
    "coffee shops in Fountain Valley",
    {"route": "general_web_search_tool", "confidence": 0.85, "reason": "local_venue_query_web_search"},
)
ok(use is False, "location.places skipped", reason)
ok(reason == "fast_path_location_places", "skip reason=fast_path_location_places", reason)

use, reason = should_use_search_planner(
    "news about OpenAI",
    {"route": "news_search_tool", "confidence": 0.9, "reason": "explicit_news_request"},
)
ok(use is False, "explicit news skipped", reason)
ok(reason == "fast_path_explicit_news", "skip reason=fast_path_explicit_news", reason)


# ---------------------------------------------------------------------------
# should_use_search_planner — invoke for messy/contextual
# ---------------------------------------------------------------------------
section("Use — follow-up tokens / low confidence / sports follow-up / product")

use, reason = should_use_search_planner(
    "these are expensive, any cheaper ones?",
    {"route": "general_web_search_tool", "confidence": 0.85, "reason": "shopping_or_recommendation_web_search"},
)
ok(use is True, "followup token 'cheaper' on shopping route triggers planner", reason)
# Product detection beats generic follow-up token detection in precedence.
ok(reason == "product_recommendation_needs_normalization",
   "reason=product_recommendation (precedence beats followup_terms)", reason)

use, reason = should_use_search_planner(
    "show me more like that",
    {"route": "uncertain", "confidence": 0.4, "reason": "no_confident_pick_falls_through"},
)
ok(use is True, "low-confidence + followup token triggers planner", reason)

use, reason = should_use_search_planner(
    "im pretty sure he lost to joao fonseca?",
    {
        "route": "sports_tool",
        "confidence": 0.86,
        "reason": "match_result_verification_claim",
        "sports_intent": {
            "is_sports": True,
            "confidence": 0.86,
            "followup_used": True,
            "opponent": "Joao Fonseca",
            "query_type": "match_result_verification",
        },
    },
)
ok(use is True, "sports follow-up with opponent triggers planner", reason)
ok(reason == "sports_followup_or_low_confidence", "reason=sports_followup_or_low_confidence", reason)

use, reason = should_use_search_planner(
    "Is Djokovic still in Roland Garros?",
    {
        "route": "sports_tool",
        "confidence": 0.92,
        "reason": "entity_plus_tournament",
        "sports_intent": {
            "is_sports": True,
            "confidence": 0.92,
            "followup_used": False,
            "opponent": "",
            "query_type": "tournament_status",
        },
    },
)
ok(use is False, "clean direct sports skipped (fast path)", reason)
ok(reason == "fast_path_sports_high_confidence",
   "reason=fast_path_sports_high_confidence", reason)

use, reason = should_use_search_planner(
    "what laptop should I buy for data science?",
    {
        "route": "general_web_search_tool",
        "confidence": 0.85,
        "reason": "shopping_or_recommendation_web_search",
    },
)
ok(use is True, "product recommendation triggers planner", reason)

use, reason = should_use_search_planner(
    "give me some news on that",
    {
        "route": "news_search_tool",
        "confidence": 0.85,
        "reason": "news_followup_deictic",
    },
)
ok(use is True, "non-pre-normalized news follow-up triggers planner", reason)

use, reason = should_use_search_planner(
    "give me some news on Garden Grove chemical leak",
    {
        "route": "news_search_tool",
        "confidence": 0.85,
        "reason": "news_followup_topic_merge",
        "news_pre_normalized": True,
    },
)
ok(use is False, "pre-normalized news skipped (info_normalizer already handled)", reason)
ok(reason == "fast_path_news_pre_normalized", "reason=fast_path_news_pre_normalized", reason)

use, reason = should_use_search_planner(
    "tell me about the recent chemical leak",
    {"route": "uncertain", "confidence": 0.5, "reason": "no_confident_pick_falls_through"},
)
ok(use is True, "low-confidence + followup token triggers planner", reason)


# ---------------------------------------------------------------------------
# should_use_search_planner — never for app actions
# ---------------------------------------------------------------------------
section("Never — app actions / clarifications")

for r in ("music_tool", "checklist_tool", "timer_tool", "panel_navigation",
          "reasoning_panel", "llm_only"):
    use, reason = should_use_search_planner(
        "do something",
        {"route": r, "confidence": 0.95, "reason": ""},
    )
    ok(use is False, f"{r} skipped", reason)

use, reason = should_use_search_planner(
    "did they win?",
    {"route": "sports_clarification_needed", "confidence": 0.6, "reason": ""},
)
ok(use is False, "sports_clarification_needed skipped", reason)

use, reason = should_use_search_planner(
    "what's nearby?",
    {"route": "clarification_needed", "confidence": 0.85, "reason": ""},
)
ok(use is False, "clarification_needed skipped", reason)


# ---------------------------------------------------------------------------
# _parse_planner_json — robust JSON extraction
# ---------------------------------------------------------------------------
section("_parse_planner_json")

valid = json.dumps({
    "intent_type": "sports.match_result",
    "entity": "Novak Djokovic",
    "entity_type": "player",
    "sport": "tennis",
    "league_or_tournament": "Roland Garros",
    "location": None,
    "time_context": "2026",
    "product_category": None,
    "use_case": None,
    "budget": None,
    "normalized_queries": [
        "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
        "Novak Djokovic lost to Joao Fonseca Roland Garros 2026",
    ],
    "answer_policy": "Use only retrieved snippets.",
    "confidence": 0.86,
    "needs_clarification": False,
    "clarification_question": None,
})
parsed = _parse_planner_json(valid)
ok(parsed is not None, "valid JSON parses", str(parsed))
ok(parsed["intent_type"] == "sports.match_result", "intent_type preserved")
ok(len(parsed["normalized_queries"]) == 2, "normalized_queries preserved")
ok(parsed["confidence"] == 0.86, "confidence preserved")

# Fenced output (markdown).
fenced = "```json\n" + valid + "\n```"
parsed_f = _parse_planner_json(fenced)
ok(parsed_f is not None, "fenced JSON still parses")
ok(parsed_f["intent_type"] == "sports.match_result", "fenced intent_type preserved")

# Prose preamble.
prose = "Sure thing! Here's the plan:\n" + valid + "\nLet me know if that's right."
parsed_p = _parse_planner_json(prose)
ok(parsed_p is not None, "JSON within prose extracted")

# Invalid intent_type -> falls back to "unknown".
bad_intent = json.dumps({
    "intent_type": "weird.unknown.type",
    "normalized_queries": ["x"],
    "confidence": 0.7,
    "needs_clarification": False,
})
parsed_b = _parse_planner_json(bad_intent)
ok(parsed_b is not None, "bad intent JSON still parses")
ok(parsed_b["intent_type"] == "unknown", "invalid intent_type coerced to 'unknown'", str(parsed_b))

# Empty/garbage.
ok(_parse_planner_json("") is None, "empty string returns None")
ok(_parse_planner_json("no json here") is None, "non-JSON text returns None")
ok(_parse_planner_json(None) is None, "None returns None")  # type: ignore[arg-type]

# Normalized_queries clamping (>3) and trimming.
many = json.dumps({
    "intent_type": "news.topic",
    "normalized_queries": ["a ?", "b !", "c ", "d", "e"],
    "confidence": 0.8,
    "needs_clarification": False,
})
parsed_m = _parse_planner_json(many)
ok(len(parsed_m["normalized_queries"]) == 3, "normalized_queries clamped to 3")
ok(parsed_m["normalized_queries"][0] == "a", "trailing punctuation stripped from first query")


# ---------------------------------------------------------------------------
# apply_search_plan — merge policy
# ---------------------------------------------------------------------------
section("apply_search_plan — non-sports overwrite + sports preserve")

# Product/web-search route: planner overwrites query.
cls = {
    "route": "general_web_search_tool",
    "query": "any cheaper laptop?",
    "confidence": 0.85,
    "reason": "shopping_or_recommendation_web_search",
}
plan = {
    "intent_type": "product.research",
    "normalized_queries": ["best budget laptop for data science 2026"],
    "confidence": 0.8,
    "needs_clarification": False,
}
apply_search_plan(plan, cls)
ok(cls["query"] == "best budget laptop for data science 2026",
   "query overwritten with planner normalized query")
ok(cls["normalized_query"] == "best budget laptop for data science 2026",
   "normalized_query stamped")
ok(cls["search_planner_applied"] is True, "search_planner_applied=True")
ok(cls.get("search_planner_intent_type") == "product.research",
   "intent_type tracked")

# Sports high-confidence: planner does NOT overwrite.
cls_s = {
    "route": "sports_tool",
    "query": "Is Djokovic still in Roland Garros?",
    "confidence": 0.92,
    "reason": "entity_plus_tournament",
    "sports_intent": {
        "is_sports": True,
        "confidence": 0.92,
        "followup_used": False,
        "opponent": "",
    },
}
plan_s = {
    "intent_type": "sports.tournament_status",
    "normalized_queries": ["something the planner cooked up"],
    "confidence": 0.8,
    "needs_clarification": False,
}
apply_search_plan(plan_s, cls_s)
ok(cls_s["query"] == "Is Djokovic still in Roland Garros?",
   "high-confidence sports query NOT overwritten", str(cls_s))
ok(cls_s["search_planner_applied"] is True, "applied flag still set for diagnostics")
ok(cls_s.get("search_planner_intent_type") == "sports.tournament_status",
   "planner intent_type recorded")

# Sports follow-up: planner DOES refine.
cls_sf = {
    "route": "sports_tool",
    "query": "im pretty sure he lost to joao fonseca?",
    "confidence": 0.86,
    "reason": "match_result_verification_claim",
    "sports_intent": {
        "is_sports": True,
        "confidence": 0.86,
        "followup_used": True,
        "opponent": "Joao Fonseca",
    },
}
plan_sf = {
    "intent_type": "sports.match_result",
    "normalized_queries": [
        "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
        "Novak Djokovic lost to Joao Fonseca Roland Garros 2026",
    ],
    "confidence": 0.85,
    "needs_clarification": False,
}
apply_search_plan(plan_sf, cls_sf)
ok(cls_sf["query"] == "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
   "sports follow-up query refined by planner")
ok(cls_sf["search_planner_normalized_queries"][0]
   == "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
   "all normalized_queries stored")

# Uncertain deterministic route + confident planner -> route upgraded
# (but NOT to sports_tool — falls through to web.search to avoid breaking
# the sports handler that needs a populated sports_intent dict).
cls_u = {
    "route": "uncertain",
    "query": "im pretty sure he lost to joao fonseca?",
    "confidence": 0.0,
    "reason": "no_confident_pick_falls_through",
}
plan_u = {
    "intent_type": "sports.match_result",
    "normalized_queries": ["Novak Djokovic Joao Fonseca result"],
    "confidence": 0.85,
    "needs_clarification": False,
}
apply_search_plan(plan_u, cls_u)
ok(cls_u["route"] == "general_web_search_tool",
   "uncertain+sports.* upgraded to web.search (not sports_tool)",
   str(cls_u))
ok(cls_u["confidence"] >= 0.85, "confidence bumped to planner's")

# News topic intent stamps news_pre_normalized=True.
cls_n = {
    "route": "news_search_tool",
    "query": "give me news on that",
    "confidence": 0.85,
    "reason": "news_followup_deictic",
}
plan_n = {
    "intent_type": "news.topic",
    "normalized_queries": ["Garden Grove Orange County chemical leak news"],
    "confidence": 0.85,
    "needs_clarification": False,
}
apply_search_plan(plan_n, cls_n)
ok(cls_n.get("news_pre_normalized") is True,
   "news.topic stamps news_pre_normalized=True")
ok(cls_n["query"] == "Garden Grove Orange County chemical leak news",
   "news query refined")

# Needs clarification: no overwrite, question stashed.
cls_c = {"route": "uncertain", "query": "?", "confidence": 0.0}
plan_c = {
    "intent_type": "unknown",
    "normalized_queries": [],
    "confidence": 0.4,
    "needs_clarification": True,
    "clarification_question": "Which player are you asking about?",
}
apply_search_plan(plan_c, cls_c)
ok(cls_c.get("search_planner_clarification") == "Which player are you asking about?",
   "clarification question stashed")
ok(cls_c["route"] == "uncertain", "route not changed for clarification path")

# Low-confidence plan: no-op on query.
cls_lo = {"route": "uncertain", "query": "huh?", "confidence": 0.0}
plan_lo = {"intent_type": "unknown", "normalized_queries": ["maybe x"], "confidence": 0.3,
           "needs_clarification": False}
apply_search_plan(plan_lo, cls_lo)
ok(cls_lo["query"] == "huh?",
   "low-confidence plan (< 0.5) does not overwrite query")


# ---------------------------------------------------------------------------
# End-to-end via fake vera
# ---------------------------------------------------------------------------
section("End-to-end — run_search_planner with fake vera")


class _FakeVera:
    """Returns a canned JSON plan that quotes the user back at the model."""

    def __init__(self, canned: dict):
        self._canned = canned
        self.last_messages: list = []

    def build_messages(self, history, prompt: str):
        self.last_messages = [{"role": "user", "content": prompt}]
        return self.last_messages

    def generate(self, messages):
        # Pretend the LLM read the prompt and emitted the canned JSON.
        return (json.dumps(self._canned), -0.5)


fake_plan = {
    "intent_type": "sports.match_result",
    "entity": "Novak Djokovic",
    "entity_type": "player",
    "sport": "tennis",
    "league_or_tournament": "Roland Garros",
    "location": None,
    "time_context": "2026",
    "product_category": None,
    "use_case": None,
    "budget": None,
    "normalized_queries": [
        "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
        "Novak Djokovic lost to Joao Fonseca Roland Garros 2026",
    ],
    "answer_policy": "Answer only from the retrieved snippets.",
    "confidence": 0.85,
    "needs_clarification": False,
    "clarification_question": None,
}
fake_vera = _FakeVera(fake_plan)
plan_out = run_search_planner(
    "im pretty sure he lost to joao fonseca?",
    fake_vera,
    classification={
        "route": "sports_tool",
        "confidence": 0.86,
        "reason": "match_result_verification_claim",
    },
    recent_sports_context={
        "entity": "Novak Djokovic",
        "sport": "tennis_atp",
        "tournament_or_league": "Roland Garros",
        "season_or_year": "2026",
        "query_type": "tournament_status",
    },
    session_id="smoke-1",
)
ok(plan_out is not None, "end-to-end plan returned", str(plan_out))
ok(plan_out["intent_type"] == "sports.match_result", "intent_type round-trip")
ok(plan_out["normalized_queries"][0]
   == "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
   "first normalized query round-trip")
ok(plan_out.get("_latency_ms") is not None, "latency captured")
ok("Prior sports context" in fake_vera.last_messages[0]["content"],
   "prior sports context embedded in prompt")

# vera=None path returns None gracefully.
plan_none = run_search_planner("anything", None)
ok(plan_none is None, "vera=None returns None (does not raise)")

# Vera that returns garbage -> None + parse_error log.
class _GarbageVera:
    def build_messages(self, h, p):
        return [{"role": "user", "content": p}]
    def generate(self, m):
        return ("definitely not json", -1.0)

plan_g = run_search_planner("anything", _GarbageVera())
ok(plan_g is None, "garbage LLM reply -> None")

# Vera that raises -> None + llm_error log (does not propagate).
class _BoomVera:
    def build_messages(self, h, p):
        return []
    def generate(self, m):
        raise RuntimeError("simulated CUDA OOM")

plan_b = run_search_planner("anything", _BoomVera())
ok(plan_b is None, "raising LLM call -> None (no propagation)")


# ---------------------------------------------------------------------------
# Diagnostics — log_search_planner_decision shape
# ---------------------------------------------------------------------------
section("log_search_planner_decision")

# Re-route stdout to capture the JSON line.
captured_lines: list[str] = []


class _CaptureStream:
    def __init__(self, real):
        self._real = real

    def write(self, s):
        captured_lines.append(s)
        return self._real.write(s)

    def flush(self):
        return self._real.flush()


sys.stdout = _CaptureStream(sys.stdout)
try:
    log_search_planner_decision(
        session_id="sess-1",
        raw_user_text="im pretty sure he lost to joao fonseca?",
        search_planner_considered=True,
        search_planner_called=True,
        deterministic_confidence=0.86,
        deterministic_route="sports_tool",
        search_planner_latency_ms=412,
        search_planner_intent_type="sports.match_result",
        search_planner_normalized_queries=[
            "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
        ],
        search_planner_answer_policy="Answer only from retrieved snippets.",
        deterministic_fallback_used=False,
        final_search_queries=[
            "Novak Djokovic Joao Fonseca Roland Garros 2026 result",
        ],
        final_result_kind="tournament",
        answer_confidence="medium",
    )
finally:
    sys.stdout = sys.stdout._real  # type: ignore[attr-defined]

trace = "".join(captured_lines)
ok("[search_planner_trace]" in trace, "trace line emitted")
ok('"deterministic_route": "sports_tool"' in trace, "deterministic_route present")
ok('"search_planner_intent_type": "sports.match_result"' in trace, "intent_type present")
ok('"search_planner_latency_ms": 412' in trace, "latency captured")


# ---------------------------------------------------------------------------
print(f"\n\033[32mPASS\033[0m: {passes}    \033[31mFAIL\033[0m: {fails}")
sys.exit(0 if fails == 0 else 1)
