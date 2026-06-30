"""Smoke tests for the pre-search sanity gate (2026-06-01).

Patch goal: stop the adaptive mini-LLM search planner from promoting
uncertain turns into `general_web_search_tool` for messages that are
actually conceptual / explanation / interpretation requests with no
positive search reason.

Specific live bug: "Wait, what is a tech sell-off?" was being routed to
web.search even though the user clearly wanted a definition from chat
context, not external lookup.

Patch-spec rules:
  1. If deterministic route is already a supported action or dedicated
     live-info tool, keep it.
  2. If planner proposes general_web_search_tool, only accept it when
     has_search_need(text) is true.
  3. If has_search_need(text) is false and the message looks like
     explanation/interpretation, return llm_only / voice.answer.
  4. If unclear, prefer llm_only over web.search unless the user
     explicitly asked to search or needs current/live data.

This file exercises:
  * `has_search_need(text)` - the positive-search-reason detector
  * `looks_like_explanation_or_interpretation(text)` - the conceptual-
    shape detector
  * `_classify_info_tool_deterministic` step 11.5 short-circuit (returns
    route="llm_only" with reason="explanation_or_interpretation_no_search_need")
  * `classify_info_tool` wrapper post-planner gate (demotes any planner
    upgrade from "uncertain" to "general_web_search_tool" when the raw
    transcript has no positive search reason)
  * The full 8 acceptance examples from the patch spec.

Run:  py -3 tests/smoke/__pre_search_sanity_gate_smoke.py
"""
from __future__ import annotations

import os as _os, sys as _sys
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..')))

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


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


# ---------------------------------------------------------------------------
# Suite A - has_search_need POSITIVE cases (each strong search reason)
# ---------------------------------------------------------------------------
section("Suite A - has_search_need POSITIVE cases (each strong search reason)")
SEARCH_NEED_POS = [
    # explicit lookup verbs
    ("Search for the latest news", "explicit lookup: search"),
    ("Look up Apple's stock price", "explicit lookup: look up"),
    ("Find me a coffee shop", "explicit lookup: find me"),
    ("Could you find out who won the game?", "explicit lookup: find out"),
    ("Google that for me", "explicit lookup: google"),
    ("Browse the web for that", "explicit lookup: browse"),
    ("Investigate that further", "explicit lookup: investigate"),
    ("Pull up Tesla's earnings report", "explicit lookup: pull up"),
    ("Do a quick search for that", "explicit lookup: do a search"),
    # freshness / currentness
    ("What's the latest in tech news", "freshness: latest"),
    ("What is happening right now in the markets?", "freshness: right now"),
    ("Tell me what's currently on the schedule", "freshness: currently"),
    ("What's going on today?", "freshness: today"),
    ("What aired tonight on the news?", "freshness: tonight"),
    ("What was on TV yesterday?", "freshness: yesterday"),
    ("What's happened this week?", "freshness: this week"),
    ("What happened in the world over the last 24 hours", "freshness: last 24 hours"),
    ("3 hours ago what was the score?", "freshness: 3 hours ago"),
    ("Show me the breaking story", "freshness: breaking"),
    ("What just happened with OpenAI?", "freshness: just happened"),
    # live data
    ("What is Tesla's stock price?", "live data: stock price"),
    ("What is Apple trading at?", "live data: trading at"),
    ("What is the weather like?", "live data: weather"),
    ("What's the temperature in Tokyo?", "live data: temperature"),
    ("What's the score of the Lakers game?", "live data: score"),
    ("What's the Nvidia market cap?", "live data: market cap"),
    ("Get me the Apple earnings report", "live data: earnings"),
    # news request
    ("Any news on Ukraine?", "news: news"),
    ("What are today's top headlines?", "news: headlines"),
    ("Show me the article on tech layoffs", "news: article"),
    ("What does the report say about climate?", "news: report"),
    ("Give me press release coverage", "news: press release"),
    # source request
    ("What's the source for that claim?", "source: source"),
    ("Give me a citation please", "source: citation"),
    ("What website talks about this?", "source: website"),
    ("Can you share a link?", "source: link"),
    ("Show me the URL", "source: url"),
    # historical / statistical
    ("What was the biggest drawdown in the past 5 years?", "stat: biggest drawdown"),
    ("Past 10 years performance of VGT", "stat: past N years"),
    ("Returns since 2020 for VTI", "stat: since YYYY"),
    ("VGT 52-week high", "stat: 52-week"),
    ("YTD return of QQQ", "stat: YTD"),
    ("All-time high for SPY", "stat: all-time"),
    ("Average return over the last 5 years", "stat: over the last N years"),
    ("Tesla earnings in 2024", "stat: in YYYY"),
    ("3-year return on AAPL", "stat: N-year return"),
]
for tx, label in SEARCH_NEED_POS:
    res = app.has_search_need(tx)
    ok(res is True, f"POS '{tx}' -> True ({label})", detail=f"got {res}")


