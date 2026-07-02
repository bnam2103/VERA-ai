"""Generic web-search action used as the public-information fallback.

This module exists so VERA can answer public-information questions that do
NOT belong to a dedicated specialized tool (time / weather / finance quote /
news). It is the implementation behind two router targets:

  * ``general_web_search_tool``  — sports scores, shopping recommendations,
    local venues with explicit city, "how many episodes" questions, etc.
  * ``finance_search_tool``       — historical / quantitative finance asks
    are still routed to ``finance.analytics`` (which already does its own
    Serper-backed search), but this module is the reusable building block
    if/when we want to widen finance-search to non-analytics topics.

The action streams an LLM answer using best-effort Serper /search snippets.
No side panel is opened — the assistant bubble carries the answer, the same
shape as ``finance.analytics``.

Design notes:

  * Serper is the same provider the news module uses, but the endpoint
    differs (``/search`` for organic vs ``/news`` for news), so we keep an
    independent module and an independent cache.
  * If Serper is unavailable we still build messages with an empty-snippet
    prompt and let the LLM answer (or politely admit it can't), so a
    transient provider outage never collapses into the generic
    "I don't have data" voice line.
  * Result objects intentionally mirror the shape used elsewhere
    (``title`` / ``summary`` / ``source`` / ``url``) so future UI surfaces
    can reuse the rendering code.
"""

from __future__ import annotations

import os
import re
import time
from html import unescape
from urllib.parse import urlparse

import requests

SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search"
SERPER_IMAGES_ENDPOINT = "https://google.serper.dev/images"
SERPER_VIDEOS_ENDPOINT = "https://google.serper.dev/videos"
SERPER_SHOPPING_ENDPOINT = "https://google.serper.dev/shopping"
SERPER_PLACES_ENDPOINT = "https://google.serper.dev/places"
SERPER_API_KEY = os.getenv("SERPER_API_KEY", "").strip()

SEARCH_CACHE_TTL = 180  # seconds — same as news module
SEARCH_RESULT_LIMIT = 8
IMAGE_RESULT_LIMIT = 6
VIDEO_RESULT_LIMIT = 3
SHOPPING_RESULT_LIMIT = 6
PLACES_RESULT_LIMIT = 8
SERPER_TIMEOUT_SEC = 5

# Canonical-list preambles — assistant MUST only name items from the ranked
# product/place list that also feeds the side panel. Grep these when debugging
# assistant/panel mismatches.
WEB_SEARCH_PRODUCT_PREAMBLE = (
    "You are answering a product-shopping question for a voice assistant.\n\n"
    "CRITICAL: You will receive a CANONICAL PRODUCT LIST. Your answer MUST "
    "recommend ONLY products from that list, using the exact product names "
    "shown. Do NOT mention any other product names (even if you know them "
    "from training). The side panel shows the same list — if you name "
    "something not on the list, the user will see a mismatch.\n\n"
    "How to answer:\n"
    "  1. Briefly summarize the top picks by rank (Best overall, Best value, "
    "Alternative) in 2-4 short sentences.\n"
    "  2. Mention price and rating when the list includes them.\n"
    "  3. Voice-friendly tone. No markdown, no bullet lists.\n"
    "  4. If the canonical list is empty, say the shopping search did not "
    "return useful products and suggest refining the query.\n\n"
)

WEB_SEARCH_LOCATION_PREAMBLE = (
    "You are answering a local place/venue question for a voice assistant.\n\n"
    "CRITICAL: You will receive a CANONICAL PLACE LIST and a SEARCH LOCATION. "
    "Your answer MUST summarize ONLY places from that list, using the exact names shown. "
    "Do NOT invent or name other businesses. The map/place panel shows the same list.\n\n"
    "How to answer:\n"
    "  1. Begin with one short sentence that names the search area used "
    "(e.g. 'Sure — here are Asian restaurants near Fountain Valley, CA.').\n"
    "  2. Summarize the top 2-4 options from the list in 2-4 short sentences.\n"
    "  3. Mention ratings or open status when available.\n"
    "  4. Voice-friendly tone. No markdown, no bullet lists.\n"
    "  5. If the list is empty, say the place search did not return results for that area.\n\n"
)

# Beta voice tone, no markdown, no fabricated numbers, never falls back to
# the bare "I don't have data" voice line without acknowledging the search.
WEB_SEARCH_PREAMBLE = (
    "You are answering a public-information question for a voice assistant "
    "using web-search snippets.\n\n"
    "How to answer:\n"
    "  1. Give a direct, source-backed answer in 2-4 short sentences.\n"
    "  2. Mention the source name(s) when the snippet supports it, briefly.\n"
    "  3. Do NOT invent specific numbers, dates, names, or scores that are not\n"
    "     in the snippets. If the snippets are weak or off-topic, say so and\n"
    "     offer to look up something more specific.\n"
    "  4. If the question is opinion/recommendation (e.g. 'best mic under $100'),\n"
    "     summarize what reviewers cite most often; do not pick a single winner\n"
    "     unless the snippets clearly agree.\n"
    "  5. Voice-friendly tone. No markdown, no bullet lists, no headings.\n"
    "  6. Do NOT say 'I don't have data' as a refusal — you DID search the web.\n"
    "     If the search came back empty, say the search did not return useful\n"
    "     results and suggest a tighter query.\n\n"
)


_web_search_cache: dict[str, dict] = {}


def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _source_from_url(url: str) -> str:
    host = urlparse(url or "").netloc.lower()
    host = re.sub(r"^www\.", "", host)
    return host or "Unknown source"


def _serper_search_organic(query: str, limit: int = SEARCH_RESULT_LIMIT) -> dict:
    """POST to Serper ``/search`` with a tiny in-process cache.

    Mirrors the pattern in ``actions/finance.py`` but with an independent
    cache so finance and generic-web evictions don't fight each other.
    """
    if not SERPER_API_KEY:
        raise RuntimeError("SERPER_API_KEY is not set")
    key = (query or "").lower().strip()
    if not key:
        raise RuntimeError("empty query")
    now = time.time()
    cached = _web_search_cache.get(key)
    if cached and now - cached["timestamp"] < SEARCH_CACHE_TTL:
        return cached["payload"]
    response = requests.post(
        SERPER_SEARCH_ENDPOINT,
        headers={
            "X-API-KEY": SERPER_API_KEY,
            "Content-Type": "application/json",
        },
        json={"q": query, "num": limit},
        timeout=SERPER_TIMEOUT_SEC,
    )
    response.raise_for_status()
    payload = response.json()
    try:
        from cost_logging.serper_helpers import log_serper_http_call

        log_serper_http_call(
            endpoint=SERPER_SEARCH_ENDPOINT,
            query=query,
            payload=payload,
            extra={"source": "web_search._serper_search_organic"},
        )
    except Exception as _serper_log_err:
        print(f"[cost_logger] serper log skipped: {_serper_log_err}")
    _web_search_cache[key] = {"payload": payload, "timestamp": now}
    return payload


def _normalize_results(payload: dict) -> list[dict]:
    """Flatten Serper ``answerBox`` + ``organic`` into a single result list.

    ``answerBox`` (when present) is prepended because Google has already
    extracted a direct answer; we mark it so the prompt can frame it as a
    high-confidence source.
    """
    out: list[dict] = []
    answer_box = payload.get("answerBox") or {}
    if answer_box:
        answer = _clean(answer_box.get("answer") or answer_box.get("snippet") or "")
        title = _clean(answer_box.get("title") or "")
        if answer:
            link = (answer_box.get("link") or "").strip()
            out.append(
                {
                    "title": title or "Answer box",
                    "summary": answer,
                    "source": answer_box.get("source") or _source_from_url(link) or "answer_box",
                    "url": link,
                    "is_answer_box": True,
                }
            )

    for item in payload.get("organic", []) or []:
        title = _clean(item.get("title", ""))
        url = (item.get("link") or "").strip()
        summary = _clean(item.get("snippet", ""))
        if not title or not url:
            continue
        out.append(
            {
                "title": title,
                "summary": summary,
                "source": item.get("source") or _source_from_url(url),
                "url": url,
                "is_answer_box": False,
            }
        )

    return out


