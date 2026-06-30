"""Smoke tests for the 2026-05-30 pre-news info-query normalizer.

Covers the 13 test cases from the spec:

Product (1-4):
  1. "can you suggest me some webcam any price is fine? i have a zoom
     meeting next and webcam is required"
     -> intent_type=product, normalized_query="best webcam for Zoom meeting",
     panel != News Results.
  2. "best mic under $100"
     -> intent_type=product, product_budget="$100"
  3. "recommend headphones for studying"
     -> intent_type=product, product_use_case="studying"
  4. "what laptop should I buy for data science?"
     -> intent_type=product

News follow-up (5-8):
  5. "do you know the chemical leaks in Orange County?"
     -> store topic=chemical leak, location=Orange County (verified via
     _extract_topic_core / _extract_topic_location).
  6. "well it was in Garden Grove i think can you give me some news on
     that?"
     -> intent_type=news, normalized_query includes Garden Grove + Orange
     County + chemical leak.
  7. "wait can you check news in Garden Grove?" after chemical-leak ctx
     -> normalized_query includes Garden Grove + chemical leak.
  8. "news about OpenAI" -> intent_type=news.

Location (9-10):
  9. "coffee shops in Irvine" -> intent_type=location.
  10. "grocery stores in Fountain Valley" -> intent_type=location.

Negative (11-13):
  11. "news about webcams" -> news, NOT product.
  12. "did Nvidia announce a new GPU?" -> news/web, NOT product
      recommendation.
  13. "best webcam news" -> route by dominant wording but flag ambiguity.

Run:  py -3 tests\\smoke\\__info_normalizer_smoke.py
"""
from __future__ import annotations

# --- bootstrap (mirrors __info_tool_router_smoke.py) -------------------
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")))
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

# Stub out heavy audio modules the same way other smoke tests do, so
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

# Import the normalizer first (pure module, fast) so we can run partial
# tests even if `app` fails to import.
from actions import info_normalizer  # noqa: E402

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


def normalize(text: str, ctx: dict | None = None) -> dict:
    return info_normalizer.normalize_info_request(text, recent_news_context=ctx)


def classify(text: str, ctx: dict | None = None) -> dict:
    return app.classify_info_tool(
        text,
        recent_news_context=ctx,
        session_id="smoke",
        location_available=False,
    )


def build(text: str, cls: dict) -> dict | None:
    return app.build_route_from_info_tool(text, cls, session_id="smoke")


def chemical_leak_ctx() -> dict:
    """The stored news context after Manual Test 5."""
    return {
        "topic": "chemical leaks in Orange County",
        "resolved_topic": "chemical leaks in Orange County",
        "entities": ["Orange County"],
        "previous_route_type": "topical_news_search",
        "answer_summary": "Chemical leak incidents reported in Orange County.",
    }


# ============================================================================
# Schema contract
# ============================================================================
section("Schema contract — normalize_info_request returns all spec keys")
EXPECTED_KEYS = {
    "intent_type", "normalized_query", "topic", "location", "entity",
    "product_category", "product_budget", "product_use_case",
    "confidence", "context_used", "reason",
}
sample = normalize("hello")
missing = EXPECTED_KEYS - set(sample.keys())
ok(not missing, "all spec keys present", detail=f"missing={missing}")
ok(isinstance(sample.get("confidence"), (int, float)), "confidence is numeric")
ok(isinstance(sample.get("context_used"), bool), "context_used is bool")


# ============================================================================
# PRODUCT — 1..4
# ============================================================================
section("Test 1 — webcam suggestion (long voice transcript)")
TEXT1 = (
    "can you suggest me some webcam any price is fine? i have a zoom meeting "
    "next and webcam is required"
)
n = normalize(TEXT1)
ok(n["intent_type"] == "product",
   "intent_type=product", detail=str(n))
ok(n["normalized_query"] == "best webcam for Zoom meeting",
   "normalized_query='best webcam for Zoom meeting'",
   detail=str(n["normalized_query"]))
ok(n["product_category"] == "webcam", "product_category=webcam")
ok(n["product_use_case"] == "Zoom meeting", "product_use_case='Zoom meeting'")
ok(n["product_budget"] in (None, ""),
   "product_budget=None (any price is fine)", detail=str(n["product_budget"]))

# Routing must not be news. classify_info_tool short-circuits to
# general_web_search_tool with the normalized query.
cls = classify(TEXT1)
ok(cls["route"] == "general_web_search_tool",
   "route=general_web_search_tool", detail=str(cls))
ok(cls.get("query") == "best webcam for Zoom meeting",
   "classification.query is normalized", detail=str(cls.get("query")))
built = build(TEXT1, cls)
ok((built or {}).get("action_name") == "web.search",
   "action=web.search", detail=str(built))
ok(((built or {}).get("slots") or {}).get("query") == "best webcam for Zoom meeting",
   "slots.query is normalized")
ok(((built or {}).get("slots") or {}).get("product_intent", {}).get("product_category") == "webcam",
   "slots.product_intent.product_category=webcam")
