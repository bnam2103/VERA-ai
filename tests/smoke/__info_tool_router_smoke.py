"""Smoke tests for the 2026-05-28 beta info-tool router.

Covers the spec the user wrote on 2026-05-28 ("Implement VERA information
tool-router with web-search fallback."). All 13 manual tests, plus the
shape contract for `classify_info_tool` and the build/log helpers.

What this test asserts:
  * `classify_info_tool(text, recent_news_context, session_id)` returns the
    spec'd schema with the right `route` for each of the 13 manual cases.
  * `build_route_from_info_tool` produces a dispatchable action dict for
    every "confident" route (time/weather/finance_quote/finance_search/
    news_search/general_web_search/clarification_needed).
  * `build_route_from_info_tool` returns None for routes that should fall
    through to the legacy pipeline (llm_only / followup_llm /
    followup_search / uncertain).
  * Location-clarification turns produce a `needs_followup=True` route
    pointing at `web.search` with `missing_slot="location"`.
  * "Stop saying 'I don't have data'": finance_search_tool routes
    "VGT biggest drawdown 5 years" to `finance.analytics`, not `llm_only`.
  * `web.search` action is wired into `execute_structured_action` (we
    don't actually hit Serper; we monkeypatch the handler to capture the
    call and prove dispatch reaches it).

Run:  py -3 tests/smoke/__info_tool_router_smoke.py
"""
from __future__ import annotations

# --- bootstrap (mirrors __news_intent_router_smoke.py) ------------------
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

# Stub out heavy audio modules the same way the other smoke tests do, so
# `import app` succeeds without TTS/ASR side effects.
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


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


def classify(text: str, ctx: dict | None = None, location_available: bool = False) -> dict:
    return app.classify_info_tool(
        text,
        recent_news_context=ctx,
        session_id="smoke",
        location_available=location_available,
    )


def build(text: str, classification: dict) -> dict | None:
    return app.build_route_from_info_tool(text, classification, session_id="smoke")


def trump_china_ctx() -> dict:
    """Recent news context used to validate follow-up classification."""
    return {
        "topic": "Trump China trip",
        "resolved_topic": "Trump China trip",
        "entities": ["Trump", "China"],
        "answer_summary": "Trump visited China to discuss trade.",
        "result_titles": ["Trump arrives in China"],
        "sources": [{"title": "Trump arrives in China", "source": "Reuters"}],
    }


# ============================================================================
# Schema contract — every classification dict must include the spec keys.
# ============================================================================
section("Schema contract — classify_info_tool always returns the spec keys")

EXPECTED_KEYS = {
    "route", "tool", "query", "entities", "metric", "timeframe",
    "required_context", "confidence", "reason",
}
sample = classify("hello")
missing = EXPECTED_KEYS - set(sample.keys())
ok(not missing, "classify_info_tool returns all spec keys", detail=f"missing={missing}")
ok(isinstance(sample.get("entities"), list), "entities is a list")
ok(isinstance(sample.get("confidence"), (int, float)), "confidence is numeric")


# ============================================================================
# Manual Test 1 — "What time is it in Ho Chi Minh City right now?"
# Expected: time_tool, no news.
# ============================================================================
section("Manual Test 1 — Ho Chi Minh City time → time_tool (no news)")
c = classify("What time is it in Ho Chi Minh City right now?")
ok(c["route"] == "time_tool", "route=time_tool", detail=str(c))
ok(c["tool"] == "time", "tool=time")
ok(c["confidence"] >= 0.9, "high confidence")
built = build("What time is it in Ho Chi Minh City right now?", c)
ok(built is not None and built.get("action_name") == "time.current",
   "build_route → time.current", detail=str(built))
ok((built or {}).get("slots", {}).get("location") == "Ho Chi Minh City",
   "time slot extracts Ho Chi Minh City only", detail=str(built))
ok(c.get("timezone_resolved") == "Asia/Ho_Chi_Minh",
   "timezone_resolved=Asia/Ho_Chi_Minh", detail=str(c))

for phrase, expected_location, expected_tz in [
    ("What time is it in Tokyo right now?", "Tokyo", "Asia/Tokyo"),
    ("what time is it", "", ""),
]:
    c = classify(phrase)
    built = build(phrase, c)
    ok(c["route"] == "time_tool",
       f"{phrase!r} → time_tool", detail=str(c))
    ok((built or {}).get("slots", {}).get("location") == expected_location,
       f"{phrase!r} extracts expected time location", detail=str(built))
    ok(c.get("timezone_resolved") == expected_tz,
       f"{phrase!r} timezone metadata", detail=str(c))


# ============================================================================
# Manual Test 2 — "What's the weather?" → clarification (no location)
# ============================================================================
section("Manual Test 2 — bare weather → weather_tool with required_context=location")
c = classify("What's the weather?")
ok(c["route"] == "weather_tool", "route=weather_tool", detail=str(c))
ok(c.get("required_context") == ["location"],
   "required_context=['location']", detail=str(c.get("required_context")))
built = build("What's the weather?", c)
ok(built is not None and built.get("action_name") == "weather.current",
   "build_route → weather.current", detail=str(built))


# ============================================================================
# Manual Test 3 — "What's the weather in Irvine?" → weather_tool with location
# ============================================================================
section("Manual Test 3 — weather in Irvine → weather_tool")
c = classify("What's the weather in Irvine?")
ok(c["route"] == "weather_tool", "route=weather_tool", detail=str(c))
ok(c.get("required_context") is None, "no clarification needed", detail=str(c.get("required_context")))
built = build("What's the weather in Irvine?", c)
ok(built is not None and built.get("action_name") == "weather.current",
   "build_route → weather.current")


# ============================================================================
# Manual Test 4 — "What's VGT trading at?" → finance_quote_tool
# ============================================================================
section("Manual Test 4 — VGT trading at → finance_quote_tool")
c = classify("What's VGT trading at?")
ok(c["route"] == "finance_quote_tool", "route=finance_quote_tool", detail=str(c))
ok(c["tool"] == "finance_quote", "tool=finance_quote")
built = build("What's VGT trading at?", c)
ok(built is not None and built.get("action_name") == "finance.quote",
   "build_route → finance.quote")


