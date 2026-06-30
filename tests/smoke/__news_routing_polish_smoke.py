"""Smoke tests for the simpler news/current-event routing rule (polish layer).

Covers:
  * `classify_news_route_for_turn(text, ctx)` returns the spec's stable
    route_classification labels:
        current_fact_search | interpretive_followup_llm_first |
        fresh_update_followup | source_specific_followup |
        broad_news_headlines | personal_news_statement |
        emotional_context | general_chat | ui_open_news_panel |
        ui_close_news_panel
  * `_classify_news_followup_type(text, ctx)` strategy still matches the
    polished classifier on each spec example.
  * The 5 manual tests from the spec block at the bottom of the user query:
        1. "Did Trump go to China last week?"           Ã¢” ’ search
        2. "Why was he there?"                          Ã¢” ’ LLM (stored ctx)
        3. "Any updates today?"                         Ã¢” ’ search
        4. "What does that mean?"                       Ã¢” ’ LLM (stored ctx)
        5. "Who else went?"                             Ã¢” ’ search if ctx is thin
  * `recent_news_context` gains `answer_summary` + `previous_route_type` +
    `timestamp` / `original_user_question` / `resolved_topic` / `sources` /
    `source_summaries` aliases without breaking the legacy field names.

Run:  py -3 __news_routing_polish_smoke.py
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

# Stub heavy modules first so `import app` doesn't try to load Whisper / TTS.
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


# ---------------------------------------------------------------------------
# A. Interpretive regex coverage (PART 1)
# ---------------------------------------------------------------------------
section("A. Interpretive regex coverage")
INTERPRETIVE_HITS = [
    "why was he there?",
    "why did he do that?",
    "what does that mean?",
    "why is that important?",
    "is that bad?",
    "is that good?",
    "is that serious?",
    "what's the reason?",
    "what's the meaning?",
    "what's the takeaway?",
    "can you explain?",
    "can you explain that?",
    "can you walk me through that?",
    "can you break that down?",
    "explain that",
    "explain",
    "so that means it's risky",
    "how does that relate?",
    "what do you make of that?",
]
for t in INTERPRETIVE_HITS:
    assert_(bool(app._NEWS_INTERPRETIVE_RE.search(t.lower())), f"interpretive: {t!r}")

INTERPRETIVE_MISSES = [
    "did Trump go to China last week?",
    "any updates today?",
    "what does Reuters say?",
    "find more sources",
    "who else went?",
    "tell me about the news",
    "I'm tired",
]
for t in INTERPRETIVE_MISSES:
    assert_(not app._NEWS_INTERPRETIVE_RE.search(t.lower()), f"NOT interpretive: {t!r}")


# ---------------------------------------------------------------------------
# B. Latest-update / verification / source-mention regex coverage (PART 2)
# ---------------------------------------------------------------------------
section("B. Latest-update / verification / outlet regex coverage")
UPDATE_HITS = [
    "any updates today?",
    "is there a newer report?",
    "any new developments?",
    "what's the latest?",
    "what's new?",
    "find more sources",
    "give me more sources",
    "any other sources",
    "show me more articles",
    "can you verify that?",
    "can you fact-check that?",
    "what does Reuters say?",
    "what do reuters say?",
    "any Bloomberg coverage?",
    "what does the new york times say?",
    "what does NPR report?",
]
for t in UPDATE_HITS:
    assert_(bool(app._NEWS_LATEST_UPDATE_RE.search(t.lower())), f"latest_update: {t!r}")

UPDATE_MISSES = [
    "why was he there?",
    "what does that mean?",
    "is that bad?",
    "did Trump go to China?",
    "tell me a joke",
]
for t in UPDATE_MISSES:
    assert_(not app._NEWS_LATEST_UPDATE_RE.search(t.lower()), f"NOT latest_update: {t!r}")


# ---------------------------------------------------------------------------
# C. Substantive-entity classifier rejects media outlets (PART 3)
# ---------------------------------------------------------------------------
section("C. Media outlets are NOT substantive_fresh entities")
for outlet in ["Reuters", "Bloomberg", "Associated Press", "CNN", "NPR", "Axios", "BBC", "The Guardian"]:
    assert_(
        app._is_substantive_news_entity(outlet) is False,
        f"outlet '{outlet}' is NOT substantive_fresh",
    )
for real_subject in ["Elon Musk", "OpenAI", "China", "Trump", "Tesla", "Sam Altman"]:
    assert_(
        app._is_substantive_news_entity(real_subject) is True,
        f"real subject '{real_subject}' IS substantive_fresh",
    )


# ---------------------------------------------------------------------------
# D. Spec PART 5 — `classify_news_route_for_turn` returns the stable labels
# ---------------------------------------------------------------------------
section("D. classify_news_route_for_turn — base routes (no context)")

base_cases = [
    # text, expected route, expected serper_called
    # Spec-list current-event questions (user's literal examples):
    ("Did Trump go to China last week?", "current_fact_search", True),
    ("Did Elon Musk win the case against OpenAI?", "current_fact_search", True),
    ("Is the highway still closed?", "current_fact_search", True),
    ("Was the LA fire contained?", "current_fact_search", True),
    # Broad headlines:
    ("what's the news?", "broad_news_headlines", True),
    # UI commands:
    ("open the news panel", "ui_open_news_panel", False),
    ("close the news panel", "ui_close_news_panel", False),
    # Personal / general:
    ("my mom just got bad news from the doctor", "personal_news_statement", False),
    ("can you tell me a joke?", "general_chat", False),
]
for text, expected_route, expected_serper in base_cases:
    r = app.classify_news_route_for_turn(text, ctx=None)
    rc = r.get("route_classification")
    sc = bool(r.get("serper_called"))
    assert_(
        rc == expected_route and sc == expected_serper,
        f"route base: {text!r} Ã¢” ’ {expected_route} (serper={expected_serper})",
        f"got route={rc} serper={sc} reason={r.get('reason')}",
    )


# ---------------------------------------------------------------------------
# E. Spec PART 5 — follow-up classifier WITH stored ctx
# ---------------------------------------------------------------------------
section("E. classify_news_route_for_turn — follow-ups with stored ctx")

ctx_rich = {
    "topic": "Trump China trip",
    "resolved_topic": "Trump China trip",
    "original_user_question": "Did Trump go to China last week?",
    "entities": ["Trump", "China", "Beijing", "Xi Jinping"],
    "timeframe": "last_week",
    "result_titles": [
        "Trump arrives in Beijing for trade talks",
        "China-US trade deal reportedly close",
        "Xi and Trump meet at Great Hall",
    ],
    "result_sources": ["Reuters", "Bloomberg", "Axios"],
    "result_urls_if_available": ["https://r/", "https://b/", "https://a/"],
    "result_published": ["2 days ago", "1 day ago", "today"],
    "result_summaries": ["Ã¢â‚¬Â¦", "Ã¢â‚¬Â¦", "Ã¢â‚¬Â¦"],
    "sources": ["Reuters", "Bloomberg", "Axios"],
    "source_summaries": ["Ã¢â‚¬Â¦", "Ã¢â‚¬Â¦", "Ã¢â‚¬Â¦"],
    "answer_summary": "Yes, Trump visited Beijing last week for trade talks with Xi.",
    "previous_route_type": "current_fact_search",
    "created_at": 0,
    "timestamp": 0,
}
followup_cases = [
    # text, expected route, expected serper_called
    ("Why was he there?", "interpretive_followup_llm_first", False),
    ("Why did he go?", "interpretive_followup_llm_first", False),
    ("What does that mean?", "interpretive_followup_llm_first", False),
    ("Why is that important?", "interpretive_followup_llm_first", False),
    ("Is that bad?", "interpretive_followup_llm_first", False),
    ("What's the reason?", "interpretive_followup_llm_first", False),
    ("Can you explain?", "interpretive_followup_llm_first", False),
    ("Any updates today?", "fresh_update_followup", True),
    ("Is there a newer report?", "fresh_update_followup", True),
    ("Can you verify that?", "fresh_update_followup", True),
    ("Find more sources.", "fresh_update_followup", True),
    ("What does Reuters say?", "fresh_update_followup", True),
    # Source-specific (cards stored Ã¢” ’ no fresh search):
    ("What did the first article say?", "source_specific_followup", False),
    ("Any links?", "source_specific_followup", False),
]
for text, expected_route, expected_serper in followup_cases:
    r = app.classify_news_route_for_turn(text, ctx=ctx_rich)
    rc = r.get("route_classification")
    sc = bool(r.get("serper_called"))
    assert_(
        rc == expected_route and sc == expected_serper,
        f"followup w/ rich ctx: {text!r} Ã¢” ’ {expected_route} (serper={expected_serper})",
        f"got route={rc} serper={sc} reason={r.get('reason')}",
    )

# "Who else went" with RICH context Ã¢” ’ answer from context.
r = app.classify_news_route_for_turn("Who else went?", ctx=ctx_rich)
assert_(
    r.get("route_classification") == "interpretive_followup_llm_first",
    "followup w/ rich ctx: 'Who else went?' Ã¢” ’ interpretive_followup_llm_first",
    f"got {r.get('route_classification')}",
)

# "Who else went" with THIN context (no titles, no answer_summary) Ã¢” ’ search.
ctx_thin = {
    "topic": "Trump China trip",
    "entities": ["Trump"],
    "result_titles": [],
    "result_sources": [],
    "result_urls_if_available": [],
    "result_published": [],
    "result_summaries": [],
    "answer_summary": "",
    "previous_route_type": "current_fact_search",
    "created_at": 0,
}
r = app.classify_news_route_for_turn("Who else went?", ctx=ctx_thin)
assert_(
    r.get("route_classification") == "current_fact_search",
    "followup w/ thin ctx: 'Who else went?' Ã¢” ’ current_fact_search",
    f"got {r.get('route_classification')}",
)


# ---------------------------------------------------------------------------
# F. Spec PART 5 — interpretive question that ALSO names a NEW entity must
#    fall through to fresh search (so we don't hallucinate context).
# ---------------------------------------------------------------------------
section("F. interpretive + new substantive entity Ã¢” ’ fresh search")
r = app.classify_news_route_for_turn(
    "Why did Sam Altman fly to Tokyo about it?",
    ctx=ctx_rich,
)
assert_(
    r.get("route_classification") == "current_fact_search" and r.get("serper_called") is True,
    "interpretive with new entity ('Sam Altman', 'Tokyo') Ã¢” ’ current_fact_search",
    f"got {r.get('route_classification')} (reason={r.get('reason')})",
)

# But "What does Reuters say?" must NOT be treated as a new-entity flip,
# even though "Reuters" is a capitalized token.
r = app.classify_news_route_for_turn("What does Reuters say?", ctx=ctx_rich)
assert_(
    r.get("route_classification") == "fresh_update_followup",
    "outlet name ('Reuters') stays in fresh_update_followup, not new-entity flip",
    f"got {r.get('route_classification')} (reason={r.get('reason')})",
)


# ---------------------------------------------------------------------------
# G. recent_news_context shape (PART 4)
# ---------------------------------------------------------------------------
section("G. recent_news_context shape after save")

fake_action_result = {
    "spoken_reply": "Yes, Trump went to China last week.",
    "action_type": "news",
    "data": {
        "headlines": [{"title": "x", "source": "Reuters", "url": "https://r"}],
        "query": "Trump China trip",
        "search_queries": ["Trump China visit last week"],
        "entities": ["Trump", "China"],
        "time_horizon": "last_week",
        "result_titles": ["Trump arrives in Beijing"],
        "result_sources": ["Reuters"],
        "result_urls": ["https://r"],
        "result_published": ["today"],
        "result_summaries": ["Ã¢â‚¬Â¦"],
        "summary": "Yes, Trump went to China last week.",
    },
    "ui_payload": None,
}
app.set_recent_news_context_from_action_result(
    "test_sess_polish",
    "Did Trump go to China last week?",
    fake_action_result,
    previous_route_type="current_fact_search",
    answer_summary="Yes, Trump went to China last week for trade talks.",
)
ctx_saved = app.recent_news_context.get("test_sess_polish")
assert_(isinstance(ctx_saved, dict) and bool(ctx_saved), "ctx was saved")
for field in (
    "topic", "resolved_topic", "original_user_query", "original_user_question",
    "entities", "timeframe", "result_titles", "result_sources",
    "result_urls_if_available", "result_published", "result_summaries",
    "sources", "source_summaries", "answer_summary",
    "previous_route_type", "created_at", "timestamp",
):
    assert_(field in (ctx_saved or {}), f"ctx field present: {field}")
assert_(
    (ctx_saved or {}).get("previous_route_type") == "current_fact_search",
    "ctx.previous_route_type == 'current_fact_search'",
)
assert_(
    (ctx_saved or {}).get("answer_summary", "").startswith("Yes, Trump went to China"),
    "ctx.answer_summary captured the polished reply text",
)
assert_(
    app.get_previous_news_route_type("test_sess_polish") == "current_fact_search",
    "get_previous_news_route_type returns saved value",
)


# ---------------------------------------------------------------------------
# H. End-to-end manual tests from the spec (PART 8)
# ---------------------------------------------------------------------------
section("H. Spec manual tests — end-to-end route_classification")

# Test 1
r1 = app.classify_news_route_for_turn("Did Trump go to China last week?", ctx=None)
assert_(
    r1.get("route_classification") == "current_fact_search" and r1.get("serper_called") is True,
    "Test 1: 'Did Trump go to China last week?' Ã¢” ’ current_fact_search + serper",
)

# Test 2 — after test 1 saved ctx_rich-like state, ask "Why was he there?"
r2 = app.classify_news_route_for_turn("Why was he there?", ctx=ctx_rich)
assert_(
    r2.get("route_classification") == "interpretive_followup_llm_first"
    and r2.get("serper_called") is False
    and r2.get("answer_from") == "stored_source_context",
    "Test 2: 'Why was he there?' Ã¢” ’ interpretive_followup_llm_first (no serper)",
)

# Test 3
r3 = app.classify_news_route_for_turn("Any updates today?", ctx=ctx_rich)
assert_(
    r3.get("route_classification") == "fresh_update_followup" and r3.get("serper_called") is True,
    "Test 3: 'Any updates today?' Ã¢” ’ fresh_update_followup + serper",
)

# Test 4
r4 = app.classify_news_route_for_turn("What does that mean?", ctx=ctx_rich)
assert_(
    r4.get("route_classification") == "interpretive_followup_llm_first"
    and r4.get("serper_called") is False,
    "Test 4: 'What does that mean?' Ã¢” ’ interpretive_followup_llm_first (no serper)",
)

# Test 5
r5_thin = app.classify_news_route_for_turn("Who else went?", ctx=ctx_thin)
r5_rich = app.classify_news_route_for_turn("Who else went?", ctx=ctx_rich)
assert_(
    r5_thin.get("route_classification") == "current_fact_search"
    and r5_thin.get("serper_called") is True,
    "Test 5a: 'Who else went?' with thin ctx Ã¢” ’ current_fact_search + serper",
)
assert_(
    r5_rich.get("route_classification") == "interpretive_followup_llm_first"
    and r5_rich.get("serper_called") is False,
    "Test 5b: 'Who else went?' with rich ctx Ã¢” ’ answers from stored context",
)


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print()
print("Ã¢”â‚¬Ã¢”â‚¬ Summary Ã¢”â‚¬Ã¢”â‚¬")
print(f"  Total: {PASS + FAIL}   {GREEN}Pass: {PASS}{RESET}   {RED if FAIL else RESET}Fail: {FAIL}{RESET}")
if FAIL:
    print(f"\n  {RED}Failed cases:{RESET}")
    for name in FAILED:
        print(f"    - {name}")
    sys.exit(1)
sys.exit(0)
