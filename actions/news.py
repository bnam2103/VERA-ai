import email.utils
import os
import re
import time
from datetime import timezone
from html import unescape
from urllib.parse import parse_qs, urlparse

import feedparser
import requests

# =========================
# CONFIG
# =========================
BBC_FEED = "https://feeds.bbci.co.uk/news/rss.xml"
SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/news"
SERPER_IMAGES_ENDPOINT = "https://google.serper.dev/images"
SERPER_VIDEOS_ENDPOINT = "https://google.serper.dev/videos"
SERPER_API_KEY = os.getenv("SERPER_API_KEY", "").strip()
CACHE_TTL = 600
SEARCH_CACHE_TTL = 300
SEARCH_RESULT_LIMIT = 5
IMAGE_RESULT_LIMIT = 6
VIDEO_RESULT_LIMIT = 3

BBC_NEWS_PREAMBLE = (
    "Summarize the following news items clearly and calmly.\n"
    "Start with 'Here are the latest news headlines:' and then describe each story.\n"
    "When describing each story, explicitly attribute it using phrasing like "
    "'According to the BBC' or 'BBC reports that'.\n"
    "Use natural spoken language suitable for a briefing.\n\n"
)

SEARCH_NEWS_PREAMBLE = (
    "Summarize these search results for a news topic clearly and calmly.\n"
    "Focus on the top result first and clearly attribute it to its source.\n"
    "Keep the reply concise and suitable for spoken output.\n"
    "If useful, mention one supporting result briefly.\n"
    "Do not invent details beyond the result snippets below.\n\n"
)

# =========================
# Cache
# =========================
_news_cache = {
    "items": None,
    "timestamp": 0,
}
_search_cache = {}


# =========================
# Helpers
# =========================
def _clean_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _parse_date(date_str):
    dt = email.utils.parsedate_to_datetime(date_str)
    return dt.astimezone(timezone.utc)


def _normalize_news_query(query: str | None) -> str:
    text = (query or "").strip()
    if not text:
        return ""

    patterns = [
        r"^(?:the\s+)?news\s+about\s+",
        r"^(?:the\s+)?news\s+on\s+",
        r"^latest\s+news\s+about\s+",
        r"^latest\s+news\s+on\s+",
        r"^latest\s+on\s+",
        r"^tell\s+me\s+(?:the\s+)?news\s+about\s+",
        r"^tell\s+me\s+(?:the\s+)?latest\s+on\s+",
        r"^can\s+you\s+tell\s+me\s+about\s+",
        r"^can\s+you\s+tell\s+me\s+whats\s+going\s+on\s+with\s+",
        r"^can\s+you\s+tell\s+me\s+what(?:'s|s)\s+going\s+on\s+with\s+",
        r"^what(?:'s|s)\s+going\s+on\s+with\s+",
        r"^what(?:'s|s)\s+going\s+on\s+in\s+",
        r"^whats\s+going\s+in\s+",
        r"^what\s+happened\s+with\s+",
        r"^tell\s+me\s+about\s+",
    ]
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)
    return text.strip(" ?!.,")


def _refine_news_search_query(query: str) -> str:
    cleaned = _normalize_news_query(query)
    lowered = cleaned.lower()
    if not cleaned:
        return ""

    if any(
        keyword in lowered for keyword in [
            "economy",
            "economic",
            "business",
            "company",
            "companies",
            "market",
            "markets",
            "politics",
            "political",
            "government",
            "tech",
            "technology",
            "war",
            "conflict",
        ]
    ):
        return f"{cleaned} latest developments"

    if not any(
        phrase in lowered for phrase in [
            "latest",
            "developments",
            "breaking",
            "update",
            "updates",
            "happening",
            "going on",
        ]
    ):
        return f"latest developments in {cleaned}"

    return cleaned


def _resolve_result_url(url: str) -> str:
    url = unescape(url or "").strip()
    if not url:
        return ""

    if url.startswith("//"):
        return "https:" + url

    if url.startswith("/l/?"):
        parsed = urlparse(url)
        redirected = parse_qs(parsed.query).get("uddg", [""])[0]
        if redirected:
            return redirected
    return url


def _source_from_url(url: str) -> str:
    host = urlparse(url).netloc.lower()
    host = re.sub(r"^www\.", "", host)
    return host or "Unknown source"


