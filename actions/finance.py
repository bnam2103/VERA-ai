import os
import re
import time
from html import unescape
from urllib.parse import urlencode, urlparse

import requests

SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search"
SERPER_IMAGES_ENDPOINT = "https://google.serper.dev/images"
SERPER_VIDEOS_ENDPOINT = "https://google.serper.dev/videos"
SERPER_API_KEY = os.getenv("SERPER_API_KEY", "").strip()
SEARCH_CACHE_TTL = 180
SEARCH_RESULT_LIMIT = 5
IMAGE_RESULT_LIMIT = 6
VIDEO_RESULT_LIMIT = 3
SYMBOL_RESOLUTION_CACHE_TTL = 3600
SYMBOL_RESOLUTION_CONFIDENCE_THRESHOLD = 0.65

GENERIC_FINANCE_SYMBOL_BLOCKLIST = frozenset({
    "STOCK",
    "STOCKS",
    "SHARE",
    "SHARES",
    "PRICE",
    "QUOTE",
    "QUOTES",
    "TICKER",
    "TICKERS",
    "FUND",
    "FUNDS",
    "ETF",
    "ETFS",
    "INDEX",
    "EQUITY",
    "EQUITIES",
    "MARKET",
    "TRADE",
    "TRADING",
    "CHART",
    "ASSET",
    "ASSETS",
})

GENERIC_FINANCE_SUBJECT_BLOCKLIST = frozenset({
    "stock",
    "stocks",
    "share",
    "shares",
    "price",
    "quote",
    "quotes",
    "ticker",
    "tickers",
    "fund",
    "funds",
    "etf",
    "etfs",
    "index",
    "equity",
    "equities",
    "market",
    "trading",
    "chart",
    "asset",
    "assets",
})

SYMBOL_EXCHANGE_OVERRIDES = {
    "AAPL": "NASDAQ",
    "NVDA": "NASDAQ",
    "MSFT": "NASDAQ",
    "AMZN": "NASDAQ",
    "GOOGL": "NASDAQ",
    "GOOG": "NASDAQ",
    "META": "NASDAQ",
    "TSLA": "NASDAQ",
    "SMH": "NASDAQ",
    "VGT": "AMEX",
    "QQQ": "NASDAQ",
    "SPY": "AMEX",
    "VOO": "AMEX",
    "IVV": "AMEX",
}

SUBJECT_SYMBOL_ALIASES = {
    "apple": ("AAPL", "NASDAQ"),
    "apple inc": ("AAPL", "NASDAQ"),
    "nvidia": ("NVDA", "NASDAQ"),
    "nvidia corp": ("NVDA", "NASDAQ"),
    "microsoft": ("MSFT", "NASDAQ"),
    "microsoft corp": ("MSFT", "NASDAQ"),
    "amazon": ("AMZN", "NASDAQ"),
    "amazon.com": ("AMZN", "NASDAQ"),
    "google": ("GOOGL", "NASDAQ"),
    "alphabet": ("GOOGL", "NASDAQ"),
    "meta": ("META", "NASDAQ"),
    "meta platforms": ("META", "NASDAQ"),
    "facebook": ("META", "NASDAQ"),
    "tesla": ("TSLA", "NASDAQ"),
    "intel": ("INTC", "NASDAQ"),
    "cisco": ("CSCO", "NASDAQ"),
    "adobe": ("ADBE", "NASDAQ"),
    "vgt": ("VGT", "AMEX"),
    "vanguard information technology etf": ("VGT", "AMEX"),
    "smh": ("SMH", "NASDAQ"),
    "vaneck semiconductor etf": ("SMH", "NASDAQ"),
    "spy": ("SPY", "AMEX"),
    "qqq": ("QQQ", "NASDAQ"),
    "voo": ("VOO", "AMEX"),
    "ivv": ("IVV", "AMEX"),
}

FINANCE_QUOTE_PREAMBLE = (
    "You are summarizing finance search results for a voice assistant.\n"
    "Answer the user's quote question directly and concisely.\n"
    "If search results provide an exact current or recent quoted price, state it clearly with the source.\n"
    "If the exact price cannot be confirmed from the search results, say you couldn't confirm a live price right now.\n"
    "Do not invent prices or percentages.\n\n"
)

FINANCE_CONTEXT_PREAMBLE = (
    "You are summarizing finance search results for a voice assistant.\n"
    "Focus on what is currently happening with the asset or company.\n"
    "Summarize the most relevant development from the top result first and mention one supporting result if useful.\n"
    "Keep it concise and source-grounded.\n\n"
)

# Analytics covers historical / quantitative finance questions (max drawdown,
# annualized return, Sharpe, beta, volatility, X-year performance). For beta we
# use Serper snippets as the fallback source instead of refusing before search.
# The model may report source-backed figures cautiously, but must not pretend it
# performed an exact adjusted-close calculation.
FINANCE_ANALYTICS_PREAMBLE = (
    "You are answering a historical or contextual finance question for a voice assistant.\n"
    "The user expects a real answer based on the search snippets below. This is the beta\n"
    "fallback path; web search results ARE the source. Do not refuse.\n"
    "\n"
    "Hard rules (read these first, they override anything else):\n"
    "  - Do NOT begin the reply with phrases like \"I don't have\", \"I can't\",\n"
    "    \"Unfortunately\", \"Without access\", \"To calculate this exactly\", or\n"
    "    \"I don't have daily price data\". Those refusals are forbidden.\n"
    "  - Do NOT echo or restate the user's question verbatim. Just answer it.\n"
    "  - Do NOT say you cannot answer. Always give the best source-backed estimate\n"
    "    you can from the snippets, then add the caveat in ONE sentence.\n"
    "  - Do NOT use intraday high/low or current-price data to answer drawdown,\n"
    "    historical return, volatility, Sharpe, beta, or similar historical metrics.\n"
    "  - Keep the whole reply to 2-4 short sentences. Voice-friendly tone.\n"
    "\n"
    "Required answer shape:\n"
    "  1. First sentence: the best source-backed numeric estimate or range from the\n"
    "     snippets, phrased as a range when sources disagree.\n"
    "     Example (drawdown): \"Based on the sources I found, VGT's largest drawdown\n"
    "     over the past 5 years appears to be roughly in the low-20% range.\"\n"
    "     Example (52-week): \"Based on the sources I found, QQQ's 52-week range is\n"
    "     about X to Y.\"\n"
    "     Example (compare): \"Based on the sources I found, VGT outpaced QQQ over\n"
    "     the past 5 years by roughly N percentage points cumulatively.\"\n"
    "     Example (why drop): \"Based on the sources I found, Nvidia is down today\n"
    "     mostly because of <reason from snippet>.\"\n"
    "  2. Second sentence: the caveat, in ONE line.\n"
    "     Use exactly this style: \"Treat this as source-reported rather than an\n"
    "     exact daily adjusted-close calculation.\"\n"
    "  3. Only if the snippets really do not contain a usable figure, say:\n"
    "     \"I found limited source-reported data, so I'd treat this as an estimate,\"\n"
    "     then give the rough direction/range you can infer (still no refusal).\n"
    "  4. Cite the source name (Morningstar, Yahoo Finance, Reuters, etc.) at most\n"
    "     once if it appears in the snippet.\n"
    "\n"
)

