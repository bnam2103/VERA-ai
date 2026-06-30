"""Explicit timer-extend intent parser (Phase 1).

Only handles phrases that clearly target an existing timer, e.g.:
  - "add 3 minutes to the timer"
  - "extend the timer by 3 minutes"
  - "make the timer 5 minutes longer"

Vague contextual phrases ("give me 5 more minutes", "add another minute")
are intentionally out of scope until Phase 2.
"""

from __future__ import annotations

import json
import re
from typing import Any

from actions.timer_duration import (
    TIMER_START_INTENT_RE,
    parse_timer_duration_seconds,
    timer_start_intent_matches,
)

__all__ = [
    "TIMER_EXTEND_INTENT_PATTERN",
    "TIMER_EXTEND_INTENT_RE",
    "timer_extend_intent_matches",
    "timer_extend_blocklist_rejects",
    "parse_timer_extend_request",
    "format_timer_duration_label",
]

# Duration token shared with timer_duration (digits + word numbers + units).
_DUR_TOKEN = (
    r"(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|"
    r"twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a|an)"
    r"(?:[\s\-]+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|"
    r"twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety))?"
)
_UNIT = r"(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)"

TIMER_EXTEND_INTENT_PATTERN = (
    r"(?:"
    # add/give/increase X (more) to/on/for my/the timer
    r"(?:add|give|increase)\s+"
    rf"(?:{_DUR_TOKEN}\s+)?(?:more\s+)?(?:{_UNIT})\s+"
    r"(?:to|on|for)\s+(?:my\s+|the\s+|that\s+)?(?:work\s*mode\s+)?timer\b"
    r"|"
    # extend/increase the timer by X
    r"(?:extend|increase)\s+(?:the\s+|my\s+|that\s+)?(?:work\s*mode\s+)?timer\s+by\s+"
    rf"(?:{_DUR_TOKEN}\s+)?(?:{_UNIT})\b"
    r"|"
    # make the timer X longer
    r"make\s+(?:the\s+|my\s+|that\s+)?(?:work\s*mode\s+)?timer\s+"
    rf"(?:{_DUR_TOKEN}\s+)?(?:{_UNIT})\s+longer\b"
    r"|"
    # give the timer X more minutes
    r"give\s+(?:the\s+|my\s+|that\s+)?(?:work\s*mode\s+)?timer\s+"
    rf"(?:{_DUR_TOKEN}\s+)?(?:more\s+)?(?:{_UNIT})\b"
    r")"
)
TIMER_EXTEND_INTENT_RE = re.compile(TIMER_EXTEND_INTENT_PATTERN, re.IGNORECASE)

_TIMER_EXTEND_BLOCKLIST: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bchecklist\b", re.I), "checklist"),
    (
        re.compile(
            r"\b(?:to|on|for|from|in)\s+(?:the\s+|my\s+)?(?:checklist|list|plan|tasks?)\b",
            re.I,
        ),
        "checklist_tail",
    ),
    (re.compile(r"\bsearch\b", re.I), "search"),
    (re.compile(r"\bworkouts?\b", re.I), "workout"),
    (
        re.compile(
            r"\bplay\b[\s\S]{0,40}?\b(?:rain|sound|sounds|music|audio|noise|podcast)\b",
            re.I,
        ),
        "play_media",
    ),
    (
        re.compile(r"\b(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+left\b", re.I),
        "time_left_question",
    ),
    (re.compile(r"\bleft\s*\?\s*$", re.I), "time_left_question"),
    (re.compile(r"\bremind\s+me\s+in\b", re.I), "remind_me_in"),
]


def timer_extend_blocklist_rejects(text: str) -> tuple[bool, str | None]:
    raw = (text or "").strip()
    if not raw:
        return True, "empty"
    for pat, reason in _TIMER_EXTEND_BLOCKLIST:
        if pat.search(raw):
            return True, reason
    if timer_start_intent_matches(raw) and not _extend_shaped_timer_phrase(raw):
        return True, "timer_start"
    return False, None


def _extend_shaped_timer_phrase(text: str) -> bool:
    """True when phrasing modifies an existing timer rather than starting one."""
    raw = (text or "").strip()
    if not raw:
        return False
    if TIMER_EXTEND_INTENT_RE.search(raw):
        return True
    return bool(
        re.search(
            r"\b(?:add|extend|increase|give)\s+[\s\S]{0,48}?\btimer\b",
            raw,
            re.I,
        )
        or re.search(r"\btimer\s+(?:[\w-]+\s+){0,4}(?:longer|more\b)", raw, re.I)
        or re.search(r"\b(?:to|by)\s+(?:my\s+|the\s+)?timer\b", raw, re.I)
    )


def timer_extend_intent_matches(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return False
    if not TIMER_EXTEND_INTENT_RE.search(raw):
        return False
    rejected, _reason = timer_extend_blocklist_rejects(raw)
    return not rejected


def _parse_extend_delta_seconds(text: str) -> int | None:
    """Extract duration delta; tolerate optional ``more`` between count and unit."""
    normalized = re.sub(r"\bmore\b", " ", text or "", flags=re.IGNORECASE)
    return parse_timer_duration_seconds(normalized)


def format_timer_duration_label(seconds: int) -> str:
    sec = max(0, int(seconds or 0))
    if sec >= 3600 and sec % 3600 == 0:
        h = sec // 3600
        return f"{h} hour{'s' if h != 1 else ''}"
    if sec >= 60 and sec % 60 == 0:
        m = sec // 60
        return f"{m} minute{'s' if m != 1 else ''}"
    return f"{sec} second{'s' if sec != 1 else ''}"


def parse_timer_extend_request(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    if not timer_extend_intent_matches(raw):
        rejected, reason = timer_extend_blocklist_rejects(raw)
        if TIMER_EXTEND_INTENT_RE.search(raw):
            try:
                print(
                    "[timer_extend_rejected] "
                    + json.dumps(
                        {"raw_text": raw[:240], "reason": reason or "no_match"},
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception:
                pass
        return None

    delta = _parse_extend_delta_seconds(raw)
    if delta is None or delta <= 0:
        try:
            print(
                "[timer_extend_rejected] "
                + json.dumps(
                    {"raw_text": raw[:240], "reason": "duration_parse_failed"},
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        return None

    try:
        print(
            "[timer_extend_detected] "
            + json.dumps(
                {
                    "raw_text": raw[:240],
                    "duration_delta_seconds": delta,
                    "source": "explicit_timer",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass

    return {
        "duration_delta_seconds": int(delta),
        "source": "explicit_timer",
        "raw": raw,
    }