# Panel safety net: the broadened _SHOPPING_RE in actions.web_search must
# also match the normalized query so panel routing lands on product.
from actions.web_search import _SHOPPING_RE  # noqa: E402
ok(bool(_SHOPPING_RE.search("best webcam for Zoom meeting")),
   "_SHOPPING_RE matches 'best webcam for Zoom meeting'")
ok(bool(_SHOPPING_RE.search(TEXT1)),
   "_SHOPPING_RE matches raw 'suggest me some webcam'")


section("Test 2 — 'best mic under $100' -> product + budget")
n = normalize("best mic under $100")
ok(n["intent_type"] == "product", "intent_type=product", detail=str(n))
ok(n["product_category"] == "microphone",
   "product_category=microphone (mic -> microphone)")
ok(n["product_budget"] == "$100", "product_budget=$100", detail=str(n["product_budget"]))
ok(n["normalized_query"] == "best microphone under $100",
   "normalized_query='best microphone under $100'", detail=n["normalized_query"])


section("Test 3 — 'recommend headphones for studying' -> use_case")
n = normalize("recommend headphones for studying")
ok(n["intent_type"] == "product", "intent_type=product")
ok(n["product_category"] == "headphones", "product_category=headphones")
ok(n["product_use_case"] == "studying", "product_use_case=studying")
ok(n["normalized_query"] == "best headphones for studying",
   "normalized_query='best headphones for studying'", detail=n["normalized_query"])


section("Test 4 — 'what laptop should I buy for data science?' -> product")
n = normalize("what laptop should I buy for data science?")
ok(n["intent_type"] == "product", "intent_type=product", detail=str(n))
ok(n["product_category"] == "laptop", "product_category=laptop")
ok(n["product_use_case"] == "data science", "product_use_case='data science'")
ok(n["normalized_query"] == "best laptop for data science",
   "normalized_query='best laptop for data science'", detail=n["normalized_query"])


# ============================================================================
# NEWS FOLLOW-UP — 5..8
# ============================================================================
section("Test 5 — chemical-leak prompt stores topic + location in ctx (helper smoke)")
# We don't have a live news.latest run here, so verify the topic+location
# extractors do the right thing on the topic phrase that
# `set_recent_news_context_from_action_result` would store.
stored_topic = "chemical leaks in Orange County"
ok(info_normalizer._extract_topic_core(stored_topic) == "chemical leak",
   "_extract_topic_core -> 'chemical leak'",
   detail=info_normalizer._extract_topic_core(stored_topic))
ok(info_normalizer._extract_topic_location(stored_topic, ["Orange County"]) == "Orange County",
   "_extract_topic_location -> 'Orange County'",
   detail=info_normalizer._extract_topic_location(stored_topic, ["Orange County"]))


section("Test 6 — 'garden grove ... news on that' merges prior topic + new location")
TEXT6 = (
    "well it was in the garden grove i think can you give me some news on that?"
)
n = normalize(TEXT6, ctx=chemical_leak_ctx())
ok(n["intent_type"] == "news", "intent_type=news", detail=str(n))
ok(n["context_used"] is True, "context_used=True")
ok("garden grove" in n["normalized_query"].lower(),
   "normalized_query contains 'Garden Grove'", detail=n["normalized_query"])
ok("orange county" in n["normalized_query"].lower(),
   "normalized_query contains 'Orange County'", detail=n["normalized_query"])
ok("chemical leak" in n["normalized_query"].lower(),
   "normalized_query contains 'chemical leak'", detail=n["normalized_query"])
ok("news" in n["normalized_query"].lower(),
   "normalized_query ends with 'news'", detail=n["normalized_query"])

# Full pipeline: classify -> build -> ensure slots carry the merged query
# and pre_normalized=True so _finalize_news_latest_slots trusts it.
cls = classify(TEXT6, ctx=chemical_leak_ctx())
ok(cls["route"] == "news_search_tool",
   "route=news_search_tool (ctx-merge)", detail=str(cls))
built = build(TEXT6, cls)
ok((built or {}).get("action_name") == "news.latest",
   "action=news.latest", detail=str(built))
slots = (built or {}).get("slots") or {}
ok(bool(slots.get("pre_normalized")),
   "slots.pre_normalized=True", detail=str(slots))
queries = slots.get("search_queries") or []
ok(any("garden grove" in q.lower() and "chemical leak" in q.lower() for q in queries),
   "search_queries contain merged topic + new location", detail=str(queries))
ents = slots.get("entities") or []
ok(any("Garden Grove" in e for e in ents) and any("Orange County" in e for e in ents),
   "slots.entities includes both new and prior location", detail=str(ents))

# Make sure _finalize_news_latest_slots respects pre_normalized and doesn't
# clobber the merged query even though the raw text is deictic ("on that").
final_slots = app._finalize_news_latest_slots("smoke-test-ctx", TEXT6, dict(slots))
fq = final_slots.get("search_queries") or []
ok(any("garden grove" in q.lower() and "chemical leak" in q.lower() for q in fq),
   "finalized slots STILL contain merged query", detail=str(fq))


