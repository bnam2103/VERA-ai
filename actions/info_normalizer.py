"""Pre-routing info-query normalizer.

This module adds a tiny normalization layer that runs BEFORE current-fact /
news routing so:

* Product recommendation phrasings ("suggest me some webcam", "recommend
  headphones for studying", "any price is fine") get short-circuited into a
  product/web-search route instead of being promoted into ``news.latest``.
* News follow-ups like "well it was in Garden Grove i think can you give me
  some news on that?" with a stored chemical-leak topic correctly merge the
  prior topic AND the new location into a single normalized search query,
  instead of falling through to a generic LLM follow-up.
* Generic news queries don't double-append the word "news" to themselves
  (Serper's /news search was getting "X latest news news").

The module is INTENTIONALLY pure (no I/O, no Serper, no LLM, no global
mutation). It just converts a raw turn + optional context into a structured
:func:`normalize_info_request` dict, which the existing ``classify_info_tool``
in ``app.py`` consumes near the top of its priority cascade.

Public API
----------
* :func:`normalize_info_request` -- the main entry point.
* :func:`dedupe_news_keywords` -- collapse "news news" / "latest news news"
  duplicates before sending to Serper.
* :func:`log_info_route_trace` -- structured log line for diagnostics.
* :func:`log_product_routed_as_news_warning` etc. -- hard warnings.

Priority order inside :func:`normalize_info_request`:

1. Explicit news request (news on/about X, give me news, updates on, recent
   reports about X) -- this beats product so "news about webcams" does NOT
   become a webcam recommendation.
2. Location/place (coffee shops in Irvine, grocery stores in Fountain
   Valley) -- venue noun + "in <place>".
3. Product / recommendation (suggest me X, recommend X, best X for ..., need
   a webcam, X under $N).
4. News follow-up with stored topic context (refine prior chemical-leak
   topic with a new location).
5. Sports / finance / weather / time are NOT replicated here -- the existing
   ``classify_info_tool`` cascade handles them and we DON'T want to fight
   that cascade. We only intercept the cases that today end up in
   ``news.latest`` or a vague ``general_web_search`` with a messy raw-text
   query.

The caller treats ``intent_type == "unknown"`` as "fall through to the
legacy cascade".
"""

from __future__ import annotations

import json
import re
from time import time
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Shared phrasing primitives
# ---------------------------------------------------------------------------

# Catalog of product/category aliases. Order matters: longer / more specific
# aliases come first so "webcam" beats "cam" and "microphone" beats "mic"
# when both literally appear. Each entry is (alias_regex, canonical_label).
# Canonical labels stay singular so the normalized "best <category> for ..."
# query reads naturally.
_PRODUCT_CATEGORIES: tuple[tuple[str, str], ...] = (
    (r"webcams?", "webcam"),
    (r"microphones?", "microphone"),
    (r"mics?", "microphone"),
    (r"headphones?", "headphones"),
    (r"earbuds?", "earbuds"),
    (r"headsets?", "headset"),
    (r"laptops?", "laptop"),
    (r"notebooks?", "laptop"),
    (r"monitors?", "monitor"),
    (r"keyboards?", "keyboard"),
    (r"(?:gaming\s+)?mice|mouse(?:e?s)?", "mouse"),
    (r"speakers?", "speakers"),
    (r"soundbars?", "soundbar"),
    (r"cameras?", "camera"),
    (r"tablets?", "tablet"),
    (r"smart\s*phones?|phones?", "phone"),
    (r"routers?", "router"),
    (r"printers?", "printer"),
    (r"office\s+chairs?|chairs?", "office chair"),
    (r"standing\s+desks?|desks?", "desk"),
    (r"ssds?|hard\s+drives?", "SSD"),
    (r"gpus?|graphics\s+cards?", "GPU"),
    (r"cpus?|processors?", "CPU"),
    (r"controllers?", "controller"),
    (r"smart\s*watch(?:es)?|watches?", "smartwatch"),
)


# Verbs / leads that signal recommendation/intent. Any of these IN COMBINATION
# WITH a product category in the same utterance counts as product intent.
_PRODUCT_INTENT_LEAD_RE = re.compile(
    r"\b("
    r"suggest(?:s|ing|ed)?|"
    r"recommend(?:s|ing|ed|ation|ations)?|"
    r"best|top|cheap(?:est)?|good|nice|decent|premium|budget|affordable|"
    r"need\s+(?:a|an|some|new)|"
    r"want\s+(?:a|an|some|new|to\s+buy|to\s+get)|"
    r"looking\s+(?:for|to\s+buy|to\s+get)|"
    r"shop(?:ping)?\s+for|"
    r"which\s+(?:webcam|mic|microphone|headphones?|headset|laptop|monitor|"
    r"keyboard|mouse|speakers?|camera|tablet|phone|router|printer|chair|desk|"
    r"gpu|cpu|ssd|controller|smartwatch)|"
    r"what\s+(?:webcam|mic|microphone|headphones?|headset|laptop|monitor|"
    r"keyboard|mouse|speakers?|camera|tablet|phone|router|printer|chair|desk|"
    r"gpu|cpu|ssd|controller|smartwatch)|"
    r"what\s+(?:should\s+i|laptop|phone|monitor|webcam|mic|microphone|"
    r"headphones?|headset|keyboard|mouse|speakers?|camera|tablet|router|"
    r"printer|chair|desk|gpu|cpu|ssd|controller|smartwatch)\s+"
    r"(?:should\s+i\s+(?:buy|get|use)|do\s+i\s+(?:need|want))|"
    r"should\s+i\s+(?:buy|get|use)|"
    r"any\s+price\s+is\s+fine|"
    r"under\s*\$?\s*\d|"
    r"below\s*\$?\s*\d|"
    r"less\s+than\s*\$?\s*\d"
    r")\b",
    re.IGNORECASE,
)