# ============================================================================
# Manual Test 5 — "What's VGT's biggest drawdown in the past 5 years?"
# Expected: finance_search_tool / web-search fallback (NOT a refusal).
# This is the core "stop saying I don't have data" promise.
# ============================================================================
section("Manual Test 5 — VGT biggest drawdown → finance_search_tool (no refusal)")
for phrase in [
    "What's VGT's biggest drawdown in the past 5 years?",
    "Biggest drawdown of VGT 5 years",
    "VGT historical drawdown",
    "SPY return over the last 10 years",
    "QQQ 52-week high and low",
    "VGT volatility over the past year",
    "Compare VGT and QQQ performance",
]:
    c = classify(phrase)
    ok(c["route"] == "finance_search_tool",
       f"{phrase!r} → finance_search_tool", detail=str(c))
    ok(c["tool"] == "web_search",
       f"{phrase!r} → tool=web_search (delegated to finance.analytics)")
    ok(c["route"] != "llm_only",
       f"{phrase!r} must NOT route to llm_only")
    built = build(phrase, c)
    ok(built is not None and built.get("action_name") == "finance.analytics",
       f"{phrase!r} → build_route → finance.analytics", detail=str(built))


# ============================================================================
# Manual Test 6 — "Did Lakers win?" → sports_tool (2026-05-30: new sport-aware
# router replaces the generic web-search fallback for recognized teams).
# ============================================================================
section("Manual Test 6 — Did Lakers win → sports_tool")
for phrase in [
    "Did Lakers win?",
    "Did the Lakers win last night?",
    "Lakers score last night",
    "Warriors vs Celtics",
]:
    c = classify(phrase)
    ok(c["route"] == "sports_tool",
       f"{phrase!r} → sports_tool", detail=str(c))
    ok(c["tool"] == "sports", f"{phrase!r} → tool=sports")
    built = build(phrase, c)
    ok(built is not None and (built.get("action_name") or "").startswith("web.sports_"),
       f"{phrase!r} → build_route → web.sports_*", detail=str(built))


# ============================================================================
# Manual Test 7 — "Best mic under $100" → general_web_search_tool
# ============================================================================
section("Manual Test 7 — Best mic under $100 → general_web_search_tool")
for phrase in [
    "Best mic under $100",
    "Best laptop stand for desk",
    "Best wireless headphones under 200",
    "Compare iPhone and Pixel",
    "Reviews of the Sony WH-1000XM5",
]:
    c = classify(phrase)
    ok(c["route"] == "general_web_search_tool",
       f"{phrase!r} → general_web_search_tool", detail=str(c))
    built = build(phrase, c)
    ok(built is not None and built.get("action_name") == "web.search",
       f"{phrase!r} → build_route → web.search")


# ============================================================================
# Manual Test 8 — "Coffee shops near me" with no location → clarification
# ============================================================================
section("Manual Test 8 — coffee shops near me (no location) → clarification_needed")
c = classify("Coffee shops near me", location_available=False)
ok(c["route"] == "clarification_needed",
   "route=clarification_needed", detail=str(c))
ok(c.get("required_context") == ["location"],
   "required_context=['location']", detail=str(c.get("required_context")))
built = build("Coffee shops near me", c)
ok(built is not None
   and built.get("action_name") == "web.search"
   and built.get("needs_followup") is True
   and built.get("missing_slot") == "location",
   "build_route → web.search with needs_followup+missing_slot=location",
   detail=str(built))


# ============================================================================
# Manual Test 9 — "Coffee shops in Irvine" → general_web_search_tool
# ============================================================================
section("Manual Test 9 — coffee shops in Irvine → general_web_search_tool")
c = classify("Coffee shops in Irvine")
ok(c["route"] == "general_web_search_tool",
   "route=general_web_search_tool", detail=str(c))
ok(c.get("required_context") is None, "no clarification needed")
built = build("Coffee shops in Irvine", c)
ok(built is not None and built.get("action_name") == "web.search",
   "build_route → web.search")


# ============================================================================
# Manual Test 10 — "Did Trump go to China last week?" → news_search_tool
# (or current_fact_search if it falls through; either is acceptable per
# the spec, but for the explicit "news" cases it must be news_search_tool).
# ============================================================================
section("Manual Test 10a — explicit news commands → news_search_tool")
for phrase in [
    "Tell me the news",
    "Breaking news",
    "What's the latest news?",
    "Latest news about OpenAI",
    "Any updates on Trump and China?",
]:
    c = classify(phrase)
    ok(c["route"] == "news_search_tool",
       f"{phrase!r} → news_search_tool", detail=str(c))
    built = build(phrase, c)
    ok(built is not None and built.get("action_name") == "news.latest",
       f"{phrase!r} → build_route → news.latest")

# The current-fact form "Did Trump go to China last week?" is fine to leave
# to the legacy `detect_news_route_intent` pipeline — assert we DON'T misroute
# it to llm_only/uncertain because of a missing news keyword.
section("Manual Test 10b — 'Did Trump go to China last week?' must not become llm_only")
c = classify("Did Trump go to China last week?")
ok(c["route"] != "llm_only",
   "'Did Trump go to China last week?' is not llm_only",
   detail=str(c))


# ============================================================================
# Manual Test 11 — "Why was he there?" (with Trump/China ctx) → followup_llm
# ============================================================================
section("Manual Test 11 — pronoun follow-up with ctx → followup_llm")
c = classify("Why was he there?", ctx=trump_china_ctx())
ok(c["route"] == "followup_llm",
   "route=followup_llm", detail=str(c))
ok(build("Why was he there?", c) is None,
   "build_route is None (falls through to LLM)")

elon_openai_ctx = {
    "topic": "Elon Musk OpenAI lawsuit",
    "resolved_topic": "Elon Musk OpenAI lawsuit",
    "entities": ["Elon Musk", "OpenAI"],
    "answer_summary": "Elon Musk sued OpenAI and alleged it had departed from its original nonprofit mission.",
}
for phrase in [
    "Was he part of OpenAI?",
    "Why did he wait so long?",
    "Was he involved early on?",
]:
    c = classify(phrase, ctx=elon_openai_ctx)
    ok(c["route"] == "followup_llm",
       f"{phrase!r} → followup_llm despite prior-topic entity", detail=str(c))
    ok(c["tool"] == "none",
       f"{phrase!r} does not select news/search tool", detail=str(c))