# 2026-05-28 — expanded venue vocabulary so the standalone food/drink/place
# nouns ("coffee near irvine", "boba in irvine", "bakery near me") trigger
# the location_map_panel instead of falling through to media_tabs. The
# preceding round only recognized the compound "coffee shops" + "cafes".
#
# Word boundaries are deliberate (`\b...\b`) so we don't false-positive on
# "coffeehouse blog" or "library science"; "coffee" only counts when it's a
# bare noun. Each alternative either has its own optional plural or already
# covers both forms (e.g. "boba" doesn't pluralize naturally).
_VENUE_NOUN_RE = re.compile(
    r"\b(?:coffee(?:\s+shops?)?|cafes?|caf[eé]s?|"
    r"boba|bubble\s+tea|matcha|tea\s+(?:shops?|houses?)?|"
    r"bakery|bakeries|brunch|brunch\s+spots?|breakfast\s+spots?|"
    r"restaurants?|diners?|ramen|sushi|pho|taquer[ií]as?|tacos?|pizza|"
    r"barbershops?|barbers?|salons?|nail\s+salons?|spas?|"
    r"gyms?|bars?|pubs?|breweries|brewery|wineries|winery|"
    r"gas\s+stations?|grocery|supermarkets?|stores?|markets?|"
    r"pharmacies|pharmacy|atms?|hotels?|motels?|parks?|"
    r"hospitals?|urgent\s+care|libraries|library|bookstores?|"
    r"study\s+(?:cafes?|spots?|spaces?))\b",
    re.IGNORECASE,
)
_NEAR_ME_RE = re.compile(
    r"\b(?:near\s+me|nearby|around\s+(?:here|me)|close\s+to\s+me|"
    r"what(?:'s|s)\s+open\s+(?:near|nearby|around))\b",
    re.IGNORECASE,
)
# Case-insensitive so "coffee near irvine" / "in fountain valley" parse the
# city even when the user types lowercase voice transcripts. We keep the
# multi-word capture by allowing 0..3 trailing words.
_IN_CITY_RE = re.compile(
    r"\b(?:in|around|near)\s+(?P<place>[a-zA-Z]+(?:\s+[a-zA-Z]+){0,3})\b",
    re.IGNORECASE,
)
# Words that must NEVER be treated as a city name even when they follow
# "near"/"in"/"around" (e.g. "near me", "in town"). We strip these from the
# captured place string before treating it as a real city.
_NON_CITY_TAIL_WORDS = {
    "me", "us", "here", "there",
    "town", "downtown", "midtown", "uptown",
    "the", "a", "an",
}
# 2026-05-30: broadened so the pre-news info normalizer's typical product
# phrasings ("can you suggest me some webcam", "recommend headphones",
# "need a laptop for data science") still land on product_results_panel
# even when the upstream normalizer is bypassed and the raw user text
# reaches this classifier verbatim. Without this safety net, "suggest me
# some webcam" was matching nothing here and falling back to a generic
# media_tabs panel.
_SHOPPING_RE = re.compile(
    r"\b(?:best|top|cheap(?:est)?|good|recommended)\s+[a-z0-9\- ]{2,40}\s+"
    r"(?:under|below|less\s+than|for\s+under)\s*\$?\s*\d"
    r"|\bbest\s+[a-z0-9\- ]{2,40}\s+(?:for|to|in)\s+[a-z0-9\- ]{2,40}"
    r"|\b(?:reviews?\s+of|reviews?\s+for|review\s+of)\b"
    r"|\bcompare\s+[a-z0-9\- ]{1,30}\s+(?:vs|versus|and|to)\s+[a-z0-9\- ]{1,30}"
    r"|\b[a-z0-9\- ]{1,20}\s+(?:vs|versus)\s+[a-z0-9\- ]{1,20}\b"
    # NEW: explicit suggest/recommend/need-a wording paired with a known
    # product category (webcam, mic, microphone, headphones, headset,
    # laptop, monitor, keyboard, mouse, speakers, camera, tablet, phone,
    # router, printer, chair, desk, gpu, cpu, ssd, controller, smartwatch).
    r"|\b(?:suggest(?:s|ing|ed)?|recommend(?:s|ing|ed|ation|ations)?|"
    r"need(?:s|ed)?\s+(?:a|an|some|new)|"
    r"want(?:s|ed)?\s+(?:a|an|some|new|to\s+buy|to\s+get)|"
    r"looking\s+(?:for|to\s+buy|to\s+get))\b[^.?!\n]{0,80}\b"
    r"(?:webcams?|mics?|microphones?|headphones?|earbuds?|headsets?|"
    r"laptops?|notebooks?|monitors?|keyboards?|mouse|mice|speakers?|"
    r"soundbars?|cameras?|tablets?|phones?|smartphones?|routers?|"
    r"printers?|chairs?|desks?|gpus?|graphics\s+cards?|cpus?|processors?|"
    r"ssds?|hard\s+drives?|controllers?|smartwatch(?:es)?|watches?)\b"
    # NEW: "<category> for <use case>" with no leading 'best' is still
    # product-shaped ("webcam for Zoom meetings", "laptop for data science").
    r"|\b(?:webcams?|mics?|microphones?|headphones?|earbuds?|headsets?|"
    r"laptops?|notebooks?|monitors?|keyboards?|mouse|mice|speakers?|"
    r"soundbars?|cameras?|tablets?|phones?|smartphones?|routers?|"
    r"printers?|chairs?|desks?|gpus?|cpus?|ssds?|controllers?|"
    r"smartwatch(?:es)?)\s+(?:for|under|recommendation|recommendations)\b"
    # NEW: "which <category> should I buy" / "what <category> should I get".
    r"|\b(?:which|what)\s+(?:webcams?|mics?|microphones?|headphones?|"
    r"earbuds?|headsets?|laptops?|monitors?|keyboards?|mouse|mice|speakers?|"
    r"cameras?|tablets?|phones?|smartphones?|routers?|printers?|chairs?|"
    r"desks?|gpus?|cpus?|ssds?|controllers?|smartwatch(?:es)?)\b"
    r"[^.?!\n]{0,30}\b(?:buy|get|use|need|want|recommend)\b",
    re.IGNORECASE,
)


def _clean_in_city_capture(capture: str) -> str:
    """Trim non-city tail words from an `_IN_CITY_RE` capture.

    "in fountain valley right now" → "fountain valley"
    "near me" → "" (filtered, we only have a tail-pronoun, not a city)
    "in town" → "" (non-city placeholder)
    """
    raw = (capture or "").strip().strip(".,!?;:")
    if not raw:
        return ""
    parts = raw.split()
    while parts and parts[-1].lower() in _NON_CITY_TAIL_WORDS:
        parts.pop()
    cleaned = " ".join(parts).strip()
    if not cleaned:
        return ""
    if cleaned.lower() in _NON_CITY_TAIL_WORDS:
        return ""
    return cleaned


_OPEN_NOW_RE = re.compile(r"\bopen\s+now\b", re.IGNORECASE)
_RADIUS_MILES_RE = re.compile(
    r"\b(?:within|under|less\s+than)\s+(\d{1,2})\s*(?:mile|mi|miles)\b",
    re.IGNORECASE,
)
_CUISINE_HINT_RE = re.compile(
    r"\b(asian|chinese|japanese|korean|thai|vietnamese|indian|mexican|italian|"
    r"sushi|ramen|pho|tacos|pizza|mediterranean|vegan|vegetarian)\b",
    re.IGNORECASE,
)
_LOCATION_ACRONYMS = frozenset({"uci", "ucla", "usc", "csuf", "csulb"})