# Explicit budget pattern. Catches "under $100", "below $50", "less than 200".
_PRODUCT_BUDGET_RE = re.compile(
    r"\b(?:under|below|less\s+than|for\s+under|cheaper\s+than|no\s+more\s+than|"
    r"up\s+to|max(?:imum)?|around|about)\s*\$?\s*(\d{2,5}(?:\.\d{1,2})?)",
    re.IGNORECASE,
)


# "any price is fine" / "budget no issue" — explicitly unconstrained.
_PRODUCT_BUDGET_ANY_RE = re.compile(
    r"\bany\s+price\s+is\s+fine\b"
    r"|\bany\s+budget\b"
    r"|\bprice\s+is\s+(?:not|no)\s+(?:a\s+)?(?:concern|issue|problem)\b"
    r"|\bbudget\s+is\s+(?:not|no)\s+(?:a\s+)?(?:concern|issue|problem)\b"
    r"|\bmoney\s+is\s+no\s+object\b",
    re.IGNORECASE,
)


# Use-case patterns mapped to a canonical normalized phrase. Order matters:
# the first match wins so "zoom meeting" beats the bare "meeting".
_PRODUCT_USE_CASE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bzoom\s+(?:meetings?|calls?)\b", re.IGNORECASE), "Zoom meeting"),
    (re.compile(r"\b(?:i\s+have\s+)?(?:a\s+)?zoom\s+meeting\b", re.IGNORECASE), "Zoom meeting"),
    (re.compile(r"\bvideo\s+conferenc(?:e|ing)\b", re.IGNORECASE), "video conferencing"),
    (re.compile(r"\bvideo\s+calls?\b", re.IGNORECASE), "video calls"),
    (re.compile(r"\bteams?\s+meetings?\b", re.IGNORECASE), "Teams meeting"),
    (re.compile(r"\bgoogle\s+meet\b", re.IGNORECASE), "Google Meet"),
    (re.compile(r"\bgaming\b", re.IGNORECASE), "gaming"),
    (re.compile(r"\b(?:live\s+)?streaming\b", re.IGNORECASE), "streaming"),
    (re.compile(r"\bstudy(?:ing)?\b", re.IGNORECASE), "studying"),
    (re.compile(r"\bschool(?:work)?\b", re.IGNORECASE), "school"),
    (re.compile(r"\b(?:university|college|grad\s+school)\b", re.IGNORECASE), "college"),
    (re.compile(r"\bdata\s+science\b", re.IGNORECASE), "data science"),
    (re.compile(r"\bmachine\s+learning\b", re.IGNORECASE), "machine learning"),
    (re.compile(r"\bsoftware\s+(?:dev|development|engineering)\b", re.IGNORECASE), "software development"),
    (re.compile(r"\bprogramming\b", re.IGNORECASE), "programming"),
    (re.compile(r"\bphoto\s+editing\b", re.IGNORECASE), "photo editing"),
    (re.compile(r"\bvideo\s+editing\b", re.IGNORECASE), "video editing"),
    (re.compile(r"\bmusic\s+production\b", re.IGNORECASE), "music production"),
    (re.compile(r"\b(?:podcast(?:ing)?|recording)\b", re.IGNORECASE), "podcasting"),
    (re.compile(r"\bpresentations?\b", re.IGNORECASE), "presentations"),
    (re.compile(r"\bteaching\b", re.IGNORECASE), "teaching"),
    (re.compile(r"\bremote\s+work(?:ing)?\b", re.IGNORECASE), "remote work"),
    (re.compile(r"\bwork\s+from\s+home\b|\bwfh\b", re.IGNORECASE), "work from home"),
    (re.compile(r"\binterviews?\b", re.IGNORECASE), "interviews"),
    (re.compile(r"\btravel(?:ing)?\b", re.IGNORECASE), "travel"),
    (re.compile(r"\boffice\s+(?:work|use)\b", re.IGNORECASE), "office work"),
    (re.compile(r"\bworking\b", re.IGNORECASE), "work"),
)