def _score_search_result(item: dict, query: str) -> int:
    title = (item.get("title") or "").lower()
    summary = (item.get("summary") or "").lower()
    url = (item.get("url") or "").lower()
    source = (item.get("source") or "").lower()
    query_terms = [term for term in re.findall(r"[a-z0-9]+", query.lower()) if len(term) > 2]

    score = 0

    for term in query_terms:
        if term in title:
            score += 4
        if term in summary:
            score += 2
        if term in url:
            score += 1

    generic_title_phrases = [
        "latest news",
        "live updates",
        "live blog",
        "newsroom",
        "news hub",
        "top stories",
        "breaking news",
        "homepage",
    ]
    generic_url_fragments = [
        "/live/",
        "/news/",
        "/newsroom",
        "/topics/",
        "/topic/",
        "/tag/",
        "/tags/",
        "/search",
    ]

    if any(phrase in title for phrase in generic_title_phrases):
        score -= 6
    if any(fragment in url for fragment in generic_url_fragments):
        score -= 4
    if "newsroom" in source:
        score -= 4

    if len(item.get("summary") or "") >= 80:
        score += 3
    elif len(item.get("summary") or "") >= 30:
        score += 1
    else:
        score -= 2

    path_depth = len([part for part in urlparse(url).path.split("/") if part])
    if path_depth >= 2:
        score += 2

    if re.search(r"\b(?:ceo|war|deal|earnings|tariffs|missiles|announced|reports?|says)\b", title + " " + summary):
        score += 2

    return score


def _rank_search_results(items: list[dict], query: str) -> list[dict]:
    ranked = sorted(
        items,
        key=lambda item: (
            _score_search_result(item, query),
            len(item.get("summary") or ""),
        ),
        reverse=True,
    )
    return ranked


def _serialize_item(item: dict) -> dict:
    published = item.get("published")
    return {
        "title": item["title"],
        "summary": item.get("summary", ""),
        "published": published.isoformat() if published else "",
        "published_display": published.strftime("%b %d, %I:%M %p UTC") if published else "",
        "source": item.get("source", "Unknown source"),
        "url": item.get("url", ""),
    }


def _normalize_serper_items(payload: dict) -> list[dict]:
    items = []

    for item in payload.get("news", []):
        title = _clean_html(item.get("title", ""))
        url = item.get("link", "").strip()
        summary = _clean_html(item.get("snippet", ""))
        if not title or not url:
            continue
        items.append({
            "title": title,
            "summary": summary,
            "published": None,
            "published_display": item.get("date", ""),
            "source": item.get("source") or _source_from_url(url),
            "url": url,
        })

    for item in payload.get("organic", []):
        title = _clean_html(item.get("title", ""))
        url = item.get("link", "").strip()
        summary = _clean_html(item.get("snippet", ""))
        if not title or not url:
            continue
        items.append({
            "title": title,
            "summary": summary,
            "published": None,
            "published_display": "",
            "source": item.get("source") or _source_from_url(url),
            "url": url,
        })

    return items


def _normalize_image_items(payload: dict) -> list[dict]:
    items = []

    for item in payload.get("images", []):
        image_url = (
            item.get("imageUrl")
            or item.get("image")
            or item.get("thumbnailUrl")
            or ""
        ).strip()
        page_url = (
            item.get("link")
            or item.get("sourceUrl")
            or item.get("url")
            or ""
        ).strip()
        title = _clean_html(item.get("title", ""))

        if not image_url:
            continue

        items.append({
            "title": title or "Image result",
            "image_url": image_url,
            "thumbnail_url": (item.get("thumbnailUrl") or image_url).strip(),
            "source": item.get("source") or _source_from_url(page_url),
            "url": page_url,
        })

    return items


def _normalize_video_items(payload: dict) -> list[dict]:
    items = []

    for item in payload.get("videos", []):
        title = _clean_html(item.get("title", ""))
        url = (item.get("link") or item.get("url") or "").strip()
        if not title or not url:
            continue

        items.append({
            "title": title,
            "summary": _clean_html(item.get("snippet", "")),
            "source": item.get("source") or _source_from_url(url),
            "published_display": item.get("date", ""),
            "url": url,
            "thumbnail_url": (item.get("imageUrl") or item.get("thumbnailUrl") or "").strip(),
        })

    return items


def _build_bbc_prompt(items: list[dict]) -> str:
    lines = []
    for i, item in enumerate(items, 1):
        lines.append(
            f"{i}. {item['title']}\n"
            f"{item['summary']}"
        )
    return "\n\n".join(lines)


def _build_search_prompt(query: str, items: list[dict]) -> str:
    lines = [f"Topic: {query}"]
    for i, item in enumerate(items[:3], 1):
        lines.append(
            f"{i}. {item['title']}\n"
            f"Source: {item['source']}\n"
            f"Snippet: {item.get('summary', '')}"
        )
    return "\n\n".join(lines)


