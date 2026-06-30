"""Smoke tests for the explicit-general-news-intent override (2026-06-01).

Patch goal: explicit general-news requests like "Can you tell me the latest
news?" must NEVER reach Serper/generic web search. They are routed to the
BBC RSS top-headlines flow (news.latest with empty query + force_top_headlines).

This file exercises:
  * `is_explicit_general_news_intent(text)` — the new helper:
      - positive examples from the patch spec
      - negative examples (specific target, weather/finance/sports conflict)
      - empty / None safety
  * `heuristic_route_action(text)` — early branch returns the expected
    news.latest route with the force_top_headlines slot for every positive
    example and DOES NOT claim any negative example.
  * `_finalize_news_latest_slots` short-circuit — when force_top_headlines
    is set, query/topic/search_queries are stripped so the action dispatcher
    calls handle_news_request(query=None, search_queries=None) and reaches
    the BBC RSS branch.
  * `build_route_from_info_tool` defense-in-depth — even when the info_tool
    classifier returns news_search_tool, an explicit-general-news intent
    is forced onto the BBC route.

Run:  py -3 tests/smoke/__explicit_general_news_intent_smoke.py
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
# Suite A - is_explicit_general_news_intent positive cases (patch spec list)
# ---------------------------------------------------------------------------
section("Suite A - is_explicit_general_news_intent POSITIVE cases (patch spec)")
POSITIVE_CASES = [
    "Tell me about the news.",
    "Can you tell me the latest news?",
    "Could you tell me the latest news please?",
    "What's the latest news?",
    "What is the latest news?",
    "Give me today's headlines.",
    "Any news updates?",
    "What's happening in the world?",
    "What is happening in the world right now?",
    "Tell me the top stories.",
    "What are the latest headlines?",
    "Show me today's news.",
    "Any news?",
    "Tell me the news",
    "Hey Vera, what are the top stories today?",
    "Give me the current events.",
    "Any breaking news?",
]
for tx in POSITIVE_CASES:
    res = app.is_explicit_general_news_intent(tx)
    ok(res is True, f"POS '{tx}' -> True", detail=f"got {res}")


# ---------------------------------------------------------------------------
# Suite B - is_explicit_general_news_intent NEGATIVE cases
# ---------------------------------------------------------------------------
section("Suite B - is_explicit_general_news_intent NEGATIVE cases (specific target / domain conflict)")
NEGATIVE_CASES = [
    # specific-topic news (still allowed to use Serper /news search)
    "Search news about Nvidia earnings.",
    "Find latest news on Spotify layoffs.",
    "What happened with the UCI protest?",
    "BBC news about Ukraine.",
    "Show me sports news about Lakers.",
    "News about UCI",
    "Latest news about OpenAI",
    "News on Apple's iPhone launch",
    # weather / finance / music / sports / app-UI domain conflicts
    "What's the weather news?",
    "Tell me the stock market news.",
    "Any sports news?",
    "Play news music",
    "Open the news panel",
    # personal / emotional (no news intent)
    "I got bad news",
    "I have terrible news",
    "I just saw the news my friend passed away",
    "Hey Vera, do you know any news from my family?",
    # general-knowledge / non-news
    "What is tennis?",
    "Tell me about Napoleon.",
    "Explain photosynthesis.",
    "Hello",
    "",
]
for tx in NEGATIVE_CASES:
    res = app.is_explicit_general_news_intent(tx)
    ok(res is False, f"NEG '{tx}' -> False", detail=f"got {res}")

# None safety
ok(app.is_explicit_general_news_intent(None) is False, "None safety -> False")
ok(app.is_explicit_general_news_intent("   ") is False, "whitespace-only -> False")


# ---------------------------------------------------------------------------
# Suite C - heuristic_route_action returns news.latest + force_top_headlines
# ---------------------------------------------------------------------------
section("Suite C - heuristic_route_action override for positive cases")
ROUTE_POSITIVE_CASES = [
    "Tell me about the news.",
    "Can you tell me the latest news?",
    "What's the latest news?",
    "Give me today's headlines.",
    "Any news updates?",
    "What's happening in the world?",
    "Tell me the top stories.",
    "What are the latest headlines?",
]
for tx in ROUTE_POSITIVE_CASES:
    route = app.heuristic_route_action(tx)
    ok(isinstance(route, dict), f"route returned (dict) for '{tx}'")
    if not isinstance(route, dict):
        continue
    ok(route.get("action_name") == "news.latest", f"action_name=news.latest for '{tx}'", detail=str(route.get("action_name")))
    ok(route.get("domain") == "news", f"domain=news for '{tx}'", detail=str(route.get("domain")))
    slots = route.get("slots") or {}
    ok(bool(slots.get("force_top_headlines")), f"force_top_headlines=True for '{tx}'", detail=str(slots))
    ok(slots.get("query") == "", f"slots.query='' for '{tx}'", detail=repr(slots.get("query")))
    ok(slots.get("topic") == "", f"slots.topic='' for '{tx}'", detail=repr(slots.get("topic")))
    ok(slots.get("search_queries") == [], f"slots.search_queries=[] for '{tx}'", detail=repr(slots.get("search_queries")))
    ok(slots.get("source_preference") == "bbc", f"slots.source_preference='bbc' for '{tx}'")
    ok(slots.get("count") == 3, f"slots.count=3 for '{tx}'")
    ok(slots.get("broad_news_reset") is False, f"slots.broad_news_reset=False for '{tx}'")


# ---------------------------------------------------------------------------
# Suite D - heuristic_route_action does NOT claim negative cases as news
# ---------------------------------------------------------------------------
section("Suite D - heuristic_route_action does NOT force-route negative cases to news.latest")
ROUTE_NEGATIVE_NOT_FORCED = [
    "Search news about Nvidia earnings.",
    "Find latest news on Spotify layoffs.",
    "BBC news about Ukraine.",
    "Show me sports news about Lakers.",
    "What's the weather news?",
    "News about UCI",
    "Latest news about OpenAI",
]
for tx in ROUTE_NEGATIVE_NOT_FORCED:
    route = app.heuristic_route_action(tx)
    # The route MAY still be news (via is_broad_news_reset_request / patterns),
    # but it MUST NOT carry the force_top_headlines flag. That flag is the
    # only path that strips the user's specific target.
    if isinstance(route, dict) and route.get("action_name") == "news.latest":
        slots = route.get("slots") or {}
        ok(
            not bool(slots.get("force_top_headlines")),
            f"NEG '{tx}' news.latest WITHOUT force_top_headlines",
            detail=str(slots),
        )
    else:
        ok(
            True,
            f"NEG '{tx}' did not produce force_top_headlines route (action={route.get('action_name') if route else None})",
        )


# ---------------------------------------------------------------------------
# Suite E - _finalize_news_latest_slots short-circuit
# ---------------------------------------------------------------------------
section("Suite E - _finalize_news_latest_slots strips inherited query when force_top_headlines=True")

# Simulate a slot dict where the upstream classifier accidentally injected
# a Serper-ready query AND search_queries. The short-circuit must wipe them
# so the action dispatcher reaches the BBC RSS branch.
poisoned_slots = {
    "query": "can you tell me the latest news",
    "topic": "can you tell me the latest news",
    "entities": ["news"],
    "time_horizon": "today",
    "search_queries": ["latest news headlines today"],
    "broad_news_reset": True,
    "force_top_headlines": True,
}
finalized = app._finalize_news_latest_slots(
    "session-test-1",
    "Can you tell me the latest news?",
    poisoned_slots,
)
ok(finalized.get("query") == "", "finalize: query stripped to ''", detail=repr(finalized.get("query")))
ok(finalized.get("topic") == "", "finalize: topic stripped to ''", detail=repr(finalized.get("topic")))
ok(finalized.get("entities") == [], "finalize: entities stripped to []", detail=repr(finalized.get("entities")))
ok(finalized.get("search_queries") == [], "finalize: search_queries stripped to []", detail=repr(finalized.get("search_queries")))
ok(finalized.get("broad_news_reset") is False, "finalize: broad_news_reset cleared to False", detail=repr(finalized.get("broad_news_reset")))
ok(finalized.get("force_top_headlines") is True, "finalize: force_top_headlines preserved", detail=repr(finalized.get("force_top_headlines")))
ok(finalized.get("source_preference") == "bbc", "finalize: source_preference=bbc preserved")
ok(finalized.get("count") == 3, "finalize: count=3 preserved")
ok(finalized.get("time_horizon") == "", "finalize: time_horizon cleared", detail=repr(finalized.get("time_horizon")))


# ---------------------------------------------------------------------------
# Suite F - build_route_from_info_tool defense-in-depth
# ---------------------------------------------------------------------------
section("Suite F - build_route_from_info_tool forces BBC route for explicit general news")

classification = {
    "route": "news_search_tool",
    "query": "can you tell me the latest news",
    "normalized_query": "can you tell me the latest news",
    "entities": [],
}
built = app.build_route_from_info_tool(
    "Can you tell me the latest news?",
    classification,
    session_id="session-test-2",
)
ok(isinstance(built, dict), "build_route_from_info_tool returned a dict")
ok(built.get("action_name") == "news.latest", "action_name=news.latest", detail=str(built.get("action_name")))
slots = built.get("slots") or {}
ok(bool(slots.get("force_top_headlines")), "force_top_headlines=True (defense-in-depth)", detail=str(slots))
ok(slots.get("query") == "", "slots.query='' (no Serper query)", detail=repr(slots.get("query")))
ok(slots.get("search_queries") == [], "slots.search_queries=[]", detail=repr(slots.get("search_queries")))
ok(slots.get("source_preference") == "bbc", "slots.source_preference=bbc")
ok(slots.get("count") == 3, "slots.count=3")

# Negative: specific-target news request still keeps the raw query.
classification_specific = {
    "route": "news_search_tool",
    "query": "Latest news about Nvidia earnings",
    "normalized_query": "Latest news about Nvidia earnings",
    "entities": ["Nvidia"],
}
built_specific = app.build_route_from_info_tool(
    "Latest news about Nvidia earnings",
    classification_specific,
    session_id="session-test-3",
)
slots_s = (built_specific or {}).get("slots") or {}
ok(
    not bool(slots_s.get("force_top_headlines")),
    "specific-target news.latest does NOT get force_top_headlines",
    detail=str(slots_s),
)
ok(
    "nvidia" in str(slots_s.get("query") or "").lower(),
    "specific-target query preserved",
    detail=repr(slots_s.get("query")),
)


# ---------------------------------------------------------------------------
# Suite G - END-TO-END: prepare_news_streaming_messages reaches BBC branch
#           when slots are stripped (no Serper call).
# ---------------------------------------------------------------------------
section("Suite G - end-to-end: BBC RSS branch is taken, Serper is NOT called")

from actions import news as _news_mod  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

_orig_get_top_news = _news_mod.get_top_news
_orig_serper_one = getattr(_news_mod, "_search_news_results_serper", None)
_orig_serper_multi = getattr(_news_mod, "search_news_results", None)

class _StubVera:
    def build_messages(self, *, chat_history, user_text):
        return [{"role": "user", "content": user_text}]

_FAKE_BBC_ITEMS = [
    {
        "title": "BBC headline 1",
        "summary": "BBC summary 1.",
        "source": "BBC",
        "url": "https://www.bbc.com/news/1",
        "published": datetime(2026, 6, 1, 8, 0, 0, tzinfo=timezone.utc),
    },
    {
        "title": "BBC headline 2",
        "summary": "BBC summary 2.",
        "source": "BBC",
        "url": "https://www.bbc.com/news/2",
        "published": datetime(2026, 6, 1, 8, 10, 0, tzinfo=timezone.utc),
    },
    {
        "title": "BBC headline 3",
        "summary": "BBC summary 3.",
        "source": "BBC",
        "url": "https://www.bbc.com/news/3",
        "published": datetime(2026, 6, 1, 8, 20, 0, tzinfo=timezone.utc),
    },
]

_top_news_called: dict = {"count": 0, "limit": None}
def _fake_get_top_news(limit=5):
    _top_news_called["count"] += 1
    _top_news_called["limit"] = limit
    return list(_FAKE_BBC_ITEMS[:limit])

_serper_calls: list = []
def _trip_serper(*args, **kwargs):
    _serper_calls.append({"args": args, "kwargs": kwargs})
    raise AssertionError("Serper MUST NOT be called for explicit general news")

_news_mod.get_top_news = _fake_get_top_news
if _orig_serper_one is not None:
    _news_mod._search_news_results_serper = _trip_serper
if _orig_serper_multi is not None:
    _news_mod.search_news_results = _trip_serper

try:
    # Drive the full chain: heuristic_route_action -> route slots ->
    # _finalize_news_latest_slots short-circuit -> handle_news_request ->
    # prepare_news_streaming_messages -> BBC RSS branch.
    text = "Can you tell me the latest news?"
    route = app.heuristic_route_action(text)
    ok(route and route.get("action_name") == "news.latest", "heuristic returns news.latest")
    finalized = app._finalize_news_latest_slots("session-e2e", text, dict(route.get("slots") or {}))
    ok(finalized.get("force_top_headlines") is True, "finalized slots preserve force_top_headlines")
    ok(finalized.get("query") == "", "finalized slots have empty query")
    ok(finalized.get("search_queries") == [], "finalized slots have empty search_queries")

    query = (finalized.get("query") or finalized.get("topic") or "").strip()
    breaking = bool(finalized.get("breaking"))
    search_queries = list(finalized.get("search_queries") or [])
    ok(query == "", "downstream query arg becomes ''")
    ok(breaking is False, "downstream breaking arg becomes False")
    ok(search_queries == [], "downstream search_queries arg becomes []")

    # Call the BBC streamer directly with the same shape the dispatcher
    # uses: query=None, breaking=False, search_queries=None.
    prepared = _news_mod.prepare_news_streaming_messages(
        _StubVera(),
        query=None,
        breaking=False,
        search_queries=None,
    )
    ok(prepared is not None, "prepare_news_streaming_messages returned a tuple")
    messages, ui_payload, finalize_fn = prepared
    ok(_top_news_called["count"] == 1, "BBC get_top_news called exactly once", detail=str(_top_news_called))
    ok(_top_news_called["limit"] == 3, "BBC get_top_news called with limit=3", detail=str(_top_news_called))
    ok(_serper_calls == [], "Serper functions NOT called", detail=str(_serper_calls))

    # Verify the LLM-input prompt uses the BBC preamble.
    user_text = messages[0]["content"]
    ok(_news_mod.BBC_NEWS_PREAMBLE.split("\n")[0] in user_text, "user_text carries BBC preamble first line")
    ok("According to the BBC" in user_text or "BBC reports that" in user_text, "user_text mentions BBC attribution phrasing")

    # Verify there are 3 numbered items in the BBC prompt.
    ok("1. BBC headline 1" in user_text, "BBC prompt has item 1")
    ok("2. BBC headline 2" in user_text, "BBC prompt has item 2")
    ok("3. BBC headline 3" in user_text, "BBC prompt has item 3")

    # Verify ui_payload + finalize result shape.
    finalized_result = finalize_fn("Here are the latest news headlines from BBC: ...")
    ok(isinstance(finalized_result, dict), "finalize returned a dict")
    ok(finalized_result.get("action_type") == "news", "action_type=news")
    headlines = (finalized_result.get("data") or {}).get("headlines") or []
    news_results = (finalized_result.get("ui_payload") or {}).get("news_results") or []
    ok(len(headlines) == 3, f"data.headlines has 3 items (len={len(headlines)})")
    ok(len(news_results) == 3, f"ui_payload.news_results has 3 items (len={len(news_results)})")
    ok(
        all((it.get("source") or "").upper() == "BBC" for it in news_results),
        "all news_results have source=BBC",
        detail=str([it.get("source") for it in news_results]),
    )
    ok(
        (finalized_result.get("data") or {}).get("mode") == "headlines",
        "data.mode='headlines'",
    )
finally:
    _news_mod.get_top_news = _orig_get_top_news
    if _orig_serper_one is not None:
        _news_mod._search_news_results_serper = _orig_serper_one
    if _orig_serper_multi is not None:
        _news_mod.search_news_results = _orig_serper_multi


# ---------------------------------------------------------------------------
print(f"\n{YELLOW}== SUMMARY =={RESET}")
print(f"  {GREEN}passed: {PASS}{RESET}")
print(f"  {RED if FAIL else GREEN}failed: {FAIL}{RESET}")
if FAIL:
    print(f"\n{RED}First failures:{RESET}")
    for n in FAILED[:10]:
        print(f"  - {n}")
sys.exit(0 if FAIL == 0 else 1)
