"""Smoke tests for the "current fact" news routing fix.

The user spec block (the one starting with
"Fix VERA current-event news routing consistency.") splits into 8 parts.
This file exercises the 8-part PART 8 manual-test grid plus the
underlying detection signals so we can grep the regression surface:

  * score_current_fact_question(text) returns the right signal breakdown
    for the spec's examples
  * _is_current_fact_question(text) gates on entity + (temporal | domain noun)
  * classify_news_search_intent(text) emits
        intentType="current_fact_question"
        shouldSearchNews=True
        requestShapeDetected=True
    for a yes/no fact-verification question even when the message has
    NO "news"/"headlines"/"search" keyword.
  * detect_news_route_intent(text) returns action="news_search" with
    current_fact_question=True for the same input — i.e. the suppressor
    "current_or_recent_without_request_shape" no longer drops the route.
  * classify_news_route_for_turn(text, ctx=None) maps yes/no fact-
    verification questions to route_classification="current_fact_search"
    with serper_called=True — both the legacy
    `specific_current_event_question` path AND the new PART 5 override
    guard for messages that came back as general_chat.
  * Interpretive follow-ups continue to take the no-search LLM path
    ("Why was he there?" + ctx Ã¢” ’ interpretive_followup_llm_first).
  * Fresh/update/source-specific follow-ups continue to re-search.
  * Personal-news / emotional turns are STILL suppressed.

Run:  py -3 __news_current_fact_routing_smoke.py
"""

from __future__ import annotations

# --- bootstrap (auto-added on move to tests/smoke/) ----------------------
# This file was moved from the repo root into tests/smoke/. Add the repo
# root to sys.path so `import app` (and sibling modules) still resolves.
# Bootstrap must come AFTER `from __future__` to satisfy the Python rule
# that __future__ imports be the first statement (fixed 2026-05-28).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..')))
# -----------------------------------------------------------------------

import io
import os
import sys
import types

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
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _TTS_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