def _search_serper_payload(endpoint: str, query: str, limit: int, cache_prefix: str) -> dict:
    if not SERPER_API_KEY:
        raise RuntimeError("SERPER_API_KEY is not set")

    cache_key = f"{cache_prefix}:{query.lower()}"
    now = time.time()
    cached = _search_cache.get(cache_key)
    if cached and now - cached["timestamp"] < SEARCH_CACHE_TTL:
        # Cache hits should NOT log a paid Serper call.
        return cached["payload"]

    response = requests.post(
        endpoint,
        headers={
            "X-API-KEY": SERPER_API_KEY,
            "Content-Type": "application/json",
        },
        json={"q": query, "num": limit},
        timeout=4,
    )
    response.raise_for_status()
    payload = response.json()

    _search_cache[cache_key] = {
        "payload": payload,
        "timestamp": now,
    }

    # Best-effort cost record. Failure must never break the news request.
    try:
        from cost_logging import log_serper_event as _log_serper_event

        _log_serper_event(
            endpoint=endpoint,
            query=query,
            query_count=1,
            raw_response={
                "search_metadata": (payload or {}).get("searchParameters"),
                "result_count": len((payload or {}).get("news") or (payload or {}).get("images") or (payload or {}).get("videos") or []),
                "credits": (payload or {}).get("credits"),
            },
            extra={"cache_prefix": cache_prefix, "limit": limit},
        )
    except Exception as _serper_log_err:
        print(f"[cost_logger] serper log skipped: {_serper_log_err}")

    return payload


def _fetch_news_media(query: str) -> tuple[list[dict], list[dict]]:
    normalized_query = _normalize_news_query(query)
    if not normalized_query or not SERPER_API_KEY:
        return [], []

    media_query = _refine_news_search_query(normalized_query)

    try:
        images_payload = _search_serper_payload(
            SERPER_IMAGES_ENDPOINT,
            f"{media_query} news",
            IMAGE_RESULT_LIMIT,
            "images",
        )
        images = _normalize_image_items(images_payload)[:IMAGE_RESULT_LIMIT]
    except Exception as exc:
        print("News image fetch error:", exc)
        images = []

    try:
        videos_payload = _search_serper_payload(
            SERPER_VIDEOS_ENDPOINT,
            f"{media_query} news",
            VIDEO_RESULT_LIMIT,
            "videos",
        )
        videos = _normalize_video_items(videos_payload)[:VIDEO_RESULT_LIMIT]
    except Exception as exc:
        print("News video fetch error:", exc)
        videos = []

    return images, videos


def _action_result_from_items(
    spoken_reply: str,
    query_label: str,
    items: list[dict],
    mode: str,
    *,
    time_horizon: str | None = None,
    entities: list[str] | None = None,
    search_queries: list[str] | None = None,
) -> dict:
    serialized_items = [_serialize_item(item) for item in items]
    images, videos = _fetch_news_media(query_label)
    data = {
        "headlines": serialized_items,
        "summary": spoken_reply,
        "mode": mode,
        "query": query_label,
        "time_horizon": time_horizon or "unspecified",
        "entities": [e for e in (entities or []) if e],
        "search_queries": [q for q in (search_queries or []) if q],
        "result_titles": [str(it.get("title") or "") for it in serialized_items],
        "result_sources": [str(it.get("source") or "") for it in serialized_items],
        "result_urls": [str(it.get("url") or "") for it in serialized_items],
        "result_published": [str(it.get("published_display") or "") for it in serialized_items],
        "result_summaries": [str(it.get("summary") or "") for it in serialized_items],
    }
    return {
        "spoken_reply": spoken_reply,
        "action_type": "news",
        "data": data,
        "ui_payload": {
            "panel_type": "media_tabs",
            "title": "News Results",
            "query": query_label,
            "news_results": serialized_items,
            "images": images,
            "videos": videos,
            "default_tab": "news",
        },
    }


# =========================
# BBC RSS Fetch
# =========================
def _fetch_rss():
    feed = feedparser.parse(BBC_FEED)

    if feed.bozo or not feed.entries:
        raise RuntimeError("RSS feed unavailable")

    items = []
    for entry in feed.entries:
        items.append({
            "title": entry.title,
            "summary": _clean_html(getattr(entry, "summary", "")),
            "published": _parse_date(entry.published),
            "source": "BBC",
            "url": getattr(entry, "link", ""),
        })

    return items