# ============================================================================
# Manual Test 12 — "Who else was there?" (with Trump/China ctx) → followup_search
# ============================================================================
section("Manual Test 12 — fresh follow-up with ctx → followup_search")
c = classify("Who else was there?", ctx=trump_china_ctx())
ok(c["route"] == "followup_search",
   "route=followup_search", detail=str(c))
ok(build("Who else was there?", c) is None,
   "build_route is None (falls through to legacy news pipeline)")


# ============================================================================
# Manual Test 13 — "Can you explain the Vietnam War?" → llm_only (no news)
# ============================================================================
section("Manual Test 13 — explain Vietnam War → llm_only (no news search)")
c = classify("Can you explain the Vietnam War?")
ok(c["route"] == "llm_only",
   "route=llm_only", detail=str(c))
ok(c["reason"] == "historical_or_educational_explanation",
   "reason=historical_or_educational_explanation",
   detail=str(c.get("reason")))
ok(build("Can you explain the Vietnam War?", c) is None,
   "build_route is None (falls through to general LLM)")


# ============================================================================
# Negative tests — stuff that must NOT be claimed by the new classifier.
# ============================================================================
section("Negative — utility/personal still wins, app actions deferred to heuristic")

# Personal news suppression — must not route to news search.
c = classify("I just saw the news my friend passed away.")
ok(c["route"] == "llm_only",
   "personal news statement → llm_only", detail=str(c))

# "What's the price of VGT?" should also be finance_quote_tool, even though
# the word "price" overlaps with general queries.
c = classify("What's the price of VGT?")
ok(c["route"] == "finance_quote_tool",
   "price of VGT → finance_quote_tool", detail=str(c))


# ============================================================================
# Dispatch wiring — execute_structured_action handles web.search.
# We monkeypatch the underlying handler so we don't actually hit Serper.
# ============================================================================
section("Dispatch — execute_structured_action dispatches web.search")

calls: list[dict] = []


def fake_web(vera, query: str, *, raw_user_text: str | None = None):
    calls.append({"query": query, "raw_user_text": raw_user_text})
    return {
        "spoken_reply": f"fake reply for {query}",
        "action_type": "web_search",
        "data": {"query": query, "results": []},
        "ui_payload": None,
    }


_original_handler = app.handle_web_search_request
app.handle_web_search_request = fake_web
try:
    route = {
        "domain": "web",
        "is_action_request": True,
        "action_name": "web.search",
        "slots": {"query": "best mic under $100", "user_text": "Best mic under $100"},
        "needs_followup": False,
        "missing_slot": None,
    }
    result, _ = app.execute_structured_action(
        "smoke", "Best mic under $100", route, client_context_snapshot=None
    )
    ok(result is not None and result.get("action_type") == "web_search",
       "execute_structured_action returned web_search result",
       detail=str(result))
    ok(len(calls) == 1 and calls[0]["query"] == "best mic under $100",
       "handle_web_search_request received the query",
       detail=str(calls))
finally:
    app.handle_web_search_request = _original_handler


# ============================================================================
# Needs-followup clarification — execute_structured_action sets pending_action.
# ============================================================================
section("Dispatch — needs_followup web.search location → sets pending_action")
app.pending_action.pop("smoke_loc", None)
route = {
    "domain": "web",
    "is_action_request": True,
    "action_name": "web.search",
    "slots": {"query": "coffee shops near me", "user_text": "coffee shops near me"},
    "needs_followup": True,
    "missing_slot": "location",
}
result, _ = app.execute_structured_action(
    "smoke_loc", "coffee shops near me", route, client_context_snapshot=None
)
ok(result is not None
   and result.get("action_type") == "web_search"
   and result.get("spoken_reply") == app.WEB_SEARCH_LOCATION_PROMPT,
   "clarification reply uses WEB_SEARCH_LOCATION_PROMPT",
   detail=str(result))
pend = app.get_pending_action("smoke_loc")
ok(pend is not None
   and pend.get("action_name") == "web.search"
   and pend.get("missing_slot") == "location",
   "pending_action recorded web.search/location",
   detail=str(pend))


# ============================================================================
# Finance analytics — search-query generation, no question echo, log emission.
# Manual tests 1-3 from the 2026-05-28 spec ("VGT drawdown", "Compare VGT/QQQ",
# "Why did Nvidia stock drop today?") run as PURE assertions on
# _finance_analytics_search_queries + _build_analytics_prompt + the structured
# [finance_analytics_route] log so we don't need a real Serper key in CI.
# ============================================================================
section("Finance analytics — VGT drawdown search-query expansion")
import io as _io
import contextlib as _ctx
from actions.finance import (
    _finance_analytics_search_queries,
    _build_analytics_prompt,
    prepare_finance_analytics_streaming,
)

vgt_queries = _finance_analytics_search_queries(
    "VGT", "What's VGT's biggest drawdown in the past 5 years?"
)
expected_vgt_phrases = [
    "VGT maximum drawdown past 5 years",
    "Vanguard Information Technology ETF VGT max drawdown 5 years",
    "VGT historical drawdown 5 year",
    "VGT drawdown chart 5 years",
]
for phrase in expected_vgt_phrases:
    ok(any(phrase in q for q in vgt_queries),
       f"VGT drawdown queries include {phrase!r}",
       detail=str(vgt_queries))

section("Finance analytics — compare VGT/QQQ paraphrases")
cmp_queries = _finance_analytics_search_queries(
    "VGT", "Compare VGT and QQQ performance over the last 5 years"
)
ok(any("VGT" in q and "QQQ" in q for q in cmp_queries),
   "compare queries include both tickers",
   detail=str(cmp_queries))
ok(any("vs" in q.lower() or "comparison" in q.lower() or "compare" in q.lower()
       for q in cmp_queries),
   "compare queries use vs/comparison/compare phrasing",
   detail=str(cmp_queries))

section("Finance analytics — 'why did NVDA drop today' paraphrases")
nvda_queries = _finance_analytics_search_queries(
    "NVDA", "Why did Nvidia stock drop today?"
)
ok(any("NVDA" in q and "today" in q.lower() for q in nvda_queries),
   "NVDA drop queries reference NVDA + today",
   detail=str(nvda_queries))

section("Finance analytics — prompt does NOT echo the user's question verbatim")
prompt_no_items = _build_analytics_prompt(
    "VGT", [], user_question="What's VGT's biggest drawdown in the past 5 years?"
)
ok("User question (verbatim)" not in prompt_no_items,
   "prompt body has no 'User question (verbatim):' label",
   detail=prompt_no_items[:200])