_finance_cache = {}


def _clean_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _source_from_url(url: str) -> str:
    host = urlparse(url or "").netloc.lower()
    host = re.sub(r"^www\.", "", host)
    return host or "Unknown source"


def _normalize_finance_subject(query: str | None) -> str:
    text = (query or "").strip()
    if not text:
        return ""

    extracted = _extract_ticker_from_finance_query(text)
    if extracted:
        return extracted

    patterns = [
        r"^can\s+you\s+tell\s+me\s+the\s+(?:stock\s+)?price\s+of\s+",
        r"^can\s+you\s+tell\s+me\s+the\s+stock\s+price\s+of\s+",
        r"^can\s+you\s+tell\s+me\s+about\s+",
        r"^what(?:'s|s|\s+is)\s+the\s+(?:stock\s+)?price\s+of\s+",
        r"^what\s+is\s+the\s+stock\s+price\s+of\s+",
        r"^what(?:'s|s|\s+is)\s+",
        r"^how\s+much\s+is\s+",
        r"^tell\s+me\s+the\s+(?:stock\s+)?price\s+of\s+",
        r"^stock\s+price\s+of\s+",
        r"^share\s+price\s+of\s+",
        r"^price\s+of\s+",
        r"^quote\s+for\s+",
        r"^what(?:'s|s)\s+going\s+on\s+with\s+",
        r"^what(?:'s|s)\s+happening\s+with\s+",
        r"^latest\s+on\s+",
    ]
    for pattern in patterns:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)

    text = text.strip(" ?!.,")
    if not text:
        return ""

    extracted = _extract_ticker_from_finance_query(text)
    if extracted:
        return extracted

    if _is_direct_ticker_like_subject(text):
        return _normalize_symbol(text)

    return text


def _is_blocked_finance_symbol(symbol: str | None) -> bool:
    return str(symbol or "").upper() in GENERIC_FINANCE_SYMBOL_BLOCKLIST


def _is_generic_finance_subject(subject: str | None) -> bool:
    return _normalize_subject_key(subject) in GENERIC_FINANCE_SUBJECT_BLOCKLIST