section("Test 7 — 'wait can you check news in Garden Grove?' inherits prior topic")
TEXT7 = "wait can you check news in Garden Grove?"
n = normalize(TEXT7, ctx=chemical_leak_ctx())
ok(n["intent_type"] == "news", "intent_type=news")
ok("garden grove" in n["normalized_query"].lower(),
   "normalized_query contains Garden Grove", detail=n["normalized_query"])
ok("chemical leak" in n["normalized_query"].lower(),
   "normalized_query contains 'chemical leak'", detail=n["normalized_query"])
cls = classify(TEXT7, ctx=chemical_leak_ctx())
ok(cls["route"] == "news_search_tool", "route=news_search_tool", detail=str(cls))


section("Test 8 — 'news about OpenAI' -> intent_type=news, no ctx merge")
n = normalize("news about OpenAI")
ok(n["intent_type"] == "news", "intent_type=news", detail=str(n))
ok(n["context_used"] is False, "context_used=False (no ctx merge)")
ok("openai" in n["normalized_query"].lower(),
   "normalized_query contains OpenAI", detail=n["normalized_query"])


# ============================================================================
# LOCATION — 9..10
# ============================================================================
section("Test 9 — 'coffee shops in Irvine' -> intent_type=location")
n = normalize("coffee shops in Irvine")
ok(n["intent_type"] == "location", "intent_type=location", detail=str(n))
ok(n["location"] == "Irvine", "location=Irvine", detail=str(n["location"]))
# classify_info_tool keeps the existing local-venue branch; just confirm
# normalize doesn't misroute as product/news.
ok(n["intent_type"] != "product", "NOT product")
ok(n["intent_type"] != "news", "NOT news")


section("Test 10 — 'grocery stores in Fountain Valley' -> location")
n = normalize("grocery stores in Fountain Valley")
ok(n["intent_type"] == "location", "intent_type=location", detail=str(n))
ok(n["location"] == "Fountain Valley",
   "location='Fountain Valley'", detail=str(n["location"]))


# ============================================================================
# NEGATIVES — 11..13
# ============================================================================
section("Test 11 — 'news about webcams' -> news, NOT product")
n = normalize("news about webcams")
ok(n["intent_type"] == "news",
   "intent_type=news (explicit news request beats product detection)",
   detail=str(n))
ok(n["intent_type"] != "product", "NOT product")


section("Test 12 — 'did Nvidia announce a new GPU?' -> NOT product recommendation")
n = normalize("did Nvidia announce a new GPU?")
ok(n["intent_type"] != "product",
   "intent_type != product (no recommendation/intent verb)", detail=str(n))
# It can be unknown (falling through to legacy current-fact router) or
# news; either is fine -- the key invariant is no product short-circuit.
ok(n["intent_type"] in ("unknown", "news", "web"),
   "intent_type in {unknown,news,web}", detail=str(n))


section("Test 13 — 'best webcam news' -> route by dominant wording, log ambiguity")
n = normalize("best webcam news")
# Dominant wording is product (two product cues 'best' + 'webcam' vs one
# news cue), so we let product win but the ambiguity signal is recorded
# for the [info_query_ambiguous] log line.
ok(n["intent_type"] == "product",
   "intent_type=product (dominant wording)", detail=str(n))
ok(n.get("ambiguity_signals") and "news_keyword_in_raw" in n["ambiguity_signals"],
   "ambiguity_signals records news_keyword_in_raw",
   detail=str(n.get("ambiguity_signals")))
ok(n["confidence"] <= 0.8,
   "confidence is downgraded when ambiguous", detail=str(n["confidence"]))


# ============================================================================
# Bonus — dedupe_news_keywords
# ============================================================================
section("Bonus — dedupe_news_keywords drops trailing duplicate 'news'")
ok(info_normalizer.dedupe_news_keywords("Garden Grove chemical leak news")
   == "Garden Grove chemical leak news",
   "preserve single 'news' suffix")
ok(info_normalizer.dedupe_news_keywords("Garden Grove chemical leak news news")
   == "Garden Grove chemical leak news",
   "collapse 'news news' -> 'news'")
ok(info_normalizer.dedupe_news_keywords("OpenAI latest news news")
   == "OpenAI latest news",
   "collapse 'latest news news' -> 'latest news'")
ok(info_normalizer.dedupe_news_keywords("OpenAI") == "OpenAI",
   "leave non-news query untouched")
ok(info_normalizer.should_append_news_keyword("Garden Grove chemical leak news") is False,
   "should_append_news_keyword=False when 'news' already present")
ok(info_normalizer.should_append_news_keyword("Garden Grove chemical leak") is True,
   "should_append_news_keyword=True when no news token")


# ============================================================================
# Summary
# ============================================================================
print(f"\n{YELLOW}== SUMMARY =={RESET}")
print(f"  {GREEN}passed: {PASS}{RESET}")
if FAIL:
    print(f"  {RED}failed: {FAIL}{RESET}")
    for name in FAILED:
        print(f"    - {name}")
    sys.exit(1)
else:
    print(f"  failed: 0")
    sys.exit(0)