ok("Do not refuse" in prompt_no_items.lower()
   or "do not refuse" in prompt_no_items.lower(),
   "no-snippets branch tells the model not to refuse",
   detail=prompt_no_items[:240])

prompt_with_items = _build_analytics_prompt(
    "VGT",
    [
        {"title": "VGT max drawdown over 5 years", "source": "morningstar.com",
         "url": "https://morningstar.com/x", "summary": "Worst drawdown was about -23% in 2022."},
        {"title": "Vanguard IT ETF performance review", "source": "etf.com",
         "url": "https://etf.com/x", "summary": "Peak-to-trough -22% in 2022."},
    ],
    user_question="What's VGT's biggest drawdown in the past 5 years?",
)
ok("Search snippets" in prompt_with_items,
   "snippet branch frames snippets as the source of record",
   detail=prompt_with_items[:240])

section("Finance analytics — [finance_analytics_route] log is emitted")
_original_search = None
try:
    import actions.finance as _af
    _original_search = _af._search_serper

    def _fake_search(query, limit=5):
        return {
            "organic": [
                {"title": f"hit for {query}", "link": f"https://example.com/{abs(hash(query))}",
                 "snippet": "Drawdown was around -22%."},
            ],
        }

    _af._search_serper = _fake_search

    class _FakeVera:
        def build_messages(self, history, prompt):
            return [{"role": "system", "content": prompt}]

    log_buf = _io.StringIO()
    with _ctx.redirect_stdout(log_buf):
        prepared = prepare_finance_analytics_streaming(
            _FakeVera(),
            "VGT",
            raw_user_text="What's VGT's biggest drawdown in the past 5 years?",
        )
    captured = log_buf.getvalue()
    ok(prepared is not None, "prepare_finance_analytics_streaming returns a triple",
       detail=str(prepared))
    ok("[finance_analytics_route]" in captured,
       "[finance_analytics_route] log line emitted",
       detail=captured[:400])
    for required_field in [
        '"selected_route": "finance_search_tool"',
        '"action": "finance.analytics"',
        '"search_queries":',
        '"serper_results_count":',
        '"source_reported_answer": true',
        '"exact_computation_performed": false',
        '"refused_due_to_missing_daily_data": false',
        '"caveat_added": true',
    ]:
        ok(required_field in captured,
           f"log contains {required_field}",
           detail=captured[:400])
finally:
    if _original_search is not None:
        _af._search_serper = _original_search


# ============================================================================
# 2026-05-28 panel-routing — finance quote / analytics / product / location.
# Each manual test asserts the panel_type the user expects + the title format
# for finance quotes (must show the ticker, not generic "Stock").
# ============================================================================
section("Panel routing — finance.quote panel title shows ticker (VGT/AAPL/NVDA)")
import actions.finance as _af_panel
_OriginalFetchMedia = _af_panel._fetch_finance_media
_OriginalSearchSerper = _af_panel._search_serper
_OriginalResolve = _af_panel._resolve_chart_symbol_with_llm


def _fake_quote_search(q, limit=5):
    return {
        "organic": [
            {"title": f"{q} quote", "link": "https://example.com/q",
             "snippet": "Recent quote $300.12"},
        ],
    }


def _fake_resolve(vera, subject, payload, items):
    sub = subject.upper().strip()
    if sub in {"VGT", "AAPL", "NVDA", "QQQ", "SPY"}:
        return sub, f"NASDAQ:{sub}"
    return "", ""


class _FakeVeraQuote:
    def build_messages(self, history, prompt):
        return [{"role": "system", "content": prompt}]

    def generate(self, messages):
        return "fake quote answer", 0.0


_af_panel._search_serper = _fake_quote_search
_af_panel._resolve_chart_symbol_with_llm = _fake_resolve
_af_panel._fetch_finance_media = lambda subject: ([], [])
try:
    for subject, expected_entity in [
        ("VGT", "VGT"),
        ("AAPL", "AAPL"),
        ("NVDA", "NVDA"),
    ]:
        prepared = _af_panel.prepare_finance_quote_streaming(_FakeVeraQuote(), subject)
        ok(prepared is not None, f"finance.quote prepared for {subject}",
           detail=str(prepared))
        _msgs, ui_payload, finalize = prepared
        ok(ui_payload.get("panel_type") == "finance_chart",
           f"finance.quote → panel_type=finance_chart for {subject}",
           detail=str(ui_payload))
        ok(expected_entity in (ui_payload.get("title") or ""),
           f"finance.quote title contains ticker {expected_entity!r}",
           detail=str(ui_payload))
        ok(ui_payload.get("title") != "Stock Chart",
           f"finance.quote title is no longer generic 'Stock Chart' for {subject}",
           detail=str(ui_payload))
        ok(ui_payload.get("entity") == expected_entity,
           f"finance.quote payload entity={expected_entity}",
           detail=str(ui_payload))
finally:
    _af_panel._search_serper = _OriginalSearchSerper
    _af_panel._resolve_chart_symbol_with_llm = _OriginalResolve
    _af_panel._fetch_finance_media = _OriginalFetchMedia

section("Finance quote — natural-language VGT/VOO ticker extraction + STOCK blocklist")
def _fake_vgt_kg_search(q, limit=5):
    return {
        "knowledgeGraph": {
            "title": "Vanguard Information Technology ETF",
            "stock": "Stock",
            "type": "ETF",
        },
        "organic": [
            {"title": "VGT stock price", "link": "https://example.com/vgt",
             "snippet": "VGT is quoted at $116.07"},
        ],
    }


def _fake_resolve_stock_trap(vera, subject, payload, items):
    sym, tv = _af_panel._extract_chart_symbol(subject, payload, items)
    return sym, tv