# ---------------------------------------------------------------------------
# Suite B - has_search_need NEGATIVE cases (no search reason)
# ---------------------------------------------------------------------------
section("Suite B - has_search_need NEGATIVE cases (definitions, interpretations, chitchat)")
SEARCH_NEED_NEG = [
    # the 4 acceptance NEGATIVE examples
    ("Wait, what is a tech sell-off?", "definition"),
    ("What does bearish mean?", "definition (mean)"),
    ("Can you explain why that matters?", "interpretation (explain)"),
    ("Does that mean tech stocks are crashing?", "interpretation (does that mean)"),
    # additional NEG
    ("What is bearish?", "definition"),
    ("What's a stock?", "definition"),
    ("Define drawdown", "definition (define)"),
    ("What does that mean?", "interpretation"),
    ("In other words, is this bad?", "interpretation"),
    ("How does inflation work?", "explanation"),
    ("Tell me what an ETF is", "explanation"),
    ("Explain that to me", "explanation"),
    ("Why is that bad?", "interpretation"),
    ("What is the meaning of bearish?", "definition (meaning of)"),
    ("Hello", "greeting"),
    ("Tell me a joke", "chitchat"),
    ("Thanks Vera", "chitchat"),
    ("What was I asking?", "meta question (no current/freshness)"),
    ("Could you say that again?", "repeat request"),
]
for tx, label in SEARCH_NEED_NEG:
    res = app.has_search_need(tx)
    ok(res is False, f"NEG '{tx}' -> False ({label})", detail=f"got {res}")

ok(app.has_search_need("") is False, "empty string -> False")
ok(app.has_search_need(None) is False, "None safety -> False")


# ---------------------------------------------------------------------------
# Suite C - looks_like_explanation_or_interpretation POSITIVE cases
# ---------------------------------------------------------------------------
section("Suite C - looks_like_explanation_or_interpretation POSITIVE (conceptual shapes)")
EXPL_POS = [
    # acceptance examples
    ("Wait, what is a tech sell-off?", "what is X (with 'wait' lead-in)"),
    ("What does bearish mean?", "what does X mean"),
    ("Can you explain why that matters?", "can you explain"),
    ("Does that mean tech stocks are crashing?", "does that mean"),
    # additional shapes
    ("What is gravity?", "bare 'what is X'"),
    ("What's a 401k?", "what's a X"),
    ("What are options?", "what are X"),
    ("What was the dot-com bubble?", "what was X"),
    ("What does NATO stand for?", "stand for"),
    ("What's the meaning of yield curve?", "meaning of"),
    ("Define bearish", "define X"),
    ("Definition of inflation", "definition of"),
    ("Tell me what an ETF is", "tell me what X is"),
    ("How does inflation work?", "how does X work"),
    ("How do interest rates work?", "how do X work"),
    ("Why is that bad?", "why is that bad"),
    ("Why does that matter?", "why does that matter"),
    ("Can you clarify that?", "can you clarify"),
    ("Could you interpret that for me?", "could you interpret"),
    ("Please elaborate", "elaborate"),
    ("Walk me through how that works", "walk me through"),
    ("Break it down for me", "break it down"),
    ("Help me understand", "help me understand"),
    ("Explain that", "explain"),
    ("Does this mean we are in a recession?", "does this mean"),
    ("Do those mean the same thing?", "do those mean"),
    ("What do you mean?", "what do you mean"),
    ("In other words, you are saying it's bullish?", "in other words"),
    ("Hmm, what is yield curve inversion?", "hmm lead-in"),
    ("Hold on, what is a market cap?", "hold on lead-in"),
    ("Hey Vera, what is QE?", "hey vera lead-in"),
]
for tx, label in EXPL_POS:
    res = app.looks_like_explanation_or_interpretation(tx)
    ok(res is True, f"POS '{tx}' -> True ({label})", detail=f"got {res}")