PLACE_SEARCH_LOCATION_PROMPT = "What city or area should I search near?"


def _normalize_city_for_display(cleaned: str) -> str:
    """Title-case a parsed city, preserving common 2-letter state suffixes.

    Keeps the existing display ("Irvine") for already-capitalized inputs and
    converts voice-transcript lowercase to title case ("fountain valley" →
    "Fountain Valley"). Two-letter trailing tokens are upper-cased so "garden
    grove ca" becomes "Garden Grove CA".
    """
    if not cleaned:
        return ""
    out_parts: list[str] = []
    for part in cleaned.split():
        low = part.lower()
        if low in _LOCATION_ACRONYMS:
            out_parts.append(part.upper())
        elif len(part) == 2 and part.isalpha():
            out_parts.append(part.upper())
        else:
            out_parts.append(part[:1].upper() + part[1:].lower())
    return " ".join(out_parts)


def _extract_explicit_place_location(raw: str) -> str:
    """Return the last explicit in/near/around city capture from the utterance."""
    location = ""
    for m in _IN_CITY_RE.finditer(raw or ""):
        candidate = _clean_in_city_capture(m.group("place") or "")
        if not candidate:
            continue
        if _VENUE_NOUN_RE.fullmatch(candidate) or _VENUE_NOUN_RE.fullmatch(
            candidate.split()[-1]
        ):
            continue
        location = candidate
    if not location:
        return ""
    return _normalize_city_for_display(location)


def _extract_place_query_text(raw: str) -> str:
    """Venue/cuisine phrase for display and Serper (without location tail)."""
    text = (raw or "").strip()
    if not text:
        return ""
    cuisine = ""
    m_cuisine = _CUISINE_HINT_RE.search(text)
    if m_cuisine:
        cuisine = m_cuisine.group(1).strip().lower()
    venue = extract_venue_category(text)
    if cuisine and venue and cuisine not in venue:
        return f"{cuisine} {venue}".strip()
    if venue:
        return venue
    return text


def _build_place_search_params(
    query: str,
    *,
    location: str = "",
    location_source: str = "",
    category: str = "",
    radius_miles: int | None = None,
    open_now: bool = False,
    latitude: float | None = None,
    longitude: float | None = None,
) -> dict:
    raw = (query or "").strip()
    place_query = _extract_place_query_text(raw) or raw
    cat = (category or extract_venue_category(raw) or "place").strip().lower()
    loc = (location or "").strip()
    return {
        "query": place_query,
        "location": loc,
        "location_source": (location_source or "").strip(),
        "radius_miles": radius_miles,
        "open_now": bool(open_now),
        "category": cat,
        "latitude": latitude,
        "longitude": longitude,
    }


def _compose_places_serper_query(search_params: dict) -> str:
    """Build the Serper Places query from structured search params."""
    place_q = str(search_params.get("query") or "").strip()
    loc = str(search_params.get("location") or "").strip()
    open_now = bool(search_params.get("open_now"))
    radius = search_params.get("radius_miles")
    lat = search_params.get("latitude")
    lng = search_params.get("longitude")
    parts = [place_q or "places"]
    if loc and loc.lower() not in {"your current location", "current location"}:
        parts.append(f"in {loc}")
    elif lat is not None and lng is not None:
        try:
            parts.append(f"near {float(lat):.5f},{float(lng):.5f}")
        except (TypeError, ValueError):
            pass
    if open_now:
        parts.append("open now")
    if isinstance(radius, int) and radius > 0:
        parts.append(f"within {radius} miles")
    return " ".join(p for p in parts if p).strip()


def _display_location_label(location: str, *, location_source: str = "") -> str:
    loc = (location or "").strip()
    if loc:
        return loc
    if location_source == "browser_geolocation":
        return "your current location"
    return ""


def _location_fallback_notice(location_source: str) -> str:
    if location_source == "saved_default":
        return " (saved default location)"
    if location_source == "browser_geolocation":
        return " (browser location)"
    return ""


def _build_place_panel_subheader(search_params: dict) -> str:
    place_q = str(search_params.get("query") or "Places").strip()
    loc = str(search_params.get("location") or "").strip()
    if loc:
        return f"{place_q.title()} near {loc}"
    return place_q.title()


def classify_web_search_panel(
    query: str,
    *,
    client_location: str = "",
    client_location_source: str = "",
    client_latitude: float | None = None,
    client_longitude: float | None = None,
) -> dict:
    """Decide which side-panel a generic web.search result should land in.

    Returns ``{panel_type, panel_mode, location, location_required,
    location_source, search_params, product_query_detected, reason}``.
    """
    raw = (query or "").strip()
    out = {
        "panel_type": "media_tabs",
        "panel_mode": "general",
        "location": "",
        "location_source": "",
        "location_required": False,
        "search_params": None,
        "product_query_detected": False,
        "reason": "default_search_panel",
    }
    if not raw:
        return out

    open_now = bool(_OPEN_NOW_RE.search(raw))
    radius_miles = None
    m_radius = _RADIUS_MILES_RE.search(raw)
    if m_radius:
        try:
            radius_miles = int(m_radius.group(1))
        except (TypeError, ValueError):
            radius_miles = None

    venue_match = _VENUE_NOUN_RE.search(raw)
    if venue_match:
        near_me = _NEAR_ME_RE.search(raw)
        explicit_location = _extract_explicit_place_location(raw)
        client_loc = (client_location or "").strip()
        client_src = (client_location_source or "").strip()

        if explicit_location:
            display = explicit_location
            params = _build_place_search_params(
                raw,
                location=display,
                location_source="utterance",
                radius_miles=radius_miles,
                open_now=open_now,
            )
            out.update(
                panel_type="location_map_panel",
                panel_mode="location",
                location=display,
                location_source="utterance",
                location_required=False,
                search_params=params,
                reason="venue_query_with_explicit_city",
            )
            return out

        if near_me and not client_loc:
            out.update(
                panel_type="location_map_panel",
                panel_mode="location",
                location_required=True,
                reason="venue_query_near_me_missing_location",
            )
            return out

        resolved_location = client_loc
        resolved_source = client_src or ("saved_default" if client_loc else "")
        if near_me and client_loc:
            resolved_source = client_src or "saved_default"

        if not resolved_location and client_latitude is not None and client_longitude is not None:
            resolved_location = "your current location"
            resolved_source = client_src or "browser_geolocation"

        if not resolved_location:
            out.update(
                panel_type="location_map_panel",
                panel_mode="location",
                location_required=True,
                reason="venue_query_missing_location",
            )
            return out

        display = _normalize_city_for_display(resolved_location)
        if display.lower() in {"your current location", "current location"}:
            display = "your current location"
        params = _build_place_search_params(
            raw,
            location=display,
            location_source=resolved_source or "saved_default",
            radius_miles=radius_miles,
            open_now=open_now,
            latitude=client_latitude if resolved_source == "browser_geolocation" else None,
            longitude=client_longitude if resolved_source == "browser_geolocation" else None,
        )
        out.update(
            panel_type="location_map_panel",
            panel_mode="location",
            location=display,
            location_source=resolved_source or "saved_default",
            location_required=False,
            search_params=params,
            reason=(
                "venue_query_with_client_location"
                if resolved_source
                else "venue_query_with_resolved_location"
            ),
        )
        return out

    if _SHOPPING_RE.search(raw):
        out.update(
            panel_type="product_results_panel",
            panel_mode="product",
            product_query_detected=True,
            reason="shopping_or_recommendation_query",
        )
        return out

    return out