_af_panel._search_serper = _fake_vgt_kg_search
_af_panel._resolve_chart_symbol_with_llm = _fake_resolve_stock_trap
try:
    for user_query, expected_symbol in [
        ("Can you tell me the price of VGT?", "VGT"),
        ("What's the price of VGT?", "VGT"),
        ("What's the price of VOO?", "VOO"),
        ("What's the price of Apple?", "AAPL"),
        ("What's the price of AAPL?", "AAPL"),
    ]:
        subject = _af_panel._normalize_finance_subject(user_query)
        ok(subject in {expected_symbol, "Apple"},
           f"subject normalized for {user_query!r} → {subject!r}",
           detail=f"expected {expected_symbol!r}")
        prepared = _af_panel.prepare_finance_quote_streaming(_FakeVeraQuote(), user_query)
        ok(prepared is not None, f"finance.quote prepared for {user_query!r}")
        _msgs, ui_payload, _fin = prepared
        ok(ui_payload.get("symbol") == expected_symbol,
           f"panel symbol is {expected_symbol!r} for {user_query!r}",
           detail=str(ui_payload))
        tv = ui_payload.get("tradingview_symbol") or ""
        ok(tv.endswith(f":{expected_symbol}"),
           f"tradingview symbol ends with :{expected_symbol} for {user_query!r}",
           detail=tv)
        ok("STOCK" not in tv.upper() or expected_symbol == "STOCK",
           f"no AMEX:STOCK trap for {user_query!r}",
           detail=tv)

    sym, tv = _af_panel._extract_chart_symbol(
        "VGT",
        {"knowledgeGraph": {"stock": "Stock", "ticker": ""}},
        [],
    )
    ok(sym == "VGT" and tv == "AMEX:VGT",
       "knowledgeGraph stock=Stock does not resolve to STOCK",
       detail=f"{sym!r} {tv!r}")

    blocked = _af_panel._normalize_symbol("Stock")
    ok(blocked == "", "generic word Stock is blocked as symbol")

    _af_panel._search_serper = lambda q, limit=5: {
        "knowledgeGraph": {"stock": "Stock", "type": "Financial product"},
        "organic": [
            {"title": "Stock market today", "link": "https://example.com/",
             "snippet": "Markets moved higher today."},
        ],
    }
    stock_query = _af_panel.prepare_finance_quote_streaming(
        _FakeVeraQuote(), "What's the price of stock?"
    )
    if stock_query:
        _m, stock_payload, _f = stock_query
        ok(not stock_payload.get("symbol"),
           "price of stock does not resolve a chart symbol",
           detail=str(stock_payload))
        ok(not stock_payload.get("chart_url"),
           "price of stock does not emit a chart URL",
           detail=str(stock_payload))
finally:
    _af_panel._search_serper = _OriginalSearchSerper
    _af_panel._resolve_chart_symbol_with_llm = _OriginalResolve
    _af_panel._fetch_finance_media = _OriginalFetchMedia

section("Panel routing — finance.analytics → media_tabs (Articles/Images/Video)")
_OriginalSearchSerperA = _af_panel._search_serper
_OriginalFetchMediaA = _af_panel._fetch_finance_media


def _fake_search_a(q, limit=5):
    return {
        "organic": [
            {"title": f"{q} historical drawdown", "link": f"https://example.com/{abs(hash(q))}",
             "snippet": "Drawdown was around -22% in 2022."},
        ],
    }


_af_panel._search_serper = _fake_search_a
_af_panel._fetch_finance_media = lambda subject: (
    [{"title": "VGT chart", "image_url": "https://example.com/img.png",
      "thumbnail_url": "https://example.com/img.png", "source": "example.com",
      "url": "https://example.com/img"}],
    [{"title": "VGT 5y review", "summary": "video summary",
      "source": "youtube.com", "published_display": "2026", "url": "https://youtu.be/abc",
      "thumbnail_url": "https://example.com/thumb.png"}],
)
try:
    prepared = _af_panel.prepare_finance_analytics_streaming(
        _FakeVeraQuote(),
        "VGT",
        raw_user_text="What's VGT's biggest drawdown in the past 5 years?",
    )
    ok(prepared is not None, "finance.analytics prepared")
    _msgs, analytics_payload, _fin = prepared
    ok(analytics_payload is not None, "finance.analytics emits a ui_payload now")
    ok(analytics_payload.get("panel_type") == "media_tabs",
       "finance.analytics panel_type = media_tabs",
       detail=str(analytics_payload))
    for key in ("news_results", "images", "videos"):
        ok(key in analytics_payload,
           f"finance.analytics payload has {key!r} bucket",
           detail=str(list(analytics_payload.keys())))
    ok(analytics_payload.get("default_tab") == "news",
       "finance.analytics default tab = news (Articles)")
finally:
    _af_panel._search_serper = _OriginalSearchSerperA
    _af_panel._fetch_finance_media = _OriginalFetchMediaA

section("Panel routing — web.search classify_web_search_panel decisions")
import actions.web_search as _ws_panel
for phrase, expected_panel, expected_loc in [
    ("Did Lakers win?", "media_tabs", ""),
    ("How many episodes are in Severance season 2?", "media_tabs", ""),
    ("Latest news about OpenAI", "media_tabs", ""),
    ("Best mic under $100", "product_results_panel", ""),
    ("Best webcam for streaming", "product_results_panel", ""),
    ("Coffee shops in Irvine", "location_map_panel", "Irvine"),
    ("coffee near irvine", "location_map_panel", "Irvine"),
    ("Coffee shops near me", "location_map_panel", ""),
    ("Restaurants near UCI", "location_map_panel", "UCI"),
    ("cafes in Fountain Valley", "location_map_panel", "Fountain Valley"),
    ("Gyms nearby", "location_map_panel", ""),
    ("Study cafes in Garden Grove", "location_map_panel", "Garden Grove"),
]:
    decision = _ws_panel.classify_web_search_panel(phrase)
    ok(decision.get("panel_type") == expected_panel,
       f"{phrase!r} → {expected_panel}",
       detail=str(decision))
    if expected_loc:
        ok(decision.get("location") == expected_loc,
           f"{phrase!r} extracts location={expected_loc!r}",
           detail=str(decision))

# Specifically: "Coffee shops near me" with no city must flag location_required.
near_me = _ws_panel.classify_web_search_panel("Coffee shops near me")
ok(near_me.get("location_required") is True,
   "'Coffee shops near me' marks location_required=True",
   detail=str(near_me))
in_city = _ws_panel.classify_web_search_panel("Coffee shops in Irvine")
ok(in_city.get("location") == "Irvine",
   "'Coffee shops in Irvine' extracts location='Irvine'",
   detail=str(in_city))
ok(in_city.get("location_required") is False,
   "'Coffee shops in Irvine' does NOT require clarification",
   detail=str(in_city))

