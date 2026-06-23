"""actions/timer_duration.py — shared timer-duration parser.

Single source of truth used by BOTH:

  * ``actions.multi_action_planner._parse_timer_duration_seconds`` — to
    fill the ``timer.set`` payload during structured planning.
  * ``app._wm_timer_parse_duration_seconds`` — the legacy work-mode
    timer parser used by single-action ``/infer`` and the work-mode
    timer dispatch path.

Both used to be hand-rolled, numeric-only regex parsers. That mismatch
caused live ``timer.set`` plans with phrasings like ``"one hour"`` or
``"an hour"`` to validate as ``duration_seconds=None``, which then
forced the multi-action planner to fall back to legacy single-action
routing (where a sibling panel/music shortcut would win and the timer
would silently never start). Centralizing the parser here keeps the
two call sites in lock-step and removes the structural gap.

What this module accepts:

  * Digit forms: ``"10 seconds"``, ``"5 minutes"``, ``"1 hour"``,
    ``"90 mins"``, ``"1 hour and 30 minutes"``, ``"for 2 hours"``.
  * Word-number forms (singular/plural, with optional articles):
    ``"one second"``, ``"a second"``, ``"twenty seconds"``,
    ``"ninety minutes"``, ``"one hour"``, ``"an hour"``,
    ``"two hours"``, ``"one hour and thirty minutes"``.
  * Mixed: ``"1 hour and forty-five minutes"`` is fine — the parser
    walks the string left-to-right and sums every ``<count> <unit>``
    pair it sees, regardless of whether the count was a digit, an
    article (``"a"`` / ``"an"`` → 1), or a word number.

What this module does NOT accept:

  * Bare ``"a timer"`` / ``"the timer"`` with no count + unit — returns
    ``None`` so the caller can fall back to a clarification prompt.
  * Fractional or decimal counts like ``"half an hour"``. The spec
    deliberately leaves those for a later round so the parser stays
    deterministic and the regression surface stays small.

The function ``parse_timer_duration_seconds(text)`` is the entire
public surface. ``WORD_NUMBERS_MAP`` is exposed for tests that want to
assert specific words are covered.
"""

from __future__ import annotations

import re

__all__ = [
    "parse_timer_duration_seconds",
    "WORD_NUMBERS_MAP",
    "TIMER_START_INTENT_PATTERN",
    "TIMER_START_INTENT_RE",
    "timer_start_intent_matches",
]


# ---------------------------------------------------------------------------
# 2026-06-13 — shared timer-START intent grammar.
#
# Single source of truth for *intent classification* (NOT duration parsing).
# Used by BOTH:
#   * ``actions.multi_action_planner`` — the ``timer.set`` action anchor and
#     the connector RHS detector, so duration-before-noun phrasings produce a
#     ``timer.set`` action with ``duration_seconds`` filled.
#   * ``app._try_work_mode_timer_core`` / ``app.looks_like_supported_app_action``
#     — the runtime work-mode timer dispatcher and the supported-app-action
#     priority guard.
#
# Why it exists: the duration parser above already accepted "10 minute",
# "1 hour", "1 hour and 30 minute", etc., but the intent regexes only matched
# the timer NOUN immediately after the verb/article ("set a timer ...").
# Duration-before-noun forms ("start a 10 minute timer", "set a 1 hour timer")
# and countdown wording ("count down 10 minutes") were never classified as a
# timer at all, so the duration parser was never reached.
#
# Grammar shapes covered (case-insensitive):
#   A. timer noun before duration:
#        "set a timer for 10 minutes", "start timer for 10 minutes",
#        "timer for 10 minutes"
#   B. duration before timer noun:
#        "start a 10 minute timer", "set 10 minute timer",
#        "set a 1 hour timer", "start a 1 hour and 30 minute timer"
#   C. countdown wording:
#        "count down 10 minutes", "start a countdown for 10 minutes",
#        "set a countdown for 30 seconds"
#   D. reminder shorthand (kept from the prior grammar):
#        "remind me in 10 minutes"
# ---------------------------------------------------------------------------
TIMER_START_INTENT_PATTERN = (
    r"(?:"
    # A/B — verb + optional article/qualifier + up to a few duration words +
    # the timer/countdown noun. The ``{0,5}`` padding is what lets the
    # duration sit BETWEEN the article and the noun ("a 10 minute timer").
    r"(?:set|start|create|make|begin|put)\s+(?:up\s+)?"
    r"(?:a\s+|an\s+|another\s+|the\s+|my\s+|me\s+a\s+|one\s+more\s+)?"
    r"(?:[\w-]+\s+){0,5}"
    r"(?:work\s*mode\s+)?(?:timer|countdown)\b"
    r"|"
    # A — noun-first: "timer for ...", "countdown for ..."
    r"(?:timer|countdown)\s+for\b"
    r"|"
    # C — "count down <...> <unit>". Two words + a trailing unit are required
    # so the single-word noun "countdown" inside ordinary prose ("the
    # countdown to launch") cannot spuriously trigger a timer.
    r"count\s+down\s+(?:[\w-]+\s+){0,3}"
    r"(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b"
    r"|"
    # D — "remind me in <number> <unit>"
    r"remind\s+me\s+in\s+"
    r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|"
    r"twenty|thirty|forty|fifty|sixty|hundred|half|a\s+(?:half|quarter|few))"
    r"(?:[-\s]\w+)?\s*"
    r"(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b"
    r")"
)
TIMER_START_INTENT_RE = re.compile(TIMER_START_INTENT_PATTERN, re.IGNORECASE)


