import time
import re
import feedparser
import email.utils
from datetime import timezone
from html import unescape

# =========================
# CONFIG
# =========================
BBC_FEED = "https://feeds.bbci.co.uk/news/rss.xml"
CACHE_TTL = 600  # seconds

NEWS_PREAMBLE = (
    "Summarize the following news items clearly and calmly.\n"
    "Start with 'Here are the latest news headlines:' and then describe each story\n"
    "When describing each story, explicitly attribute it using phrasing like "
    "'According to the BBC' or 'BBC reports that'.\n"
    "Use natural spoken language suitable for a briefing.\n\n"
)

# =========================
# Cache
# =========================
_news_cache = {
    "items": None,
    "timestamp": 0
}

# =========================
# Helpers
# =========================
def _clean_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    return unescape(text).strip()

def _parse_date(date_str):
    dt = email.utils.parsedate_to_datetime(date_str)
    return dt.astimezone(timezone.utc)

# =========================
# RSS Fetch
# =========================
def _fetch_rss():
    feed = feedparser.parse(BBC_FEED)

    if feed.bozo or not feed.entries:
        raise RuntimeError("RSS feed unavailable")

    items = []
    for e in feed.entries:
        items.append({
            "title": e.title,
            "summary": _clean_html(e.summary),
            "published": _parse_date(e.published),
            "source": "BBC"
        })

    return items

# =========================
# Public API
# =========================
def get_top_news(limit=5):
    now = time.time()

    if _news_cache["items"] and now - _news_cache["timestamp"] < CACHE_TTL:
        return _news_cache["items"][:limit]

    items = _fetch_rss()
    _news_cache["items"] = items
    _news_cache["timestamp"] = now

    return items[:limit]

def build_news_prompt(items):
    lines = []
    for i, item in enumerate(items, 1):
        lines.append(
            f"{i}. {item['title']}\n"
            f"{item['summary']}"
        )
    return "\n\n".join(lines)

# =========================
# MAIN ACTION (NO MODEL CREATION)
# =========================
def handle_news_request(vera):
    try:
        items = get_top_news(limit=3)
    except Exception as e:
        print("News fetch error:", e)
        return "I’m having trouble fetching the news right now."

    prompt = build_news_prompt(items)

    messages = vera.build_messages(
        chat_history=[],
        user_text=NEWS_PREAMBLE + prompt
    )

    response, _ = vera.generate(messages)
    return response