section("Panel routing — web.search emits matching panel ui_payload")
_OriginalOrganic = _ws_panel._serper_search_organic
_OriginalMedia = _ws_panel._serper_media


def _fake_organic(q, limit=8):
    return {"organic": [{"title": q, "link": "https://example.com/o",
                         "snippet": "Top organic result."}]}


def _fake_media(endpoint, q, limit, prefix):
    if prefix == "shopping":
        return {"shopping": [{
            "title": "Top Mic 100", "link": "https://shop.example/mic",
            "price": "$95.00", "rating": 4.6, "ratingCount": 1200,
            "source": "shop.example", "imageUrl": "https://shop.example/mic.png",
        }]}
    if prefix == "places":
        return {"places": [{
            "title": "Cafe Test", "address": "1 St, Irvine CA",
            "rating": 4.7, "ratingCount": 200, "openState": "Open",
            "category": "Coffee shop", "website": "https://cafe.example",
            "directionsLink": "https://maps.example/dir",
            "latitude": 33.6, "longitude": -117.8,
        }]}
    if prefix == "images":
        return {"images": [{"imageUrl": "https://example.com/i.png",
                            "title": "img"}]}
    if prefix == "videos":
        return {"videos": [{"title": "vid", "link": "https://youtu.be/x",
                            "snippet": "video"}]}
    return {}


class _FakeVeraWeb:
    def build_messages(self, history, prompt):
        return [{"role": "system", "content": prompt}]


_ws_panel._serper_search_organic = _fake_organic
_ws_panel._serper_media = _fake_media
try:
    for q, expected in [
        ("Best mic under $100", "product_results_panel"),
        ("Coffee shops in Irvine", "location_map_panel"),
        ("Did Lakers win?", "media_tabs"),
        ("Latest news about OpenAI", "media_tabs"),
        ("How many episodes are in Severance season 2?", "media_tabs"),
    ]:
        prepared = _ws_panel.prepare_web_search_streaming(_FakeVeraWeb(), q, raw_user_text=q)
        ok(prepared is not None, f"web.search prepared for {q!r}")
        _msgs, ui_payload, fin = prepared
        ok(ui_payload is not None, f"web.search ui_payload present for {q!r}")
        ok(ui_payload.get("panel_type") == expected,
           f"web.search {q!r} → panel_type={expected}",
           detail=str(ui_payload))
        if expected == "product_results_panel":
            ok(isinstance(ui_payload.get("products"), list) and len(ui_payload["products"]) > 0,
               f"product panel includes product cards",
               detail=str(ui_payload))
        if expected == "location_map_panel":
            ok(isinstance(ui_payload.get("places"), list) and len(ui_payload["places"]) > 0,
               f"location panel includes place cards",
               detail=str(ui_payload))
        if expected == "media_tabs":
            for key in ("news_results", "images", "videos"):
                ok(key in ui_payload,
                   f"media-tabs panel has {key!r} bucket for {q!r}",
                   detail=str(list(ui_payload.keys())))
finally:
    _ws_panel._serper_search_organic = _OriginalOrganic
    _ws_panel._serper_media = _OriginalMedia

section("Panel routing — 'coffee shops near me' with no city → asks for location")
c_near_me = classify("Coffee shops near me", location_available=False)
ok(c_near_me["route"] == "clarification_needed",
   "info-tool classifier still asks for location when missing",
   detail=str(c_near_me))
built_near_me = build("Coffee shops near me", c_near_me)
ok(built_near_me is not None
   and built_near_me.get("action_name") == "web.search"
   and built_near_me.get("needs_followup") is True
   and built_near_me.get("missing_slot") == "location",
   "near-me without city → web.search needs_followup=location",
   detail=str(built_near_me))

# ============================================================================
# 2026-05-28 — product panel ranking + image normalization
# ============================================================================
section("Product panel — top-3 ranking + rank labels")


def _fake_shopping_many(endpoint, q, limit, prefix):
    if prefix != "shopping":
        return _fake_media(endpoint, q, limit, prefix)
    return {"shopping": [
        # Wrong category — must NOT appear in mic-query canonical list.
        {"title": "Pro Webcam HD 1080p", "link": "https://shop.example/webcam",
         "extractedPrice": 79.0, "rating": 4.9, "ratingCount": 9000,
         "imageUrl": "https://shop.example/webcam.png", "source": "CamShop"},
        # Premium / highly rated, no price constraint match
        {"title": "Studio Pro Mic", "link": "https://shop.example/pro",
         "extractedPrice": 249.0, "rating": 4.8, "ratingCount": 1500,
         "imageUrl": "https://shop.example/pro.png", "source": "ProAudio"},
        # Budget under $100, decent rating
        {"title": "Budget USB Mic", "link": "https://shop.example/budget",
         "extractedPrice": 49.0, "rating": 4.3, "ratingCount": 4500,
         "imageUrl": "https://shop.example/budget.png", "source": "Cheapo"},
        # Mid-range under $100
        {"title": "Mid Range Cardioid", "link": "https://shop.example/mid",
         "extractedPrice": 89.0, "rating": 4.6, "ratingCount": 2300,
         "imageUrl": "https://shop.example/mid.png", "source": "MidShop"},
        # Filler with no image (placeholder path)
        {"title": "No Image Mic", "link": "https://shop.example/noimg",
         "extractedPrice": 79.0, "rating": 4.2, "ratingCount": 30,
         "source": "RandomShop"},
        # Filler with no rating
        {"title": "Unrated Mic", "link": "https://shop.example/unrated",
         "extractedPrice": 59.0, "imageUrl": "https://shop.example/u.png",
         "source": "Unrated"},
    ]}