# ---------------------------------------------------------------------------
# Suite D - looks_like_explanation_or_interpretation NEGATIVE cases
# ---------------------------------------------------------------------------
section("Suite D - looks_like_explanation_or_interpretation NEGATIVE (lookup/news/chitchat)")
EXPL_NEG = [
    ("Look up Apple's stock price", "explicit lookup"),
    ("Search for Tesla earnings news", "explicit search"),
    ("Find me a coffee shop", "explicit find"),
    ("What time is it?", "time query, not 'what is X'"),
    ("What time is it in Tokyo?", "time query"),
    ("Coffee shops near me", "location query"),
    ("Set a 5 minute timer", "app action"),
    ("Pause the music", "app action"),
    ("Play Feather by Sabrina Carpenter", "app action"),
    ("Hello", "greeting"),
    ("Thanks Vera", "chitchat"),
    ("How many episodes are in season 1 of Severance?", "episode-count question"),
    ("How are you?", "greeting question (carve-out via no anchor)"),
]
for tx, label in EXPL_NEG:
    res = app.looks_like_explanation_or_interpretation(tx)
    ok(res is False, f"NEG '{tx}' -> False ({label})", detail=f"got {res}")

ok(app.looks_like_explanation_or_interpretation("") is False, "empty -> False")
ok(app.looks_like_explanation_or_interpretation(None) is False, "None safety -> False")


# ---------------------------------------------------------------------------
# Suite E - _classify_info_tool_deterministic step 11.5 short-circuit
# ---------------------------------------------------------------------------
section("Suite E - _classify_info_tool_deterministic returns llm_only for explanation w/o search need")
DET_LLM_ONLY_CASES = [
    "Wait, what is a tech sell-off?",
    "What does bearish mean?",
    "Can you explain why that matters?",
    "Does that mean tech stocks are crashing?",
    "What is a 401k?",
    "What's a stock?",
    "Define bearish",
    "How does inflation work?",
    "Why is that bad?",
    "Tell me what an ETF is",
    "Hmm, what is a yield curve?",
    "In other words, are we in a recession?",
]
for tx in DET_LLM_ONLY_CASES:
    res = app._classify_info_tool_deterministic(tx)
    ok(
        res.get("route") == "llm_only",
        f"'{tx}' -> route='llm_only'",
        detail=str(res.get("route")),
    )
    ok(
        res.get("reason") == "explanation_or_interpretation_no_search_need",
        f"'{tx}' -> reason='explanation_or_interpretation_no_search_need'",
        detail=str(res.get("reason")),
    )

# Negative deterministic: turns with positive search reason must NOT
# short-circuit to llm_only via step 11.5. They either route to a
# dedicated info tool, or fall through to "uncertain" for the planner.
section("Suite E.2 - turns with positive search reason are NOT demoted to llm_only by step 11.5")
DET_NOT_LLM_ONLY_CASES = [
    "Why is VGT down today?",  # 'today' -> has_search_need=True
    "Look up why tech stocks are selling off",
    "Search latest news about tech selloff",
    "What is VGT trading at right now?",  # 'trading at', 'right now'
    "What is the latest iPhone?",  # 'latest' -> has_search_need=True
    "What is happening with Nvidia stock price right now?",
    "Pull up Tesla recent earnings",
]
for tx in DET_NOT_LLM_ONLY_CASES:
    res = app._classify_info_tool_deterministic(tx)
    # We don't care about the exact non-llm_only route - the dedicated
    # cascade might claim it (finance / news / etc.), or it might fall
    # through to "uncertain" for the planner. The only forbidden outcome
    # is the step 11.5 demotion.
    is_step_11_5 = (
        res.get("route") == "llm_only"
        and res.get("reason") == "explanation_or_interpretation_no_search_need"
    )
    ok(
        not is_step_11_5,
        f"'{tx}' is NOT demoted by step 11.5",
        detail=f"got route={res.get('route')!r} reason={res.get('reason')!r}",
    )