def _extract_ticker_from_finance_query(query: str | None) -> str:
    text = (query or "").strip()
    if not text:
        return ""

    patterns = [
        r"(?:price|quote|trading(?:\s+at)?)\s+(?:of|for)\s+\$?([A-Za-z]{1,5})\b",
        r"\b\$?([A-Za-z]{1,5})\s+(?:stock|share|etf|fund)\s+price\b",
        r"\b(?:for|of)\s+\$?([A-Za-z]{1,5})\b\s*[?.!]*$",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if not match:
            continue
        symbol = _normalize_symbol(match.group(1))
        if symbol and _is_direct_ticker_like_subject(symbol):
            return symbol
    return ""


def _normalize_serper_items(payload: dict) -> list[dict]:
    items = []
    for item in payload.get("news", []):
        title = _clean_text(item.get("title", ""))
        url = (item.get("link") or "").strip()
        summary = _clean_text(item.get("snippet", ""))
        if not title or not url:
            continue
        items.append({
            "title": title,
            "summary": summary,
            "source": item.get("source") or _source_from_url(url),
            "published_display": item.get("date", ""),
            "url": url,
        })

    for item in payload.get("organic", []):
        title = _clean_text(item.get("title", ""))
        url = (item.get("link") or "").strip()
        summary = _clean_text(item.get("snippet", ""))
        if not title or not url:
            continue
        items.append({
            "title": title,
            "summary": summary,
            "source": item.get("source") or _source_from_url(url),
            "published_display": "",
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
        if not image_url:
            continue

        items.append({
            "title": _clean_text(item.get("title", "")) or "Image result",
            "image_url": image_url,
            "thumbnail_url": (item.get("thumbnailUrl") or image_url).strip(),
            "source": item.get("source") or _source_from_url(page_url),
            "url": page_url,
        })

    return items


def _normalize_video_items(payload: dict) -> list[dict]:
    items = []
    for item in payload.get("videos", []):
        title = _clean_text(item.get("title", ""))
        url = (item.get("link") or item.get("url") or "").strip()
        if not title or not url:
            continue

        items.append({
            "title": title,
            "summary": _clean_text(item.get("snippet", "")),
            "source": item.get("source") or _source_from_url(url),
            "published_display": item.get("date", ""),
            "url": url,
            "thumbnail_url": (item.get("imageUrl") or item.get("thumbnailUrl") or "").strip(),
        })

    return items


def _score_finance_item(item: dict, subject: str) -> int:
    title = (item.get("title") or "").lower()
    summary = (item.get("summary") or "").lower()
    url = (item.get("url") or "").lower()
    subject_terms = [term for term in re.findall(r"[a-z0-9]+", subject.lower()) if len(term) > 1]

    score = 0
    for term in subject_terms:
        if term in title:
            score += 4
        if term in summary:
            score += 2
        if term in url:
            score += 1

    if len(item.get("summary") or "") >= 80:
        score += 2
    if re.search(r"\b(?:shares|stock|etf|fund|price|quote|surge|falls|earnings|guidance|downgrade|upgrade)\b", title + " " + summary):
        score += 3
    if re.search(r"\b(?:newsroom|investor relations|home|homepage)\b", title):
        score -= 3
    if any(fragment in url for fragment in ["/live/", "/search", "/tag/", "/topic/"]):
        score -= 3

    return score


def _rank_finance_items(items: list[dict], subject: str) -> list[dict]:
    return sorted(
        items,
        key=lambda item: (_score_finance_item(item, subject), len(item.get("summary") or "")),
        reverse=True,
    )


def _search_serper(query: str, limit: int = SEARCH_RESULT_LIMIT) -> dict:
    if not SERPER_API_KEY:
        raise RuntimeError("SERPER_API_KEY is not set")

    cache_key = query.lower()
    now = time.time()
    cached = _finance_cache.get(cache_key)
    if cached and now - cached["timestamp"] < SEARCH_CACHE_TTL:
        return cached["payload"]

    response = requests.post(
        SERPER_SEARCH_ENDPOINT,
        headers={
            "X-API-KEY": SERPER_API_KEY,
            "Content-Type": "application/json",
        },
        json={"q": query},
        timeout=4,
    )
    response.raise_for_status()
    payload = response.json()

    try:
        from cost_logging.serper_helpers import log_serper_http_call

        log_serper_http_call(
            endpoint=SERPER_SEARCH_ENDPOINT,
            query=query,
            payload=payload,
            extra={"source": "finance._search_serper"},
        )
    except Exception as _serper_log_err:
        print(f"[cost_logger] serper log skipped: {_serper_log_err}")

    _finance_cache[cache_key] = {
        "payload": payload,
        "timestamp": now,
    }
    return payload


def _search_media_serper(endpoint: str, query: str, limit: int, cache_prefix: str) -> dict:
    if not SERPER_API_KEY:
        raise RuntimeError("SERPER_API_KEY is not set")

    cache_key = f"{cache_prefix}:{query.lower()}"
    now = time.time()
    cached = _finance_cache.get(cache_key)
    if cached and now - cached["timestamp"] < SEARCH_CACHE_TTL:
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

    try:
        from cost_logging.serper_helpers import log_serper_http_call

        log_serper_http_call(
            endpoint=endpoint,
            query=query,
            payload=payload,
            extra={"source": "finance._search_media_serper", "cache_prefix": cache_prefix},
        )
    except Exception as _serper_log_err:
        print(f"[cost_logger] serper log skipped: {_serper_log_err}")

    _finance_cache[cache_key] = {
        "payload": payload,
        "timestamp": now,
    }
    return payload


def _build_quote_prompt(subject: str, payload: dict, items: list[dict]) -> str:
    lines = [f"Asset: {subject}"]
    answer_box = payload.get("answerBox") or {}
    if answer_box:
        lines.append(
            "Answer box:\n"
            f"Title: {_clean_text(answer_box.get('title', ''))}\n"
            f"Answer: {_clean_text(answer_box.get('answer', ''))}\n"
            f"Snippet: {_clean_text(answer_box.get('snippet', ''))}"
        )

    for i, item in enumerate(items[:3], 1):
        lines.append(
            f"{i}. {item['title']}\n"
            f"Source: {item['source']}\n"
            f"Snippet: {item.get('summary', '')}"
        )
    return "\n\n".join(lines)


def _build_context_prompt(subject: str, items: list[dict]) -> str:
    lines = [f"Asset: {subject}"]
    for i, item in enumerate(items[:3], 1):
        lines.append(
            f"{i}. {item['title']}\n"
            f"Source: {item['source']}\n"
            f"Snippet: {item.get('summary', '')}"
        )
    return "\n\n".join(lines)


def _build_symbol_resolution_context(subject: str, payload: dict, items: list[dict]) -> str:
    lines = [f"Requested subject: {subject}"]

    answer_box = payload.get("answerBox") or {}
    if answer_box:
        lines.append(
            "Answer box:\n"
            f"Title: {_clean_text(answer_box.get('title', ''))}\n"
            f"Answer: {_clean_text(answer_box.get('answer', ''))}\n"
            f"Snippet: {_clean_text(answer_box.get('snippet', ''))}"
        )

    knowledge_graph = payload.get("knowledgeGraph") or {}
    if knowledge_graph:
        lines.append(
            "Knowledge graph:\n"
            f"Title: {_clean_text(knowledge_graph.get('title', ''))}\n"
            f"Type: {_clean_text(knowledge_graph.get('type', ''))}\n"
            f"Description: {_clean_text(knowledge_graph.get('description', ''))}"
        )

    for i, item in enumerate(items[:3], 1):
        lines.append(
            f"{i}. {item['title']}\n"
            f"Source: {item['source']}\n"
            f"URL: {item.get('url', '')}\n"
            f"Snippet: {item.get('summary', '')}"
        )

    return "\n\n".join(lines)


def _finance_context_panel_payload(title: str, query: str, items: list[dict], images: list[dict], videos: list[dict]) -> dict:
    return {
        "panel_type": "media_tabs",
        "title": title,
        "query": query,
        "news_results": items,
        "images": images,
        "videos": videos,
        "default_tab": "news",
    }


def _extract_symbol_candidates(text: str | None) -> list[str]:
    raw = str(text or "").upper()
    candidates = []

    candidates.extend(re.findall(r"\b(?:NASDAQ|NYSE|AMEX|ARCA|NYSEARCA|CBOE|BATS|TSX|LSE|TSE|HKEX)\s*[:\-]\s*([A-Z.\-]{1,10})\b", raw))
    candidates.extend(re.findall(r"/quote/([A-Z.\-]{1,10})", raw))
    candidates.extend(re.findall(r"\(([A-Z.\-]{1,10})\)", raw))
    candidates.extend(re.findall(r"\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b(?=\s+(?:STOCK|SHARES|QUOTE|PRICE))", raw))

    return candidates


def _extract_exchange_candidates(text: str | None) -> list[str]:
    raw = str(text or "").upper()
    exchanges = []

    for match in re.findall(r"\b(NASDAQ|NYSE|AMEX|ARCA|NYSEARCA|CBOE|BATS|TSX|LSE|TSE|HKEX)\b", raw):
        exchanges.append(match)

    if "NYSE ARCA" in raw or "NYSEARCA" in raw:
        exchanges.append("AMEX")

    return exchanges


def _normalize_symbol(candidate: str | None) -> str:
    symbol = re.sub(r"[^A-Z.\-]", "", str(candidate or "").upper())
    if re.fullmatch(r"[A-Z]{1,5}(?:\.[A-Z]{1,2})?", symbol):
        if _is_blocked_finance_symbol(symbol):
            return ""
        return symbol
    return ""


def _normalize_exchange(candidate: str | None) -> str:
    exchange = re.sub(r"[^A-Z]", "", str(candidate or "").upper())
    aliases = {
        "NYSEARCA": "AMEX",
        "ARCA": "AMEX",
    }
    exchange = aliases.get(exchange, exchange)
    if exchange in {"NASDAQ", "NYSE", "AMEX", "CBOE", "BATS", "TSX", "LSE", "TSE", "HKEX"}:
        return exchange
    return ""


def _normalize_subject_key(subject: str | None) -> str:
    return re.sub(r"\s+", " ", str(subject or "").strip().lower())


def _subject_alias_resolution(subject: str | None) -> tuple[str, str]:
    key = _normalize_subject_key(subject)
    return SUBJECT_SYMBOL_ALIASES.get(key, ("", ""))


def _is_direct_ticker_like_subject(subject: str | None) -> bool:
    raw = str(subject or "").strip()
    if not raw or " " in raw:
        return False

    normalized = _normalize_symbol(raw)
    if not normalized:
        return False

    if normalized in SYMBOL_EXCHANGE_OVERRIDES:
        return True

    return bool(
        re.fullmatch(r"[A-Z]{1,4}", normalized)
        or "." in normalized
        or bool(re.search(r"\d", normalized))
    )


def _looks_like_etf_or_fund(subject: str, payload: dict, items: list[dict]) -> bool:
    haystacks = [subject]
    for container in (payload.get("answerBox") or {}, payload.get("knowledgeGraph") or {}):
        for key in ("title", "answer", "snippet", "description", "type"):
            haystacks.append(str(container.get(key, "")))
    for item in items[:3]:
        haystacks.append(str(item.get("title", "")))
        haystacks.append(str(item.get("summary", "")))

    combined = " ".join(haystacks).lower()
    return bool(re.search(r"\b(?:etf|fund|index fund|exchange traded fund|vanguard|ishares|spdr)\b", combined))


def _extract_chart_symbol(subject: str, payload: dict, items: list[dict]) -> tuple[str, str]:
    explicit_symbol_candidates = []
    regex_symbol_candidates = []
    exchange_candidates = []

    alias_symbol, alias_exchange = _subject_alias_resolution(subject)
    if alias_symbol:
        return alias_symbol, f"{alias_exchange}:{alias_symbol}"

    query_ticker = _extract_ticker_from_finance_query(subject) or (
        _normalize_symbol(subject) if _is_direct_ticker_like_subject(subject) else ""
    )
    subject_symbol = query_ticker
    if subject_symbol:
        explicit_symbol_candidates.append(subject_symbol)

    for container in (payload.get("answerBox") or {}, payload.get("knowledgeGraph") or {}):
        for key in ("ticker", "symbol", "stockSymbol"):
            value = container.get(key)
            if value:
                explicit_symbol_candidates.append(value)
        stock_value = container.get("stock")
        if stock_value:
            normalized_stock = _normalize_symbol(stock_value)
            if normalized_stock:
                explicit_symbol_candidates.append(normalized_stock)
        for key in ("title", "answer", "snippet", "description"):
            value = container.get(key)
            regex_symbol_candidates.extend(_extract_symbol_candidates(value))
            exchange_candidates.extend(_extract_exchange_candidates(value))

    for item in items[:3]:
        regex_symbol_candidates.extend(_extract_symbol_candidates(item.get("title")))
        regex_symbol_candidates.extend(_extract_symbol_candidates(item.get("url")))
        regex_symbol_candidates.extend(_extract_symbol_candidates(item.get("summary")))
        exchange_candidates.extend(_extract_exchange_candidates(item.get("title")))
        exchange_candidates.extend(_extract_exchange_candidates(item.get("url")))
        exchange_candidates.extend(_extract_exchange_candidates(item.get("summary")))

    symbol = ""
    for candidate in explicit_symbol_candidates:
        symbol = _normalize_symbol(candidate)
        if symbol:
            break

    if not symbol:
        for candidate in regex_symbol_candidates:
            normalized_candidate = _normalize_symbol(candidate)
            if not normalized_candidate:
                continue
            if subject_symbol and normalized_candidate != subject_symbol:
                continue
            symbol = normalized_candidate
            break

    if not symbol:
        return "", ""

    override_exchange = SYMBOL_EXCHANGE_OVERRIDES.get(symbol)
    if override_exchange:
        return symbol, f"{override_exchange}:{symbol}"

    exchange = ""
    for candidate in exchange_candidates:
        exchange = _normalize_exchange(candidate)
        if exchange:
            break

    if not exchange:
        exchange = "AMEX" if _looks_like_etf_or_fund(subject, payload, items) else "NASDAQ"

    return symbol, f"{exchange}:{symbol}"


def _get_cached_symbol_resolution(cache_key: str) -> tuple[str, str] | None:
    cached = _finance_cache.get(cache_key)
    now = time.time()
    if cached and now - cached["timestamp"] < SYMBOL_RESOLUTION_CACHE_TTL:
        return cached["value"]
    return None


def _set_cached_symbol_resolution(cache_key: str, value: tuple[str, str]):
    _finance_cache[cache_key] = {
        "value": value,
        "timestamp": time.time(),
    }


def _resolve_chart_symbol_with_llm(vera, subject: str, payload: dict, items: list[dict]) -> tuple[str, str]:
    cache_key = f"symbol-resolution:v2:{subject.lower()}"
    cached = _get_cached_symbol_resolution(cache_key)
    if cached is not None:
        return cached

    deterministic = _extract_chart_symbol(subject, payload, items)
    if deterministic != ("", ""):
        _set_cached_symbol_resolution(cache_key, deterministic)
        return deterministic

    context = _build_symbol_resolution_context(subject, payload, items)
    resolved = vera.resolve_finance_symbol(user_text=subject, search_context=context)

    symbol = _normalize_symbol(resolved.get("symbol"))
    exchange = _normalize_exchange(resolved.get("exchange"))
    asset_type = str(resolved.get("asset_type") or "unknown").lower()
    confidence = float(resolved.get("confidence") or 0.0)
    is_valid = bool(resolved.get("is_valid"))

    if symbol and is_valid and confidence >= SYMBOL_RESOLUTION_CONFIDENCE_THRESHOLD and not _is_blocked_finance_symbol(symbol):
        override_exchange = SYMBOL_EXCHANGE_OVERRIDES.get(symbol)
        if override_exchange:
            exchange = override_exchange
        if not exchange:
            exchange = "AMEX" if asset_type in {"etf", "fund"} or _looks_like_etf_or_fund(subject, payload, items) else "NASDAQ"
        value = (symbol, f"{exchange}:{symbol}")
        _set_cached_symbol_resolution(cache_key, value)
        return value

    fallback_symbol = _normalize_symbol(subject) if _is_direct_ticker_like_subject(subject) else ""
    if fallback_symbol:
        fallback_exchange = SYMBOL_EXCHANGE_OVERRIDES.get(fallback_symbol) or (
            "AMEX" if _looks_like_etf_or_fund(subject, payload, items) else "NASDAQ"
        )
        value = (fallback_symbol, f"{fallback_exchange}:{fallback_symbol}")
        _set_cached_symbol_resolution(cache_key, value)
        return value

    value = ("", "")
    _set_cached_symbol_resolution(cache_key, value)
    return value


def _build_tradingview_chart_url(tradingview_symbol: str) -> str:
    if not tradingview_symbol:
        return ""

    params = urlencode({
        "symbol": tradingview_symbol,
        "interval": "D",
    })
    return f"/static/tradingview_chart.html?{params}"


def _fetch_finance_media(subject: str) -> tuple[list[dict], list[dict]]:
    if not subject or not SERPER_API_KEY:
        return [], []

    image_query = f"{subject} stock company"
    video_query = f"{subject} stock analysis"

    try:
        images_payload = _search_media_serper(
            SERPER_IMAGES_ENDPOINT,
            image_query,
            IMAGE_RESULT_LIMIT,
            "images",
        )
        images = _normalize_image_items(images_payload)[:IMAGE_RESULT_LIMIT]
    except Exception as exc:
        print("Finance image fetch error:", exc)
        images = []

    try:
        videos_payload = _search_media_serper(
            SERPER_VIDEOS_ENDPOINT,
            video_query,
            VIDEO_RESULT_LIMIT,
            "videos",
        )
        videos = _normalize_video_items(videos_payload)[:VIDEO_RESULT_LIMIT]
    except Exception as exc:
        print("Finance video fetch error:", exc)
        videos = []

    return images, videos


def _log_finance_panel_payload(
    *,
    user_text: str = "",
    extracted_ticker: str = "",
    resolved_ticker: str = "",
    panel_symbol: str = "",
    tradingview_symbol: str = "",
    asset_type: str = "",
    source: str = "",
) -> None:
    try:
        import json as _json

        print(
            "[finance_panel_payload] "
            + _json.dumps(
                {
                    "user_text": (user_text or "")[:200],
                    "extractedTicker": (extracted_ticker or "")[:32],
                    "resolvedTicker": (resolved_ticker or "")[:32],
                    "panelSymbol": (panel_symbol or "")[:32],
                    "tradingviewSymbol": (tradingview_symbol or "")[:48],
                    "assetType": (asset_type or "")[:32],
                    "source": (source or "")[:64],
                }
            )
        )
    except Exception:
        pass


def prepare_finance_quote_streaming(vera, query: str):
    """
    Serper + symbol resolution + messages for async_generate_stream (no main LLM).
    Returns (messages, ui_payload, finalize_fn) or None on failure.
    Caller must ensure subject is non-empty.
    """
    subject = _normalize_finance_subject(query)
    if not subject:
        return None
    generic_subject = _is_generic_finance_subject(subject)
    extracted_ticker = _extract_ticker_from_finance_query(query) or (
        subject if _is_direct_ticker_like_subject(subject) else ""
    )
    try:
        payload = _search_serper(f"{subject} stock price")
        items = _rank_finance_items(_normalize_serper_items(payload), subject)
        prompt = _build_quote_prompt(subject, payload, items)
        messages = vera.build_messages([], FINANCE_QUOTE_PREAMBLE + prompt)
        symbol, tradingview_symbol = _resolve_chart_symbol_with_llm(vera, subject, payload, items)
        if _is_blocked_finance_symbol(symbol):
            symbol = ""
        if generic_subject and not extracted_ticker:
            symbol = ""
            tradingview_symbol = ""
        panel_symbol = symbol or extracted_ticker or (
            _normalize_symbol(subject) if _is_direct_ticker_like_subject(subject) else ""
        )
        if panel_symbol and (
            not tradingview_symbol
            or tradingview_symbol.split(":")[-1] != panel_symbol
        ):
            override_exchange = SYMBOL_EXCHANGE_OVERRIDES.get(panel_symbol)
            if override_exchange:
                tradingview_symbol = f"{override_exchange}:{panel_symbol}"
            else:
                exchange = "AMEX" if _looks_like_etf_or_fund(subject, payload, items) else "NASDAQ"
                tradingview_symbol = f"{exchange}:{panel_symbol}"
        quote_title_entity = panel_symbol or subject or ""
        if not quote_title_entity:
            quote_title_entity = "Stock"
        quote_title = f"{quote_title_entity} — Quote"
        ui_payload = {
            "panel_type": "finance_chart",
            "title": quote_title,
            "entity": quote_title_entity,
            "query": subject,
            "symbol": panel_symbol,
            "tradingview_symbol": tradingview_symbol,
            "chart_url": _build_tradingview_chart_url(tradingview_symbol),
            "source_url": items[0]["url"] if items else "",
        }
        _log_finance_panel_payload(
            user_text=query,
            extracted_ticker=extracted_ticker,
            resolved_ticker=symbol,
            panel_symbol=panel_symbol,
            tradingview_symbol=tradingview_symbol,
            asset_type="etf" if panel_symbol in {"VGT", "VOO", "SPY", "IVV", "SMH"} else "equity",
            source="prepare_finance_quote_streaming",
        )
        try:
            _log_panel_routing(
                selected_route="finance_quote_tool",
                selected_tool="finance_quote",
                selected_panel_type="finance_chart",
                query=subject,
                entity_extracted=quote_title_entity,
                finance_symbol_extracted=symbol,
                cards_count=len(items),
                panel_payload_sent=True,
            )
        except Exception:
            pass

        def finalize(response: str):
            return {
                "spoken_reply": response,
                "action_type": "finance",
                "data": {
                    "mode": "quote",
                    "query": subject,
                    "symbol": panel_symbol,
                    "tradingview_symbol": tradingview_symbol,
                    "results": items,
                },
                "ui_payload": ui_payload,
            }

        return messages, ui_payload, finalize
    except Exception as exc:
        print("Finance quote error:", exc)
        return None


def handle_finance_quote_request(vera, query: str):
    subject = _normalize_finance_subject(query)
    if not subject:
        return {
            "spoken_reply": "I couldn't tell which ticker or asset you meant.",
            "action_type": "finance",
            "data": None,
            "ui_payload": None,
        }

    prepared = prepare_finance_quote_streaming(vera, query)
    if prepared is None:
        try:
            from safety_limits import FallbackMessages as _SF, log_safety_block as _sl
            _sl(reason="finance_api_failure", mode="non_work", feature="finance",
                extra={"subject": subject[:120], "mode_request": "quote"})
            spoken_reply = _SF.FINANCE_FAILURE
        except Exception:
            spoken_reply = "Finance information is not available right now."
        return {
            "spoken_reply": spoken_reply,
            "action_type": "finance",
            "data": None,
            "ui_payload": None,
            "service_failure": "finance",
        }
    messages, _ui, finalize = prepared
    response, _ = vera.generate(messages)
    return finalize(response)


def prepare_finance_context_streaming(vera, query: str):
    """Returns (messages, ui_payload, finalize_fn) or None on failure."""
    subject = _normalize_finance_subject(query)
    if not subject:
        return None
    try:
        payload = _search_serper(f"{subject} stock news")
        items = _rank_finance_items(_normalize_serper_items(payload), subject)
        prompt = _build_context_prompt(subject, items)
        messages = vera.build_messages([], FINANCE_CONTEXT_PREAMBLE + prompt)
        images, videos = _fetch_finance_media(subject)
        ui_payload = _finance_context_panel_payload("Finance Context", subject, items, images, videos)

        def finalize(response: str):
            return {
                "spoken_reply": response,
                "action_type": "finance",
                "data": {
                    "mode": "context",
                    "query": subject,
                    "results": items,
                },
                "ui_payload": ui_payload,
            }

        return messages, ui_payload, finalize
    except Exception as exc:
        print("Finance context error:", exc)
        return None


def handle_finance_context_request(vera, query: str):
    subject = _normalize_finance_subject(query)
    if not subject:
        return {
            "spoken_reply": "I couldn't tell which asset or company you meant.",
            "action_type": "finance",
            "data": None,
            "ui_payload": None,
        }

    prepared = prepare_finance_context_streaming(vera, query)
    if prepared is None:
        try:
            from safety_limits import FallbackMessages as _SF, log_safety_block as _sl
            _sl(reason="finance_api_failure", mode="non_work", feature="finance",
                extra={"subject": subject[:120], "mode_request": "context"})
            spoken_reply = _SF.FINANCE_FAILURE
        except Exception:
            spoken_reply = "Finance information is not available right now."
        return {
            "spoken_reply": spoken_reply,
            "action_type": "finance",
            "data": None,
            "ui_payload": None,
            "service_failure": "finance",
        }
    messages, _ui, finalize = prepared
    response, _ = vera.generate(messages)
    return finalize(response)


# ============================================================================
# Analytics (historical / quantitative finance) — temporary LLM-only handler.
# ============================================================================

# Keywords that classify a request as historical/quantitative finance analytics
# rather than a current quote or stock-news context. Kept lowercase, used as a
# substring match by `is_finance_analytics_query` (no anchored regex required
# because callers already split metric phrases out of the full sentence).
_FINANCE_ANALYTICS_METRIC_TERMS = (
    "max drawdown",
    "maximum drawdown",
    "biggest drawdown",
    "worst drawdown",
    "largest drawdown",
    "deepest drawdown",
    "drawdown",
    "historical return",
    "historical returns",
    "annualized return",
    "annualised return",
    "cagr",
    "compound annual growth rate",
    "rolling return",
    "trailing return",
    "5-year performance",
    "5 year performance",
    "five-year performance",
    "five year performance",
    "10-year performance",
    "10 year performance",
    "10-year return",
    "year-over-year return",
    "ytd return",
    "year to date return",
    "volatility",
    "standard deviation of returns",
    "sharpe",
    "sharpe ratio",
    "sortino",
    "sortino ratio",
    "treynor ratio",
    "information ratio",
    "beta",
    "alpha",
    "r squared",
    "r-squared",
    "compare performance",
    "performance over time",
    "worst drop",
    "worst year",
    "best year",
    "worst quarter",
    "best quarter",
    "max loss",
    "maximum loss",
)


def is_finance_analytics_query(text: str) -> bool:
    """True if the text asks for historical/quantitative finance metrics.

    We deliberately stay loose here (substring matching). The router already
    filters out obvious non-finance utterances before we ever look at this.
    """
    raw = (text or "").lower()
    if not raw:
        return False
    for term in _FINANCE_ANALYTICS_METRIC_TERMS:
        if term in raw:
            return True
    # "past N years" / "over the past N years" + finance verb is also analytics.
    if re.search(
        r"\b(?:past|last|over the past|over the last|trailing)\s+\d+\s+(?:year|years|yr|yrs|month|months)\b",
        raw,
    ) and re.search(r"\b(?:return|returns|performance|drawdown|volatility)\b", raw):
        return True
    # "N year(s) return", "5-year return", "10 year performance" without a
    # leading "past/last" — the duration + a historical metric word is enough.
    if re.search(
        r"\b\d{1,2}\s*[- ]?\s*(?:year|years|yr|yrs|month|months)\s+(?:return|returns|performance|cagr|drawdown|volatility|gain|loss|history)\b",
        raw,
    ):
        return True
    return False


def _build_analytics_prompt(
    subject: str,
    items: list[dict] | None,
    *,
    user_question: str = "",
) -> str:
    """Frame the snippets as the source of record and put the user's question
    first so the model answers it instead of echoing it.

    Important: we do NOT add a `User question (verbatim): ...` field here. That
    used to make the model literally print the user's question back at the top
    of the reply before answering it (see bug report 2026-05-28). Instead, the
    question is inlined as a single short instruction line so the model treats
    it as input, not as a quotation it should reproduce."""
    lines: list[str] = []
    if user_question:
        lines.append(
            f"Answer this finance question using the search snippets below: "
            f"{user_question}"
        )
    lines.append(f"Asset: {subject}")

    items = items or []
    if items:
        lines.append(
            "Search snippets (the beta source of record — use these to answer; "
            "do not refuse just because they are snippets):"
        )
        # 2026-05-28 — analytics answers benefit from a richer snippet window
        # than the 3-line quote/context prompts. Cap at 5 so the prompt stays
        # voice-latency friendly while still giving the model multiple sources
        # to triangulate a range from.
        for i, item in enumerate(items[:5], 1):
            lines.append(
                f"{i}. {item.get('title', '')}\n"
                f"Source: {item.get('source', '')}\n"
                f"Snippet: {item.get('summary', '')}"
            )
    else:
        lines.append(
            "Search snippets: none returned. Give the rough source-reported direction "
            "or range you can infer from general knowledge, then add the "
            "\"limited source-reported data\" caveat. Do NOT refuse."
        )
    return "\n\n".join(lines)


_FINANCE_ANALYTICS_TICKER_ALIAS_NAMES = {
    "VGT": "Vanguard Information Technology ETF VGT",
    "QQQ": "Invesco QQQ Trust",
    "SPY": "SPDR S&P 500 ETF SPY",
    "VOO": "Vanguard S&P 500 ETF VOO",
    "IVV": "iShares Core S&P 500 ETF IVV",
    "SMH": "VanEck Semiconductor ETF SMH",
    "NVDA": "Nvidia stock NVDA",
    "AAPL": "Apple Inc AAPL",
    "MSFT": "Microsoft Corp MSFT",
    "AMZN": "Amazon AMZN",
    "GOOGL": "Alphabet GOOGL",
    "META": "Meta Platforms META",
    "TSLA": "Tesla TSLA",
}


def _finance_analytics_extract_tickers(text: str) -> list[str]:
    """Find every plausible ticker symbol in the text in order, deduped."""
    raw = (text or "").strip()
    if not raw:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for m in re.finditer(r"\b[A-Z]{2,5}\b", raw):
        tok = m.group(0)
        if tok in {"WHAT", "DID", "WAS", "IS", "ARE", "WHY", "WHO", "HOW", "ETF"}:
            continue
        if tok in seen:
            continue
        seen.add(tok)
        out.append(tok)
    return out


def _finance_analytics_timeframe(text: str) -> str:
    """Return a short timeframe phrase like '5 years', '10 years', 'today',
    '52 week', or '' when unspecified."""
    low = (text or "").lower()
    if not low:
        return ""
    m = re.search(
        r"\b(?:past|last|over\s+the\s+past|over\s+the\s+last|trailing)\s+(\d+)\s+"
        r"(year|years|month|months|week|weeks)\b",
        low,
    )
    if m:
        return f"{m.group(1)} {m.group(2)}"
    m = re.search(r"\b(\d+)\s*[- ]?(year|years|month|months|week|weeks)\b", low)
    if m:
        return f"{m.group(1)} {m.group(2)}"
    if re.search(r"\b52[-\s]?week\b", low):
        return "52 week"
    if re.search(r"\b(?:today|right now|currently)\b", low):
        return "today"
    if re.search(r"\bytd\b|\byear[-\s]to[-\s]date\b", low):
        return "ytd"
    if re.search(r"\ball[-\s]?time\b", low):
        return "all time"
    return ""


def _finance_analytics_search_queries(subject: str, raw_user_text: str | None = None) -> list[str]:
    """Build the ranked Serper search-query list for finance.analytics.

    Per the 2026-05-28 spec, drawdown questions for VGT should generate:
      - "VGT maximum drawdown past 5 years"
      - "Vanguard Information Technology ETF VGT max drawdown 5 years"
      - "VGT historical drawdown 5 year"
      - "VGT drawdown chart 5 years"
    Comparison and "why did <stock> drop today" prompts get analogous
    paraphrases so the model has multiple source angles to triangulate from.
    """
    user_question = (raw_user_text or "").strip()
    subject_clean = _normalize_finance_subject(subject) or (subject or "").strip()
    low = user_question.lower()
    queries: list[str] = []

    tickers = _finance_analytics_extract_tickers(user_question or subject_clean)
    primary_ticker = tickers[0] if tickers else ""
    if not primary_ticker and subject_clean:
        alias_symbol, _alias_exchange = _subject_alias_resolution(subject_clean)
        primary_ticker = alias_symbol or primary_ticker
    secondary_ticker = tickers[1] if len(tickers) > 1 else ""

    timeframe = _finance_analytics_timeframe(low) or "5 years"
    primary_full_name = _FINANCE_ANALYTICS_TICKER_ALIAS_NAMES.get(primary_ticker, "")
    secondary_full_name = _FINANCE_ANALYTICS_TICKER_ALIAS_NAMES.get(secondary_ticker, "")

    is_drawdown = bool(
        re.search(r"\bdrawdown\b|\bworst\s+drop\b|\bmax(?:imum)?\s+loss\b", low)
    )
    is_52_week = bool(re.search(r"\b52[-\s]?week\b", low))
    is_compare = bool(
        re.search(r"\bcompare\b|\bvs\.?\b|\bversus\b", low)
        or (
            secondary_ticker
            and re.search(r"\b(?:and|vs|versus|to)\b", low)
        )
    )
    is_drop_today = bool(
        re.search(
            r"\b(?:why|what)\b.*\b(?:drop|fall|tank|sink|surge|spike|rally|jump|down|up)\b",
            low,
        )
    )

    if is_drawdown and primary_ticker:
        queries.append(f"{primary_ticker} maximum drawdown past {timeframe}")
        if primary_full_name:
            queries.append(f"{primary_full_name} max drawdown {timeframe}")
        else:
            queries.append(f"{primary_ticker} max drawdown {timeframe}")
        queries.append(f"{primary_ticker} historical drawdown {timeframe.split()[0]} year")
        queries.append(f"{primary_ticker} drawdown chart {timeframe}")

    if is_52_week and primary_ticker:
        queries.append(f"{primary_ticker} 52 week high low")
        if primary_full_name:
            queries.append(f"{primary_full_name} 52 week range")

    if is_compare and primary_ticker and secondary_ticker:
        queries.append(
            f"compare {primary_ticker} and {secondary_ticker} performance last {timeframe}"
        )
        queries.append(
            f"{primary_ticker} vs {secondary_ticker} total return {timeframe}"
        )
        queries.append(
            f"{primary_ticker} {secondary_ticker} {timeframe} return comparison"
        )

    if is_drop_today and primary_ticker:
        # Don't include "today" twice if it's already part of timeframe.
        queries.append(f"why is {primary_ticker} down today")
        queries.append(f"{primary_ticker} stock news today")
        if primary_full_name:
            queries.append(f"{primary_full_name} news today")

    if primary_ticker and re.search(
        r"\b(?:return|performance|volatility|cagr|sharpe|sortino|beta|alpha)\b",
        low,
    ):
        queries.append(f"{primary_ticker} {user_question}")
        queries.append(f"{primary_ticker} {timeframe} performance")

    if user_question:
        queries.append(user_question)
    if (
        subject_clean
        and user_question
        and subject_clean.lower() not in user_question.lower()
    ):
        queries.append(f"{subject_clean} {user_question}")
    if subject_clean:
        queries.append(f"{subject_clean} historical performance")

    seen: set[str] = set()
    out: list[str] = []
    for query in queries:
        q = re.sub(r"\s+", " ", str(query or "")).strip()
        if not q:
            continue
        key = q.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(q)
    # Cap at 8 — the prepare path only actually issues HTTP calls for the
    # first few that return snippets; the rest are kept in the logs so the
    # operator can audit which paraphrases were considered.
    return out[:8]


def _log_panel_routing(
    *,
    selected_route: str,
    selected_tool: str,
    selected_panel_type: str,
    query: str = "",
    entity_extracted: str = "",
    finance_symbol_extracted: str = "",
    location_required: bool = False,
    location_available: bool = False,
    product_query_detected: bool = False,
    cards_count: int = 0,
    panel_payload_sent: bool = True,
    note: str = "",
) -> None:
    """Single grep target for the 2026-05-28 panel-routing decision log.

    Emitted by both finance and web_search actions whenever they choose (or
    intentionally suppress) a side-panel payload. Grep ``[panel_routing]``.
    """
    try:
        import json as _json
        print(
            "[panel_routing] "
            + _json.dumps(
                {
                    "selected_route": selected_route,
                    "selected_tool": selected_tool,
                    "selected_panel_type": selected_panel_type,
                    "query": (query or "")[:200],
                    "entity_extracted": (entity_extracted or "")[:120],
                    "finance_symbol_extracted": (finance_symbol_extracted or "")[:32],
                    "location_required": bool(location_required),
                    "location_available": bool(location_available),
                    "product_query_detected": bool(product_query_detected),
                    "cards_count": int(cards_count),
                    "panel_payload_sent": bool(panel_payload_sent),
                    "note": (note or "")[:160],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        try:
            print("[panel_routing] log_serialization_failed", flush=True)
        except Exception:
            pass


def _log_finance_analytics_route(
    *,
    user_question: str,
    subject: str,
    search_queries: list[str],
    queries_issued: list[str],
    serper_results_count: int,
    serper_error: str = "",
) -> None:
    """Structured log of every finance.analytics dispatch.

    Grep target: ``[finance_analytics_route]``. Emits the spec'd fields the
    operator needs to confirm web-search fallback fired, how many sources we
    got back, and that the model is in source-reported mode rather than the
    old "no daily data" refusal path."""
    try:
        import json as _json
        print(
            "[finance_analytics_route] "
            + _json.dumps(
                {
                    "selected_route": "finance_search_tool",
                    "action": "finance.analytics",
                    "subject": subject[:120],
                    "user_question": user_question[:200],
                    "search_queries": search_queries[:8],
                    "queries_issued": queries_issued[:8],
                    "serper_results_count": int(serper_results_count),
                    "serper_error": serper_error[:160] if serper_error else "",
                    "source_reported_answer": bool(serper_results_count > 0),
                    "exact_computation_performed": False,
                    "refused_due_to_missing_daily_data": False,
                    "caveat_added": True,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        try:
            print("[finance_analytics_route] log_serialization_failed", flush=True)
        except Exception:
            pass


def prepare_finance_analytics_streaming(vera, query: str, *, raw_user_text: str | None = None):
    """Streaming handler for finance.analytics.

    Returns (messages, ui_payload, finalize_fn) or None on failure.
    No chart/news panel is opened — analytics answers stay in the voice bubble
    until a proper historical-data source is wired in.
    """
    subject = _normalize_finance_subject(query) or (query or "").strip()
    if not subject:
        return None
    user_question = (raw_user_text or query or "").strip()

    # Best-effort search to surface reputable historical context. We try the
    # first few paraphrases until we collect enough snippets — earlier code
    # stopped at the first non-empty result, which often returned a single
    # weak hit and made the model fall back to its refusal phrasing.
    items: list[dict] = []
    search_queries = _finance_analytics_search_queries(subject, raw_user_text)
    queries_issued: list[str] = []
    serper_error = ""
    SNIPPET_TARGET = 5
    MAX_QUERIES_TO_ISSUE = 4
    try:
        accumulated: list[dict] = []
        seen_urls: set[str] = set()
        for search_query in search_queries[:MAX_QUERIES_TO_ISSUE]:
            queries_issued.append(search_query)
            try:
                payload = _search_serper(search_query)
            except Exception as exc:
                serper_error = f"{type(exc).__name__}: {exc}"
                print(
                    "Finance analytics search error (continuing with what we have):",
                    exc,
                )
                continue
            for normalized in _normalize_serper_items(payload):
                url = (normalized.get("url") or "").strip().lower()
                if url and url in seen_urls:
                    continue
                if url:
                    seen_urls.add(url)
                accumulated.append(normalized)
            if len(accumulated) >= SNIPPET_TARGET:
                break
        items = _rank_finance_items(accumulated, subject)
    except Exception as exc:
        serper_error = f"{type(exc).__name__}: {exc}"
        print("Finance analytics search error (continuing without snippets):", exc)
        items = []

    _log_finance_analytics_route(
        user_question=user_question,
        subject=subject,
        search_queries=search_queries,
        queries_issued=queries_issued,
        serper_results_count=len(items),
        serper_error=serper_error,
    )

    prompt = _build_analytics_prompt(subject, items, user_question=user_question)
    try:
        messages = vera.build_messages([], FINANCE_ANALYTICS_PREAMBLE + prompt)
    except Exception as exc:
        print("Finance analytics prompt error:", exc)
        return None

    # 2026-05-28 — historical / contextual finance answers should land in the
    # existing search/news-style panel (Articles / Images / Video), NOT the
    # quote chart panel. Re-use the same `media_tabs` shape news + finance
    # context already use; pull supplementary images + videos best-effort.
    try:
        images, videos = _fetch_finance_media(subject)
    except Exception as exc:
        print("Finance analytics media fetch error:", exc)
        images, videos = [], []
    analytics_title_entity = (subject or user_question or "Finance").strip()
    analytics_panel_title = f"{analytics_title_entity} — Search Results"
    ui_payload = _finance_context_panel_payload(
        analytics_panel_title, subject, items, images, videos
    )
    try:
        _log_panel_routing(
            selected_route="finance_search_tool",
            selected_tool="web_search",
            selected_panel_type="media_tabs",
            query=user_question or subject,
            entity_extracted=analytics_title_entity,
            cards_count=len(items),
            panel_payload_sent=True,
            note="finance.analytics → search/news-style panel",
        )
    except Exception:
        pass

    def finalize(response: str):
        return {
            "spoken_reply": response,
            "action_type": "finance",
            "data": {
                "mode": "analytics",
                "query": subject,
                "results": items,
                "search_queries": search_queries,
                "queries_issued": queries_issued,
            },
            "ui_payload": ui_payload,
        }

    return messages, ui_payload, finalize


def handle_finance_analytics_request(vera, query: str, *, raw_user_text: str | None = None):
    subject = _normalize_finance_subject(query) or (query or "").strip()
    if not subject:
        return {
            "spoken_reply": "I couldn't tell which asset or company you meant.",
            "action_type": "finance",
            "data": None,
            "ui_payload": None,
        }
    prepared = prepare_finance_analytics_streaming(vera, query, raw_user_text=raw_user_text)
    if prepared is None:
        try:
            from safety_limits import FallbackMessages as _SF, log_safety_block as _sl
            _sl(reason="finance_api_failure", mode="non_work", feature="finance",
                extra={"subject": subject[:120], "mode_request": "analytics"})
            spoken_reply = _SF.FINANCE_FAILURE
        except Exception:
            spoken_reply = "Finance information is not available right now."
        return {
            "spoken_reply": spoken_reply,
            "action_type": "finance",
            "data": None,
            "ui_payload": None,
            "service_failure": "finance",
        }
    messages, _ui, finalize = prepared
    response, _ = vera.generate(messages)
    return finalize(response)