_ws_panel._serper_search_organic = _fake_organic
_ws_panel._serper_media = _fake_shopping_many
try:
    prepared = _ws_panel.prepare_web_search_streaming(
        _FakeVeraWeb(), "best mic under $100", raw_user_text="best mic under $100"
    )
    ok(prepared is not None, "best mic under $100 → prepared payload")
    _msgs, ui_payload, fin = prepared
    ok(ui_payload.get("panel_type") == "product_results_panel",
       "panel_type=product_results_panel for shopping query")
    products = ui_payload.get("products") or []
    ok(len(products) == 3,
       "product panel capped to exactly 3 cards",
       detail=f"got {len(products)}")
    rank_labels = [p.get("rank_label") for p in products]
    ok(rank_labels == ["Best overall", "Best value", "Alternative"],
       "rank_labels are Best overall / Best value / Alternative",
       detail=str(rank_labels))
    overall = products[0]
    ok(overall.get("title") == "Studio Pro Mic",
       "Best overall = highest-rated item (Studio Pro Mic)",
       detail=str(overall))
    value = products[1]
    ok(value.get("title") == "Budget USB Mic",
       "Best value = cheapest item satisfying $100 constraint",
       detail=str(value))
    ok(ui_payload.get("extras_count") >= 2,
       "extras_count reports hidden items beyond the top-3 grid",
       detail=str(ui_payload.get("extras_count")))
    ok(ui_payload.get("price_constraint") == 100.0,
       "price_constraint extracted from 'under $100'",
       detail=str(ui_payload.get("price_constraint")))
    ok(ui_payload.get("rank_labels") == ["Best overall", "Best value", "Alternative"],
       "ui_payload.rank_labels surfaces the rank trio")
    ok(ui_payload.get("result_kind") == "product", "product payload result_kind=product")
    ok(bool(ui_payload.get("request_id")), "product payload includes request_id")
    ok(int(ui_payload.get("created_at_ms") or 0) > 0, "product payload includes created_at_ms")
    ok(isinstance(ui_payload.get("canonical_products"), list),
       "product payload includes canonical_products")
    ok(
        all("webcam" not in (p.get("title") or "").lower() for p in products),
        "mic query canonical list excludes unrelated webcam SKUs",
        detail=str([p.get("title") for p in products]),
    )
    # Per spec: image presence is part of the structured log; we can at
    # least assert at least one ranked product carries an image_url.
    ok(any((p.get("image_url") or "").strip() for p in products),
       "at least one ranked product carries image_url")
finally:
    _ws_panel._serper_search_organic = _OriginalOrganic
    _ws_panel._serper_media = _OriginalMedia

# ============================================================================
# 2026-05-28 — location panel map pins + multi-card rendering
# ============================================================================
section("Location panel — map pins + multi-card payload")


def _fake_places_many(endpoint, q, limit, prefix):
    if prefix != "places":
        return _fake_media(endpoint, q, limit, prefix)
    return {"places": [
        {"title": "Alta Coffee", "address": "506 31st St, Newport Beach CA",
         "rating": 4.7, "ratingCount": 320, "openState": "Open",
         "category": "Coffee shop", "website": "https://alta.example",
         "latitude": 33.61, "longitude": -117.92},
        {"title": "Kean Coffee", "address": "2043 Westcliff Dr, Newport Beach CA",
         "rating": 4.6, "ratingCount": 800, "openState": "Open",
         "category": "Coffee shop", "website": "https://kean.example",
         "latitude": 33.62, "longitude": -117.93},
        # Address-only (no coordinates → no pin, but still a card).
        {"title": "Stereoscope", "address": "1 W St, Buena Park CA",
         "rating": 4.5, "category": "Coffee shop",
         "website": "https://stereo.example"},
    ]}


_ws_panel._serper_search_organic = _fake_organic
_ws_panel._serper_media = _fake_places_many
try:
    prepared = _ws_panel.prepare_web_search_streaming(
        _FakeVeraWeb(), "coffee shops in Irvine", raw_user_text="coffee shops in Irvine"
    )
    ok(prepared is not None, "coffee shops in Irvine → prepared payload")
    _msgs, ui_payload, fin = prepared
    ok(ui_payload.get("panel_type") == "location_map_panel",
       "panel_type=location_map_panel for explicit-city venue query")
    places = ui_payload.get("places") or []
    ok(len(places) == 3, "location panel renders all 3 place cards",
       detail=f"got {len(places)}")
    pins = ui_payload.get("map_pins") or []
    ok(len(pins) == 2,
       "map_pins == 2 (only the 2 places with coordinates)",
       detail=str(pins))
    ok(ui_payload.get("map_available") is True,
       "map_available flag flipped on when any pins exist")
    ok(ui_payload.get("place_count") == 3, "place_count reports total cards")
    ok(ui_payload.get("location") == "Irvine",
       "location field surfaces the parsed city",
       detail=str(ui_payload.get("location")))
finally:
    _ws_panel._serper_search_organic = _OriginalOrganic
    _ws_panel._serper_media = _OriginalMedia

# ============================================================================
# 2026-05-28 — pending location follow-up actually opens the panel
# ============================================================================
section("Pending location — 'Irvine' reply resumes search and opens panel")
import app as _app_pl
_OriginalHandleA = _app_pl.handle_web_search_request
_calls = {"args": []}


def _capture_handle(vera_arg, query, raw_user_text=None):
    _calls["args"].append({"query": query, "raw_user_text": raw_user_text})
    # Pretend the resumed call returns a populated location_map_panel.
    return {
        "spoken_reply": "Here are some coffee shops in Irvine.",
        "action_type": "web_search",
        "data": {"query": query, "places": [{"name": "Demo Cafe"}]},
        "ui_payload": {
            "panel_type": "location_map_panel",
            "title": "Places",
            "query": query,
            "location": "Irvine",
            "places": [{"name": "Demo Cafe"}],
            "map_pins": [],
            "map_available": False,
            "place_count": 1,
        },
    }


_app_pl.handle_web_search_request = _capture_handle
try:
    # Pretend the dispatcher previously set a pending action for
    # "coffee shops near me" with location missing.
    pending_state = {
        "action_name": "web.search",
        "missing_slot": "location",
        "slots": {"user_text": "coffee shops near me",
                  "query": "coffee shops near me"},
    }
    result, _t = _app_pl.resolve_pending_web_search_request(
        "pl-test-session", "Irvine", pending_state
    )
    ok(result is not None and result.get("ui_payload") is not None,
       "pending resolve returns an action_result with a ui_payload")
    ok(result["ui_payload"].get("panel_type") == "location_map_panel",
       "resolved pending opens location_map_panel",
       detail=str(result["ui_payload"]))
    ok(len(_calls["args"]) == 1, "handle_web_search_request called exactly once")
    forwarded = _calls["args"][0]
    ok("Irvine" in (forwarded["query"] or ""),
       "combined query carries the user-provided city ('Irvine')",
       detail=str(forwarded))
    # CRITICAL: raw_user_text must equal combined_query so the classifier
    # sees the city and routes to location_map_panel (not clarification).
    ok(forwarded["raw_user_text"] == forwarded["query"],
       "resolver passes combined_query as raw_user_text (classifier sees city)",
       detail=str(forwarded))