# ---------------------------------------------------------------------------
# Suite F - classify_info_tool wrapper post-planner gate
# ---------------------------------------------------------------------------
section("Suite F - classify_info_tool wrapper demotes planner-upgraded uncertain->web.search w/o search need")
# We patch out the deterministic cascade AND simulate the planner
# upgrading "uncertain" -> "general_web_search_tool" to isolate the post-
# planner gate. The gate's contract is: when the deterministic verdict
# was "uncertain" AND the planner promoted to general_web_search_tool
# AND has_search_need(text) is False, the wrapper demotes the final
# verdict back to llm_only.

_orig_det = app._classify_info_tool_deterministic
_orig_maybe = app._maybe_apply_search_planner


def _det_stub_uncertain(text, **kwargs):
    return {
        "route": "uncertain",
        "tool": "none",
        "query": text,
        "entities": [],
        "metric": None,
        "timeframe": None,
        "required_context": None,
        "confidence": 0.0,
        "reason": "smoke_test_uncertain_stub",
    }


def _planner_stub_upgrade_to_web_search(text, classification, **kwargs):
    classification["route"] = "general_web_search_tool"
    classification["tool"] = "web_search"
    classification["confidence"] = 0.8
    classification["reason"] = (
        str(classification.get("reason") or "")
        + "|search_planner_intent_web.current_fact"
    )
    classification["search_planner_applied"] = True


app._classify_info_tool_deterministic = _det_stub_uncertain
app._maybe_apply_search_planner = _planner_stub_upgrade_to_web_search

try:
    # Cases that MUST be demoted to llm_only (no search need).
    demote_cases = [
        "Wait, what is a tech sell-off?",
        "What does bearish mean?",
        "Can you explain why that matters?",
        "Does that mean tech stocks are crashing?",
        "What is gravity?",
        "Define inflation",
        "How does the stock market work?",
        "Why is that bad?",
        "In other words, are we in a recession?",
    ]
    for tx in demote_cases:
        res = app.classify_info_tool(tx)
        ok(
            res.get("route") == "llm_only",
            f"demote: '{tx}' -> route='llm_only'",
            detail=str(res.get("route")),
        )
        ok(
            "search_necessity_gate_demoted_no_positive_search_need" in str(res.get("reason") or ""),
            f"demote: '{tx}' carries reason marker",
            detail=str(res.get("reason")),
        )
        ok(
            bool(res.get("search_necessity_gate_demoted")),
            f"demote: '{tx}' carries `search_necessity_gate_demoted` flag",
            detail=str(res.get("search_necessity_gate_demoted")),
        )

    # Cases that MUST stay as general_web_search_tool (positive search reason).
    keep_cases = [
        "Why is VGT down today?",  # 'today' freshness
        "Look up why tech stocks are selling off",  # 'look up' lookup verb
        "Search latest news about tech selloff",  # 'search', 'latest', 'news'
        "What is VGT trading at right now?",  # 'trading at', 'right now'
        "What's the price of Apple stock today?",  # 'price', 'today'
        "Latest headlines on Ukraine",  # 'latest', 'headlines'
        "Pull up Tesla earnings report",  # 'pull up', 'earnings'
        "Find me a coffee shop near me",  # 'find me'
        "Get me a citation for that",  # 'citation'
        "What was the biggest drawdown in the past 5 years?",  # historical/stat
        "VGT 52-week high",  # 52-week
    ]
    for tx in keep_cases:
        res = app.classify_info_tool(tx)
        ok(
            res.get("route") == "general_web_search_tool",
            f"keep: '{tx}' -> route='general_web_search_tool'",
            detail=str(res.get("route")),
        )
        ok(
            not bool(res.get("search_necessity_gate_demoted")),
            f"keep: '{tx}' NOT demoted",
            detail=str(res.get("search_necessity_gate_demoted")),
        )

    # Deterministic shopping / local / show route must NOT be demoted - i.e.
    # when the deterministic verdict was already "general_web_search_tool"
    # (NOT "uncertain"), the gate must leave it alone even without
    # has_search_need keywords.
    def _det_stub_shopping(text, **kwargs):
        return {
            "route": "general_web_search_tool",
            "tool": "web_search",
            "query": text,
            "entities": [],
            "metric": None,
            "timeframe": None,
            "required_context": None,
            "confidence": 0.85,
            "reason": "shopping_or_recommendation_web_search",
        }

    def _planner_stub_noop(text, classification, **kwargs):
        return  # planner doesn't run / no-op

    app._classify_info_tool_deterministic = _det_stub_shopping
    app._maybe_apply_search_planner = _planner_stub_noop
    no_search_need_shopping_text = "best webcam"  # no freshness / lookup / news word
    res_shop = app.classify_info_tool(no_search_need_shopping_text)
    ok(
        res_shop.get("route") == "general_web_search_tool",
        "deterministic shopping route preserved (not demoted by gate)",
        detail=str(res_shop.get("route")),
    )
    ok(
        not bool(res_shop.get("search_necessity_gate_demoted")),
        "deterministic shopping route NOT demoted",
        detail=str(res_shop.get("search_necessity_gate_demoted")),
    )