# Explicit news request shapes (independent of follow-up context). Catches
# "news about X", "news on X", "latest news on", "give me news on/about",
# "any updates on X", "recent reports of X", "report(ed) on X".
_NEWS_EXPLICIT_RE = re.compile(
    r"\b("
    r"(?:give\s+me|show\s+me|share|find|get|fetch|pull\s+up|look\s+up)\s+"
    r"(?:some\s+|the\s+|any\s+)?(?:news|updates?|reports?|headlines?|coverage)"
    r"|news\s+(?:on|about|of|regarding|for|in|from)\s+\w"
    r"|(?:latest|recent|new|breaking)\s+(?:news|updates?|reports?|headlines?|"
    r"developments?|coverage)"
    r"|(?:any\s+)?(?:recent|new)\s+reports?\b"
    r"|what(?:'s|\s+is|\s+are)\s+(?:the\s+)?(?:latest|new)\s+(?:on|about|with|in)\s+\w"
    r"|update\s+me\s+on"
    r"|check\s+(?:the\s+)?news"
    r"|headlines?\s+(?:on|about|from|of|regarding)"
    r"|(?:any\s+)?(?:reports?|updates?|coverage)\s+(?:on|about|of|regarding|in|from)\s+\w"
    r")",
    re.IGNORECASE,
)


# Deictic news follow-up — "news on that", "updates on that", "any news there",
# "check news in <place>", "anything new there", "what about <place>?".
_NEWS_FOLLOWUP_DEICTIC_RE = re.compile(
    r"\b("
    r"(?:news|updates?|reports?|headlines?|coverage)\s+(?:on|about|of|regarding|in|for)\s+"
    r"(?:that|this|it|there|the\s+(?:case|incident|story|issue|event|situation))"
    r"|(?:check|find|get|look\s+up|pull\s+up)\s+(?:the\s+)?news"
    r"|(?:any|anything)\s+(?:new|news|recent|recently)\s+(?:on|about|in|there|here)?"
    r"|what(?:'s|\s+is)\s+(?:the\s+)?(?:latest|new)\s+(?:on|about|with|there|here)"
    r"|how\s+about\s+(?:in\s+)?(?P<follow_place>[a-zA-Z][a-zA-Z\s]{1,40})"
    r"|what\s+about\s+(?:in\s+)?(?P<follow_place2>[a-zA-Z][a-zA-Z\s]{1,40})"
    r"|(?:tell|tell\s+me|update\s+me)\s+(?:more\s+)?(?:about|on)\s+(?:that|this|it|there)"
    r")",
    re.IGNORECASE,
)


# Location/place venue patterns. Mirrors `_INFO_TOOL_VENUE_RE` minimally so
# our priority-1 routing can detect "coffee shops in Irvine" / "grocery
# stores in Fountain Valley" before product/news ever sees the turn.
_LOCATION_VENUE_RE = re.compile(
    r"\b("
    r"coffee\s+shops?|cafes?|cafeterias?|coffee\s+houses?"
    r"|restaurants?|food|places?\s+to\s+eat|where\s+to\s+eat|dinner|lunch|breakfast|brunch"
    r"|bars?|pubs?|breweries?|wineries?"
    r"|grocery\s+stores?|supermarkets?|grocer(?:y|ies)|farmer'?s?\s+markets?"
    r"|pharmacies|drug\s+stores?|cvs|walgreens|rite\s+aid"
    r"|gas\s+stations?|charging\s+stations?"
    r"|gyms?|yoga\s+studios?|pilates\s+studios?|fitness\s+centers?"
    r"|libraries|bookstores?|book\s+shops?"
    r"|parks?|playgrounds?|trails?|hiking|beaches?"
    r"|hospitals?|urgent\s+cares?|clinics?"
    r"|hotels?|motels?|airbnbs?|inns?"
    r"|salons?|barbers?|nail\s+salons?|spas?"
    r"|atms?|banks?|credit\s+unions?"
    r"|movie\s+theat(?:er|re)s?|cinemas?"
    r"|museums?|galleries|aquariums?|zoos?"
    r"|airports?|train\s+stations?|bus\s+stops?|stations?"
    r"|stores?|shops?|malls?|outlets?|markets?"
    r"|venues?|spots?|attractions?|things?\s+to\s+do"
    r")\b",
    re.IGNORECASE,
)
_LOCATION_IN_PLACE_RE = re.compile(
    r"\b(?:in|around|near|by|at)\s+(?:the\s+)?(?P<place>[a-zA-Z][a-zA-Z'\-\.]+(?:\s+[a-zA-Z][a-zA-Z'\-\.]+){0,3})\b",
    re.IGNORECASE,
)
_LOCATION_NEAR_ME_RE = re.compile(
    r"\bnear\s+me\b|\baround\s+me\b|\bnearby\b", re.IGNORECASE
)


# Place-name extraction inside follow-ups. Voice transcripts often say
# "in the garden grove" → we strip leading "the" and capitalize.
_FOLLOWUP_PLACE_RE = re.compile(
    r"\bin\s+(?:the\s+)?(?P<place>[a-zA-Z][a-zA-Z'\-\.]+(?:\s+[a-zA-Z][a-zA-Z'\-\.]+){0,3})",
    re.IGNORECASE,
)