import app  # noqa: E402

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def assert_(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' — ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}Ã¢”â‚¬Ã¢”â‚¬ {title} Ã¢”â‚¬Ã¢”â‚¬{RESET}")


# ---------------------------------------------------------------
# A. score_current_fact_question: signal breakdown
# ---------------------------------------------------------------
section("A. score_current_fact_question signal breakdown")

POSITIVE_CASES = [
    "Did Trump go to China last week?",
    "Did Donald Trump go to China last week?",
    "Did Elon Musk win the case against OpenAI?",
    "Is the highway still closed?",
    "Was the LA fire contained?",
    # The spec lists "Did X happen today?" / "Did X happen last week?" /
    # "Is X confirmed?" / "What happened with X?" as templates where X is
    # a placeholder for a real noun. We exercise the pattern by
    # instantiating X with realistic public-entity nouns.
    "Did the Apple launch happen today?",
    "Did the election happen last week?",
    "Is the verdict confirmed?",
    "What happened with the OpenAI lawsuit?",
    "What's happening with the Bitcoin ETF this week?",
    "Did Apple confirm the launch yesterday?",
    "Is Bitcoin still crashing?",
    "Has the senator confirmed his resignation?",
]

for text in POSITIVE_CASES:
    score = app.score_current_fact_question(text)
    assert_(
        bool(score.get("matches")),
        f"score+: {text!r} Ã¢” ’ matches=True",
        detail=str(score),
    )
    assert_(
        score.get("current_fact_question_score", 0.0) > 0.0,
        f"score+: {text!r} Ã¢” ’ score > 0",
        detail=str(score),
    )

NEGATIVE_CASES = [
    "Did you sleep well?",
    "Is dinner ready?",
    "Did I send the email?",
    "Why are we still talking about this?",   # interpretive shape, no entity
    "What does that mean?",                   # interpretive, no entity
    "Can you tell me a joke?",                # imperative, no question shape
    "Tell me the news",                       # broad news, not yes/no fact
    "I just saw the news my friend passed away",   # personal/emotional
]

for text in NEGATIVE_CASES:
    is_fact_q = app._is_current_fact_question(text)
    assert_(not is_fact_q, f"score-: {text!r} Ã¢” ’ is_current_fact_question=False",
            detail=f"score={app.score_current_fact_question(text)}")


# ---------------------------------------------------------------
# B. classify_news_search_intent — current-fact branch
# ---------------------------------------------------------------
section("B. classify_news_search_intent for current-fact questions")

for text in POSITIVE_CASES:
    cls = app.classify_news_search_intent(text)
    assert_(
        cls.get("intentType") == "current_fact_question",
        f"intent classifier: {text!r} Ã¢” ’ intentType=current_fact_question",
        detail=str(cls.get("intentType")),
    )
    assert_(
        bool(cls.get("shouldSearchNews")),
        f"intent classifier: {text!r} Ã¢” ’ shouldSearchNews=True",
    )
    assert_(
        bool(cls.get("requestShapeDetected")),
        f"intent classifier: {text!r} Ã¢” ’ requestShapeDetected=True (PART 3 unblock)",
    )
    assert_(
        bool(cls.get("currentFactQuestionDetected")),
        f"intent classifier: {text!r} Ã¢” ’ currentFactQuestionDetected=True",
    )


# Sanity: existing classifications stay stable
cls_imperative = app.classify_news_search_intent("tell me the news")
assert_(cls_imperative.get("intentType") == "explicit_news_request",
        "intent classifier: 'tell me the news' Ã¢” ’ explicit_news_request")
cls_personal = app.classify_news_search_intent("I just got bad news, my dad passed away")
assert_(cls_personal.get("intentType") == "emotional_context",
        "intent classifier: personal/emotional still suppressed")


# ---------------------------------------------------------------
# C. detect_news_route_intent now fires news_search on fact questions
# ---------------------------------------------------------------
section("C. detect_news_route_intent for current-fact questions")

for text in POSITIVE_CASES:
    intent = app.detect_news_route_intent(text, recent_news_context=None)
    assert_(
        intent.get("action") == "news_search",
        f"route intent: {text!r} Ã¢” ’ action=news_search",
        detail=str(intent.get("action")) + " reason=" + str(intent.get("reason")),
    )
    assert_(
        bool(intent.get("current_fact_question")),
        f"route intent: {text!r} Ã¢” ’ current_fact_question=True",
    )

# Negative: 'I saw [Entity] in the news' is still suppressed (no request shape)
intent_passive = app.detect_news_route_intent("I saw Tesla in the news today", recent_news_context=None)
assert_(
    intent_passive.get("action") == "skip"
    and not intent_passive.get("current_fact_question"),
    "route intent: 'I saw Tesla in the news today' (no request shape) still suppressed",
    detail=str(intent_passive),
)

# Negative: 'Did you sleep well?' must NOT fire
intent_personal_q = app.detect_news_route_intent("Did you sleep well?", recent_news_context=None)
assert_(
    intent_personal_q.get("action") == "skip",
    "route intent: 'Did you sleep well?' Ã¢” ’ skip",
    detail=str(intent_personal_q),
)


# ---------------------------------------------------------------
# D. classify_news_route_for_turn end-to-end
# ---------------------------------------------------------------
section("D. classify_news_route_for_turn current_fact_search routing")

for text in POSITIVE_CASES:
    route = app.classify_news_route_for_turn(text, ctx=None)
    assert_(
        route.get("route_classification") == "current_fact_search",
        f"route turn: {text!r} Ã¢” ’ current_fact_search",
        detail=str(route.get("route_classification"))
        + " base=" + str(route.get("base_classification"))
        + " reason=" + str(route.get("reason")),
    )
    assert_(
        bool(route.get("serper_called")),
        f"route turn: {text!r} Ã¢” ’ serper_called=True",
    )

# PART 5 override guard: base_classification == general_chat but score positive
# Force the base classifier to return general_chat by using a phrasing that
# slips past `_SPECIFIC_FACTUAL_QUESTION_LEAD_RE` (which actually catches
# all of them — so we test the guard directly by stubbing).
class _ForcedGeneralChatBase(dict):
    pass


orig_classify = app.classify_news_request_type

def _stub_general_chat_base(text):
    base = orig_classify(text)
    if "trump" in (text or "").lower() and "china" in (text or "").lower():
        # Override to general_chat to exercise the new override branch
        out = dict(base)
        out["requestType"] = "general_chat"
        out["reason"] = "stubbed_for_test_override"
        out["specificQuestionDetected"] = False
        return out
    return base

app.classify_news_request_type = _stub_general_chat_base
try:
    forced_route = app.classify_news_route_for_turn(
        "Did Trump go to China last week?", ctx=None
    )
    assert_(
        forced_route.get("route_classification") == "current_fact_search",
        "PART 5 guard: base=general_chat + fact_question Ã¢” ’ current_fact_search override",
        detail=str(forced_route),
    )
    assert_(
        bool(forced_route.get("serper_called")),
        "PART 5 guard: serper_called still True after override",
    )
    assert_(
        "general_chat_override_current_fact_question" in str(forced_route.get("reason") or ""),
        "PART 5 guard: reason explains the override",
    )
finally:
    app.classify_news_request_type = orig_classify

# Personal/emotional still wins even if score would have matched
emo_route = app.classify_news_route_for_turn(
    "I just heard terrible news, my dad died", ctx=None,
)
assert_(
    emo_route.get("route_classification") == "emotional_context",
    "PART 5 guard: emotional context not overridden",
    detail=str(emo_route),
)


# ---------------------------------------------------------------
# E. PART 6 — stored context after current_fact_search
# ---------------------------------------------------------------
section("E. PART 6 — recent_news_context after current_fact_search")

session_id = "smoke_current_fact_session"
app.recent_news_context.pop(session_id, None)

fake_action_result = {
    "data": {
        "query": "Trump China trip last week",
        "search_queries": ["Trump China visit last week"],
        "entities": ["Trump", "China"],
        "time_horizon": "last_week",
        "headlines": [{"title": "Trump arrives in Beijing", "source": "Reuters"}],
        "result_titles": ["Trump arrives in Beijing"],
        "result_sources": ["Reuters"],
        "result_urls": ["https://example.com/trump-china"],
        "result_published": ["2025-05-12"],
        "result_summaries": ["Reuters report on Trump's Beijing arrival."],
    },
    "spoken_reply": "I found Reuters coverage of Trump's China trip.",
}

# Mimic the real call path: polish-layer classifies as current_fact_search,
# action result is stored with previous_route_type=current_fact_search.
polish_route = app.classify_news_route_for_turn(
    "Did Trump go to China last week?", ctx=None
)
assert_(
    polish_route.get("route_classification") == "current_fact_search",
    "polish_route precondition: current_fact_search",
    detail=str(polish_route),
)

app.set_recent_news_context_from_action_result(
    session_id,
    "Did Trump go to China last week?",
    fake_action_result,
    previous_route_type=polish_route.get("route_classification") or "current_fact_search",
    answer_summary="Yes, Reuters confirms Trump visited Beijing last week.",
)

ctx = app.get_recent_news_context(session_id)
assert_(ctx is not None, "PART 6: ctx saved after current_fact_search")
if ctx:
    assert_(ctx.get("previous_route_type") == "current_fact_search",
            "PART 6: ctx.previous_route_type == 'current_fact_search'",
            detail=str(ctx.get("previous_route_type")))
    assert_(ctx.get("original_user_question") == "Did Trump go to China last week?",
            "PART 6: ctx.original_user_question preserved",
            detail=str(ctx.get("original_user_question")))
    assert_(ctx.get("resolved_topic") == "Trump China trip last week",
            "PART 6: ctx.resolved_topic set from action data",
            detail=str(ctx.get("resolved_topic")))
    assert_("Trump" in (ctx.get("entities") or []) and "China" in (ctx.get("entities") or []),
            "PART 6: ctx.entities includes Trump + China")
    assert_(ctx.get("answer_summary", "").startswith("Yes, Reuters confirms"),
            "PART 6: ctx.answer_summary captures the streamed reply",
            detail=str(ctx.get("answer_summary"))[:80])
    assert_(ctx.get("sources") == ctx.get("result_sources"),
            "PART 6: ctx.sources mirrors ctx.result_sources")
    assert_(isinstance(ctx.get("timestamp"), (int, float)),
            "PART 6: ctx.timestamp present")


# ---------------------------------------------------------------
# F. Follow-ups against stored current_fact_search context
# ---------------------------------------------------------------
section("F. Follow-ups against stored current_fact_search context")

# Interpretive — must NOT re-search
follow_interp = app.classify_news_route_for_turn("Why was he there?", ctx=ctx)
assert_(
    follow_interp.get("route_classification") == "interpretive_followup_llm_first",
    "PART 3: 'Why was he there?' Ã¢” ’ interpretive_followup_llm_first",
    detail=str(follow_interp),
)
assert_(not follow_interp.get("serper_called"),
        "PART 3: 'Why was he there?' Ã¢” ’ serper_called=False")

# What does that mean — interpretive
follow_meaning = app.classify_news_route_for_turn("What does that mean?", ctx=ctx)
assert_(
    follow_meaning.get("route_classification") == "interpretive_followup_llm_first",
    "PART 3: 'What does that mean?' Ã¢” ’ interpretive_followup_llm_first",
    detail=str(follow_meaning),
)

# Fresh update — must re-search
follow_update = app.classify_news_route_for_turn("Any updates today?", ctx=ctx)
assert_(
    follow_update.get("route_classification") == "fresh_update_followup",
    "PART 4: 'Any updates today?' Ã¢” ’ fresh_update_followup",
    detail=str(follow_update),
)
assert_(bool(follow_update.get("serper_called")),
        "PART 4: 'Any updates today?' Ã¢” ’ serper_called=True")

# Source-specific — uses stored cards
follow_source = app.classify_news_route_for_turn(
    "What does Reuters say?", ctx=ctx,
)
# Reuters mention is also a fresh_update keyword in the polish layer.
# Either fresh_update_followup OR source_specific_followup is acceptable
# as long as it does NOT route to interpretive (i.e., it searches/sources).
assert_(
    follow_source.get("route_classification") in (
        "fresh_update_followup",
        "source_specific_followup",
    ),
    "PART 4: 'What does Reuters say?' Ã¢” ’ fresh_update_followup OR source_specific_followup",
    detail=str(follow_source),
)


# ---------------------------------------------------------------
# G. PART 8 — spec manual tests, end-to-end
# ---------------------------------------------------------------
section("G. PART 8 — spec manual tests")

# Test 1 — Current fact search
t1 = app.classify_news_route_for_turn("Did Trump go to China last week?", ctx=None)
assert_(
    t1.get("route_classification") == "current_fact_search"
    and bool(t1.get("serper_called")),
    "Test 1: 'Did Trump go to China last week?' Ã¢” ’ current_fact_search + serper",
    detail=str(t1),
)

# Test 2 — Rephrased
t2 = app.classify_news_route_for_turn(
    "Did Donald Trump go to China last week?", ctx=None,
)
assert_(
    t2.get("route_classification") == "current_fact_search"
    and bool(t2.get("serper_called")),
    "Test 2: 'Did Donald Trump go to China last week?' Ã¢” ’ current_fact_search + serper",
    detail=str(t2),
)

# Test 3 — Interpretive follow-up (uses stored ctx from PART 6)
t3 = app.classify_news_route_for_turn("Why was he there?", ctx=ctx)
assert_(
    t3.get("route_classification") == "interpretive_followup_llm_first"
    and not t3.get("serper_called"),
    "Test 3: 'Why was he there?' Ã¢” ’ interpretive_followup_llm_first (no serper)",
    detail=str(t3),
)

# Test 4 — Explanation follow-up
t4 = app.classify_news_route_for_turn("What does that mean?", ctx=ctx)
assert_(
    t4.get("route_classification") == "interpretive_followup_llm_first"
    and not t4.get("serper_called"),
    "Test 4: 'What does that mean?' Ã¢” ’ interpretive_followup_llm_first (no serper)",
    detail=str(t4),
)

# Test 5 — Fresh update follow-up
t5 = app.classify_news_route_for_turn("Any updates today?", ctx=ctx)
assert_(
    t5.get("route_classification") == "fresh_update_followup"
    and bool(t5.get("serper_called")),
    "Test 5: 'Any updates today?' Ã¢” ’ fresh_update_followup + serper",
    detail=str(t5),
)

# Test 6 — Source-specific follow-up (with stored Reuters card)
t6 = app.classify_news_route_for_turn("What does Reuters say?", ctx=ctx)
assert_(
    t6.get("route_classification") in (
        "fresh_update_followup",
        "source_specific_followup",
    ),
    "Test 6: 'What does Reuters say?' Ã¢” ’ re-searches OR uses stored sources",
    detail=str(t6),
)

# Test 7 — General public figure current fact
t7 = app.classify_news_route_for_turn(
    "Did Elon Musk win the case against OpenAI?", ctx=None,
)
assert_(
    t7.get("route_classification") == "current_fact_search"
    and bool(t7.get("serper_called")),
    "Test 7: 'Did Elon Musk win the case against OpenAI?' Ã¢” ’ current_fact_search + serper",
    detail=str(t7),
)

# Test 8 — Personal news still suppressed
t8 = app.classify_news_route_for_turn(
    "I just saw the news my friend passed away", ctx=None,
)
assert_(
    t8.get("route_classification") in ("emotional_context", "personal_news_statement"),
    "Test 8: personal news still suppressed (no news route)",
    detail=str(t8),
)
assert_(
    not t8.get("serper_called"),
    "Test 8: personal news Ã¢” ’ serper_called=False",
)


# ---------------------------------------------------------------
# H. PART 7 — structured log emits the expected fields
# ---------------------------------------------------------------
section("H. PART 7 — [news_current_fact_decision] log shape")

import json as _json

logged_lines: list[str] = []

orig_print = print

def _capture_print(*args, **kwargs):
    msg = " ".join(str(a) for a in args)
    if msg.startswith("[news_current_fact_decision]"):
        logged_lines.append(msg)
    return orig_print(*args, **kwargs)

import builtins as _bi
_bi.print = _capture_print
try:
    score = app.score_current_fact_question("Did Trump go to China last week?")
    app.log_current_fact_question_decision(
        "log_test_session", "Did Trump go to China last week?", score,
        routed_to="current_fact_search", serper_called=True,
        reason="yes_no_question_about_recent_public_event",
    )
finally:
    _bi.print = orig_print

assert_(len(logged_lines) >= 1,
        "PART 7: [news_current_fact_decision] line was emitted")

if logged_lines:
    payload_str = logged_lines[-1].split("[news_current_fact_decision]", 1)[-1].strip()
    try:
        payload = _json.loads(payload_str)
    except Exception:
        payload = {}
    for key in (
        "session_id",
        "latest_user_text",
        "question_shape_detected",
        "public_entity_detected",
        "public_domain_noun_detected",
        "recent_time_marker_detected",
        "current_fact_question_score",
        "matches",
        "routed_to",
        "serper_called",
        "reason",
    ):
        assert_(key in payload, f"PART 7: log payload contains '{key}'",
                detail=str(payload))


# ---------------------------------------------------------------
# I. Negative regression — yes/no questions that are NOT fact-checks
# ---------------------------------------------------------------
section("I. Negative regression — non-news yes/no questions")

NEGATIVE_END_TO_END = [
    ("Did you sleep well?", "general_chat"),
    ("Is dinner ready?", "general_chat"),
    ("Did I send the email?", "general_chat"),
    ("Tell me a joke", "general_chat"),
]

for text, expected in NEGATIVE_END_TO_END:
    route = app.classify_news_route_for_turn(text, ctx=None)
    assert_(
        route.get("route_classification") == expected,
        f"neg: {text!r} Ã¢” ’ {expected}",
        detail=str(route),
    )


# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
print()
print("Ã¢”â‚¬" * 56)
total = PASS + FAIL
status_color = GREEN if FAIL == 0 else RED
print(f"  Total: {total}   {GREEN}Pass: {PASS}{RESET}   {status_color}Fail: {FAIL}{RESET}")
if FAILED:
    print()
    print("  Failed tests:")
    for n in FAILED:
        print(f"    - {n}")

sys.exit(0 if FAIL == 0 else 1)