finally:
    app._classify_info_tool_deterministic = _orig_det
    app._maybe_apply_search_planner = _orig_maybe


# ---------------------------------------------------------------------------
# Suite G - end-to-end acceptance examples from the patch spec
# ---------------------------------------------------------------------------
section("Suite G - end-to-end acceptance examples from the patch spec")
# We run the FULL classify_info_tool with planner stubbed to always
# upgrade uncertain->general_web_search_tool. That gives every
# "explanation w/o search need" turn a chance to escape via planner -
# the gate must catch and demote them. For the search-need turns, the
# planner's promotion is allowed to stand (or the deterministic cascade
# already routes them somewhere else; either way they must NOT end up
# as llm_only via the demotion path).

_orig_maybe2 = app._maybe_apply_search_planner

def _planner_stub_aggressive(text, classification, **kwargs):
    """Simulate the worst-case planner: it ALWAYS promotes uncertain to
    general_web_search_tool. The gate must save us from this for the
    explanation/no-search-need turns."""
    if str(classification.get("route") or "") == "uncertain":
        classification["route"] = "general_web_search_tool"
        classification["tool"] = "web_search"
        classification["confidence"] = 0.7
        classification["reason"] = (
            str(classification.get("reason") or "")
            + "|search_planner_intent_web.current_fact"
        )
        classification["search_planner_applied"] = True


app._maybe_apply_search_planner = _planner_stub_aggressive

try:
    # The 4 NEGATIVE acceptance examples: must end up as llm_only.
    NO_SEARCH = [
        "Wait, what is a tech sell-off?",
        "What does bearish mean?",
        "Can you explain why that matters?",
        "Does that mean tech stocks are crashing?",
    ]
    for tx in NO_SEARCH:
        res = app.classify_info_tool(tx)
        ok(
            res.get("route") == "llm_only",
            f"acceptance NO-SEARCH: '{tx}' -> route='llm_only'",
            detail=str(res.get("route")),
        )

    # The 4 POSITIVE acceptance examples: must NOT end up as llm_only.
    SEARCH_OK = [
        "Why is VGT down today?",
        "Look up why tech stocks are selling off",
        "Search latest news about tech selloff",
        "What is VGT trading at right now?",
    ]
    for tx in SEARCH_OK:
        res = app.classify_info_tool(tx)
        route = res.get("route") or ""
        is_search_ok_route = route in (
            "general_web_search_tool",
            "news_search_tool",
            "finance_tool",
            "finance_quote_tool",
            "finance_search_tool",
            "sports_tool",
            "weather_tool",
        )
        ok(
            is_search_ok_route,
            f"acceptance SEARCH-OK: '{tx}' -> non-llm_only ({route})",
            detail=f"got route={route!r} reason={res.get('reason')!r}",
        )
finally:
    app._maybe_apply_search_planner = _orig_maybe2


# ---------------------------------------------------------------------------
print(f"\n{YELLOW}== SUMMARY =={RESET}")
print(f"  {GREEN}passed: {PASS}{RESET}")
print(f"  {RED if FAIL else GREEN}failed: {FAIL}{RESET}")
if FAIL:
    print(f"\n{RED}First failures:{RESET}")
    for n in FAILED[:15]:
        print(f"  - {n}")
sys.exit(0 if FAIL == 0 else 1)