def _build_prompt(query: str, items: list[dict]) -> str:
    """Build the prompt body that follows ``WEB_SEARCH_PREAMBLE``.

    Snippets are capped to 6 to keep the prompt token-frugal; the answer-box
    (if present) is always first so the model leans on it.
    """
    lines = [f"User query: {query}"]
    if items:
        lines.append("\nWeb-search snippets (use only what is actually relevant):")
        for i, item in enumerate(items[:6], 1):
            tag = "[answer box] " if item.get("is_answer_box") else ""
            lines.append(
                f"{i}. {tag}{item['title']}\n"
                f"Source: {item['source']}\n"
                f"Snippet: {item.get('summary', '')}"
            )
    else:
        lines.append(
            "\nNo snippets came back from the search. Tell the user the search "
            "did not return useful results, suggest a tighter query, and do NOT "
            "invent an answer."
        )
    return "\n\n".join(lines)


def _serper_media(endpoint: str, query: str, limit: int, cache_prefix: str) -> dict:
    """POST to a Serper media endpoint (images/videos/shopping/places)."""
    if not SERPER_API_KEY:
        raise RuntimeError("SERPER_API_KEY is not set")
    key = (query or "").lower().strip()
    if not key:
        raise RuntimeError("empty query")
    cache_key = f"{cache_prefix}:{key}"
    now = time.time()
    cached = _web_search_cache.get(cache_key)
    if cached and now - cached["timestamp"] < SEARCH_CACHE_TTL:
        return cached["payload"]
    response = requests.post(
        endpoint,
        headers={"X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json"},
        json={"q": query, "num": limit},
        timeout=SERPER_TIMEOUT_SEC,
    )
    response.raise_for_status()
    payload = response.json()
    try:
        from cost_logging.serper_helpers import log_serper_http_call

        log_serper_http_call(
            endpoint=endpoint,
            query=query,
            payload=payload,
            extra={"source": "web_search._serper_media", "cache_prefix": cache_prefix},
        )
    except Exception as _serper_log_err:
        print(f"[cost_logger] serper log skipped: {_serper_log_err}")
    _web_search_cache[cache_key] = {"payload": payload, "timestamp": now}
    return payload


def _normalize_images(payload: dict) -> list[dict]:
    out: list[dict] = []
    for item in (payload or {}).get("images") or []:
        image_url = (item.get("imageUrl") or item.get("image") or item.get("thumbnailUrl") or "").strip()
        page_url = (item.get("link") or item.get("sourceUrl") or item.get("url") or "").strip()
        if not image_url:
            continue
        out.append(
            {
                "title": _clean(item.get("title")) or "Image result",
                "image_url": image_url,
                "thumbnail_url": (item.get("thumbnailUrl") or image_url).strip(),
                "source": item.get("source") or _source_from_url(page_url),
                "url": page_url,
            }
        )
    return out[:IMAGE_RESULT_LIMIT]


def _normalize_videos(payload: dict) -> list[dict]:
    out: list[dict] = []
    for item in (payload or {}).get("videos") or []:
        url = (item.get("link") or item.get("url") or "").strip()
        title = _clean(item.get("title"))
        if not title or not url:
            continue
        out.append(
            {
                "title": title,
                "summary": _clean(item.get("snippet")),
                "source": item.get("source") or _source_from_url(url),
                "published_display": item.get("date") or "",
                "url": url,
                "thumbnail_url": (item.get("imageUrl") or item.get("thumbnailUrl") or "").strip(),
            }
        )
    return out[:VIDEO_RESULT_LIMIT]


def _normalize_shopping(payload: dict) -> list[dict]:
    out: list[dict] = []
    for item in (payload or {}).get("shopping") or []:
        title = _clean(item.get("title"))
        url = (item.get("link") or item.get("url") or "").strip()
        if not title or not url:
            continue
        price = ""
        for key in ("price", "priceRange", "extractedPrice"):
            value = item.get(key)
            if value:
                price = _clean(str(value))
                break
        # Numeric helpers for ranking (used by `_rank_top_three_products`):
        # we keep the human-readable `price` string separate from the numeric
        # value so the card UI stays exactly as Serper presented it.
        price_value: float | None = None
        for key in ("extractedPrice", "price", "priceRange"):
            value = item.get(key)
            if value is None:
                continue
            try:
                # Strip currency symbols + commas + range tail (e.g. "from $99")
                raw_str = str(value)
                m = re.search(r"(\d+(?:\.\d+)?)", raw_str.replace(",", ""))
                if m:
                    price_value = float(m.group(1))
                    break
            except Exception:
                price_value = None
        rating_value = item.get("rating") or item.get("ratingScore")
        rating_count = item.get("ratingCount") or item.get("reviews")
        rating_text = ""
        if rating_value:
            rating_text = f"{rating_value}"
            if rating_count:
                rating_text += f" ({rating_count})"
        rating_num: float | None = None
        try:
            if rating_value is not None:
                rating_num = float(rating_value)
        except Exception:
            rating_num = None
        rating_count_num: int | None = None
        try:
            if rating_count is not None:
                rating_count_num = int(rating_count)
        except Exception:
            rating_count_num = None
        image_url = (item.get("imageUrl") or item.get("image") or "").strip()
        out.append(
            {
                "title": title,
                "price": price,
                "rating": rating_text,
                "source": item.get("source") or _source_from_url(url),
                "image_url": image_url,
                "url": url,
                "summary": _clean(item.get("snippet") or item.get("description")),
                # ranking-only metadata (frontend ignores these keys, smoke
                # asserts on them):
                "_price_value": price_value,
                "_rating_value": rating_num,
                "_rating_count": rating_count_num,
                "_image_present": bool(image_url),
            }
        )
    return out[:SHOPPING_RESULT_LIMIT]


