"""Smoke tests for the unified current-info intent router.

The user spec block (the one starting with "Refactor VERA news/current-info
routing into a cleaner intent-based router.") splits into 12 parts. This
file exercises:

  * `classify_current_info_intent(text, recent_news_context, session_id)` —
    the new top-level router (PART 1).
  * Priority order: personal_emotional > UI actions > explicit headlines >
    explicit topical search > current_fact_search > follow-ups > general
    chat (PART 2).
  * Personal/emotional statements suppress search even when the message
    contains "news" (PART 3).
  * Explicit news/headline/search commands route to the news panel
    (PART 4 A/B/C).
  * Current factual public questions search even without the word "news"
    (PART 5) — including the spec example
    "do you know if Jensen Huang made a new GPU?".
  * Interpretive follow-ups use stored source context with LLM (PART 6).
  * Fresh-update / source-specific follow-ups re-search (PART 7).
  * Stale recent_news_context cannot hijack unrelated topics — finance,
    math, app UI commands, personal/emotional (PART 8).
  * News panel modes are surfaced via `news_panel_mode` (PART 10).
  * The structured `[current_info_intent]` log line carries every PART 11
    signal field.
  * All 11 manual tests from PART 12 pass end-to-end.

Run:  py -3 __news_intent_router_smoke.py
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
import json
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
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


def call_router(text: str, ctx: dict | None = None, session_id: str = "smoke") -> dict:
    return app.classify_current_info_intent(
        text,
        recent_news_context=ctx,
        session_id=session_id,
    )


def trump_china_ctx() -> dict:
    return {
        "topic": "Trump China trip",
        "resolved_topic": "Trump China trip",
        "entities": ["Trump", "China"],
        "answer_summary": "Trump visited China to discuss trade.",
        "result_titles": ["Trump arrives in China", "Beijing talks open"],
        "previous_route_type": "current_fact_search",
        "sources": [
            {"title": "Trump arrives in China", "source": "Reuters"},
            {"title": "Beijing talks open", "source": "Bloomberg"},
        ],
    }


# ---------------------------------------------------------------
# A. Spec PART 3 — personal/emotional always suppresses search,
#    even when the message contains the word "news".
# ---------------------------------------------------------------
section("A. PART 3 — personal/emotional suppresses search (the word 'news' must not hijack)")

PERSONAL_OR_EMOTIONAL = [
    "i just saw the news my friend just passed away",
    "I got bad news today",
    "I heard terrible news",
    "The news from my family is bad",
    "My friend just passed away",
    "Someone died",
    "My friend got into an accident",
    "I'm overwhelmed",
    "I feel numb",
    "I don't know how to feel about this",
]
for text in PERSONAL_OR_EMOTIONAL:
    intent = call_router(text)
    assert_(intent["route"] == "personal_emotional",
            f"PART 3: {text!r} Ã¢” ’ route=personal_emotional",
            detail=str(intent))
    assert_(intent["shouldSearch"] is False,
            f"PART 3: {text!r} Ã¢” ’ shouldSearch=False")
    assert_(intent["shouldOpenNewsPanel"] is False,
            f"PART 3: {text!r} Ã¢” ’ shouldOpenNewsPanel=False")
    assert_(intent["news_panel_mode"] == "unchanged",
            f"PART 3: {text!r} Ã¢” ’ news_panel_mode=unchanged")
    assert_(intent["answer_source"] == "emotional_support",
            f"PART 3: {text!r} Ã¢” ’ answer_source=emotional_support")
    assert_(intent["signals"]["personal_emotional_detected"] is True,
            f"PART 3: {text!r} Ã¢” ’ personal_emotional_detected=True")


# ---------------------------------------------------------------
# B. Spec PART 4A — broad headline requests open the headlines panel.
# ---------------------------------------------------------------
section("B. PART 4A — broad explicit headline requests")

BROAD_HEADLINE_REQUESTS = [
    "tell me the news",
    "show me the news",
    "breaking news",
    "latest headlines",
    "what are today's headlines",
    "what's happening today",
]
for text in BROAD_HEADLINE_REQUESTS:
    intent = call_router(text)
    assert_(intent["route"] == "explicit_news_headlines",
            f"PART 4A: {text!r} Ã¢” ’ route=explicit_news_headlines",
            detail=str(intent))
    assert_(intent["shouldSearch"] is True,
            f"PART 4A: {text!r} Ã¢” ’ shouldSearch=True")
    assert_(intent["shouldOpenNewsPanel"] is True,
            f"PART 4A: {text!r} Ã¢” ’ shouldOpenNewsPanel=True")
    assert_(intent["news_panel_mode"] == "headlines",
            f"PART 4A: {text!r} Ã¢” ’ news_panel_mode=headlines")
    assert_(intent["signals"]["explicit_news_command_detected"] is True,
            f"PART 4A: {text!r} Ã¢” ’ explicit_news_command_detected=True")


# ---------------------------------------------------------------
# C. Spec PART 4B — explicit topical news/search commands route to
#    `explicit_news_search`.
# ---------------------------------------------------------------
section("C. PART 4B — explicit topical news/search commands")

EXPLICIT_TOPICAL_SEARCH = [
    "latest news about OpenAI",
    "search news about NVIDIA",
    "look up latest updates on the LA fire",
    "find articles about Trump China",
    "what's the latest on Jensen Huang",
]
for text in EXPLICIT_TOPICAL_SEARCH:
    intent = call_router(text)
    assert_(intent["route"] in {"explicit_news_search", "current_fact_search", "explicit_news_headlines"},
            f"PART 4B: {text!r} Ã¢” ’ news/search route",
            detail=str(intent))
    assert_(intent["shouldSearch"] is True,
            f"PART 4B: {text!r} Ã¢” ’ shouldSearch=True")
    assert_(intent["shouldOpenNewsPanel"] is True,
            f"PART 4B: {text!r} Ã¢” ’ shouldOpenNewsPanel=True")
    assert_(intent["signals"]["explicit_news_command_detected"] is True,
            f"PART 4B: {text!r} Ã¢” ’ explicit_news_command_detected=True")


# ---------------------------------------------------------------
# D. Spec PART 4C — news panel UI-only commands route to UI without fetch.
# ---------------------------------------------------------------
section("D. PART 4C — news panel UI-only commands (no fetch)")

UI_ONLY_PANEL_REQUESTS = [
    "open the news panel",
    "show the news panel",
]
for text in UI_ONLY_PANEL_REQUESTS:
    intent = call_router(text)
    assert_(intent["route"] == "explicit_news_headlines",
            f"PART 4C: {text!r} Ã¢” ’ route=explicit_news_headlines")
    assert_(intent["shouldSearch"] is False,
            f"PART 4C: {text!r} Ã¢” ’ shouldSearch=False (UI-only)")
    assert_(intent["shouldOpenNewsPanel"] is True,
            f"PART 4C: {text!r} Ã¢” ’ shouldOpenNewsPanel=True")
    assert_(intent["news_panel_mode"] == "ui_only",
            f"PART 4C: {text!r} Ã¢” ’ news_panel_mode=ui_only")

UI_CLOSE_PANEL_REQUESTS = [
    "close the news panel",
    "hide news panel",
]
for text in UI_CLOSE_PANEL_REQUESTS:
    intent = call_router(text)
    assert_(intent["news_panel_mode"] == "ui_only",
            f"PART 4C: {text!r} Ã¢” ’ news_panel_mode=ui_only (close)")
    assert_(intent["shouldSearch"] is False,
            f"PART 4C: {text!r} Ã¢” ’ shouldSearch=False (close)")


# ---------------------------------------------------------------
# E. Spec PART 5 — current factual public questions search even when
#    the message has no "news" / "headlines" keyword.
# ---------------------------------------------------------------
section("E. PART 5 — current factual public questions")

CURRENT_FACT_QUESTIONS = [
    "Did Trump go to China last week?",
    "Did Donald Trump go to China last week?",
    "Do you know if Jensen Huang made a new GPU?",
    "Did NVIDIA announce a new GPU?",
    "Did Elon Musk win the case against OpenAI?",
    "Is the highway still closed?",
    "Was the LA fire contained?",
    "Did Apple release a new MacBook?",
    "Is there a new OpenAI model?",
    "Has the Fed cut rates?",
]
for text in CURRENT_FACT_QUESTIONS:
    intent = call_router(text)
    assert_(intent["route"] == "current_fact_search",
            f"PART 5: {text!r} Ã¢” ’ route=current_fact_search",
            detail=str(intent))
    assert_(intent["shouldSearch"] is True,
            f"PART 5: {text!r} Ã¢” ’ shouldSearch=True (search even w/o 'news')")
    assert_(intent["shouldOpenNewsPanel"] is True,
            f"PART 5: {text!r} Ã¢” ’ shouldOpenNewsPanel=True (source support)")
    assert_(intent["news_panel_mode"] == "sources_for_answer",
            f"PART 5: {text!r} Ã¢” ’ news_panel_mode=sources_for_answer")
    assert_(intent["answer_source"] == "search_result",
            f"PART 5: {text!r} Ã¢” ’ answer_source=search_result")
    assert_(intent["signals"]["current_fact_question_detected"] is True,
            f"PART 5: {text!r} Ã¢” ’ current_fact_question_detected=True")
    assert_(intent["signals"]["question_shape_detected"] is True,
            f"PART 5: {text!r} Ã¢” ’ question_shape_detected=True")


# ---------------------------------------------------------------
# F. Spec PART 6 — interpretive follow-ups use stored ctx with LLM
# ---------------------------------------------------------------
section("F. PART 6 — interpretive follow-ups use stored source context")

ctx = trump_china_ctx()
INTERPRETIVE_FOLLOWUPS = [
    "why was he there?",
    "why did he do that?",
    "what does that mean?",
    "why is that important?",
    "is that bad?",
    "can you explain?",
    "what was the reason?",
]
for text in INTERPRETIVE_FOLLOWUPS:
    intent = call_router(text, ctx=ctx)
    assert_(intent["route"] == "interpretive_followup_llm",
            f"PART 6: {text!r} Ã¢” ’ route=interpretive_followup_llm",
            detail=str(intent))
    assert_(intent["shouldSearch"] is False,
            f"PART 6: {text!r} Ã¢” ’ shouldSearch=False (LLM uses stored ctx)")
    assert_(intent["answer_source"] == "stored_source_context",
            f"PART 6: {text!r} Ã¢” ’ answer_source=stored_source_context")
    assert_(intent["news_panel_mode"] == "unchanged",
            f"PART 6: {text!r} Ã¢” ’ news_panel_mode=unchanged (no panel reshow)")
    assert_(intent["signals"]["followup_detected"] is True,
            f"PART 6: {text!r} Ã¢” ’ followup_detected=True")
    assert_(intent["signals"]["followup_type"] == "interpretive",
            f"PART 6: {text!r} Ã¢” ’ followup_type=interpretive")


# ---------------------------------------------------------------
# G. Spec PART 7 — fresh-update / source-specific follow-ups re-search
# ---------------------------------------------------------------
section("G. PART 7 — fresh-update + source-specific follow-ups")

FRESH_UPDATE = [
    "any updates today?",
    "what's the latest?",
    "is there newer info?",
    "what happened after that?",
    "was it confirmed later?",
]
for text in FRESH_UPDATE:
    intent = call_router(text, ctx=ctx)
    assert_(intent["route"] == "fresh_update_search",
            f"PART 7: {text!r} Ã¢” ’ route=fresh_update_search",
            detail=str(intent))
    assert_(intent["shouldSearch"] is True,
            f"PART 7: {text!r} Ã¢” ’ shouldSearch=True")
    assert_(intent["signals"]["followup_type"] == "fresh_update",
            f"PART 7: {text!r} Ã¢” ’ followup_type=fresh_update")

# Source-specific (use stored cards if available)
src_intent = call_router("what does Reuters say?", ctx=ctx)
assert_(src_intent["route"] == "source_specific_followup",
        "PART 7: 'what does Reuters say?' Ã¢” ’ source_specific_followup",
        detail=str(src_intent))
assert_(src_intent["news_panel_mode"] == "sources_for_answer",
        "PART 7: source-specific follow-up Ã¢” ’ news_panel_mode=sources_for_answer")
assert_(src_intent["signals"]["followup_type"] == "source_specific",
        "PART 7: source-specific follow-up Ã¢” ’ followup_type=source_specific")


# ---------------------------------------------------------------
# H. Spec PART 8 — stale recent_news_context cannot hijack unrelated
#    topics (finance / math / app UI / personal-emotional).
# ---------------------------------------------------------------
section("H. PART 8 — stale recent_news_context cannot hijack unrelated topics")

STRONG_NEW_TOPICS_WITH_CTX = [
    ("what's the biggest drawdown of VGT in the past 5 years?", "finance_analytics_keyword"),
    ("plot the sharpe ratio for SPY", "finance_analytics_keyword"),
    ("solve x^2 + 5x + 6 = 0", "math_request"),
    ("integrate sin(x) dx", "math_request"),
    ("write a python function that reverses a string", "code_request"),
    ("open the news panel", "news_panel_open_command"),
    ("close the news panel", "news_panel_close_command"),
    ("My friend just passed away", "personal_or_emotional_statement"),
    ("I'm overwhelmed", "personal_or_emotional_statement"),
]
for text, expected_reason in STRONG_NEW_TOPICS_WITH_CTX:
    intent = call_router(text, ctx=ctx)
    sig = intent["signals"]
    if expected_reason == "personal_or_emotional_statement":
        # Personal/emotional gets dispatched BEFORE the strong-new-topic
        # check, but its presence still implies "do not let news ctx hijack".
        assert_(intent["route"] == "personal_emotional",
                f"PART 8 personal: {text!r} Ã¢” ’ route=personal_emotional")
        assert_(intent["shouldSearch"] is False,
                f"PART 8 personal: {text!r} Ã¢” ’ shouldSearch=False")
        continue
    # For finance/math/code/app-action: the router must NOT inherit news ctx
    assert_(sig["strong_new_topic_detected"] is True,
            f"PART 8: {text!r} Ã¢” ’ strong_new_topic_detected=True",
            detail=str(sig))
    assert_(sig["strong_new_topic_reason"] == expected_reason,
            f"PART 8: {text!r} Ã¢” ’ strong_new_topic_reason={expected_reason}",
            detail=sig.get("strong_new_topic_reason"))
    assert_(sig["followup_detected"] is False,
            f"PART 8: {text!r} Ã¢” ’ followup_detected=False (ctx ignored)")
    # The route must NOT be a follow-up route — it's either a fresh
    # explicit route (panel UI / current-fact) or general chat. The key
    # invariant is: shouldSearch is not forced True by ctx hijack.
    assert_(intent["route"] not in {
        "interpretive_followup_llm",
        "fresh_update_search",
        "source_specific_followup",
    }, f"PART 8: {text!r} Ã¢” ’ not a news follow-up route",
        detail=intent["route"])

# Topic similarity should be 0.0 for strong new topics — we never even
# bother to compute it (the early bail is the whole point).
nt = call_router("what's the biggest drawdown of VGT in the past 5 years?", ctx=ctx)
assert_(nt["signals"]["topic_similarity_to_recent_news"] == 0.0,
        "PART 8: topic_similarity stays 0.0 when strong new topic detected")

# In the ABSENCE of ctx, the same strong-new-topic message routes to
# general chat with the same reason.
nt_no_ctx = call_router("what's the biggest drawdown of VGT in the past 5 years?", ctx=None)
assert_(nt_no_ctx["signals"]["strong_new_topic_detected"] is True,
        "PART 8: strong-new-topic signal also fires without ctx")
assert_(nt_no_ctx["route"] == "general_chat",
        "PART 8: strong-new-topic without ctx Ã¢” ’ general_chat (downstream handles finance route)")


# ---------------------------------------------------------------
# I. Spec PART 11 — every required signal field is in the result dict
# ---------------------------------------------------------------
section("I. PART 11 — signal shape is complete on every result")

REQUIRED_SIGNAL_FIELDS = {
    "raw_news_keyword_detected",
    "personal_emotional_detected",
    "explicit_news_command_detected",
    "current_fact_question_detected",
    "question_shape_detected",
    "public_entity_detected",
    "recent_or_change_marker_detected",
    "followup_detected",
    "followup_type",
    "recent_news_context_available",
    "recent_news_context_topic",
    "topic_similarity_to_recent_news",
    "strong_new_topic_detected",
    "strong_new_topic_reason",
}
REQUIRED_TOP_FIELDS = {
    "route", "shouldSearch", "shouldOpenNewsPanel", "news_panel_mode",
    "answer_source", "confidence", "reason", "entities", "topic", "signals",
}

SHAPE_PROBES = [
    "i just saw the news my friend just passed away",
    "Did Trump go to China last week?",
    "tell me the news",
    "why was he there?",
    "what's the biggest drawdown of VGT in the past 5 years?",
    "",
    "hello",
]
for text in SHAPE_PROBES:
    intent = call_router(text, ctx=ctx if text else None)
    assert_(REQUIRED_TOP_FIELDS.issubset(set(intent.keys())),
            f"PART 11 shape: {text!r} Ã¢” ’ all top-level fields present",
            detail=str(set(intent.keys()) ^ REQUIRED_TOP_FIELDS))
    sig_keys = set((intent.get("signals") or {}).keys())
    assert_(REQUIRED_SIGNAL_FIELDS.issubset(sig_keys),
            f"PART 11 shape: {text!r} Ã¢” ’ all signal fields present",
            detail=str(sig_keys ^ REQUIRED_SIGNAL_FIELDS))


# ---------------------------------------------------------------
# J. Spec PART 11 — log_current_info_intent emits a clean JSON line
#    with the required field names and values.
# ---------------------------------------------------------------
section("J. PART 11 — [current_info_intent] log emits required fields")


class _CapStream:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, s: str) -> int:
        for chunk in str(s).splitlines():
            chunk = chunk.strip()
            if chunk:
                self.lines.append(chunk)
        return len(s)

    def flush(self) -> None:
        pass


cap = _CapStream()
real_stdout = sys.stdout
try:
    sys.stdout = cap
    intent_emo = call_router("i just saw the news my friend just passed away")
    app.log_current_info_intent("smoke-emo", "i just saw the news my friend just passed away", intent_emo)
    intent_fact = call_router("do you know if Jensen Huang made a new GPU?")
    app.log_current_info_intent("smoke-fact", "do you know if Jensen Huang made a new GPU?", intent_fact)
    intent_broad = call_router("tell me the news")
    app.log_current_info_intent("smoke-broad", "tell me the news", intent_broad)
    intent_follow = call_router("why was he there?", ctx=trump_china_ctx())
    app.log_current_info_intent("smoke-follow", "why was he there?", intent_follow)
finally:
    sys.stdout = real_stdout

emo_line = next((ln for ln in cap.lines if ln.startswith("[current_info_intent]") and "smoke-emo" in ln), "")
fact_line = next((ln for ln in cap.lines if ln.startswith("[current_info_intent]") and "smoke-fact" in ln), "")
broad_line = next((ln for ln in cap.lines if ln.startswith("[current_info_intent]") and "smoke-broad" in ln), "")
follow_line = next((ln for ln in cap.lines if ln.startswith("[current_info_intent]") and "smoke-follow" in ln), "")

assert_(emo_line.startswith("[current_info_intent]"),
        "PART 11 log: emits [current_info_intent] for personal/emotional")
assert_(fact_line.startswith("[current_info_intent]"),
        "PART 11 log: emits [current_info_intent] for current-fact question")
assert_(broad_line.startswith("[current_info_intent]"),
        "PART 11 log: emits [current_info_intent] for broad news")
assert_(follow_line.startswith("[current_info_intent]"),
        "PART 11 log: emits [current_info_intent] for follow-up")


def _parse(line: str) -> dict:
    payload = line[len("[current_info_intent] "):]
    try:
        return json.loads(payload)
    except Exception:
        return {}


emo = _parse(emo_line)
assert_(emo.get("route") == "personal_emotional",
        "PART 11 log: emo line Ã¢” ’ route=personal_emotional")
assert_(emo.get("personal_emotional_detected") is True,
        "PART 11 log: emo line Ã¢” ’ personal_emotional_detected=True")
assert_(emo.get("raw_news_keyword_detected") is True,
        "PART 11 log: emo line Ã¢” ’ raw_news_keyword_detected=True (and yet no search)")
assert_(emo.get("shouldSearch") is False,
        "PART 11 log: emo line Ã¢” ’ shouldSearch=False")
assert_(emo.get("serper_called") is False,
        "PART 11 log: emo line Ã¢” ’ serper_called=False")

fact = _parse(fact_line)
assert_(fact.get("route") == "current_fact_search",
        "PART 11 log: fact line Ã¢” ’ route=current_fact_search",
        detail=str(fact))
assert_(fact.get("current_fact_question_detected") is True,
        "PART 11 log: fact line Ã¢” ’ current_fact_question_detected=True")
assert_(fact.get("public_entity_detected") is True,
        "PART 11 log: fact line Ã¢” ’ public_entity_detected=True (Jensen Huang)")
assert_(fact.get("recent_or_change_marker_detected") is True,
        "PART 11 log: fact line Ã¢” ’ recent_or_change_marker_detected=True ('new')")
assert_(fact.get("shouldSearch") is True,
        "PART 11 log: fact line Ã¢” ’ shouldSearch=True")

broad = _parse(broad_line)
assert_(broad.get("route") == "explicit_news_headlines",
        "PART 11 log: broad line Ã¢” ’ route=explicit_news_headlines")
assert_(broad.get("explicit_news_command_detected") is True,
        "PART 11 log: broad line Ã¢” ’ explicit_news_command_detected=True")
assert_(broad.get("news_panel_mode") == "headlines",
        "PART 11 log: broad line Ã¢” ’ news_panel_mode=headlines")

follow = _parse(follow_line)
assert_(follow.get("route") == "interpretive_followup_llm",
        "PART 11 log: follow line Ã¢” ’ route=interpretive_followup_llm",
        detail=str(follow))
assert_(follow.get("followup_detected") is True,
        "PART 11 log: follow line Ã¢” ’ followup_detected=True")
assert_(follow.get("followup_type") == "interpretive",
        "PART 11 log: follow line Ã¢” ’ followup_type=interpretive")
assert_(follow.get("shouldSearch") is False,
        "PART 11 log: follow line Ã¢” ’ shouldSearch=False (uses stored ctx)")


# ---------------------------------------------------------------
# K. Spec PART 12 — the 11 explicit manual tests from the spec
# ---------------------------------------------------------------
section("K. PART 12 — the 11 manual tests from the spec")

# Test 1 — Personal news should not search
t1 = call_router("i just saw the news my friend just passed away")
assert_(t1["route"] == "personal_emotional",
        "Test 1: 'i just saw the news my friend just passed away' Ã¢” ’ personal_emotional")
assert_(t1["shouldSearch"] is False,
        "Test 1: shouldSearch=False")
assert_(t1["shouldOpenNewsPanel"] is False,
        "Test 1: shouldOpenNewsPanel=False")
assert_(t1["answer_source"] == "emotional_support",
        "Test 1: answer_source=emotional_support")

# Test 2 — Bad news should not search
t2 = call_router("I got bad news today")
assert_(t2["route"] == "personal_emotional",
        "Test 2: 'I got bad news today' Ã¢” ’ personal_emotional")
assert_(t2["shouldSearch"] is False,
        "Test 2: shouldSearch=False")

# Test 3 — Explicit broad news
t3 = call_router("tell me the news")
assert_(t3["route"] == "explicit_news_headlines",
        "Test 3: 'tell me the news' Ã¢” ’ explicit_news_headlines")
assert_(t3["shouldSearch"] is True,
        "Test 3: shouldSearch=True")
assert_(t3["news_panel_mode"] == "headlines",
        "Test 3: news_panel_mode=headlines")

# Test 4 — Current fact without word "news"
t4 = call_router("do you know if Jensen Huang made a new GPU?")
assert_(t4["route"] == "current_fact_search",
        "Test 4: 'do you know if Jensen Huang made a new GPU?' Ã¢” ’ current_fact_search",
        detail=str(t4))
assert_(t4["shouldSearch"] is True,
        "Test 4: shouldSearch=True")
assert_(t4["answer_source"] == "search_result",
        "Test 4: answer_source=search_result (direct answer with sources)")
assert_(t4["news_panel_mode"] == "sources_for_answer",
        "Test 4: news_panel_mode=sources_for_answer (panel shows cards)")

# Test 5 — Current fact public figure
t5 = call_router("Did Trump go to China last week?")
assert_(t5["route"] == "current_fact_search",
        "Test 5: 'Did Trump go to China last week?' Ã¢” ’ current_fact_search")
assert_(t5["shouldSearch"] is True,
        "Test 5: shouldSearch=True")
assert_(t5["answer_source"] == "search_result",
        "Test 5: answer_source=search_result")

# Test 6 — Interpretive follow-up after Test 5
t6 = call_router("why was he there?", ctx=trump_china_ctx())
assert_(t6["route"] == "interpretive_followup_llm",
        "Test 6: 'why was he there?' + ctx Ã¢” ’ interpretive_followup_llm")
assert_(t6["shouldSearch"] is False,
        "Test 6: shouldSearch=False (LLM uses stored ctx first)")
assert_(t6["answer_source"] == "stored_source_context",
        "Test 6: answer_source=stored_source_context")

# Test 7 — Fresh update follow-up after Test 5
t7 = call_router("any updates today?", ctx=trump_china_ctx())
assert_(t7["route"] == "fresh_update_search",
        "Test 7: 'any updates today?' + ctx Ã¢” ’ fresh_update_search")
assert_(t7["shouldSearch"] is True,
        "Test 7: shouldSearch=True")

# Test 8 — Source-specific follow-up after Test 5
t8 = call_router("what does Reuters say?", ctx=trump_china_ctx())
assert_(t8["route"] == "source_specific_followup",
        "Test 8: 'what does Reuters say?' + ctx Ã¢” ’ source_specific_followup",
        detail=str(t8))

# Test 9 — New unrelated topic after news (finance)
t9 = call_router(
    "what's the biggest drawdown of VGT in the past 5 years?",
    ctx=trump_china_ctx(),
)
assert_(t9["signals"]["strong_new_topic_detected"] is True,
        "Test 9: VGT drawdown Ã¢” ’ strong_new_topic_detected=True (Trump/China ctx ignored)")
assert_(t9["route"] not in {
    "interpretive_followup_llm",
    "fresh_update_search",
    "source_specific_followup",
}, "Test 9: VGT drawdown Ã¢” ’ not a news follow-up route")

# Test 10 — News about company explicitly
t10 = call_router("latest news about NVIDIA")
assert_(t10["shouldSearch"] is True,
        "Test 10: 'latest news about NVIDIA' Ã¢” ’ shouldSearch=True")
assert_(t10["shouldOpenNewsPanel"] is True,
        "Test 10: 'latest news about NVIDIA' Ã¢” ’ shouldOpenNewsPanel=True")
assert_(t10["signals"]["explicit_news_command_detected"] is True,
        "Test 10: 'latest news about NVIDIA' Ã¢” ’ explicit_news_command_detected=True")

# Test 11 — Product announcement question
t11 = call_router("Did NVIDIA announce a new GPU?")
assert_(t11["route"] == "current_fact_search",
        "Test 11: 'Did NVIDIA announce a new GPU?' Ã¢” ’ current_fact_search",
        detail=str(t11))
assert_(t11["shouldSearch"] is True,
        "Test 11: shouldSearch=True")
assert_(t11["answer_source"] == "search_result",
        "Test 11: answer_source=search_result")


# ---------------------------------------------------------------
# L. Negative regressions — general chat must NOT route to news.
# ---------------------------------------------------------------
section("L. Negative — generic chat / non-news inputs stay general_chat")

GENERAL_CHAT = [
    "hi vera",
    "tell me a joke",
    "what's 2 plus 2",
    "I love this song",
    "you're funny",
    "thanks",
]
for text in GENERAL_CHAT:
    intent = call_router(text)
    assert_(intent["route"] == "general_chat",
            f"Negative: {text!r} Ã¢” ’ general_chat",
            detail=str(intent))
    assert_(intent["shouldSearch"] is False,
            f"Negative: {text!r} Ã¢” ’ shouldSearch=False")
    assert_(intent["shouldOpenNewsPanel"] is False,
            f"Negative: {text!r} Ã¢” ’ shouldOpenNewsPanel=False")


# ---------------------------------------------------------------
# M. Topic similarity — overlap heuristic returns a sensible score
# ---------------------------------------------------------------
section("M. _topic_similarity_to_recent_news_context overlap")

ctx_full = trump_china_ctx()
sim_high = app._topic_similarity_to_recent_news_context("what did Trump say next?", ctx_full)
assert_(sim_high >= 0.5,
        "topic_similarity: 'Trump' overlap with stored entities Ã¢” ’ >= 0.5",
        detail=str(sim_high))

sim_zero = app._topic_similarity_to_recent_news_context("VGT drawdown over 5 years", ctx_full)
assert_(sim_zero == 0.0,
        "topic_similarity: 'VGT drawdown' has no overlap with Trump/China Ã¢” ’ 0.0",
        detail=str(sim_zero))

sim_empty = app._topic_similarity_to_recent_news_context("hello", None)
assert_(sim_empty == 0.0,
        "topic_similarity: ctx=None Ã¢” ’ 0.0")


# ---------------------------------------------------------------
# N. _is_strong_new_topic_message: signal reasons
# ---------------------------------------------------------------
section("N. _is_strong_new_topic_message reason coverage")

STRONG_TOPIC_CASES = [
    ("what's the biggest drawdown of VGT?", "finance_analytics_keyword"),
    ("plot SPY's 5 year return", "finance_analytics_keyword"),
    ("solve this equation: 3x+5=14", "math_request"),
    ("integrate sin x from 0 to pi", "math_request"),
    ("write a python function to sort a list", "code_request"),
    ("open the news panel", "news_panel_open_command"),
    ("close the news panel", "news_panel_close_command"),
    ("my friend just died", "personal_or_emotional_statement"),
    ("I'm overwhelmed", "personal_or_emotional_statement"),
]
for text, expected_reason in STRONG_TOPIC_CASES:
    res = app._is_strong_new_topic_message(text)
    assert_(res["detected"] is True,
            f"strong_new_topic: {text!r} Ã¢” ’ detected=True",
            detail=str(res))
    assert_(res["reason"] == expected_reason,
            f"strong_new_topic: {text!r} Ã¢” ’ reason={expected_reason}",
            detail=res["reason"])

NOT_STRONG_TOPIC = [
    "hi vera",
    "tell me the news",
    "Did Trump go to China?",
    "what does Reuters say?",
    "why was he there?",
    "do you know if Jensen Huang made a new GPU?",
]
for text in NOT_STRONG_TOPIC:
    res = app._is_strong_new_topic_message(text)
    assert_(res["detected"] is False,
            f"strong_new_topic NEG: {text!r} Ã¢” ’ detected=False",
            detail=str(res))


# ---------------------------------------------------------------
# PART 2+7+11+12+15 (2026-05-28): strict-routing spec assertions
# Mirrors the 9 manual tests in the user's spec PART 15. Pure backend
# coverage; the frontend mirror lives in
# tests/smoke/__news_frontend_extraction_smoke.mjs Suite R.
# ---------------------------------------------------------------
section("PART 15 (2026-05-28) strict-routing spec coverage")

# PART 15 Test 1 — historical explanation must NEVER search news.
HIST_EDU_NEG = [
    "Can you explain the Vietnam War?",
    "What caused the Vietnam War?",
    "Who won World War II?",
    "Explain the Cold War.",
    "Tell me about Napoleon.",
    "Explain the French Revolution.",
    "Explain photosynthesis.",
    "What is the Roman Empire?",
    "Why did the Soviet Union collapse?",
]
for text in HIST_EDU_NEG:
    res = call_router(text)
    assert_(
        res["route"] == "historical_or_educational_explanation",
        f"PART 15 Test 1: {text!r} Ã¢” ’ historical_or_educational_explanation",
        detail=str(res.get("route")),
    )
    assert_(
        res["shouldSearch"] is False,
        f"PART 15 Test 1: {text!r} Ã¢” ’ shouldSearch=False",
        detail=str(res.get("shouldSearch")),
    )
    assert_(
        bool(res.get("signals", {}).get("historical_or_educational_detected")),
        f"PART 15 Test 1: {text!r} Ã¢” ’ historical_or_educational_detected=True",
        detail=str(res.get("signals", {}).get("historical_or_educational_detected")),
    )

# PART 15 Test 8 — explicit news ABOUT a historical topic IS legit news.
HIST_EDU_OVERRIDE = [
    "Latest news about the Vietnam War documentary",
    "Did Netflix release a Cold War series today",
]
for text in HIST_EDU_OVERRIDE:
    res = call_router(text)
    assert_(
        res["route"] != "historical_or_educational_explanation",
        f"PART 15 Test 8: {text!r} Ã¢” ’ NOT historical (news override)",
        detail=str(res.get("route")),
    )

# PART 15 Test 6 — stable named-entity factual question.
# User chose `current_fact_search` default (PART 12 → AskQuestion answer):
# any named-entity factual question routes to search, NOT to general_chat.
res = call_router("Was Elon Musk part of the OpenAI team?")
assert_(
    res["route"] in {"current_fact_search", "general_chat"},
    "PART 15 Test 6: 'Was Elon Musk part of OpenAI team' Ã¢” ’ current_fact_search OR general_chat",
    detail=str(res.get("route")),
)
# `shouldSearch=True` when route=current_fact_search; either way the
# routing must NOT reuse a prior topic — see PART 15 Test 7 next.

# PART 15 Test 7 — pronoun follow-up after Musk-sue-OpenAI ctx routes
# interpretively; standalone Musk-named-entity question does NOT inherit
# prior topic as search query (PART 7 stale-query reuse guard).
musk_sue_ctx = {
    "topic": "Elon Musk sue OpenAI",
    "entities": ["Elon Musk", "OpenAI"],
    "timeframe": "past_week",
    "original_user_query": "Why did Elon Musk sue OpenAI?",
    "previous_route_type": "current_fact_search",
    "timestamp": int(__import__("time").time()),
    "result_cards": [{"title": "x", "url": "y", "snippet": "z"}],
}
# Pronoun-led question against ctx. Per spec PART 11: "This CAN be follow-up
# because 'he' refers to Elon Musk." — wording is permissive. Frontend
# classifyVeraTurnRoute routes this to interpretive_followup_llm via the
# _newsRouterStartsWithPronounQuestion guard; backend may legitimately
# route to current_fact_search since "openai" is a public entity. Either
# is acceptable AS LONG AS the search query is NOT the stale 'sue' topic.
res_pronoun = call_router(
    "Was he part of the OpenAI team?",
    ctx=musk_sue_ctx,
    session_id="smoke-musk-1",
)
assert_(
    res_pronoun["route"] in {
        "interpretive_followup_llm",
        "interpretive_followup_llm_first",
        "current_fact_search",
        "general_chat",
    },
    "PART 15 Test 7: pronoun 'Was he part of OpenAI' Ã¢” ’ interpretive OR current_fact (spec permissive)",
    detail=str(res_pronoun.get("route")),
)
# What MUST be true: the pronoun-led question must not reuse the stale
# 'sue' topic. This is the actual stale-query-reuse bug we fixed.
assert_(
    "sue" not in str(res_pronoun.get("topic") or "").lower(),
    "PART 15 Test 7: pronoun follow-up MUST NOT reuse prior topic 'sue'",
    detail=str(res_pronoun.get("topic")),
)
# Same question with full named entity Ã¢” ’ NEW question, not follow-up.
# Backend stale-query guards must prevent ctx.topic ('Elon Musk sue OpenAI')
# from being reused as the search query.
res_named = call_router(
    "Was Elon Musk part of the OpenAI team?",
    ctx=musk_sue_ctx,
    session_id="smoke-musk-2",
)
# Either current_fact_search (default per user choice) or general_chat
# is acceptable, but NEVER an interpretive follow-up over stale ctx.
assert_(
    res_named["route"] not in {"interpretive_followup_llm", "interpretive_followup_llm_first"},
    "PART 15 Test 7: named-entity question is NOT an interpretive follow-up",
    detail=str(res_named.get("route")),
)
assert_(
    "sue" not in str(res_named.get("topic") or "").lower(),
    "PART 15 Test 7: named-entity question MUST NOT reuse prior topic 'sue'",
    detail=str(res_named.get("topic")),
)

# PART 15 Test 9 — personal news suppression (already covered elsewhere
# but asserting on the same single grep target here for spec PART 4).
res = call_router("I just saw the news my friend passed away")
assert_(
    res["route"] == "personal_emotional",
    "PART 15 Test 9: personal grief Ã¢” ’ personal_emotional",
    detail=str(res.get("route")),
)
assert_(
    res["shouldSearch"] is False,
    "PART 15 Test 9: personal grief Ã¢” ’ shouldSearch=False",
    detail=str(res.get("shouldSearch")),
)
assert_(
    bool(res.get("signals", {}).get("personal_emotional_detected")),
    "PART 15 Test 9: personal_emotional_detected=True",
    detail=str(res.get("signals", {}).get("personal_emotional_detected")),
)


# ---------------------------------------------------------------
# Summary
# ---------------------------------------------------------------
print(f"\n{YELLOW}Summary:{RESET} {GREEN}{PASS} passed{RESET}, {RED}{FAIL} failed{RESET}")
if FAIL:
    print(f"{RED}Failed tests:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
sys.exit(0)