def get_top_news(limit=5):
    now = time.time()

    if _news_cache["items"] and now - _news_cache["timestamp"] < CACHE_TTL:
        return _news_cache["items"][:limit]

    items = _fetch_rss()
    _news_cache["items"] = items
    _news_cache["timestamp"] = now
    return items[:limit]


# =========================
# Search Fetch
# =========================
def _search_news_results_serper(query: str, limit: int = SEARCH_RESULT_LIMIT):
    # 2026-05-30: dedupe trailing "news" / "latest news" so we don't send
    # Serper "X latest news news". The normalizer in
    # `actions/info_normalizer.py` may already append "news" to a merged
    # context query; appending again here used to produce duplicates that
    # hurt result relevance.
    try:
        from actions.info_normalizer import (  # local import to avoid cycle
            dedupe_news_keywords as _dedupe_news_kw,
            should_append_news_keyword as _should_append_news_kw,
        )
        base_query = _dedupe_news_kw(query or "")
        if _should_append_news_kw(base_query):
            search_query = f"{base_query} news"
        else:
            search_query = base_query
    except Exception:
        # If the normalizer module fails to import for any reason, fall
        # back to the legacy "X news" suffix behavior.
        search_query = f"{query} news"
    payload = _search_serper_payload(
        SERPER_SEARCH_ENDPOINT,
        search_query,
        limit,
        "news",
    )
    items = _normalize_serper_items(payload)
    if not items:
        raise RuntimeError("Serper results unavailable")
    return items[:limit]


def search_news_results(query: str, limit: int = SEARCH_RESULT_LIMIT):
    normalized_query = _normalize_news_query(query)
    if not normalized_query:
        return []
    search_query = _refine_news_search_query(normalized_query)

    items = _search_news_results_serper(search_query, limit=limit)
    print(f"[NEWS] provider=serper query={search_query!r} results={len(items)}")
    return items


def _dedup_items_by_url(items: list[dict]) -> list[dict]:
    seen: set = set()
    out: list[dict] = []
    for item in items or []:
        url = (item.get("url") or "").strip().lower()
        if not url or url in seen:
            continue
        seen.add(url)
        out.append(item)
    return out


def search_news_results_multi(
    queries: list[str],
    limit_per_query: int = 4,
    rank_against: str | None = None,
) -> list[dict]:
    """Run several pre-built search queries, merge, dedup by URL, rank by relevance.

    Pre-built queries skip _refine_news_search_query so we don't wrap them
    in 'latest developments in …' for caller-supplied entity-rich strings.
    """
    merged: list[dict] = []
    for q in queries or []:
        qq = (q or "").strip()
        if not qq:
            continue
        try:
            items = _search_news_results_serper(qq, limit=limit_per_query)
            print(f"[NEWS] provider=serper multi_query={qq!r} results={len(items)}")
            merged.extend(items or [])
        except Exception as exc:
            print(f"News multi-query fetch error for {qq!r}: {exc}")
    merged = _dedup_items_by_url(merged)
    ranker_query = (rank_against or " ".join(queries or [])).strip()
    if ranker_query:
        merged = _rank_search_results(merged, ranker_query)
    return merged