# Stop-words that should never be treated as a place name when we sweep
# "in <X>" from voice transcripts. Many of these can appear after "in" in
# natural English ("in the news", "in case", "in fact"...).
_PLACE_STOPWORDS: frozenset[str] = frozenset(
    {
        "the", "a", "an", "my", "your", "our", "their", "his", "her",
        "case", "fact", "general", "general", "person", "particular",
        "summary", "short", "addition", "the news", "news", "the case",
        "the morning", "the evening", "the afternoon", "the meeting",
        "the meantime", "the future", "the past", "the present", "general",
        "town", "downtown", "midtown", "uptown",
        "here", "there", "town", "city", "country", "world",
        "place", "places", "general", "general",
    }
)


# Topic-noun extractor for stored ctx like "chemical leaks in Orange County".
# We split on " in " / " around " / " near " and keep the LEFT side as the
# topic phrase.
_CTX_TOPIC_SPLIT_RE = re.compile(
    r"\s+(?:in|around|near|at|throughout|across)\s+", re.IGNORECASE
)


# News-keyword dedupe regex.
_NEWS_KEYWORD_TRAILING_RE = re.compile(
    r"\s+(?:news|latest\s+news|breaking\s+news|news\s+update|news\s+report|"
    r"recent\s+news|new\s+report|news\s+headlines?)$",
    re.IGNORECASE,
)
_NEWS_KEYWORD_PRESENT_RE = re.compile(
    r"\b(?:news|latest|update|updates|breaking|headline|headlines|"
    r"report|reported|reports|coverage)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _clean_phrase(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip(" \t\r\n.,;:!?'\"")).strip()


def _title_place(place: str) -> str:
    """Capitalize each word of a place phrase. Strips leading determiners
    ("the", "a", "an") because voice transcripts often include them ("in the
    garden grove"). Falls back to the input if cleaning leaves nothing.
    """
    if not place:
        return ""
    cleaned = _clean_phrase(place)
    parts = [p for p in cleaned.split() if p]
    if parts and parts[0].lower() in {"the", "a", "an"}:
        parts = parts[1:]
    if not parts:
        return ""
    return " ".join(p.capitalize() for p in parts)


def _detect_product_category(text: str) -> Optional[tuple[str, str]]:
    """Return ``(matched_alias, canonical_label)`` for the first product
    category we recognize in ``text``. Returns ``None`` if no category match.
    """
    if not text:
        return None
    low = text.lower()
    for alias_pat, canonical in _PRODUCT_CATEGORIES:
        m = re.search(rf"\b(?:{alias_pat})\b", low)
        if m:
            return (m.group(0), canonical)
    return None


def _detect_product_use_case(text: str) -> str:
    """Return a canonical use-case phrase or '' if none detected."""
    if not text:
        return ""
    for pat, canonical in _PRODUCT_USE_CASE_PATTERNS:
        m = pat.search(text)
        if m:
            if canonical:
                return canonical
            # No canonical override -> return the literal match in lower-case
            # so it slots cleanly into "best X for <use case>".
            return _clean_phrase(m.group(0)).lower()
    return ""


def _detect_product_budget(text: str) -> str:
    """Return a budget label like "$100" or '' if none."""
    if not text:
        return ""
    if _PRODUCT_BUDGET_ANY_RE.search(text):
        return ""  # explicit "any price" => no budget filter
    m = _PRODUCT_BUDGET_RE.search(text)
    if m:
        amount = m.group(1)
        # Pad with $ if not already present and amount is plain digits.
        return f"${amount}"
    return ""


def _is_product_intent(text: str) -> bool:
    """A turn counts as product intent when a recommendation/intent lead AND
    a known product category both appear. "best webcam for Zoom" matches.
    "news about webcams" does NOT match because "news" is treated upstream.
    """
    if not text:
        return False
    if not _PRODUCT_INTENT_LEAD_RE.search(text):
        return False
    cat = _detect_product_category(text)
    return cat is not None


def _build_product_normalized_query(
    category: str, budget: str, use_case: str
) -> str:
    """Compose a clean "best <category> for <use_case> under <$N>" query."""
    parts: list[str] = ["best", category]
    if use_case:
        parts.extend(["for", use_case])
    if budget:
        parts.extend(["under", budget])
    return " ".join(parts).strip()


def _extract_topic_core(ctx_topic: str) -> str:
    """From a stored topic like "chemical leaks in Orange County" return
    just "chemical leak" (lowercased, singular-ish trim). Falls back to the
    full topic if no "in <place>" pivot exists.
    """
    raw = _clean_phrase(ctx_topic or "")
    if not raw:
        return ""
    head = _CTX_TOPIC_SPLIT_RE.split(raw, maxsplit=1)[0]
    head = _clean_phrase(head).lower()
    # Strip leading interrogatives ("do you know the chemical leaks" -> "the
    # chemical leaks") that sometimes leak into ctx.topic when the topic
    # phrase wasn't sanitized at save time.
    head = re.sub(
        r"^(?:do\s+you\s+know|did\s+you\s+know|have\s+you\s+heard|"
        r"have\s+you\s+seen|can\s+you\s+tell\s+me\s+about|"
        r"tell\s+me\s+about|what(?:'s|\s+is)|what\s+do\s+you\s+know\s+about)\s+",
        "",
        head,
    )
    head = re.sub(r"^(?:the|a|an)\s+", "", head)
    # Light singularization: "leaks" -> "leak", "fires" -> "fire". We only
    # trim the trailing "s" when the prior word is a single word and ends
    # in a non-"s" consonant + "s" (avoids "news" -> "new").
    if head and head.endswith("s") and not head.endswith(("ss", "us", "is", "ews")):
        candidate = head[:-1]
        if len(candidate) >= 3:
            head = candidate
    return head


def _extract_topic_location(ctx_topic: str, ctx_entities: list[str]) -> str:
    """Return the previously-mentioned location, preferring the explicit
    "in <Place>" segment in ``ctx_topic`` and falling back to the first
    geographic-looking entity in ``ctx_entities``."""
    if ctx_topic:
        split = _CTX_TOPIC_SPLIT_RE.split(ctx_topic, maxsplit=1)
        if len(split) == 2:
            tail = _clean_phrase(split[1])
            if tail:
                return _title_place(tail)
    for ent in ctx_entities or []:
        ent_s = _clean_phrase(str(ent))
        if ent_s and ent_s[0].isupper():
            return ent_s
    return ""


_FOLLOWUP_WHAT_ABOUT_RE = re.compile(
    r"\b(?:what|how)\s+about\s+(?:in\s+)?(?P<place>[a-zA-Z][a-zA-Z'\-\.]+(?:\s+[a-zA-Z][a-zA-Z'\-\.]+){0,3})",
    re.IGNORECASE,
)


_NON_PLACE_TOKENS: frozenset[str] = frozenset(
    {
        # subject pronouns + auxiliaries
        "i", "you", "we", "they", "he", "she", "it", "us", "them",
        "me", "my", "your", "our", "their", "his", "her",
        # auxiliaries / common verbs that follow "in <place>"
        "can", "could", "would", "should", "may", "might", "will",
        "do", "did", "does", "is", "are", "was", "were", "be", "been",
        "being", "have", "has", "had",
        "give", "tell", "show", "find", "get", "check", "search",
        "lookup", "fetch", "share", "send",
        # connectors / fillers
        "and", "but", "or", "so", "because", "since", "though",
        "please", "thanks", "ok", "okay", "well", "now", "then",
        "any", "some", "more", "less", "few", "many", "much",
        # prepositions that signal end of place phrase
        "on", "at", "by", "for", "to", "with", "from", "of",
        "about", "regarding", "around", "near",
        # interrogatives
        "what", "where", "when", "how", "why", "who", "which",
        # filler words
        "the", "a", "an",
        # question words and stoppers
        "right", "really", "sure", "exactly",
    }
)


def _trim_to_place_tokens(raw_place: str) -> str:
    """Walk the captured place phrase left->right and stop at the first
    token that obviously isn't part of a place name. Voice transcripts give
    us things like "garden grove can you" -- we keep "garden grove" only.
    """
    if not raw_place:
        return ""
    kept: list[str] = []
    for tok in raw_place.split():
        low = tok.lower().strip(".,;:!?'\"")
        if not low:
            continue
        if low in _NON_PLACE_TOKENS and not kept:
            # Leading non-place token (e.g. "the") -> skip but keep walking.
            continue
        if low in _NON_PLACE_TOKENS:
            break
        kept.append(tok)
    return " ".join(kept).strip()


def _candidate_place_is_valid(raw: str) -> bool:
    """Return True if a captured place phrase looks like a real place."""
    if not raw:
        return False
    low = raw.lower()
    if low in _PLACE_STOPWORDS:
        return False
    head = low.split()[0]
    if head in {"news", "case", "fact", "general", "meantime", "morning"}:
        return False
    return True


def _strip_followup_filler_for_place(text: str) -> str:
    """Strip ONLY the cheap filler phrases that come BETWEEN a "in <place>"
    fragment and the rest of the request, so the place regex doesn't latch
    onto trailing words.

    Important: we must NOT strip "can you" because the user often says
    "can you check news in Garden Grove?" -- the place comes AFTER "can you".
    """
    if not text:
        return ""
    cleaned = text
    # Drop "i think" / "i guess" / "you know" interjections.
    cleaned = re.sub(
        r"\b(?:i\s+think|i\s+guess|i\s+believe|you\s+know|like|maybe|"
        r"please|thanks?(?:\s+you)?)\b",
        " ",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def _extract_new_location_candidate(text: str) -> str:
    """Pull a NEW location out of the follow-up text. Voice transcripts say
    "well it was in the garden grove i think" -> we want "Garden Grove".
    Also handles "what about Garden Grove?" / "how about Garden Grove?"
    where there's no "in" preposition.

    Returns '' if no obvious location is present.
    """
    if not text:
        return ""
    cleaned = _strip_followup_filler_for_place(text)

    # Prefer "in <place>" since it's the strongest signal.
    m = _FOLLOWUP_PLACE_RE.search(cleaned)
    if m:
        raw = _trim_to_place_tokens(_clean_phrase(m.group("place")))
        if _candidate_place_is_valid(raw):
            return _title_place(raw)

    # Fall back to "what about <place>" / "how about <place>".
    m2 = _FOLLOWUP_WHAT_ABOUT_RE.search(cleaned)
    if m2:
        raw = _trim_to_place_tokens(_clean_phrase(m2.group("place")))
        if _candidate_place_is_valid(raw):
            return _title_place(raw)

    return ""


def _looks_like_news_followup(text: str) -> bool:
    """True when ``text`` reads like a news follow-up turn (deictic news
    request OR explicit news request that lacks a strong fresh entity)."""
    if not text:
        return False
    return bool(_NEWS_FOLLOWUP_DEICTIC_RE.search(text)) or bool(
        _NEWS_EXPLICIT_RE.search(text)
    )


def _is_explicit_news_request(text: str) -> bool:
    return bool(_NEWS_EXPLICIT_RE.search(text or ""))


def _is_location_query(text: str) -> bool:
    """Venue-noun + optional "in <place>" / "near me", or bare venue recommend."""
    if not text:
        return False
    if not _LOCATION_VENUE_RE.search(text):
        return False
    if _LOCATION_IN_PLACE_RE.search(text) or _LOCATION_NEAR_ME_RE.search(text):
        return True
    # "Can you recommend an Asian restaurant?" — venue intent without area yet.
    if re.search(
        r"\b(?:recommend(?:s|ing|ed|ation|ations)?|suggest(?:s|ing|ed)?|"
        r"best|top|good|nice|any)\b",
        text,
        re.IGNORECASE,
    ):
        return True
    return False


def _extract_location_query_place(text: str) -> str:
    if _LOCATION_NEAR_ME_RE.search(text or ""):
        return ""
    m = _LOCATION_IN_PLACE_RE.search(text or "")
    if not m:
        return ""
    raw = _trim_to_place_tokens(_clean_phrase(m.group("place")))
    if not raw or raw.lower() in _PLACE_STOPWORDS:
        return ""
    return _title_place(raw)


# ---------------------------------------------------------------------------
# Public: dedupe_news_keywords
# ---------------------------------------------------------------------------


def dedupe_news_keywords(query: str) -> str:
    """Collapse trailing news/duplicate keywords.

    Examples
    --------
    >>> dedupe_news_keywords("Garden Grove chemical leak news")
    'Garden Grove chemical leak news'
    >>> dedupe_news_keywords("Garden Grove chemical leak news news")
    'Garden Grove chemical leak news'
    >>> dedupe_news_keywords("OpenAI latest news news")
    'OpenAI latest news'
    >>> dedupe_news_keywords("OpenAI")
    'OpenAI'
    """
    if not query:
        return ""
    q = _clean_phrase(query)
    # Repeatedly strip trailing "news" / "latest news" tokens when they
    # appear more than once (handles "X news news" and "X latest news news").
    while True:
        trimmed = _NEWS_KEYWORD_TRAILING_RE.sub("", q).strip()
        if trimmed == q or not trimmed:
            break
        if _NEWS_KEYWORD_PRESENT_RE.search(trimmed):
            q = trimmed
        else:
            break
    # Final collapse of duplicated adjacent "news" tokens.
    q = re.sub(r"\b(news)(\s+\1\b)+", r"\1", q, flags=re.IGNORECASE)
    return q.strip()


def should_append_news_keyword(query: str) -> bool:
    """Return True if the query does NOT already mention any news-shaped
    keyword. Callers append "news" to the Serper query only when this is
    True, which prevents "X latest news news"."""
    if not query:
        return True
    return not _NEWS_KEYWORD_PRESENT_RE.search(query)


# ---------------------------------------------------------------------------
# Public: normalize_info_request
# ---------------------------------------------------------------------------


def _default_payload(text: str) -> dict:
    return {
        "intent_type": "unknown",
        "normalized_query": _clean_phrase(text),
        "topic": None,
        "location": None,
        "entity": None,
        "product_category": None,
        "product_budget": None,
        "product_use_case": None,
        "confidence": 0.0,
        "context_used": False,
        "reason": "no_normalization_match",
    }


def normalize_info_request(
    text: str,
    recent_news_context: dict | None = None,
    *,
    location_available: bool = False,
) -> dict:
    """Pre-news info-query normalization.

    Returns a dict with the schema described in the module docstring. The
    caller (``classify_info_tool`` in ``app.py``) inspects ``intent_type``
    and short-circuits to the corresponding route when it isn't ``"unknown"``.

    Priority order:

        1. Explicit news request    -> ``"news"``
        2. Location/venue query     -> ``"location"``
        3. Product / recommendation -> ``"product"``
        4. News follow-up with ctx  -> ``"news"`` (merged)
    """
    payload = _default_payload(text)
    raw = (text or "").strip()
    if not raw:
        payload["reason"] = "empty_text"
        return payload

    # --------- 1) Explicit news request ---------------------------------
    explicit_news = _is_explicit_news_request(raw)
    # We DON'T return immediately on explicit_news yet; we need to give the
    # ctx-merge branch a chance to enrich the query when the user says
    # "give me some news on that" with stored chemical-leak ctx. But we
    # tentatively set intent_type so location/product can override only when
    # they're truly stronger (location wins for "news in Garden Grove" only
    # if no prior ctx topic exists -- see below).

    # --------- 2) Location/venue query ----------------------------------
    if _is_location_query(raw):
        place = _extract_location_query_place(raw)
        payload.update(
            intent_type="location",
            normalized_query=raw if not place else f"{_extract_venue_phrase(raw)} in {place}",
            location=place or None,
            confidence=0.9,
            reason="location_venue_query",
        )
        return payload

    # --------- 3) Product / recommendation ------------------------------
    if _is_product_intent(raw):
        cat_match = _detect_product_category(raw)
        if cat_match is not None:
            _alias, canonical = cat_match
            use_case = _detect_product_use_case(raw)
            budget = _detect_product_budget(raw)
            normalized = _build_product_normalized_query(canonical, budget, use_case)
            ambiguity_signals: list[str] = []
            if re.search(r"\bnews\b", raw, re.IGNORECASE):
                ambiguity_signals.append("news_keyword_in_raw")
            payload.update(
                intent_type="product",
                normalized_query=normalized,
                topic=canonical,
                product_category=canonical,
                product_use_case=use_case or None,
                product_budget=budget or None,
                confidence=(0.7 if ambiguity_signals else 0.92),
                reason=(
                    "product_recommendation_intent_ambiguous"
                    if ambiguity_signals
                    else "product_recommendation_intent"
                ),
            )
            if ambiguity_signals:
                payload["ambiguity_signals"] = ambiguity_signals
            return payload

    # --------- 4) News follow-up with stored topic context --------------
    ctx_topic_core = ""
    ctx_topic_location = ""
    ctx_entities: list[str] = []
    if isinstance(recent_news_context, dict) and recent_news_context:
        raw_ctx_topic = str(recent_news_context.get("topic") or "")
        ctx_entities = [
            str(e).strip()
            for e in (recent_news_context.get("entities") or [])
            if str(e).strip()
        ]
        ctx_topic_core = _extract_topic_core(raw_ctx_topic)
        ctx_topic_location = _extract_topic_location(raw_ctx_topic, ctx_entities)

    if ctx_topic_core and _looks_like_news_followup(raw):
        new_loc = _extract_new_location_candidate(raw)
        # Build the merged query:
        #   "<new_loc> <prior_loc> <topic_core> news"
        # Skip duplicates and empty pieces, then dedupe news suffix.
        pieces: list[str] = []
        for piece in (new_loc, ctx_topic_location, ctx_topic_core):
            if not piece:
                continue
            already = any(piece.lower() == p.lower() for p in pieces)
            if not already:
                pieces.append(piece)
        normalized = " ".join(pieces).strip()
        # Append "news" only if not already present.
        if should_append_news_keyword(normalized):
            normalized = f"{normalized} news"
        normalized = dedupe_news_keywords(normalized)

        location_label = ""
        if new_loc and ctx_topic_location and new_loc.lower() != ctx_topic_location.lower():
            location_label = f"{new_loc}, {ctx_topic_location}"
        elif new_loc:
            location_label = new_loc
        elif ctx_topic_location:
            location_label = ctx_topic_location

        payload.update(
            intent_type="news",
            normalized_query=normalized,
            topic=ctx_topic_core,
            location=location_label or None,
            entity=(new_loc or ctx_topic_location) or None,
            confidence=0.88,
            context_used=True,
            reason=(
                "news_followup_topic_merge_with_new_location"
                if new_loc
                else "news_followup_topic_merge_from_ctx"
            ),
        )
        return payload

    # --------- 5) Explicit news request without ctx merge ---------------
    if explicit_news:
        # Plain "news about X" — keep the user's wording but dedupe trailing
        # duplicates if they happen to end with "news news".
        normalized = dedupe_news_keywords(raw)
        payload.update(
            intent_type="news",
            normalized_query=normalized,
            confidence=0.78,
            reason="explicit_news_request_no_ctx_merge",
        )
        return payload

    # No normalization match -> caller falls through to legacy cascade.
    return payload


def _extract_venue_phrase(text: str) -> str:
    """Return the canonical venue noun phrase from a location query so
    "coffee shops in Irvine" normalizes to "coffee shops in Irvine" instead
    of "in Irvine"."""
    m = _LOCATION_VENUE_RE.search(text or "")
    if not m:
        return _clean_phrase(text or "").lower()
    return m.group(0).lower()


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


def log_info_route_trace(
    *,
    session_id: str = "",
    raw_user_text: str = "",
    resolved_user_text: str = "",
    prior_info_context: dict | None = None,
    info_intent_detected: bool = False,
    info_intent_type: str = "",
    normalized_query: str = "",
    query_terms_added_from_context: list[str] | None = None,
    entity: str | None = None,
    location: str | None = None,
    product_category: str | None = None,
    product_budget: str | None = None,
    product_use_case: str | None = None,
    confidence: float = 0.0,
    reason: str = "",
    result_kind: str = "",
    panel_title: str = "",
    serper_endpoint_used: str = "",
    shopping_results_available: bool | None = None,
    organic_fallback_used: bool | None = None,
    news_results_available: bool | None = None,
    panel_payload_type: str = "",
    final_reply: str = "",
) -> None:
    """Emit a structured ``[info_route_trace]`` log line."""
    try:
        payload = {
            "session_id": (session_id or "")[:64],
            "raw_user_text": (raw_user_text or "")[:240],
            "resolved_user_text": (resolved_user_text or raw_user_text or "")[:240],
            "prior_info_context": _summarize_ctx_for_log(prior_info_context),
            "info_intent_detected": bool(info_intent_detected),
            "info_intent_type": info_intent_type or "",
            "normalized_query": (normalized_query or "")[:240],
            "query_terms_added_from_context": list(query_terms_added_from_context or []),
            "entity": entity,
            "location": location,
            "product_category": product_category,
            "product_budget": product_budget,
            "product_use_case": product_use_case,
            "confidence": round(float(confidence or 0.0), 3),
            "reason": (reason or "")[:120],
            "result_kind": result_kind or "",
            "panel_title": panel_title or "",
            "serper_endpoint_used": serper_endpoint_used or "",
            "shopping_results_available": shopping_results_available,
            "organic_fallback_used": organic_fallback_used,
            "news_results_available": news_results_available,
            "panel_payload_type": panel_payload_type or "",
            "final_reply": (final_reply or "")[:240],
            "ts": round(time(), 3),
        }
        print("[info_route_trace] " + json.dumps(payload), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[info_route_trace_error] {exc!r}", flush=True)


def _summarize_ctx_for_log(ctx: dict | None) -> dict:
    if not isinstance(ctx, dict):
        return {}
    return {
        "topic": str(ctx.get("topic") or "")[:160],
        "entities": list(ctx.get("entities") or [])[:6],
        "previous_route_type": str(ctx.get("previous_route_type") or "")[:64],
        "has_topic": bool(ctx.get("topic")),
    }


def log_product_routed_as_news_warning(
    *, session_id: str, raw_user_text: str, normalized_query: str, route_taken: str
) -> None:
    print(
        "[product_routed_as_news] " + json.dumps(
            {
                "session_id": (session_id or "")[:64],
                "raw_user_text": (raw_user_text or "")[:240],
                "normalized_query": (normalized_query or "")[:240],
                "route_taken": (route_taken or "")[:64],
            }
        ),
        flush=True,
    )


def log_news_query_missing_topic_context_warning(
    *, session_id: str, raw_user_text: str, normalized_query: str
) -> None:
    print(
        "[news_query_missing_topic_context] " + json.dumps(
            {
                "session_id": (session_id or "")[:64],
                "raw_user_text": (raw_user_text or "")[:240],
                "normalized_query": (normalized_query or "")[:240],
            }
        ),
        flush=True,
    )


def log_location_routed_as_reasoning_panel_warning(
    *, session_id: str, raw_user_text: str, panel_payload_type: str
) -> None:
    print(
        "[location_routed_as_reasoning_panel] " + json.dumps(
            {
                "session_id": (session_id or "")[:64],
                "raw_user_text": (raw_user_text or "")[:240],
                "panel_payload_type": (panel_payload_type or "")[:64],
            }
        ),
        flush=True,
    )


def log_generic_search_low_relevance_warning(
    *, session_id: str, raw_user_text: str, normalized_query: str
) -> None:
    print(
        "[generic_search_low_relevance] " + json.dumps(
            {
                "session_id": (session_id or "")[:64],
                "raw_user_text": (raw_user_text or "")[:240],
                "normalized_query": (normalized_query or "")[:240],
            }
        ),
        flush=True,
    )


def log_info_query_ambiguous_warning(
    *,
    session_id: str,
    raw_user_text: str,
    chosen_intent: str,
    competing_signals: list[str],
) -> None:
    """Soft warning when a turn matches multiple intent types (e.g.
    "best webcam news" -> product + news). Caller still picks one route by
    dominant wording; this just leaves a breadcrumb so we can audit later.
    """
    print(
        "[info_query_ambiguous] " + json.dumps(
            {
                "session_id": (session_id or "")[:64],
                "raw_user_text": (raw_user_text or "")[:240],
                "chosen_intent": (chosen_intent or "")[:32],
                "competing_signals": list(competing_signals or [])[:6],
            }
        ),
        flush=True,
    )


__all__ = [
    "normalize_info_request",
    "dedupe_news_keywords",
    "should_append_news_keyword",
    "log_info_route_trace",
    "log_product_routed_as_news_warning",
    "log_news_query_missing_topic_context_warning",
    "log_location_routed_as_reasoning_panel_warning",
    "log_generic_search_low_relevance_warning",
]