finally:
    _app_pl.handle_web_search_request = _OriginalHandleA

# ============================================================================
# 2026-05-28 — venue-category extraction for pending_place_query payloads
# ============================================================================
section("Venue category — extract_venue_category covers the spec phrases")
for phrase, expected_substring in [
    ("coffee shops near me", "coffee shops"),
    ("cafes near UCI", "cafes"),
    ("restaurants in Garden Grove", "restaurants"),
    ("study cafes near me", "study cafes"),
    ("gyms nearby", "gyms"),
]:
    cat = _ws_panel.extract_venue_category(phrase)
    ok(expected_substring in cat,
       f"extract_venue_category({phrase!r}) → contains {expected_substring!r}",
       detail=f"got {cat!r}")

# ============================================================================
# 2026-05-28 — '[product_panel]' + '[place_panel]' logs emit on render
# ============================================================================
section("Structured logs — [product_panel] and [place_panel] fire")
import io as _io
import contextlib as _ctx

_ws_panel._serper_search_organic = _fake_organic
_ws_panel._serper_media = _fake_shopping_many
buf = _io.StringIO()
try:
    with _ctx.redirect_stdout(buf):
        _ws_panel.prepare_web_search_streaming(
            _FakeVeraWeb(), "best mic under $100", raw_user_text="best mic under $100"
        )
    out = buf.getvalue()
    ok("[product_panel]" in out, "product render emits [product_panel] log",
       detail=out[:300])
    ok('"product_panel_created": true' in out,
       "[product_panel] log marks product_panel_created=true")
    ok('"product_image_present": true' in out,
       "[product_panel] log marks product_image_present=true")
    ok('"product_cards_rendered": 3' in out,
       "[product_panel] log reports 3 rendered cards")
finally:
    _ws_panel._serper_search_organic = _OriginalOrganic
    _ws_panel._serper_media = _OriginalMedia

_ws_panel._serper_search_organic = _fake_organic
_ws_panel._serper_media = _fake_places_many
buf2 = _io.StringIO()
try:
    with _ctx.redirect_stdout(buf2):
        _ws_panel.prepare_web_search_streaming(
            _FakeVeraWeb(), "coffee shops in Irvine",
            raw_user_text="coffee shops in Irvine"
        )
    out2 = buf2.getvalue()
    ok("[place_panel]" in out2, "place render emits [place_panel] log",
       detail=out2[:300])
    ok('"location_panel_created": true' in out2,
       "[place_panel] log marks location_panel_created=true")
    ok('"map_pins_count": 2' in out2,
       "[place_panel] log reports map_pins_count=2",
       detail=out2[:600])
    ok('"places_count": 3' in out2,
       "[place_panel] log reports places_count=3")
finally:
    _ws_panel._serper_search_organic = _OriginalOrganic
    _ws_panel._serper_media = _OriginalMedia

# ============================================================================
# 2026-05-28 — info-tool direct location phrases (lowercase + bare coffee)
# ============================================================================
section("Info-tool — direct location routes to web.search")
for phrase in (
    "coffee near irvine",
    "coffee shops in Irvine",
    "cafes in Fountain Valley",
    "restaurants near UCI",
):
    c = classify(phrase, location_available=False)
    ok(c["route"] == "general_web_search_tool",
       f"info-tool {phrase!r} → general_web_search_tool",
       detail=str(c))
    b = build(phrase, c)
    ok(b is not None and b.get("action_name") == "web.search",
       f"info-tool {phrase!r} builds web.search route",
       detail=str(b))

section("Pending location — lowercase 'fountain valley' title-cases + resolves")
_app_pl2 = _app_pl
_OrigHandleB = _app_pl2.handle_web_search_request
_calls2 = {"args": []}


def _capture_handle2(vera_arg, query, raw_user_text=None):
    _calls2["args"].append({"query": query, "raw_user_text": raw_user_text})
    return {
        "spoken_reply": "Here are coffee shops in Fountain Valley.",
        "action_type": "web_search",
        "data": {"query": query},
        "ui_payload": {
            "panel_type": "location_map_panel",
            "query": query,
            "location": "Fountain Valley",
            "places": [],
            "request_id": "req_test",
            "result_kind": "location",
            "created_at_ms": 999999,
        },
    }


_app_pl2.handle_web_search_request = _capture_handle2
try:
    pending_fv = {
        "action_name": "web.search",
        "missing_slot": "location",
        "slots": {"user_text": "coffee shops near me", "query": "coffee shops near me"},
    }
    result_fv, _ = _app_pl2.resolve_pending_web_search_request(
        "pl-fv", "fountain valley", pending_fv
    )
    ok("Fountain Valley" in (_calls2["args"][0]["query"] or ""),
       "pending resolve title-cases fountain valley → Fountain Valley",
       detail=str(_calls2["args"][0]))
    ok(result_fv.get("ui_payload", {}).get("panel_type") == "location_map_panel",
       "fountain valley follow-up opens location_map_panel")
finally:
    _app_pl2.handle_web_search_request = _OrigHandleB

section("Location payload — request_id + canonical_places metadata")
_ws_panel._serper_search_organic = _fake_organic
_ws_panel._serper_media = _fake_places_many
try:
    prepared_loc = _ws_panel.prepare_web_search_streaming(
        _FakeVeraWeb(), "coffee near irvine", raw_user_text="coffee near irvine"
    )
    _m, ui_loc, _f = prepared_loc
    ok(ui_loc.get("panel_type") == "location_map_panel",
       "coffee near irvine → location_map_panel payload")
    ok(ui_loc.get("result_kind") == "location", "location payload result_kind=location")
    ok(bool(ui_loc.get("request_id")), "location payload has request_id")
    ok(isinstance(ui_loc.get("canonical_places"), list),
       "location payload has canonical_places")
finally:
    _ws_panel._serper_search_organic = _OriginalOrganic
    _ws_panel._serper_media = _OriginalMedia

# ============================================================================
# Final tally
# ============================================================================
print(f"\n{'='*60}")
print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
if FAILED:
    print("\nFailing tests:")
    for n in FAILED:
        print(f"  - {n}")
    sys.exit(1)
print("All info-tool router smoke tests passed.")