# Price-constraint extraction so "best mic under $100" actually filters out the
# $400 studio mic Serper sometimes surfaces. The regex covers the four common
# voice phrasings; we never *require* a hit, the filter is best-effort.
_PRICE_CONSTRAINT_RE = re.compile(
    r"\b(?:under|below|less\s+than|for\s+under|cheaper\s+than|no\s+more\s+than|"
    r"up\s+to|max(?:imum)?)\s*\$?\s*(?P<amount>\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


def _extract_price_constraint(query: str) -> float | None:
    if not query:
        return None
    m = _PRICE_CONSTRAINT_RE.search(query)
    if not m:
        return None
    try:
        return float(m.group("amount"))
    except Exception:
        return None


# 2026-05-28 — top-3 ranked product layout.
# Spec asks for "best overall", "best value", "alternative/budget/premium"
# tabs. We never invent data: when there are fewer than 3 distinct buckets,
# the extras simply fall back to a generic rank label so the card still
# renders predictably.
PRODUCT_RANK_LABELS_DEFAULT = ("Best overall", "Best value", "Alternative")

# Product categories we can detect + terms that indicate a WRONG category
# (e.g. webcam results when the user asked for a mic).
_PRODUCT_CATEGORY_ALIASES: dict[str, tuple[str, ...]] = {
    "mic": ("mic", "mics", "microphone", "microphones"),
    "webcam": ("webcam", "webcams", "web cam", "web cams"),
    "headphone": ("headphone", "headphones", "earbud", "earbuds", "headset", "headsets"),
    "laptop stand": ("laptop stand", "laptop stands"),
    "keyboard": ("keyboard", "keyboards"),
    "monitor": ("monitor", "monitors", "display", "displays"),
}
_PRODUCT_CATEGORY_CONFLICTS: dict[str, tuple[str, ...]] = {
    "mic": ("webcam", "camera", "monitor", "keyboard", "mouse", "headphone", "speaker", "laptop stand"),
    "microphone": ("webcam", "camera", "monitor", "keyboard", "mouse", "headphone", "speaker", "laptop stand"),
    "webcam": ("microphone", "mic", "headphone", "speaker", "keyboard"),
    "headphone": ("webcam", "mic", "microphone", "monitor", "keyboard"),
    "laptop stand": ("webcam", "mic", "microphone", "headphone", "keyboard", "monitor"),
}


def _current_request_id() -> str:
    """Read the per-request id set by app.py's request handlers."""
    try:
        from app import _current_request_id_var
        rid = _current_request_id_var.get()
        if rid:
            return str(rid)
    except Exception:
        pass
    return "req_unknown"


def _extract_primary_product_category(query: str) -> str:
    """Best-effort category noun from a shopping query ('best mic under $100')."""
    low = (query or "").lower()
    if not low:
        return ""
    # Longest alias match first so "laptop stand" beats "laptop".
    for key in sorted(_PRODUCT_CATEGORY_ALIASES.keys(), key=len, reverse=True):
        for alias in _PRODUCT_CATEGORY_ALIASES[key]:
            if re.search(r"\b" + re.escape(alias) + r"\b", low):
                return key
    m = re.search(
        r"\b(?:best|top|good|cheap(?:est)?|recommended)\s+"
        r"(?P<cat>[a-z0-9\- ]{2,30}?)(?:\s+(?:under|below|for|to|in)\b|\s*$)",
        low,
    )
    return (m.group("cat").strip() if m else "")


def _product_conflicts_category(title: str, category: str) -> bool:
    """True when the product title looks like the wrong product type."""
    if not category or not title:
        return False
    low = title.lower()
    conflicts = _PRODUCT_CATEGORY_CONFLICTS.get(category, ())
    category_ok = any(
        re.search(r"\b" + re.escape(alias) + r"\b", low)
        for alias in _PRODUCT_CATEGORY_ALIASES.get(category, (category,))
    )
    if category_ok:
        return False
    for term in conflicts:
        if re.search(r"\b" + re.escape(term) + r"\b", low):
            return True
    return False


def _snippet_mention_score(title: str, snippets: list[dict]) -> int:
    """Count organic snippets that mention this product title (or its lead token)."""
    if not title or not snippets:
        return 0
    low_title = title.lower()
    lead = low_title.split()[0] if low_title.split() else low_title
    score = 0
    for snip in snippets:
        blob = f"{snip.get('title', '')} {snip.get('summary', '')}".lower()
        if low_title in blob or (len(lead) > 3 and lead in blob):
            score += 1
    return score


def _product_rank_score(
    item: dict,
    *,
    category: str,
    snippets: list[dict],
    constraint: float | None,
) -> float:
    """Composite relevance score used before picking overall/value/alt slots."""
    title = (item.get("title") or "").strip()
    if not title:
        return -999.0
    if _product_conflicts_category(title, category):
        return -999.0
    score = 0.0
    low = title.lower()
    if category:
        for alias in _PRODUCT_CATEGORY_ALIASES.get(category, (category,)):
            if re.search(r"\b" + re.escape(alias) + r"\b", low):
                score += 50.0
                break
    score += _snippet_mention_score(title, snippets) * 8.0
    rating = item.get("_rating_value") or 0.0
    reviews = item.get("_rating_count") or 0
    score += float(rating) * 5.0 + min(int(reviews), 5000) / 500.0
    if item.get("_image_present"):
        score += 2.0
    pv = item.get("_price_value")
    if isinstance(pv, (int, float)):
        if constraint is not None and pv <= constraint:
            score += 6.0
        elif constraint is not None and pv > constraint:
            score -= 12.0
    return score


def _build_canonical_product_prompt(
    query: str, canonical_products: list[dict], snippets: list[dict]
) -> str:
    lines = [
        f"User query: {query}",
        "\nCANONICAL PRODUCT LIST (recommend ONLY these — panel uses this exact list):",
    ]
    if not canonical_products:
        lines.append("(empty — say shopping search returned no useful products)")
    for p in canonical_products:
        label = p.get("rank_label") or "Pick"
        lines.append(
            f"- [{label}] {p.get('title', 'Product')}"
            + (f" | {p.get('price')}" if p.get("price") else "")
            + (f" | rating {p.get('rating')}" if p.get("rating") else "")
            + (f" | {p.get('source')}" if p.get("source") else "")
            + (f" | {p.get('summary', '')[:100]}" if p.get("summary") else "")
        )
    if snippets:
        lines.append(
            "\nSupporting web snippets (context only — do NOT name products "
            "not listed above):"
        )
        for i, sn in enumerate(snippets[:4], 1):
            lines.append(
                f"{i}. {sn.get('title', '')}\n   {sn.get('summary', '')[:180]}"
            )
    return "\n\n".join(lines)


def _build_canonical_place_prompt(
    query: str,
    canonical_places: list[dict],
    snippets: list[dict],
    *,
    search_location: str = "",
    location_source: str = "",
) -> str:
    loc_label = _display_location_label(search_location, location_source=location_source)
    lines = [
        f"User query: {query}",
        f"SEARCH LOCATION USED: {loc_label or '(not specified)'}",
    ]
    if location_source == "saved_default" and loc_label:
        lines.append(
            f"Note: no city was named in the question — using the saved default "
            f"location ({loc_label}). Say so briefly in your opening sentence."
        )
    elif location_source == "browser_geolocation" and loc_label:
        lines.append(
            "Note: using the browser's approximate current location. Mention that "
            "briefly if helpful."
        )
    lines.append(
        "\nCANONICAL PLACE LIST (summarize ONLY these — panel uses this exact list):"
    )
    if not canonical_places:
        lines.append("(empty — say place search returned no results)")
    for i, p in enumerate(canonical_places[:8], 1):
        lines.append(
            f"{i}. {p.get('name', 'Place')}"
            + (f" | {p.get('address')}" if p.get("address") else "")
            + (f" | rating {p.get('rating')}" if p.get("rating") else "")
            + (f" | {p.get('open_state')}" if p.get("open_state") else "")
        )
    if snippets:
        lines.append("\nSupporting snippets (context only):")
        for i, sn in enumerate(snippets[:3], 1):
            lines.append(f"{i}. {sn.get('title', '')}: {sn.get('summary', '')[:120]}")
    return "\n\n".join(lines)


def _canonical_product_titles(products: list[dict]) -> list[str]:
    return [(p.get("title") or "").strip() for p in products if (p.get("title") or "").strip()]


def _canonical_place_names(places: list[dict]) -> list[str]:
    return [(p.get("name") or "").strip() for p in places if (p.get("name") or "").strip()]


def _stamp_panel_payload(
    payload: dict,
    *,
    request_id: str,
    query: str,
    result_kind: str,
) -> dict:
    payload["request_id"] = request_id
    payload["query"] = query
    payload["result_kind"] = result_kind
    payload["created_at_ms"] = int(time.time() * 1000)
    return payload


def _rank_top_three_products(
    products: list[dict],
    query: str = "",
    *,
    snippets: list[dict] | None = None,
) -> list[dict]:
    """Pick up to 3 ranked products and stamp a ``rank_label`` on each.

    Pool is filtered/scored by product category + snippet mentions + price
    constraint so the assistant and panel share one canonical list.
    """
    if not products:
        return []
    category = _extract_primary_product_category(query)
    constraint = _extract_price_constraint(query)
    snips = snippets or []

    pool: list[dict] = []
    seen_urls: set[str] = set()
    for raw_item in products:
        if not isinstance(raw_item, dict):
            continue
        item = dict(raw_item)
        url = (item.get("url") or "").strip()
        if url in seen_urls:
            continue
        if _product_rank_score(
            item, category=category, snippets=snips, constraint=constraint
        ) < -100:
            continue
        seen_urls.add(url)
        pool.append(item)
    if not pool:
        # Relax category filter if Serper returned only off-category items.
        for raw_item in products:
            if not isinstance(raw_item, dict):
                continue
            item = dict(raw_item)
            url = (item.get("url") or "").strip()
            if url in seen_urls:
                continue
            seen_urls.add(url)
            pool.append(item)
    if not pool:
        return []

    pool.sort(
        key=lambda it: _product_rank_score(
            it, category=category, snippets=snips, constraint=constraint
        ),
        reverse=True,
    )

    def _overall_key(it: dict) -> tuple[float, int, float]:
        r = it.get("_rating_value") or 0.0
        c = it.get("_rating_count") or 0
        s = _product_rank_score(it, category=category, snippets=snips, constraint=constraint)
        return (float(r), int(c), float(s))

    best_overall = max(pool, key=_overall_key)
    selected: list[dict] = [best_overall]
    remaining = [it for it in pool if it is not best_overall]

    # 2) Best value — cheapest, optionally constrained.
    def _value_key(it: dict) -> float:
        pv = it.get("_price_value")
        return float(pv) if isinstance(pv, (int, float)) else float("inf")

    candidates = remaining
    if constraint is not None:
        within = [it for it in remaining if (it.get("_price_value") or 0) and it["_price_value"] <= constraint]
        if within:
            candidates = within
    if candidates:
        best_value = min(candidates, key=_value_key)
        # Don't select a "best value" with no price at all — that just dupes
        # "best overall" with a confusing label.
        if isinstance(best_value.get("_price_value"), (int, float)):
            selected.append(best_value)
            remaining = [it for it in remaining if it is not best_value]
        elif remaining:
            # No useful value pick, but still fill the slot so the rank trio
            # is visually balanced. Pick by remaining rating.
            fallback = max(remaining, key=_overall_key)
            selected.append(fallback)
            remaining = [it for it in remaining if it is not fallback]

    # 3) Alternative / premium.
    if remaining and len(selected) < 3:
        if any((it.get("_rating_value") or 0) > 0 for it in remaining):
            alt = max(remaining, key=_overall_key)
        else:
            alt = max(
                remaining,
                key=lambda it: (
                    it.get("_price_value")
                    if isinstance(it.get("_price_value"), (int, float))
                    else 0.0
                ),
            )
        selected.append(alt)

    # Stamp rank labels and strip private `_` keys so the frontend payload
    # stays compact + auditable.
    ranked: list[dict] = []
    for idx, item in enumerate(selected[:3]):
        clean_item = {k: v for k, v in item.items() if not k.startswith("_")}
        clean_item["rank_label"] = PRODUCT_RANK_LABELS_DEFAULT[idx]
        clean_item["rank_index"] = idx + 1
        ranked.append(clean_item)
    return ranked


def _normalize_places(payload: dict) -> list[dict]:
    out: list[dict] = []
    for item in (payload or {}).get("places") or []:
        title = _clean(item.get("title"))
        if not title:
            continue
        address = _clean(item.get("address"))
        rating_value = item.get("rating") or item.get("ratingScore")
        rating_count = item.get("ratingCount") or item.get("reviews")
        rating_text = ""
        if rating_value:
            rating_text = f"{rating_value}"
            if rating_count:
                rating_text += f" ({rating_count})"
        open_state = ""
        for key in ("openState", "openStatus", "hours", "isOpen"):
            value = item.get(key)
            if value:
                open_state = _clean(str(value))
                break
        directions_url = (item.get("directions") or item.get("directionsLink") or "").strip()
        link = (item.get("website") or item.get("link") or item.get("url") or "").strip()
        distance = _clean(item.get("distance") or item.get("distanceText") or "")
        out.append(
            {
                "name": title,
                "address": address,
                "rating": rating_text,
                "review_count": str(rating_count) if rating_count else "",
                "open_state": open_state,
                "category": _clean(item.get("category")),
                "distance": distance,
                "source": item.get("source") or _source_from_url(link or directions_url),
                "url": link,
                "directions_url": directions_url,
                "latitude": item.get("latitude") or item.get("lat") or None,
                "longitude": item.get("longitude") or item.get("lng") or item.get("lon") or None,
            }
        )
    return out[:PLACES_RESULT_LIMIT]


def _build_product_panel_payload(
    query: str,
    items: list[dict],
    *,
    total_available: int | None = None,
    request_id: str = "",
) -> dict:
    """Build the product side-panel payload.

    The list ``items`` here is already capped to top-3 and rank-stamped.
    ``total_available`` is the size of the un-pruned shopping list, so the
    frontend can render a "View N more" affordance later without us having
    to re-issue the search.
    """
    title = "Shopping Results"
    extras = max(0, (int(total_available) if total_available else len(items)) - len(items))
    payload = {
        "panel_type": "product_results_panel",
        "title": title,
        "query": query,
        "products": items,
        "canonical_products": items,
        "rank_labels": list(PRODUCT_RANK_LABELS_DEFAULT[: len(items)]),
        "extras_count": extras,
        "price_constraint": _extract_price_constraint(query),
    }
    return _stamp_panel_payload(
        payload, request_id=request_id or _current_request_id(), query=query, result_kind="product"
    )


def _build_location_panel_payload(
    query: str,
    items: list[dict],
    *,
    location: str = "",
    location_source: str = "",
    search_params: dict | None = None,
    request_id: str = "",
) -> dict:
    """Build the location/map side-panel payload.

    Includes ``map_pins`` (a slim {name, latitude, longitude} list for the
    eventual real map view) so the frontend can render either a real map
    when coordinates exist or a card-only placeholder when they don't.
    """
    sp = search_params or _build_place_search_params(
        query, location=location, location_source=location_source
    )
    loc_display = _display_location_label(
        str(sp.get("location") or location or ""),
        location_source=str(sp.get("location_source") or location_source or ""),
    )
    title = "Places"
    map_pins = []
    for item in items or []:
        lat = item.get("latitude")
        lng = item.get("longitude")
        if lat is None or lng is None:
            continue
        try:
            lat_f = float(lat)
            lng_f = float(lng)
        except (TypeError, ValueError):
            continue
        map_pins.append(
            {
                "name": item.get("name") or "",
                "latitude": lat_f,
                "longitude": lng_f,
                "address": item.get("address") or "",
            }
        )
    payload = {
        "panel_type": "location_map_panel",
        "title": title,
        "subheader": _build_place_panel_subheader(sp),
        "query": str(sp.get("query") or query),
        "location": loc_display,
        "location_source": str(sp.get("location_source") or location_source or ""),
        "search_params": sp,
        "places": items,
        "canonical_places": items,
        "map_pins": map_pins,
        "map_available": bool(map_pins),
        "place_count": len(items or []),
    }
    return _stamp_panel_payload(
        payload,
        request_id=request_id or _current_request_id(),
        query=query,
        result_kind="location",
    )


def _log_product_panel(
    *,
    query: str,
    product_query_detected: bool,
    product_results_count: int,
    product_cards_rendered: int,
    product_image_present: bool,
    product_panel_created: bool,
    price_constraint: float | None = None,
    current_request_id: str = "",
    panel_payload_request_id: str = "",
    user_query: str = "",
    panel_query: str = "",
    canonical_products: list | None = None,
    product_panel_products: list | None = None,
    note: str = "",
) -> None:
    """Single grep target for the 2026-05-28 product-panel decision log.

    Grep ``[product_panel]``. The fields mirror the spec verbatim so we can
    tail the log and confirm each pipeline step fired exactly once.
    """
    try:
        import json as _json
        print(
            "[product_panel] "
            + _json.dumps(
                {
                    "query": (query or "")[:200],
                    "user_query": (user_query or query or "")[:200],
                    "panel_query": (panel_query or query or "")[:200],
                    "product_query_detected": bool(product_query_detected),
                    "current_request_id": (current_request_id or "")[:40],
                    "panel_payload_request_id": (panel_payload_request_id or "")[:40],
                    "product_results_count": int(product_results_count),
                    "product_cards_rendered": int(product_cards_rendered),
                    "product_image_present": bool(product_image_present),
                    "product_panel_created": bool(product_panel_created),
                    "canonical_products": _canonical_product_titles(
                        canonical_products or product_panel_products or []
                    )[:6],
                    "product_panel_products": _canonical_product_titles(
                        product_panel_products or canonical_products or []
                    )[:6],
                    "price_constraint": (
                        float(price_constraint) if price_constraint is not None else None
                    ),
                    "note": (note or "")[:160],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        try:
            print("[product_panel] log_serialization_failed", flush=True)
        except Exception:
            pass


def _log_place_panel(
    *,
    query: str,
    place_query_detected: bool,
    location_required: bool,
    location_available: bool,
    pending_place_query_set: bool = False,
    pending_place_query_resolved: bool = False,
    place_search_query: str = "",
    places_count: int = 0,
    map_pins_count: int = 0,
    location_panel_created: bool = False,
    pending_category: str = "",
    pending_original_text: str = "",
    resolved_location: str = "",
    place_category: str = "",
    explicit_location_detected: str = "",
    location_raw: str = "",
    location_normalized: str = "",
    resolved_place_query: str = "",
    canonical_places: list | None = None,
    location_panel_places: list | None = None,
    current_request_id: str = "",
    panel_payload_request_id: str = "",
    note: str = "",
) -> None:
    """Single grep target for the 2026-05-28 place/location-panel log.

    Used by both ``actions/web_search.py`` (panel creation) and
    ``app.py`` (pending-action lifecycle). Grep ``[place_panel]``.
    """
    try:
        import json as _json
        print(
            "[place_panel] "
            + _json.dumps(
                {
                    "query": (query or "")[:200],
                    "place_query_detected": bool(place_query_detected),
                    "place_category": (place_category or pending_category or "")[:80],
                    "explicit_location_detected": (explicit_location_detected or resolved_location or "")[:120],
                    "location_raw": (location_raw or "")[:120],
                    "location_normalized": (location_normalized or resolved_location or "")[:120],
                    "location_required": bool(location_required),
                    "location_available": bool(location_available),
                    "pending_place_query_set": bool(pending_place_query_set),
                    "pending_place_query_resolved": bool(
                        pending_place_query_resolved
                    ),
                    "place_search_query": (place_search_query or "")[:200],
                    "resolved_place_query": (resolved_place_query or place_search_query or "")[:200],
                    "places_count": int(places_count),
                    "map_pins_count": int(map_pins_count),
                    "location_panel_created": bool(location_panel_created),
                    "canonical_places": _canonical_place_names(
                        canonical_places or location_panel_places or []
                    )[:8],
                    "location_panel_places": _canonical_place_names(
                        location_panel_places or canonical_places or []
                    )[:8],
                    "current_request_id": (current_request_id or "")[:40],
                    "panel_payload_request_id": (panel_payload_request_id or "")[:40],
                    "pending_category": (pending_category or "")[:80],
                    "pending_original_text": (pending_original_text or "")[:200],
                    "resolved_location": (resolved_location or "")[:120],
                    "note": (note or "")[:160],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        try:
            print("[place_panel] log_serialization_failed", flush=True)
        except Exception:
            pass


# Lightweight helper used by `app.py` (pending-action lifecycle) so the
# venue-category portion of the spec's pending_place_query payload stays
# in this module (single source of truth for the regex).
def extract_venue_category(text: str) -> str:
    """Pull the venue noun out of a place query for log/pending payloads.

    Returns "" when nothing matches — the caller treats that as "unknown
    category, use the full original text as the search query instead".
    """
    if not text:
        return ""
    m = _VENUE_NOUN_RE.search(text)
    return (m.group(0) if m else "").strip().lower()


def _build_media_tabs_payload(
    query: str,
    articles: list[dict],
    images: list[dict],
    videos: list[dict],
) -> dict:
    return {
        "panel_type": "media_tabs",
        "title": "Search Results",
        "query": query,
        "news_results": articles,
        "images": images,
        "videos": videos,
        "default_tab": "news",
    }


def prepare_web_search_streaming(
    vera,
    query: str,
    *,
    raw_user_text: str | None = None,
    client_location: str = "",
    client_location_source: str = "",
    client_latitude: float | None = None,
    client_longitude: float | None = None,
):
    """Streaming entry point for ``web.search``.

    Returns ``(messages, ui_payload, finalize_fn)`` or ``None`` on failure.
    A failure here (None) lets the caller fall back to ``run_general_llm``
    so the user still gets an answer — we never silently drop the turn.
    """
    q = (query or "").strip()
    if not q:
        return None

    user_question = (raw_user_text or q).strip()
    request_id = _current_request_id()
    panel_decision = classify_web_search_panel(
        user_question or q,
        client_location=client_location,
        client_location_source=client_location_source,
        client_latitude=client_latitude,
        client_longitude=client_longitude,
    )
    panel_mode = panel_decision.get("panel_mode") or "general"
    search_params = panel_decision.get("search_params") or {}

    if panel_decision.get("location_required"):

        def _location_clarify_finalize(_response: str = "") -> dict:
            spoken = ( _response or "").strip() or PLACE_SEARCH_LOCATION_PROMPT
            return {
                "spoken_reply": spoken,
                "action_type": "web_search",
                "data": {
                    "query": q,
                    "user_query": user_question,
                    "location_required": True,
                    "panel_mode": "location",
                },
                "ui_payload": None,
                "location_required": True,
            }

        try:
            clarify_messages = vera.build_messages(
                [],
                "Reply ONLY with this exact question and nothing else: "
                + PLACE_SEARCH_LOCATION_PROMPT,
            )
        except Exception:
            clarify_messages = [
                {
                    "role": "user",
                    "content": PLACE_SEARCH_LOCATION_PROMPT,
                }
            ]
        try:
            _import_panel_routing_logger()(
                selected_route="clarification_needed",
                selected_tool="web_search",
                selected_panel_type="location_map_panel",
                query=q,
                entity_extracted="",
                location_required=True,
                location_available=False,
                product_query_detected=False,
                cards_count=0,
                panel_payload_sent=False,
                note=panel_decision.get("reason") or "venue_query_missing_location",
            )
        except Exception:
            pass
        return clarify_messages, None, _location_clarify_finalize

    items: list[dict] = []
    images: list[dict] = []
    videos: list[dict] = []
    products: list[dict] = []
    places: list[dict] = []

    try:
        payload = _serper_search_organic(q)
        items = _normalize_results(payload)
    except Exception as exc:
        # Soft failure: log and keep going with an empty snippet list so the
        # LLM can still respond honestly ("search didn't return useful…").
        print("[web_search] serper error (continuing without snippets):", exc)
        items = []

    if panel_mode == "product":
        try:
            shopping_payload = _serper_media(
                SERPER_SHOPPING_ENDPOINT, q, SHOPPING_RESULT_LIMIT, "shopping"
            )
            products = _normalize_shopping(shopping_payload)
        except Exception as exc:
            print("[web_search] shopping error (continuing):", exc)
            products = []
    elif panel_mode == "location":
        if not panel_decision.get("location_required"):
            places_query = (
                _compose_places_serper_query(search_params) if search_params else q
            )
            try:
                places_payload = _serper_media(
                    SERPER_PLACES_ENDPOINT, places_query, PLACES_RESULT_LIMIT, "places"
                )
                places = _normalize_places(places_payload)
            except Exception as exc:
                print("[web_search] places error (continuing):", exc)
                places = []
        # When `location_required` is True we intentionally DON'T fetch
        # places — the dispatcher will emit the "What city or area should I
        # search near?" prompt and resume on the next user turn via
        # `resolve_pending_web_search_request`. The `[place_panel]` log
        # below still fires so the lifecycle (detected → required → not
        # resolved) is observable in a single grep.
    else:  # general
        try:
            images_payload = _serper_media(
                SERPER_IMAGES_ENDPOINT, q, IMAGE_RESULT_LIMIT, "images"
            )
            images = _normalize_images(images_payload)
        except Exception as exc:
            print("[web_search] images error (continuing):", exc)
            images = []
        try:
            videos_payload = _serper_media(
                SERPER_VIDEOS_ENDPOINT, q, VIDEO_RESULT_LIMIT, "videos"
            )
            videos = _normalize_videos(videos_payload)
        except Exception as exc:
            print("[web_search] videos error (continuing):", exc)
            videos = []

    # Build ui_payload that matches the panel mode the spec defines. Even when
    # snippets/products/places came back empty we still emit a payload so the
    # frontend can render a "no results" surface that matches the spec
    # (location → map panel placeholder, product → product panel placeholder).
    ui_payload: dict | None = None
    cards_count = 0
    ranked_products: list[dict] = []
    canonical_places: list[dict] = places
    if panel_mode == "product":
        # Canonical pipeline: shopping → normalize → rank → same list for LLM + panel.
        ranked_products = _rank_top_three_products(
            products, query=q, snippets=items
        )
        ui_payload = _build_product_panel_payload(
            q,
            ranked_products,
            total_available=len(products),
            request_id=request_id,
        )
        cards_count = len(ranked_products)
        _log_product_panel(
            query=q,
            user_query=user_question,
            panel_query=q,
            product_query_detected=True,
            current_request_id=request_id,
            panel_payload_request_id=str(ui_payload.get("request_id") or ""),
            product_results_count=len(products),
            product_cards_rendered=len(ranked_products),
            product_image_present=any(
                bool((p.get("image_url") or "").strip()) for p in ranked_products
            ),
            product_panel_created=ui_payload is not None,
            canonical_products=ranked_products,
            product_panel_products=ranked_products,
            price_constraint=_extract_price_constraint(q),
            note=(
                "canonical_products_shared_with_assistant_prompt"
                if ranked_products
                else "empty_shopping_results"
            ),
        )
    elif panel_mode == "location":
        if not panel_decision.get("location_required"):
            canonical_places = places
            ui_payload = _build_location_panel_payload(
                q,
                canonical_places,
                location=panel_decision.get("location") or "",
                location_source=panel_decision.get("location_source") or "",
                search_params=search_params or None,
                request_id=request_id,
            )
            cards_count = len(canonical_places)
        _log_place_panel(
            query=q,
            place_query_detected=True,
            place_category=extract_venue_category(user_question or q),
            explicit_location_detected=str(panel_decision.get("location") or ""),
            location_raw=str(panel_decision.get("location") or ""),
            location_normalized=str(panel_decision.get("location") or ""),
            location_required=bool(panel_decision.get("location_required")),
            location_available=bool(panel_decision.get("location")),
            pending_place_query_set=False,  # set by app.py's pending-action path
            pending_place_query_resolved=False,
            place_search_query=q,
            resolved_place_query=q,
            places_count=len(canonical_places),
            canonical_places=canonical_places,
            location_panel_places=canonical_places,
            current_request_id=request_id,
            panel_payload_request_id=(
                str(ui_payload.get("request_id") or "") if isinstance(ui_payload, dict) else ""
            ),
            map_pins_count=(
                int(ui_payload.get("map_pins") and len(ui_payload["map_pins"]))
                if isinstance(ui_payload, dict)
                else 0
            ),
            location_panel_created=ui_payload is not None,
            resolved_location=str(panel_decision.get("location") or ""),
            note=(
                "canonical_places_shared_with_assistant_prompt"
                if ui_payload is not None
                else "location_required_no_panel_yet"
            ),
        )
    else:
        ui_payload = _build_media_tabs_payload(q, items, images, videos)
        cards_count = len(items) + len(images) + len(videos)

    try:
        _import_panel_routing_logger()(
            selected_route=(
                "clarification_needed"
                if panel_decision.get("location_required") and not panel_decision.get("location")
                else "general_web_search_tool"
            ),
            selected_tool="web_search",
            selected_panel_type=panel_decision.get("panel_type") or "media_tabs",
            query=q,
            entity_extracted=panel_decision.get("location") or "",
            location_required=bool(panel_decision.get("location_required")),
            location_available=bool(panel_decision.get("location")),
            product_query_detected=bool(panel_decision.get("product_query_detected")),
            cards_count=cards_count,
            panel_payload_sent=ui_payload is not None,
            note=panel_decision.get("reason") or "",
        )
    except Exception:
        pass

    if panel_mode == "product":
        prompt_body = _build_canonical_product_prompt(q, ranked_products, items)
        preamble = WEB_SEARCH_PRODUCT_PREAMBLE
    elif panel_mode == "location" and canonical_places and not panel_decision.get(
        "location_required"
    ):
        prompt_body = _build_canonical_place_prompt(
            q,
            canonical_places,
            items,
            search_location=str(search_params.get("location") or panel_decision.get("location") or ""),
            location_source=str(
                search_params.get("location_source")
                or panel_decision.get("location_source")
                or ""
            ),
        )
        preamble = WEB_SEARCH_LOCATION_PREAMBLE
    else:
        prompt_body = _build_prompt(q, items)
        preamble = WEB_SEARCH_PREAMBLE

    full_prompt = preamble + prompt_body + f"\n\nUser question (verbatim): {user_question}"
    try:
        messages = vera.build_messages([], full_prompt)
    except Exception as exc:
        print("[web_search] prompt error:", exc)
        return None

    def finalize(response: str) -> dict:
        return {
            "spoken_reply": response,
            "action_type": "web_search",
            "data": {
                "query": q,
                "user_query": user_question,
                "request_id": request_id,
                "results": items,
                "products": ranked_products,
                "canonical_products": ranked_products,
                "products_all": products,
                "places": canonical_places,
                "canonical_places": canonical_places,
                "images": images,
                "videos": videos,
                "panel_mode": panel_mode,
                "search_params": search_params or None,
                "location": panel_decision.get("location") or "",
                "location_source": panel_decision.get("location_source") or "",
            },
            "ui_payload": ui_payload,
        }

    return messages, ui_payload, finalize


def _import_panel_routing_logger():
    """Import-lazy reference to the shared `[panel_routing]` logger that
    lives in actions.finance (single grep target across both modules)."""
    from actions.finance import _log_panel_routing as _logger
    return _logger


def handle_web_search_request(
    vera,
    query: str,
    *,
    raw_user_text: str | None = None,
    client_location: str = "",
    client_location_source: str = "",
    client_latitude: float | None = None,
    client_longitude: float | None = None,
) -> dict:
    """Synchronous entry point. Mirrors ``handle_finance_analytics_request``.

    Used by the non-streaming dispatch in ``execute_structured_action`` and
    also by smoke tests that want to assert on the answer shape.
    """
    q = (query or "").strip()
    if not q:
        return {
            "spoken_reply": "What should I search the web for?",
            "action_type": "web_search",
            "data": None,
            "ui_payload": None,
        }
    prepared = prepare_web_search_streaming(
        vera,
        q,
        raw_user_text=raw_user_text,
        client_location=client_location,
        client_location_source=client_location_source,
        client_latitude=client_latitude,
        client_longitude=client_longitude,
    )
    if prepared is None:
        return {
            "spoken_reply": "I couldn't reach the search service right now.",
            "action_type": "web_search",
            "data": None,
            "ui_payload": None,
            "service_failure": "web_search",
        }
    messages, _ui, finalize = prepared
    if not messages:
        return finalize()
    response, _ = vera.generate(messages)
    return finalize(response)