# =========================
# Main action
# =========================
def prepare_news_streaming_messages(
    vera,
    query: str | None = None,
    breaking: bool = False,
    search_queries: list[str] | None = None,
    time_horizon: str | None = None,
    entities: list[str] | None = None,
):
    """
    Fetch RSS/Serper and build messages for async_generate_stream (no LLM).
    Returns (messages, ui_payload, finalize_fn) or None on fetch failure.
    finalize_fn(spoken_reply: str) -> action_result dict
    """
    normalized_query = _normalize_news_query(query)
    pre_built = [q.strip() for q in (search_queries or []) if (q or "").strip()]

    try:
        if pre_built:
            label = normalized_query or pre_built[0]
            ranked_items = search_news_results_multi(
                pre_built, limit_per_query=4, rank_against=label
            )[:SEARCH_RESULT_LIMIT]
            prompt = _build_search_prompt(label, ranked_items)
            messages = vera.build_messages(
                chat_history=[],
                user_text=SEARCH_NEWS_PREAMBLE + prompt,
            )
            partial = _action_result_from_items(
                "", label, ranked_items, mode="search",
                time_horizon=time_horizon, entities=entities, search_queries=pre_built,
            )

            def finalize(response: str):
                return _action_result_from_items(
                    response, label, ranked_items, mode="search",
                    time_horizon=time_horizon, entities=entities, search_queries=pre_built,
                )

            return messages, partial.get("ui_payload"), finalize

        if normalized_query:
            items = search_news_results(normalized_query)
            ranked_items = _rank_search_results(items, normalized_query)
            prompt = _build_search_prompt(normalized_query, ranked_items)
            messages = vera.build_messages(
                chat_history=[],
                user_text=SEARCH_NEWS_PREAMBLE + prompt,
            )
            partial = _action_result_from_items(
                "", normalized_query, ranked_items, mode="search",
                time_horizon=time_horizon, entities=entities,
            )

            def finalize(response: str):
                return _action_result_from_items(
                    response, normalized_query, ranked_items, mode="search",
                    time_horizon=time_horizon, entities=entities,
                )

            return messages, partial.get("ui_payload"), finalize

        if breaking:
            items = search_news_results("breaking news")
            ranked_items = _rank_search_results(items, "breaking news")
            prompt = _build_search_prompt("breaking news", ranked_items)
            messages = vera.build_messages(
                chat_history=[],
                user_text=SEARCH_NEWS_PREAMBLE + prompt,
            )
            partial = _action_result_from_items("", "Breaking news", ranked_items, mode="breaking")

            def finalize(response: str):
                return _action_result_from_items(response, "Breaking news", ranked_items, mode="breaking")

            return messages, partial.get("ui_payload"), finalize

        items = get_top_news(limit=3)
        prompt = _build_bbc_prompt(items)
        messages = vera.build_messages(
            chat_history=[],
            user_text=BBC_NEWS_PREAMBLE + prompt,
        )
        partial = _action_result_from_items("", "Top headlines", items, mode="headlines")

        def finalize(response: str):
            return _action_result_from_items(response, "Top headlines", items, mode="headlines")

        return messages, partial.get("ui_payload"), finalize
    except Exception as e:
        print("News fetch error:", e)
        return None


def handle_news_open_panel(*, query: str = "", title: str = "") -> dict:
    """UI-only action that opens the News side panel WITHOUT routing through
    Work Mode / reasoning panel logic.

    Used when the user says things like:
      - "open the news panel"
      - "show news panel"
      - "bring up news"

    The frontend listens on ``panel_type: "news_panel_ui"`` with ``op: "open"``
    and either restores the cached news results or shows an empty headlines
    shell so the user can immediately see/use the panel. The voice reply is
    intentionally short (the user just asked for a UI surface, not a
    briefing).
    """
    spoken_title = (title or "").strip() or "News"
    if title:
        spoken = f"Opened the news panel for {spoken_title}."
    else:
        spoken = "Opened the news panel."
    return {
        "spoken_reply": spoken,
        "action_type": "news",
        "data": {"ui_only": True, "op": "open"},
        "ui_payload": {
            "panel_type": "news_panel_ui",
            "op": "open",
            "title": title or "",
            "query": query or "",
        },
    }


def handle_news_close_panel() -> dict:
    """UI-only action that closes the News side panel without affecting
    Work Mode or reasoning panel state."""
    return {
        "spoken_reply": "Closed the news panel.",
        "action_type": "news",
        "data": {"ui_only": True, "op": "close"},
        "ui_payload": {
            "panel_type": "news_panel_ui",
            "op": "close",
        },
    }


def handle_news_request(
    vera,
    query: str | None = None,
    breaking: bool = False,
    search_queries: list[str] | None = None,
    time_horizon: str | None = None,
    entities: list[str] | None = None,
):
    normalized_query = _normalize_news_query(query)

    try:
        prepared = prepare_news_streaming_messages(
            vera, query, breaking,
            search_queries=search_queries,
            time_horizon=time_horizon,
            entities=entities,
        )
        if prepared is None:
            if normalized_query or breaking:
                topic_label = normalized_query or "breaking news"
                spoken_reply = f"I couldn't find useful news results for {topic_label} right now."
            else:
                spoken_reply = "I’m having trouble fetching the news right now."
            return {
                "spoken_reply": spoken_reply,
                "action_type": "news",
                "data": None,
                "ui_payload": None,
            }
        messages, _ui, finalize = prepared
        response, _ = vera.generate(messages)
        return finalize(response)
    except Exception as e:
        print("News fetch error:", e)
        try:
            from safety_limits import FallbackMessages as _SF, log_safety_block as _sl
            _sl(reason="search_api_failure", mode="non_work", feature="news",
                extra={"error": str(e)[:200], "query": (normalized_query or "")[:120]})
            spoken_reply = _SF.SEARCH_NEWS_FAILURE
        except Exception:
            spoken_reply = "Search/news information is not available right now."
        return {
            "spoken_reply": spoken_reply,
            "action_type": "news",
            "data": None,
            "ui_payload": None,
            "service_failure": "news",
        }