def timer_start_intent_matches(text: str) -> bool:
    """True when ``text`` contains a timer-START intent (any supported
    grammar shape). Duration parsing is a separate concern handled by
    ``parse_timer_duration_seconds``."""
    if not text:
        return False
    return bool(TIMER_START_INTENT_RE.search(text))


WORD_NUMBERS_MAP: dict[str, int] = {
    "zero": 0,
    "one": 1, "a": 1, "an": 1, "single": 1,
    "two": 2, "couple": 2,
    "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}

_UNIT_TO_SECONDS: dict[str, int] = {
    "h": 3600, "hr": 3600, "hrs": 3600, "hour": 3600, "hours": 3600,
    "m": 60, "min": 60, "mins": 60, "minute": 60, "minutes": 60,
    "s": 1, "sec": 1, "secs": 1, "second": 1, "seconds": 1,
}

# Sorted by length DESC so the regex tries multi-word tokens first
# (``"twenty"`` before ``"two"``, ``"single"`` before ``"a"`` etc.).
_WORD_NUMBER_ALT = "|".join(
    sorted((re.escape(w) for w in WORD_NUMBERS_MAP), key=len, reverse=True)
)
_UNIT_ALT = "|".join(
    sorted((re.escape(u) for u in _UNIT_TO_SECONDS), key=len, reverse=True)
)

# Word-number pair: optionally a "tens-then-ones" form such as
# ``"twenty one seconds"`` or hyphenated ``"twenty-one"``. We allow
# either form but cap to a single ones word so we don't accidentally
# eat the next clause (``"one and"``).
_PAIR_RE = re.compile(
    rf"\b(?P<count>(?:\d+|(?:{_WORD_NUMBER_ALT})(?:[\s\-]+(?:{_WORD_NUMBER_ALT}))?))"
    rf"\s+(?P<unit>{_UNIT_ALT})\b",
    re.IGNORECASE,
)


def _count_token_to_int(token: str) -> int | None:
    """Convert a count token (digits, single word, or ``"twenty one"``) to int."""
    t = (token or "").strip().lower()
    if not t:
        return None
    if t.isdigit():
        try:
            return int(t)
        except ValueError:
            return None
    parts = re.split(r"[\s\-]+", t)
    total = 0
    matched = False
    for p in parts:
        if p in WORD_NUMBERS_MAP:
            total += WORD_NUMBERS_MAP[p]
            matched = True
        elif p.isdigit():
            try:
                total += int(p)
                matched = True
            except ValueError:
                return None
        else:
            return None
    return total if matched else None


def parse_timer_duration_seconds(text: str) -> int | None:
    """Return total seconds for the FIRST timer-duration phrasing in ``text``.

    Walks the string left-to-right and sums every ``<count> <unit>``
    pair found, so compound phrasings like ``"one hour and thirty
    minutes"`` resolve to ``5400``. Returns ``None`` when no
    count+unit pair is present.
    """
    s = (text or "").strip().lower()
    if not s:
        return None
    total = 0
    found = False
    for m in _PAIR_RE.finditer(s):
        count = _count_token_to_int(m.group("count"))
        if count is None:
            continue
        unit = (m.group("unit") or "").lower()
        per_unit = _UNIT_TO_SECONDS.get(unit)
        if per_unit is None:
            continue
        total += count * per_unit
        found = True
    return total if found else None
