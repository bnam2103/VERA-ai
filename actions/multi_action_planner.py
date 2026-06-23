"""actions/multi_action_planner.py — VERA structured semantic action planner.

Goal (2026-05-29 spec):

    Use heuristics ONLY as a cheap trigger to detect possible compound commands.
    Then use a structured semantic planner to return an ordered action plan.
    Then validate and execute the plan sequentially.

This module is the "structured semantic planner" half. Execution wiring is
intentionally separate — the planner is observable + testable on its own
before we let it steer the dispatcher.

Public API (all pure / side-effect-free except the structured log line):

    should_trigger_planner(text) -> tuple[bool, str]
        Cheap regex gate. Returns (triggered, reason). Reason strings are
        grep-friendly (e.g. ``connector_and_multi_family``). Never raises.

    plan_user_actions(text, *, vera=None, context=None) -> dict
        Returns the spec'd JSON shape (see top of file). When ``vera`` is
        provided and exposes ``route_action``-style JSON generation, the
        planner asks the LLM for a higher-confidence plan and falls back to
        the deterministic backbone on parse failure / low confidence. The
        deterministic path is the source of truth for the smoke tests so
        the suite stays reproducible without an LLM at hand.

    validate_plan(plan) -> tuple[bool, list[str], str | None]
        Returns ``(ok, errors, clarification_question)``. Errors are short
        machine-readable codes ("missing_panel_target", "empty_play_query");
        the clarification question is None unless the planner / validator
        decides we should re-ask the user instead of guessing.

    _log_planner(...) -> None
        Single grep target ``[planner]``. Emits one JSON line covering every
        debug field listed in the spec.

Action families this module recognizes (matches the spec verbatim — the
dispatcher in app.py maps them to existing handlers):

    panel.navigate / panel.open / panel.close
    music.play / music.pause / music.resume / music.next / music.previous /
        music.volume
    checklist.add / checklist.remove / checklist.complete / checklist.sync
    voice.answer
    reasoning.request

JSON contract returned by ``plan_user_actions``:

    {
      "is_multi_action": bool,
      "actions": [
        {
          "type": <one of the action families above>,
          "span": <substring of the original text this action came from>,
          "payload": <dict — schema is per-family; see _ACTION_PAYLOAD_KEYS>,
          "order": <int, 1-based>,
          "confidence": <float in [0, 1]>
        },
        ...
      ],
      "clarification_needed": bool,
      "clarification_question": <str | None>,
      "reason": <short grep-friendly string>
    }

Design notes:

  * The planner is paranoid about "and": for checklist-bodies it lets
    "milk and eggs" stay as two items, but for general compound text it
    only splits on "and"/"then"/etc. when the right-hand side begins with
    a recognized action verb. That avoids the classic "play rock and roll"
    / "explain supply and demand" false splits.

  * "X after Y" is rewritten to (Y, X) before validation so the assistant
    plays Feather first and *then* turns the volume up. "X before Y" stays
    as (X, Y).

  * "X in panel N" is rewritten to (panel.navigate(N), X(target=N)) even
    when "panel N" appears at the end of the utterance.

  * Confidence is a deterministic function of (1) how cleanly the regex
    matched, (2) whether every span maps to a known action verb, and
    (3) whether validation produced any errors. The dispatcher can use a
    threshold to decide whether to honor the plan or ask for clarification.
"""

from __future__ import annotations

import json
import re
import uuid
import time
from typing import Any, Iterable

# Shared normalizer for "play X" spans. The planner uses it to populate
# music.play payloads with a structured ``music_intent`` so the executor
# can switch on ``play_kind`` instead of re-parsing the raw text.
from actions.music_intent import (
    detect_music_unsupported_modifier,
    normalize_music_play_request,
)

# Shared timer-START intent grammar (single source of truth). Imported early
# so the ``ACTION_ANCHORS`` catalog below and the connector RHS detector can
# both reuse the exact same grammar that ``app.py`` uses for the runtime
# work-mode timer dispatcher. See ``actions/timer_duration.py``.
from actions.timer_duration import (
    TIMER_START_INTENT_PATTERN as _TIMER_START_INTENT_PATTERN,
)

# ---------------------------------------------------------------------------
# 2026-05-29 OPTION B FIX — LLM upgrade hook disabled for live execution.
#
# The smoke suite (212 PASS) exercises the deterministic backbone with
# ``vera=None`` and confirms it correctly handles every spec phrase:
# checklist + music, timer + music, playlist-name intent, unpause priority,
# panel suffix, semantic reorder. Live ``/infer`` diverged from the smoke
# tests because the LLM upgrade hook could rewrite the deterministic plan
# in three observed ways:
#
#   1. Drop ``timer.set`` / ``timer.cancel`` (these were never added to
#      the LLM prompt's family menu) → map "set a timer" to
#      ``voice.answer`` → timer narrated but never enqueued.
#   2. Emit ``music.play`` with the wrong payload key (e.g. ``"text"`` or
#      empty) → validation fails → planner returns ``None`` → greedy
#      single-action shortcut fires → second action dropped.
#   3. Omit per-action ``confidence`` fields → average confidence 0.0 <
#      gate min 0.60 → planner returns ``None`` → same fallthrough.
#
# Until ``_choose_plan`` is redesigned with strict per-payload validation
# (and the LLM prompt is regenerated against the current
# ``ACTION_ANCHORS`` catalog), the LLM upgrade hook is OFF by default.
# Flip this flag to True only after the prompt + acceptance logic have
# been hardened.
ENABLE_LLM_MULTI_ACTION_PLANNER: bool = False

# ---------------------------------------------------------------------------
# Action-verb catalog. Single source of truth for the planner + validators.
# Keep alternatives lowercase; we normalize the input text to lowercase
# before matching to keep regex compact.
# ---------------------------------------------------------------------------

# Each entry: (action_family, anchor_regex). Order matters — the FIRST entry
# whose regex matches at a given position wins. We deliberately list the
# most-specific patterns first so e.g. ``"open a new panel"`` beats the bare
# ``"open"`` heuristic (we don't actually treat bare "open" as an anchor).
ACTION_ANCHORS: list[tuple[str, str]] = [
    # ----- info / tool answers -----
    # These must come before broad reasoning/voice anchors. Mixed commands like
    # "what time is it in Tokyo and pause the music" should plan the time clause
    # as a first-class action instead of letting the legacy single-action router
    # consume the whole utterance and drop the music clause.
    (
        "info.time",
        r"(?:what(?:'s|s| is)\s+(?:the\s+)?time(?:\s+is\s+it)?|"
        r"what\s+time\s+is\s+it|"
        r"current\s+time|"
        r"tell\s+me\s+(?:the\s+)?time|"
        r"check\s+(?:the\s+)?time)\b",
    ),
    (
        "info.weather",
        r"(?:what(?:'s|s| is)\s+(?:the\s+)?weather|"
        r"how(?:'s|s| is)\s+(?:the\s+)?weather|"
        r"tell\s+me\s+(?:the\s+)?weather|"
        r"check\s+(?:the\s+)?weather|"
        r"current\s+weather|"
        r"is\s+it\s+(?:raining|rainy|snowing|windy|hot|cold))\b",
    ),
    # 2026-06-02 — bare/continuation info anchors for compound info
    # queries. Without these, utterances like
    #     "weather in Irvine and time in Tokyo"
    # or  "Can you tell me the time in Tokyo and the weather in Fountain Valley?"
    # only anchor the half with an explicit verb (what/tell me/current/
    # check) and the rest gets absorbed into the FIRST clause's
    # `location` slot ("Tokyo and the weather in Fountain Valley"). The
    # continuation anchors fire only AFTER a connector word (and|then|
    # also|plus|or); the leading branch (`^`) fires at the very start
    # of the utterance. Both are intentionally narrow — they require
    # ``noun + (in|at|for) + word`` so generic phrases like "the time
    # and energy" don't accidentally anchor. The forecast/temperature
    # alternates piggy-back on info.weather because they share the same
    # downstream handler (weather.current).
    (
        "info.time",
        r"(?<=\band\s)(?:the\s+)?time\s+(?:in|at|for)\s+\w"
        r"|(?<=\bthen\s)(?:the\s+)?time\s+(?:in|at|for)\s+\w"
        r"|(?<=\balso\s)(?:the\s+)?time\s+(?:in|at|for)\s+\w"
        r"|(?<=\bplus\s)(?:the\s+)?time\s+(?:in|at|for)\s+\w"
        r"|(?<=\bor\s)(?:the\s+)?time\s+(?:in|at|for)\s+\w"
        r"|^\s*(?:the\s+)?time\s+(?:in|at|for)\s+\w",
    ),
    (
        "info.weather",
        r"(?<=\band\s)(?:the\s+)?(?:weather|forecast|temperature)\s+(?:in|at|for)\s+\w"
        r"|(?<=\bthen\s)(?:the\s+)?(?:weather|forecast|temperature)\s+(?:in|at|for)\s+\w"
        r"|(?<=\balso\s)(?:the\s+)?(?:weather|forecast|temperature)\s+(?:in|at|for)\s+\w"
        r"|(?<=\bplus\s)(?:the\s+)?(?:weather|forecast|temperature)\s+(?:in|at|for)\s+\w"
        r"|(?<=\bor\s)(?:the\s+)?(?:weather|forecast|temperature)\s+(?:in|at|for)\s+\w"
        r"|^\s*(?:the\s+)?(?:weather|forecast|temperature)\s+(?:in|at|for)\s+\w",
    ),
    (
        "info.finance",
        r"(?:what(?:'s|s| is)\s+[\w.$-]{1,12}(?:'s)?\s+(?:trading\s+at|stock\s+price|share\s+price)|"
        r"(?:stock|share)\s+price\s+(?:of|for)\s+[\w.$-]{1,40}|"
        r"(?:quote|market\s+cap)\s+(?:for|of)\s+[\w.$-]{1,40}|"
        r"[\w.$-]{1,12}\s+(?:trading\s+at|stock\s+price|share\s+price|market\s+cap|"
        r"(?:biggest\s+)?drawdown|return|volatility|52-week|52\s+week|sharpe|beta))\b",
    ),
    (
        "info.news",
        r"(?:what(?:'s|s| is)\s+(?:the\s+)?(?:latest\s+)?news|"
        r"(?:latest|breaking)\s+news|"
        r"tell\s+me\s+(?:the\s+)?news|"
        r"any\s+(?:updates|news)\s+on|"
        r"latest\s+on\s+[\w][\w\s.&'-]{1,80})\b",
    ),
    # info.sports / info.product / info.location come BEFORE info.search so a
    # phrase like "did the Lakers win" anchors as info.sports (more specific)
    # and "coffee shops near me" anchors as info.location. info.search is the
    # generic catch-all. Anchors are intentionally bounded (small {1,40}
    # character runs) so the regex cannot eat a sibling action clause like
    # "and play lo-fi" that follows the info span.
    (
        "info.sports",
        # 2026-05-30: extended beyond NBA/NFL/MLB teams to also anchor on
        # tennis players + tournaments + top soccer players. The router still
        # uses a richer entity catalog (see actions.sports), but the planner
        # only needs enough signal to ATTACH a sports anchor on compound
        # utterances ("did the Lakers win and play lo-fi", "is Djokovic still
        # in Roland Garros and pause the music"). Keep this generic — do not
        # add Lakers-specific patterns; rely on the catalog there.
        r"(?:did\s+(?:the\s+)?[\w][\w\s.&'-]{1,40}\s+(?:win|lose|score|beat|tie|draw)\b|"
        # team names — same NBA / NFL / MLB / soccer subset we had, plus a
        # few common nicknames; the full catalog lives in actions.sports.
        r"\b(?:lakers|clippers|warriors|celtics|knicks|bulls|nets|heat|cavaliers|cavs|"
        r"sixers|76ers|raptors|bucks|mavericks|mavs|nuggets|suns|kings|pelicans|"
        r"jazz|wizards|hawks|hornets|magic|grizzlies|thunder|rockets|"
        r"timberwolves|trail\s*blazers|pacers|pistons|"
        r"yankees|red\s+sox|dodgers|giants|cubs|mets|braves|astros|phillies|"
        r"49ers|niners|eagles|cowboys|patriots|chiefs|packers|bills|rams|ravens|"
        r"steelers|broncos|raiders|chargers|jets|saints|falcons|panthers|"
        r"buccaneers|seahawks|vikings|lions|"
        r"liverpool|arsenal|chelsea|tottenham|manchester(?:\s+united|\s+city)?|"
        r"newcastle|barcelona|real\s+madrid|atletico|psg|bayern|"
        r"borussia\s+dortmund|juventus|inter\s+milan|ac\s+milan|napoli)\s+"
        r"(?:score|won|lost|win|lose|vs\.?|versus|game|games|match|playing|next)\b|"
        # tennis players — surname-only is fine because the planner pairs
        # them with tournament_status / schedule phrasing downstream.
        r"\b(?:djokovic|alcaraz|sinner|medvedev|zverev|tsitsipas|rune|ruud|"
        r"rublev|hurkacz|fritz|tiafoe|shelton|swiatek|sabalenka|gauff|"
        r"rybakina|pegula|jabeur|raducanu)\b|"
        # tournaments
        r"\b(?:roland\s+garros|french\s+open|wimbledon|us\s+open|"
        r"australian\s+open|atp\s+finals|wta\s+finals|champions\s+league|"
        r"europa\s+league|fifa\s+world\s+cup|world\s+cup|premier\s+league|"
        r"la\s+liga|serie\s+a|bundesliga|ligue\s+1|mls\s+cup|"
        r"nba\s+finals|nba\s+playoffs|super\s+bowl|nfl\s+playoffs|"
        r"world\s+series|mlb\s+playoffs|stanley\s+cup|nhl\s+playoffs|"
        r"masters\s+tournament)\b|"
        # soccer top players (generic, not Lakers-specific)
        r"\b(?:messi|ronaldo|mbappe|mbappé|haaland|vinicius|bellingham|"
        r"saka|kane|salah|lewandowski|de\s+bruyne)\b|"
        # generic sports-phrasing anchors
        r"\b(?:score|scores|standings|results?)\s+(?:of|for)\s+(?:the\s+)?\w|"
        r"\b(?:still\s+in|knocked\s+out\s+of|eliminated\s+from|advanced\s+to)\s+(?:the\s+)?\w|"
        r"\b(?:next\s+(?:match|game|fixture|opponent|round))\b)",
    ),
    (
        "info.product",
        # Intentionally NO "compare" verb here — "compare A and B" is also
        # a legitimate reasoning.request phrasing (compare two stocks /
        # ideas / arguments), and the priority-by-anchor-order rule would
        # otherwise let info.product steal those. We rely on product-ish
        # superlatives + "reviews/recommendations" instead.
        r"(?:best|top|cheapest|fastest|highest[-\s]?rated|reviews?\s+of|"
        r"recommend(?:ation)?s?\s+(?:for|of))\s+\w",
    ),
    (
        "info.location",
        r"(?:coffee\s+shops?|cafes?|restaurants?|gyms?|bars?|stores?|hotels?|"
        r"parks?|libraries?|hospitals?|pharmacies?|gas\s+stations?|"
        r"food|brunch|lunch|dinner)\s+"
        r"(?:near|in|around|by)\s+\w|"
        r"\b(?:near|around)\s+me\b",
    ),
    (
        "info.search",
        # General catch-all for "did X happen / announce / release …" style
        # follow-ups that aren't sports, product, or location-specific. Kept
        # narrow so it doesn't compete with info.sports / info.product.
        r"(?:did\s+(?:the\s+)?[\w][\w\s.&'-]{1,40}\s+(?:happen|go|announce|release)\b)",
    ),
    # ----- panel -----
    (
        "panel.navigate",
        r"(?:open|select|show)\s+(?:the\s+)?(?:panel\s+\d+|"
        r"(?:first|second|third|fourth|last|previous|next)\s+panel)",
    ),
    (
        "panel.open",
        # 2026-06-01 — added the explicit ``reasoning\s+panel`` noun so
        # phrases like "open a new reasoning panel" anchor cleanly (the
        # older alternation ate "panel" but skipped "reasoning ", so the
        # whole verb-phrase failed to match when "reasoning" sat between
        # the adjective slot and "panel"). The anaphoric branch ("open a
        # new one" / "make another one") is here too, but it is gated by
        # ``_is_panel_open_anchor_valid`` against the LEFT-hand context
        # so we don't treat "make a new one" as panel-open in unrelated
        # sentences.
        r"(?:(?:open|create|make|add)\s+(?:up\s+)?(?:a|another|the|one\s+more)?\s*"
        r"(?:new|extra|additional|empty|another)?\s*"
        r"(?:reasoning\s+panel|panel|reasoning\s+space|reasoning\s+tab|tab)|"
        r"(?:open|create|make)\s+(?:a|another|one\s+more)\s+(?:new\s+|other\s+|fresh\s+)?"
        r"one(?:\s*(?:panel|tab|space)\b|[\s.,;!?]|$)|"
        r"(?:another|one\s+more)\s+(?:new\s+|other\s+|fresh\s+)?"
        r"one(?:\s*(?:panel|tab|space)\b|[\s.,;!?]|$)|"
        r"reopen\s+(?:the\s+)?(?:last|previous|prior|recent|closed)\s+(?:panel|tab))",
    ),
    (
        "panel.close",
        r"close\s+(?:panel\s+\d+|this\s+panel|the\s+(?:first|second|third|fourth|last|current|active)\s+(?:panel|two|three|four|panels)|"
        r"all\s+(?:other\s+)?panels|(?:current\s+|active\s+)?panel)",
    ),
    (
        "panel.navigate",
        r"(?:go\s+to|switch\s+to|use|go\s+back\s+to|navigate\s+to|jump\s+to|move\s+to)\s+"
        r"(?:the\s+)?(?:panel\s+\d+|(?:first|second|third|fourth|last|previous|next)\s+panel|"
        r"\w[\w\s]*?\s+panel)",
    ),
    # ----- music -----
    (
        # NOTE: We treat ``music`` and ``volume`` as equivalent VOLUME
        # TARGETS for the colloquial "turn up/down" / "raise" / "lower"
        # / "crank up/down" phrasings. Users routinely say "turn up the
        # music" to mean "raise the volume", so the planner must anchor
        # both wordings here — otherwise the planner finds 0 anchors,
        # ``is_multi_action`` collapses to False, and the legacy router
        # ends up handling the full compound utterance and dropping all
        # but the first detected intent.
        #
        # We deliberately do NOT extend ``set the volume to N%`` to
        # ``set the music``: "set the music" is too ambiguous (the user
        # might mean a song / source / mood), so the level-set variant
        # still requires the literal token ``volume``.
        "music.volume",
        r"(?:turn\s+(?:up|down)\s+(?:the\s+)?(?:music\s+)?(?:music|volume)|"
        r"turn\s+(?:the\s+)?(?:music|volume)\s+(?:up|down)|"
        r"turn\s+it\s+(?:up|down)\b|"
        r"(?:music|volume)\s+(?:up|down)|"
        r"(?:raise|lower|increase|decrease)\s+(?:the\s+)?(?:music|volume|sound|playback)|"
        r"set\s+(?:the\s+)?volume(?:\s+to\s+\d+%?)?|"
        r"crank\s+(?:up|down)\s+(?:the\s+)?(?:music|volume)|"
        # 2026-06-02 — "crank it up/down" is the pronoun form of the same
        # gesture as "turn it up/down". Without this branch the planner
        # silently drops the volume action from "Unpause the music, play
        # the next song, and crank it up." because the verb has no
        # explicit ``music`` / ``volume`` noun.
        r"crank\s+it\s+(?:up|down)\b|"
        r"make\s+(?:it|the\s+(?:music|volume|sound|playback))\s+(?:louder|quieter|softer|loud|quiet))",
    ),
    (
        "music.next",
        # Reordering note: the "skip to the next [song]" branch MUST come
        # before the bare ``skip\s+(?:this\s+)?(?:song|track)?`` branch,
        # otherwise Python regex picks the first-listed (shorter, empty-
        # tailed) alternative and "skip to the next song" anchors as just
        # "skip " — leaving "next song" to anchor a SECOND music.next
        # span. With "to the next" first we match the full 21-char span
        # exactly once.
        r"(?:next\s+(?:song|track)|"
        r"skip\s+(?:to\s+(?:the\s+)?next(?:\s+(?:song|track))?|"
        r"ahead|(?:this\s+)?(?:song|track)?)|"
        # 2026-06-02 — accept "play next" AND "play the next" (and the
        # song/track suffixed forms) so the planner consistently routes
        # to music.next instead of leaking a bogus
        # ``music.play(query="the")`` for "play the next song".
        r"play\s+(?:the\s+)?next(?:\s+(?:song|track))?)",
    ),
    (
        "music.previous",
        r"(?:previous\s+(?:song|track)|prev\s+(?:song|track)?|"
        r"go\s+back\s+(?:one|a)\s+(?:song|track)|previous\s+track|"
        # 2026-06-02 — mirror the music.next ``play\s+(?:the\s+)?next``
        # rule so "play previous" / "play the previous" / "play prev" /
        # "play the prev" all anchor as music.previous instead of
        # leaking through as music.play(query="the"/"prev").
        r"play\s+(?:the\s+)?(?:previous|prev)(?:\s+(?:song|track))?)",
    ),
    # NOTE: music.resume MUST come before music.pause so a tie on
    # ``start == 0`` ("unpause the music") resolves to resume. We also use
    # a fixed-width lookbehind on the pause regex so "pause" inside
    # "unpause" / "un pause" cannot match independently. Both guards
    # together fix the long-standing "unpause → pause" bug.
    (
        "music.resume",
        r"(?:un\s*pause(?:\s+(?:the\s+)?(?:music|playback|track|song))?|"
        r"resume(?:\s+(?:the\s+)?(?:music|playback|track|song))?|"
        r"continue\s+(?:playing|playback|the\s+(?:music|playback|track|song)))",
    ),
    (
        "music.pause",
        r"(?<!un)(?<!un\s)(?:pause(?:\s+(?:the\s+)?(?:music|playback|track|song))?|"
        r"stop\s+(?:the\s+)?(?:music|playback|track|song))",
    ),
    (
        "music.play",
        # Has to come AFTER play-next / play-previous to avoid eating them.
        # ``play``/``put on`` are unconditional triggers (with a play-next
        # lookahead carve-out). ``start``/``begin playing`` is narrower —
        # we only treat it as music when followed by a music-domain noun
        # (lo-fi, music, playback, playlist, track, song, album, spotify)
        # so "start a timer" stays a timer.set.
        #
        # 2026-06-02 — the play-next/previous carve-out was widened to
        # accept an optional ``the`` between ``play`` and the next/prev
        # token. Without this, "play the next song" anchored as
        # music.play(query="the") because the lookahead only saw the
        # literal "next"/"previous"/"prev" tokens. The bogus
        # music.play(query="the") then executed and Spotify returned a
        # real-but-unrequested track such as "the cure by Olivia
        # Rodrigo", which surfaced as apparent hallucination.
        r"(?:(?:play|put\s+on)\b(?!\s+(?:the\s+)?(?:next|previous|prev))|"
        r"(?:start|begin\s+playing)\s+(?:the\s+|a\s+|some\s+)?"
        r"(?:lo[-\s]?fi(?:\s+mix)?|lofi|spotify|music|playback|"
        r"playlist|track|song|album))",
    ),
    # ----- timer -----
    # ``timer.cancel`` is listed BEFORE ``checklist.remove`` so a phrase
    # like ``"remove the timer"`` resolves to timer.cancel (both regexes
    # match at start=0; ACTION_ANCHORS index breaks the tie). ``timer.set``
    # is broad enough to catch ``"set a timer"``, ``"start a timer"``,
    # and the colloquial ``"remind me in 10 minutes"`` shorthand.
    (
        "timer.cancel",
        r"(?:cancel|stop|clear|remove|erase|delete|kill|end|drop|scrap|nix|close|"
        r"turn\s+off|get\s+rid\s+of)\s+(?:the\s+|my\s+|that\s+|this\s+)?"
        r"(?:work\s*mode\s+)?timer\b",
    ),
    (
        "timer.set",
        # Shared timer-START grammar (see actions/timer_duration.py). Covers
        # noun-before-duration ("set a timer for 10 minutes"),
        # duration-before-noun ("start a 10 minute timer", "set a 1 hour
        # timer"), countdown wording ("count down 10 minutes"), and the
        # "remind me in <N> <unit>" shorthand. The duration parser inside
        # ``_parse_timer_duration_seconds`` then fills ``duration_seconds``.
        _TIMER_START_INTENT_PATTERN,
    ),
    # ----- checklist -----
    (
        "checklist.sync",
        r"sync\s+(?:the\s+)?(?:plan|checklist|list|reasoning(?:\s+plan)?)\b",
    ),
    (
        "checklist.complete",
        # "mark X complete", "check off X", "mark first done"
        r"(?:mark\b|check\s+off\b|check\s+(?:item|the)\b)",
    ),
    (
        "checklist.remove",
        r"(?:remove\b|delete\b|drop\b|take\s+off\b|cross\s+off\b)",
    ),
    (
        "checklist.add",
        # "add X to checklist", "put X on the list"
        # We REQUIRE the verb (add/put) to be near a checklist-tail keyword
        # before we accept this as a checklist-add anchor. That avoids
        # treating bare "add" in general chat as a checklist add.
        r"(?:add|put)\b",
    ),
    # ----- reasoning -----
    (
        "reasoning.request",
        # Direct verbs ("explain X", "summarize Y", "compare A and B") plus
        # a "give/put/provide/write up <article> <reasoning-noun>" family
        # ("give me a detailed explanation of X", "put an explanation of X
        # in panel 2") so the planner anchors variant wording the same as
        # the bare verb. The reasoning-noun list mirrors what the
        # downstream reasoning router produces (explanation / summary /
        # writeup / outline / breakdown / deep-dive / analysis / overview).
        #
        # 2026-06-01 — added "plan" / "help me plan" / "help me draft" /
        # "help me outline" so requests like "help me plan an English
        # essay" anchor as reasoning. "plan" is guarded by an immediate
        # object-determiner / "out" / possessive so the noun usages
        # ("the plan", "follow the plan", "checklist plan") don't anchor.
        r"(?:explain|solve|write|summari[sz]e|analy[sz]e|describe|teach\s+me|"
        r"compare|outline|walk\s+me\s+through|tell\s+me\s+about|"
        r"break\s+down|derive|prove|draft|brainstorm|critique|"
        r"review|review\s+the|edit|revise|continue\s+the\s+(?:essay|outline|draft)|"
        r"help\s+me\s+(?:with|solve|understand|write|plan|draft|outline|brainstorm)|"
        # 2026-06-02 — narrow "work/walk/go/think/talk/reason/run through"
        # variants so panel-targeted reasoning like
        # "Can you work through this in panel 1?" anchors as reasoning
        # instead of falling through to voice.answer. Each form requires
        # a trailing object word so we don't anchor random uses of "go" /
        # "run" / "work" outside of a reasoning frame.
        r"work\s+through\s+\w|walk\s+through\s+\w|go\s+through\s+\w|"
        r"think\s+through\s+\w|talk\s+through\s+\w|reason\s+through\s+\w|"
        r"run\s+through\s+\w|"
        r"make\s+(?:a|an|the)?\s*(?:[\w'-]+\s+){0,6}"
        r"(?:status\s+update|summary|plan|outline|draft|explanation|comparison|"
        r"analysis|list|table|paragraph|sentence|message|email|report|"
        r"write[-\s]?up|recommendation|roadmap|checklist)\b|"
        r"plan\s+(?:out\s+)?(?:my|an?|the|this|that)\s+(?:\w+\s+)?"
        r"(?:essay|paper|report|outline|response|answer|write[-\s]?up|"
        r"draft|presentation|talk|speech|project|paragraph|section|study|"
        r"schedule|plan|approach|strategy|argument|thesis|story|article)|"
        r"(?:put|provide|give\s+me|give\s+us|write\s+up|share)\s+"
        r"(?:a\s+|an\s+|the\s+|this\s+|that\s+|me\s+a\s+|me\s+an\s+|us\s+an?\s+|"
        r"a\s+(?:detailed|quick|short|long|brief|thorough|in[-\s]depth)\s+|"
        r"an\s+in[-\s]depth\s+)?"
        r"(?:answer|explanation|summary|write[-\s]?up|outline|breakdown|"
        r"deep[-\s]dive|analysis|overview)\b)",
    ),
    (
        "voice.answer",
        r"(?:what|who|where|when|why|how|did\s+(?:the\s+)?[\w]|"
        r"is\s+(?:the|there|it)\b|are\s+(?:the|there)\b|was\s+(?:the|there|it)\b|"
        r"were\s+(?:the|there)\b)\b",
    ),
]

# Cheap heuristic gate: any of these strongly suggests the utterance might be
# compound and worth running through ``plan_user_actions``.
_CONNECTORS_RE = re.compile(
    r"\b(?:and|then|after\s+that|after|before|also|plus|next,)\b",
    re.IGNORECASE,
)
# We only split on connectors when the RIGHT-hand-side begins with one of
# these verb stems. This is what prevents "rock and roll" / "supply and
# demand" / "Sabrina Carpenter and turn up" from getting split incorrectly:
# only the latter has "turn" as the right-hand verb stem.
_ACTION_VERB_RHS_RE = re.compile(
    r"^\s*(?:and|then|also|plus|after\s+that|next,)?\s*"
    r"(?:can\s+you\s+|could\s+you\s+|please\s+|now\s+|then\s+)?"
    # ``open``/``create`` are bare verbs so the gate fires on
    # "open panel 2", "open a new panel", "open a new reasoning panel".
    # ``make`` is narrower because it doubles as a non-panel verb
    # ("make a sandwich") — we require either an explicit
    # ``(?:new\s+)?(?:reasoning\s+)?panel`` noun OR an anaphoric
    # ``(?:a|another|one\s+more)\s+(?:new\s+)?one`` (gated by left-hand
    # panel context inside the planner so unrelated "make another one"
    # in non-panel chat doesn't trigger).
    r"(?:open|create|"
    r"make\s+(?:a|another|the)?\s*(?:new\s+)?(?:reasoning\s+)?panel|"
    r"make\s+(?:a|another|one\s+more)\s+(?:new\s+|other\s+|fresh\s+)?"
    r"one(?:\s*(?:panel|tab|space)\b|[\s.,;!?]|$)|"
    r"make\s+(?:a|an|the)?\s*(?:[\w'-]+\s+){0,6}"
    r"(?:status\s+update|summary|plan|outline|draft|explanation|comparison|"
    r"analysis|list|table|paragraph|sentence|message|email|report|"
    r"write[-\s]?up|recommendation|roadmap|checklist)\b|"
    r"(?:another|one\s+more)\s+(?:new\s+|other\s+|fresh\s+)?"
    r"one(?:\s*(?:panel|tab|space)\b|[\s.,;!?]|$)|"
    r"reopen\s+(?:the\s+)?(?:last|previous|prior|recent|closed)|"
    r"add|put|remove|delete|drop|mark|check\s+off|sync|"
    r"close|go\s+to|switch\s+to|use\s+panel|navigate|"
    r"play|put\s+on|pause|stop|resume|continue|unpause|un\s*pause|skip|next|previous|prev|"
    r"start\s+(?:the\s+|a\s+|some\s+)?(?:lo[-\s]?fi|lofi|music|playback|playlist|track|song|album|spotify)|"
    r"begin\s+playing|"
    r"turn\s+(?:up|down)|turn\s+it\s+(?:up|down)|turn\s+the\s+volume|volume\s+(?:up|down)|"
    r"raise\s+(?:the\s+)?(?:volume|music|sound|playback)|"
    r"lower\s+(?:the\s+)?(?:volume|music|sound|playback)|"
    r"increase\s+(?:the\s+)?(?:volume|music|sound|playback)|"
    r"decrease\s+(?:the\s+)?(?:volume|music|sound|playback)|"
    r"crank\s+(?:up|down)|"
    # 2026-06-02 — accept the pronoun form ("crank it up/down") so a
    # connector-led second clause like "Pause and then crank it up."
    # passes ``_action_verb_after_connector`` and the planner is allowed
    # to look for a second action anchor.
    r"crank\s+it\s+(?:up|down)|"
    r"make\s+(?:it|the\s+(?:music|volume|sound|playback))\s+"
    r"(?:louder|quieter|softer|loud|quiet)|"
    r"set\s+the?\s*volume|"
    # timer-START. The duration may sit between the article and the noun
    # ("set a 10 minute timer", "start a 1 hour timer"); countdown wording
    # ("count down 10 minutes", "start a countdown for 30 seconds") is also
    # accepted. Kept in lock-step with the shared grammar in
    # ``actions/timer_duration.py`` so a connector-led second timer clause
    # ("play lo-fi and start a 10 minute timer") is split correctly.
    r"(?:set|start|create|make|begin)\s+(?:up\s+)?"
    r"(?:a\s+|an\s+|another\s+|the\s+|my\s+|me\s+a\s+|one\s+more\s+)?"
    r"(?:[\w-]+\s+){0,5}(?:work\s*mode\s+)?(?:timer|countdown)|"
    r"(?:timer|countdown)\s+for|"
    r"count\s+down\s+(?:[\w-]+\s+){0,3}(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)|"
    r"cancel\s+(?:the\s+|my\s+|that\s+|this\s+)?(?:work\s*mode\s+)?timer|"
    r"erase\s+(?:the\s+|my\s+|that\s+|this\s+)?(?:work\s*mode\s+)?timer|"
    r"close\s+(?:the\s+|my\s+|that\s+|this\s+)?(?:work\s*mode\s+)?timer|"
    r"remind\s+me\s+in\b|"
    r"explain|solve|write|summari[sz]e|analy[sz]e|describe|teach|"
    r"compare|outline|walk\s+me\s+through|tell\s+me\s+about|"
    r"derive|prove|draft|brainstorm|critique|review|edit|revise|"
    r"help\s+me|"
    # Bare "plan" reasoning verb when it leads a clause after a
    # connector ("open panel 2 and help me plan my essay there.";
    # the explicit "help me" form is already covered above, this
    # branch covers the "and plan my essay" variant where the user
    # drops the helper).
    r"plan\s+(?:out\s+)?(?:my|an?|the|this|that)\b|"
    r"provide|give\s+(?:me|us)|write\s+up|share\s+(?:a\s+|an\s+|the\s+)?(?:explanation|summary|writeup|outline|breakdown|analysis|overview)|"
    r"what|who|where|when|why|how|did\s+(?:the\s+)?[\w]|"
    r"tell\s+me\s+(?:the\s+)?(?:weather|time|news)|"
    r"current\s+(?:weather|time)|latest\s+news|breaking\s+news|"
    r"(?:stock|share)\s+price|quote\s+(?:for|of)|trading\s+at|"
    r"best|top|reviews?\s+of|recommend(?:ation)?s?\s+(?:for|of)|"
    r"coffee\s+shops?|cafes?|restaurants?|gyms?|bars?|stores?|hotels?|"
    r"parks?|libraries?|hospitals?|pharmacies?|gas\s+stations?)\b",
    re.IGNORECASE,
)

# Tail phrases that mark "this clause is a checklist add". We accept any of
# the prepositions {to, on, in, onto, into} optionally followed by a
# determiner {the, my, our, this}, optionally followed by a checklist noun
# {checklist, list, plan, todo, to-do, to-do list}. The whole tail is
# anchored as a single regex so callers can split a body on it AND strip
# it from leaked item text (defense in depth — _split_checklist_items
# would otherwise emit "hello to the checklist" as one item when the body
# was extracted from a span that wasn't trimmed first).
_CHECKLIST_TAIL_RE = re.compile(
    r"\b(?:to|on|in|onto|into)\s+(?:the|my|our|this)?\s*"
    r"(?:check[-\s]?list|to[-\s]?do(?:\s+list)?|list|plan)\b",
    re.IGNORECASE,
)
# Same family but used as a *prefix* before the verb ("on my checklist, add ...").
# Same alternation as the tail regex, kept separate so the prefix lookbehind
# in _checklist_anchor_is_valid stays narrow.
_CHECKLIST_TAIL_PREP_RE = re.compile(
    r"\b(?:on|in|onto|into)\s+(?:the|my|our|this)\s+"
    r"(?:check[-\s]?list|to[-\s]?do(?:\s+list)?|list|plan)\b",
    re.IGNORECASE,
)
_PUT_REASONING_PANEL_RE = re.compile(
    r"^\s*put\s+"
    r"(?:(?:a|an|the|this|that)\s+)?"
    r"(?:answer|explanation|summary|analysis|overview|breakdown|write[-\s]?up)\b"
    r"[\s\S]{0,160}?"
    r"\bin\s+(?:the\s+)?(?:(?:reasoning|answer|explanation)\s+)?panel"
    r"(?:\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))?\b",
    re.IGNORECASE,
)
# Trailing connector words we want to drop from a span before logging /
# extracting payload — these are leftovers from the next anchor (e.g. the
# "and" in "add hello to the checklist and play lo-fi"). Anchor-driven
# splitting keeps the connector with the right-hand span, but it also
# trails into the left-hand span when the regex captures a few characters
# beyond the trailing punctuation. We strip them after the punctuation rstrip.
_TRAILING_CONNECTOR_RE = re.compile(
    r"\s+(?:and|then|after\s+that|also|plus|but|so|next)\s*$",
    re.IGNORECASE,
)
# Leading filler we want to drop from a music.play query so the dispatcher
# doesn't search for "the lo-fi mix" verbatim. Two guards keep this from
# eating real song titles:
#   * The article must be lowercase ("the lo-fi mix" → strip; "The Beatles"
#     → keep, because "The" is part of the proper noun and the user
#     deliberately capitalized it).
#   * There must be at least one non-space character after the article.
# We require the article to be at the very start of the (already trimmed)
# query string.
_MUSIC_QUERY_LEADING_ARTICLE_RE = re.compile(
    r"^(?:the|a|an|some)\s+(?=[a-z0-9])",
)

# "in my playlist", "from the playlist", "in my list", … — any trailing
# phrase that scopes the search to the user's currently-active Spotify
# playlist instead of doing a global track search. We anchor on the
# preposition + (optional determiner) + the noun "playlist" / "list".
# Captures the phrase as group 0 so the planner can both strip it from
# the query AND echo it back in the payload for debug logging.
_PLAYLIST_SCOPE_RE = re.compile(
    r"\b(?P<phrase>(?:in|from|on|within)\s+(?:my|the|this|that|our)\s+playlist|"
    r"(?:in|from|on|within)\s+playlist|"
    r"(?:in|from)\s+(?:my|the|this|that|our)\s+list)\b",
    re.IGNORECASE,
)

# "in panel N" / "in the Vietnam War panel" / "in panel two" target capture.
_PANEL_TARGET_SUFFIX_RE = re.compile(
    r"\bin\s+(?:the\s+)?panel\s+(?P<num>\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
    re.IGNORECASE,
)
_PANEL_TARGET_TITLE_RE = re.compile(
    r"\bin\s+(?:the\s+)?(?P<title>[A-Z][\w\s\-]{1,40}?)\s+panel\b",
)

_ORDINAL_TO_INT = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "last": -1,
}

# "after playing Feather" — gerund right after "after" → semantic reorder
# "after playing X" means "first play X, then ...".
_AFTER_GERUND_RE = re.compile(
    r"\bafter\s+(?P<verb>playing|opening|closing|adding|removing|"
    r"explaining|solving|writing|summari[sz]ing|analy[sz]ing|"
    r"pausing|resuming|skipping)\s+(?P<obj>.+?)(?:[.?!]|$)",
    re.IGNORECASE,
)

# Multi-panel-close pattern. Covers all three voice phrasings:
#     "close panel 1 and panel 3"     — number-word-number variant
#     "close panel 1 and 3"           — number-then-bare-numbers variant
#     "close panels 1 and 3"          — pluralized noun variant
# The trailing-numbers branch lets us match either form without a separate
# regex per phrasing.
_MULTI_PANEL_CLOSE_RE = re.compile(
    r"close\s+(?:panels?\s+\d+(?:\s*(?:,|and)\s*(?:panel\s+)?\d+)+|"
    r"panels?\s+\d+(?:\s*(?:,|and)\s*\d+)+)",
    re.IGNORECASE,
)

# Anaphoric panel.open detection. Matches phrases like "open a new one",
# "make another one", "create one more new one" — these are only valid as
# panel.open when an earlier clause in the same utterance already
# established a panel context (panel/tab/reasoning space) or a previous
# panel-family action. Without that left-hand context, "make a new one"
# is far too ambiguous (could refer to a sandwich, a timer, a checklist
# item, …) and the planner should NOT treat it as panel.open.
_ANAPHORIC_PANEL_OPEN_RE = re.compile(
    r"^(?:open|create|make)\s+(?:a|another|one\s+more)\s+"
    r"(?:new\s+|other\s+|fresh\s+)?one(?:\s*(?:panel|tab|space)\b|[\s.,;!?]|$)",
    re.IGNORECASE,
)
_BARE_ANAPHORIC_PANEL_ONE_RE = re.compile(
    r"^(?:another|one\s+more)\s+(?:new\s+|other\s+|fresh\s+)?"
    r"one(?:\s*(?:panel|tab|space)\b|[\s.,;!?]|$)",
    re.IGNORECASE,
)
_MAKE_REASONING_ARTIFACT_NOUNS = (
    r"status\s+update|summary|plan|outline|draft|explanation|comparison|"
    r"analysis|list|table|paragraph|sentence|message|email|report|"
    r"write[-\s]?up|recommendation|roadmap|checklist"
)
_MAKE_REASONING_ARTIFACT_RE = re.compile(
    rf"(?is)^\s*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?"
    rf"make\s+(?:a|an|the)?\s*(?:[\w'-]+\s+){{0,6}}"
    rf"(?:{_MAKE_REASONING_ARTIFACT_NOUNS})\b",
)
_PRECEDING_PANEL_CONTEXT_RE = re.compile(
    r"\b(?:panel|tab|reasoning\s+space|reasoning\s+tab|reasoning\s+panel|"
    r"work\s*mode|workmode)\b",
    re.IGNORECASE,
)

# "reasoning.request body that targets TWO different panels" — e.g.
# "Explain problem 1 in panel 1 and problem 2 in panel 2." The current
# heuristic can only attach one panel target per reasoning span, so
# silently merging both halves into panel 1 would be wrong. When we
# detect this shape we surface a clarification question instead.
_MULTI_PANEL_REASONING_RE = re.compile(
    r"\bin\s+(?:the\s+)?panel\s+(?:\d+|one|two|three|four|five|"
    r"six|seven|eight|nine|ten)\b"
    r"[\s\S]{0,200}?"
    r"\b(?:and|,)\b"
    r"[\s\S]{0,200}?"
    r"\bin\s+(?:the\s+)?panel\s+(?:\d+|one|two|three|four|five|"
    r"six|seven|eight|nine|ten)\b",
    re.IGNORECASE,
)

# Volume direction extraction.
#
# These mirror the ``music.volume`` anchor catalog above: anything that
# the anchor accepts MUST be recognized here too, otherwise the planner
# would correctly anchor "turn up the music" but then emit a
# ``music.volume`` payload with ``direction=None`` and fail validation.
# Specifically we accept "music up" / "up the music" / etc. alongside
# the existing "volume" wordings.
_VOLUME_UP_RE = re.compile(
    r"\b(?:turn\s+up|turn\s+it\s+up|raise|increase|crank\s+up|"
    # 2026-06-02 — pronoun form "crank it up" mirrors "turn it up".
    r"crank\s+it\s+up|"
    r"(?:music|volume)\s+up|"
    r"up\s+the\s+(?:music|volume)|"
    r"make\s+(?:it|the\s+(?:music|volume|sound|playback))\s+"
    r"(?:louder|loud)|"
    r"louder)\b",
    re.IGNORECASE,
)
_VOLUME_DOWN_RE = re.compile(
    r"\b(?:turn\s+down|turn\s+it\s+down|lower|decrease|crank\s+down|"
    # 2026-06-02 — pronoun form "crank it down" mirrors "turn it down".
    r"crank\s+it\s+down|"
    r"(?:music|volume)\s+down|"
    r"down\s+the\s+(?:music|volume)|"
    r"make\s+(?:it|the\s+(?:music|volume|sound|playback))\s+"
    r"(?:quieter|softer|quiet)|"
    r"quieter|softer)\b",
    re.IGNORECASE,
)
# 2026-06-02 — Degenerate "play X" queries.
#
# Stop-word queries like "play the" / "play it" produce a Spotify search
# for a meaningless token, which still returns a real (but unrequested)
# track such as "the cure by Olivia Rodrigo". That surfaces as apparent
# hallucination in the combined voice reply. The narrow lookahead fix in
# the ``music.play`` anchor blocks the most common shape
# ("play the next song"), but this set is defense-in-depth: if a future
# anchor-level regression lets a stop-word query through, the planner
# drops the action and the handler refuses to call Spotify search.
_DEGENERATE_PLAY_QUERY_SET = frozenset({
    "the",
    "a",
    "an",
    "some",
    "it",
    "that",
    "this",
})


def _is_degenerate_play_query(q: str) -> bool:
    """True when ``q`` is a stop-word that should NEVER reach Spotify."""
    if not q:
        return True
    s = (q or "").strip().lower()
    if not s:
        return True
    # Strip trailing punctuation a planner span may carry over.
    s = re.sub(r"[\.\!\?\,;:]+$", "", s).strip()
    if not s:
        return True
    return s in _DEGENERATE_PLAY_QUERY_SET


_VOLUME_SET_RE = re.compile(
    # Level-set still REQUIRES the literal "volume" token — "set the
    # music to 50%" is ambiguous (could mean source/mood/track) so we
    # leave it as a non-anchor that falls back to legacy routing.
    r"\bset\s+(?:the\s+)?volume\s+to\s+(?P<level>\d+)%?\b",
    re.IGNORECASE,
)

# Panel-number extraction inside a span (covers "panel 2", "panel two",
# "the second panel"). Returns the integer or -1 for "last".
_PANEL_NUMBER_RE = re.compile(
    r"\bpanel\s+(?P<num>\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
    re.IGNORECASE,
)
_PANEL_ORDINAL_RE = re.compile(
    r"\bthe\s+(?P<ord>first|second|third|fourth|fifth|last)\s+panel\b",
    re.IGNORECASE,
)

_INFO_TIME_LOCATION_RE = re.compile(
    r"\b(?:what(?:'s|s| is)\s+(?:the\s+)?time(?:\s+is\s+it)?|what\s+time\s+is\s+it|"
    r"current\s+time|tell\s+me\s+(?:the\s+)?time|check\s+(?:the\s+)?time)"
    r"(?:\s+(?:right\s+now|now|currently))?"
    r"(?:\s+(?:in|at|for)\s+(?P<location>.+))?$",
    re.IGNORECASE,
)
_INFO_WEATHER_LOCATION_RE = re.compile(
    r"\b(?:what(?:'s|s| is)\s+(?:the\s+)?weather(?:\s+like)?|"
    r"how(?:'s|s| is)\s+(?:the\s+)?weather(?:\s+like)?|"
    r"tell\s+me\s+(?:the\s+)?weather|check\s+(?:the\s+)?weather|"
    r"current\s+weather|is\s+it\s+(?:raining|rainy|snowing|windy|hot|cold))"
    r"(?:\s+(?:in|at|for)\s+(?P<location>.+))?$",
    re.IGNORECASE,
)
_INFO_LOCATION_TRAILING_FILLER_RE = re.compile(
    r"\s+(?:right\s+now|now|currently|today|outside)\s*$",
    re.IGNORECASE,
)


# Required payload keys per action family. Used by ``validate_plan``.
_ACTION_PAYLOAD_KEYS: dict[str, tuple[str, ...]] = {
    "panel.navigate": ("target",),
    "panel.open": (),
    "panel.close": ("targets",),
    "music.play": ("query",),
    "music.pause": (),
    "music.resume": (),
    "music.next": (),
    "music.previous": (),
    "music.volume": ("direction",),  # direction or level
    "checklist.add": ("items",),
    "checklist.remove": ("targets",),
    "checklist.complete": ("targets",),
    "checklist.sync": (),
    "timer.set": ("duration_seconds",),
    "timer.cancel": (),
    "info.time": ("text",),
    "info.weather": ("text",),
    "info.news": ("query",),
    "info.search": ("query",),
    "info.finance": ("query",),
    "info.sports": ("query",),
    "info.product": ("query",),
    "info.location": ("query",),
    "voice.answer": ("text",),
    "reasoning.request": ("text",),
}

# Duration parser for ``timer.set`` spans. Delegates to the shared
# parser in ``actions.timer_duration`` so the planner's payload always
# agrees with ``app._wm_timer_parse_duration_seconds`` (which also
# delegates to the same module). Returns total seconds or ``None`` when
# no count+unit pair is present (e.g. ``"set a timer"`` without a
# duration — validation will fall through to clarification).
from actions.timer_duration import (  # noqa: E402  (kept near the function it powers)
    parse_timer_duration_seconds as _shared_parse_timer_duration_seconds,
)


def _parse_timer_duration_seconds(span: str) -> int | None:
    return _shared_parse_timer_duration_seconds(span)


# ---------------------------------------------------------------------------
# Heuristic trigger gate
# ---------------------------------------------------------------------------


def should_trigger_planner(text: str) -> tuple[bool, str]:
    """Cheap regex check: does this utterance LOOK compound enough to plan?

    Returns ``(triggered, reason)``. The reason string is logged so an
    operator can tell which heuristic fired (and which ones tripped on
    benign single-action input).
    """
    if not text or not text.strip():
        return False, "empty_text"
    raw = text.strip()

    if _new_panel_content_plan(raw, emit_logs=False) is not None:
        return True, "new_panel_content_task"

    has_connector = bool(_CONNECTORS_RE.search(raw))
    has_in_panel_suffix = bool(_PANEL_TARGET_SUFFIX_RE.search(raw))
    has_after_gerund = bool(_AFTER_GERUND_RE.search(raw))
    has_multi_close = bool(_MULTI_PANEL_CLOSE_RE.search(raw))

    # Count how many *distinct* action families the text references. We use
    # the same anchor catalog the planner itself uses so the trigger and the
    # planner stay in sync. We also track distinct info subfamilies
    # (info.time, info.weather, info.news, info.finance, info.sports,
    # info.product, info.location) separately because the family-split
    # collapse rule above maps every ``info.*`` anchor to the same bucket,
    # which would otherwise hide multi-info compounds like
    # "weather in Irvine and time in Tokyo" from the trigger.
    families_hit: set[str] = set()
    info_subfamilies_hit: set[str] = set()
    low = raw.lower()
    for family, pattern in ACTION_ANCHORS:
        if re.search(pattern, low):
            families_hit.add(family.split(".")[0])  # collapse to family group
            if family.startswith("info."):
                info_subfamilies_hit.add(family)
            # NB: cannot early-break on ``families_hit >= 2`` anymore — we
            # need to finish counting info subfamilies for the
            # ``connector_and_multi_info_subfamily`` check below. The anchor
            # catalog is ~24 entries so the extra ``re.search`` work is
            # negligible.

    if has_in_panel_suffix and ("reasoning" in families_hit or "music" in families_hit or "checklist" in families_hit):
        return True, "in_panel_suffix_with_action"
    # 2026-06-02 — Panel + reasoning combo without a connector
    # ("Use panel 3 to explain tennis." / "Go to panel 2 and explain
    # the Vietnam War." — the latter has a connector and is handled by
    # ``connector_and_multi_family`` below). Without this rule, a voice
    # transcript that pairs a navigate verb directly with a reasoning
    # verb never reaches the planner because no connector word matches
    # ``_CONNECTORS_RE`` and ``has_in_panel_suffix`` is also False (the
    # text has "to panel N", not "in panel N"). The combo is still a
    # clearly compound work-mode intent and must dispatch through the
    # multi-action executor so the reasoning lands in the targeted lane.
    if "panel" in families_hit and "reasoning" in families_hit:
        return True, "panel_navigate_with_reasoning"
    # 2026-06-02 — "in panel N" + a clear command-intent shape but no
    # explicit reasoning verb anchor ("Do this in panel 3.",
    # "Can you make a plan in panel 2?", "Help me build a study
    # schedule in panel 1."). The downstream fallback in
    # ``_heuristic_plan`` already promotes these to a panel-targeted
    # reasoning plan, but voice input never reaches the planner unless
    # the trigger fires here. Statements like "The picture in panel 3
    # is broken." don't match ``_PANEL_REASONING_FALLBACK_INTENT_RE``
    # and continue down the legacy voice.answer path.
    if has_in_panel_suffix:
        try:
            cleaned_for_intent = _strip_panel_phrase_from_reasoning_text(raw).strip()
        except Exception:
            cleaned_for_intent = ""
        if cleaned_for_intent and _PANEL_REASONING_FALLBACK_INTENT_RE.match(
            cleaned_for_intent
        ):
            return True, "panel_suffix_with_command_intent"
    if has_after_gerund and has_connector:
        return True, "after_gerund_connector"
    if has_multi_close:
        return True, "multi_panel_close_pattern"
    if has_connector and len(families_hit) >= 2:
        return True, "connector_and_multi_family"
    # 2026-06-02 — two distinct info subfamilies in one utterance with a
    # connector ("weather in Irvine and time in Tokyo", "tell me the time
    # in Tokyo and the weather in Fountain Valley"). Without this rule the
    # family-collapse above sees only one bucket ("info") and the planner
    # never fires for info+info compounds.
    if has_connector and len(info_subfamilies_hit) >= 2:
        return True, "connector_and_multi_info_subfamily"
    if has_connector and _action_verb_after_connector(raw):
        return True, "connector_with_action_verb_rhs"
    return False, "single_action_or_no_connector"


def _action_verb_after_connector(text: str) -> bool:
    """True when an action verb starts the clause AFTER a connector.

    Lets us catch "play X and turn up Y" even when family detection only
    sees one family in the pre-split text (e.g. music.play matches twice,
    not once-per-family).
    """
    for m in _CONNECTORS_RE.finditer(text):
        rhs = text[m.end():]
        matched = bool(_ACTION_VERB_RHS_RE.match(rhs))
        try:
            print(
                ("[action_anchor_match] " if matched else "[action_anchor_miss] ")
                + json.dumps(
                    {
                        "connector": m.group(0),
                        "rhs_preview": rhs.strip()[:160],
                        "rhs_action_verb_matched": matched,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        if matched:
            return True
    return False


# ---------------------------------------------------------------------------
# Deterministic planner backbone
# ---------------------------------------------------------------------------


def _find_action_anchors(text: str) -> list[tuple[int, str, int]]:
    """Return ``[(start_offset, family, end_offset), ...]`` sorted by offset.

    Each anchor marks the start of a span we believe is the head of an
    action. Overlapping anchors are resolved by keeping the EARLIEST match
    (and within ties the most specific family — order of ``ACTION_ANCHORS``
    is the tiebreaker).

    The per-family validity hooks (``_checklist_anchor_is_valid`` /
    ``_is_panel_open_anchor_valid``) run BEFORE the overlap dedup so an
    invalid ``add``/``put`` checklist anchor cannot shadow a different
    family's anchor that starts at the same offset. Example:
        "put an explanation of the Vietnam War in panel 2"
    has both a checklist.add anchor at "put" and a reasoning.request
    anchor at "put an explanation". The checklist anchor is rejected
    (no checklist tail) here, so the reasoning anchor survives the
    overlap pass and the plan correctly contains reasoning.request.
    """
    low = text.lower()
    raw_hits: list[tuple[int, str, int, int]] = []  # start, family, end, priority
    for priority, (family, pattern) in enumerate(ACTION_ANCHORS):
        for m in re.finditer(pattern, low):
            start, end = m.start(), m.end()
            if family == "checklist.add" and not _checklist_anchor_is_valid(text, start, end):
                continue
            if family == "panel.open" and not _is_panel_open_anchor_valid(text, start, end):
                continue
            raw_hits.append((start, family, end, priority))

    # Dedup overlapping: prefer earlier start; for same start, prefer lower priority (more specific).
    raw_hits.sort(key=lambda x: (x[0], x[3]))
    accepted: list[tuple[int, str, int]] = []
    for start, family, end, _prio in raw_hits:
        # Filter out anchors that fall inside a previously accepted span.
        if accepted and start < accepted[-1][2]:
            continue
        accepted.append((start, family, end))
    return accepted


def _checklist_anchor_is_valid(
    text: str, anchor_start: int, anchor_end: int
) -> bool:
    """A bare ``add`` / ``put`` anchor only counts as ``checklist.add`` when
    a checklist tail appears AFTER it in the same clause.

    Narrow multi-action shorthand exception:
        "can you add hello and play yea in my playlist"

    In Work Mode, "add hello" before an obvious second action is understood
    as a checklist add even without an explicit "to checklist" tail. We only
    accept the bare form when there is non-empty item text before a connector
    and the right-hand side starts with another action verb. This keeps
    ordinary "add X and Y" from being over-split while allowing the executor
    to preserve the checklist ui_payload for the user's current test.
    """
    clause = text[anchor_start:anchor_start + 240]
    # "put an explanation/answer ... in panel N" is reasoning placement, not
    # checklist editing. This must be rejected BEFORE the bare Work Mode
    # shorthand below; otherwise "put an explanation ... in panel 3 and play
    # lo-fi" looks like a valid "put <body> and <second-action>" checklist add.
    if _PUT_REASONING_PANEL_RE.search(clause):
        return False
    tail = text[anchor_end:anchor_end + 200]
    if _CHECKLIST_TAIL_RE.search(tail):
        return True
    # Also accept "on my checklist" prefix BEFORE the add (rare).
    pre = text[max(0, anchor_start - 80):anchor_start]
    if _CHECKLIST_TAIL_PREP_RE.search(pre):
        return True
    m = re.match(r"\s+(?P<body>.+?)\s+\b(?:and|then|also|plus)\b(?P<rhs>.+)$", tail, re.IGNORECASE)
    if m:
        body = (m.group("body") or "").strip(" .,:;!?")
        rhs = (m.group("rhs") or "").strip()
        if body and _ACTION_VERB_RHS_RE.match(rhs):
            return True
    return False


def _anaphoric_one_is_followed_by_non_panel_tail(text: str, end: int) -> bool:
    """True when the matched ``one`` is the start of a longer token/phrase.

    Rejects false positives like ``make a one-sentence status update`` where
    the panel-open regex would otherwise stop at ``make a one``.
    """
    if end >= len(text):
        return False
    nxt = text[end]
    if nxt == "-":
        return True
    if nxt.isalnum():
        return True
    return False


def _is_panel_open_anchor_valid(text: str, start: int, end: int) -> bool:
    """Tighten panel.open before we accept it.

    Two rules currently live here:

    1. The bare "open" regex above is intentionally narrow on its own; this
       hook is the place to drop "open the news panel" / similar
       different-family wordings if we ever need to.
    2. The anaphoric "open a new one" / "make another one" branch only
       counts as panel.open when an earlier clause in the same utterance
       already established a panel context. Without that guard, the
       planner would happily treat "Make a new one" in completely
       unrelated chat ("Bake a cake. Make a new one tomorrow.") as a
       panel.open, which is wrong and noisy.
    """
    clause = text[start:end]
    is_anaphoric = bool(
        _ANAPHORIC_PANEL_OPEN_RE.match(clause)
        or _BARE_ANAPHORIC_PANEL_ONE_RE.match(clause)
    )
    if is_anaphoric:
        if _anaphoric_one_is_followed_by_non_panel_tail(text, end):
            return False
        before = text[:start]
        if not _PRECEDING_PANEL_CONTEXT_RE.search(before):
            return False
    if _MAKE_REASONING_ARTIFACT_RE.match(clause) or (
        end < len(text) and _MAKE_REASONING_ARTIFACT_RE.match(text[start:])
    ):
        return False
    return True


def _split_into_spans(text: str, anchors: list[tuple[int, str, int]]) -> list[dict]:
    """Slice ``text`` into one span per anchor.

    Each span runs from its anchor's start through the start of the NEXT
    anchor (or end of string). Connector words at the boundary are kept
    with the right-hand span so the assistant can quote it cleanly.
    """
    if not anchors:
        return []
    spans: list[dict] = []
    for i, (start, family, _end) in enumerate(anchors):
        stop = anchors[i + 1][0] if i + 1 < len(anchors) else len(text)
        raw_span = text[start:stop].strip().rstrip(".,;:!?").strip()
        # Strip a trailing connector that bled in from the boundary between
        # this anchor and the next ("add hello to the checklist and" →
        # "add hello to the checklist"). Loop because chained connectors
        # like "and then" can stack.
        prev = None
        while raw_span and raw_span != prev:
            prev = raw_span
            raw_span = _TRAILING_CONNECTOR_RE.sub("", raw_span).rstrip(".,;:!?").strip()
        spans.append(
            {
                "type": family,
                "span": raw_span,
                "_anchor_start": start,
                "_anchor_end": stop,
            }
        )
    return spans


def _compound_clause_segments_for_log(text: str) -> list[str]:
    """Best-effort diagnostic split for connector-led compounds.

    This is intentionally log-only; execution still uses anchor spans. We
    strip leading conversational filler like "you" so an utterance such as
    "and you unpause the music and crank up the volume" logs the useful
    segments the user actually intended.
    """
    segments: list[str] = []
    for part in _CONNECTORS_RE.split(text or ""):
        seg = (part or "").strip().strip(".,;:!? ")
        seg = re.sub(r"(?i)^(?:you|can\s+you|could\s+you|please)\s+", "", seg).strip()
        if seg:
            segments.append(seg)
    return segments


def _log_compound_segments(
    *,
    raw_text: str,
    reordered_text: str,
    anchors: list[tuple[int, str, int]],
    spans: list[dict],
) -> None:
    """Emit trace logs for compound splitting and any action-looking segment
    that did not become a planned span."""
    try:
        segments = _compound_clause_segments_for_log(reordered_text)
        span_texts = [str(s.get("span") or "") for s in spans]
        print(
            "[compound_segments] "
            + json.dumps(
                {
                    "raw_user_text": (raw_text or "")[:240],
                    "reordered_text": (reordered_text or "")[:240],
                    "segments": segments,
                    "anchors": [
                        {
                            "type": family,
                            "start": start,
                            "end": end,
                            "text": reordered_text[start:end],
                        }
                        for start, family, end in anchors
                    ],
                    "spans": [
                        {"type": s.get("type"), "span": s.get("span")}
                        for s in spans
                    ],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        lowered_spans = [s.lower() for s in span_texts if s]
        for segment in segments:
            seg_low = segment.lower()
            actionish = bool(_ACTION_VERB_RHS_RE.match(segment))
            handled = any(seg_low in sp or sp in seg_low for sp in lowered_spans)
            if actionish and not handled:
                print(
                    "[multi_action_unhandled_segment] "
                    + json.dumps(
                        {
                            "segment": segment[:200],
                            "raw_user_text": (raw_text or "")[:240],
                            "planned_spans": span_texts,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
    except Exception:
        pass


def _resolve_panel_number_in(span: str) -> int | None:
    m = _PANEL_NUMBER_RE.search(span)
    if m:
        token = m.group("num").lower()
        if token.isdigit():
            return int(token)
        return _ORDINAL_TO_INT.get(token)
    m2 = _PANEL_ORDINAL_RE.search(span)
    if m2:
        return _ORDINAL_TO_INT.get(m2.group("ord").lower())
    return None


def _clean_info_clause_text(text: str) -> str:
    t = (text or "").strip().strip(".,;:!? ")
    t = _TRAILING_CONNECTOR_RE.sub("", t).strip().strip(".,;:!? ")
    return t


def _clean_info_location(value: str | None) -> str:
    loc = _clean_info_clause_text(value or "")
    loc = _INFO_LOCATION_TRAILING_FILLER_RE.sub("", loc).strip()
    loc = re.sub(
        r"^(?:the\s+)?(?:weather|time)\s+(?:in|at|for)\s+",
        "",
        loc,
        flags=re.IGNORECASE,
    ).strip()
    return loc.strip(".,;:!? ")


def _extract_time_location(span: str) -> str:
    s = _clean_info_clause_text(span)
    m = _INFO_TIME_LOCATION_RE.search(s)
    if m:
        return _clean_info_location(m.group("location"))
    m = re.search(r"\b(?:in|at|for)\s+(?P<location>[^,;!?]+)$", s, re.IGNORECASE)
    return _clean_info_location(m.group("location") if m else "")


def _extract_weather_location(span: str) -> str:
    s = _clean_info_clause_text(span)
    m = _INFO_WEATHER_LOCATION_RE.search(s)
    if m:
        return _clean_info_location(m.group("location"))
    m = re.search(r"\b(?:in|at|for)\s+(?P<location>[^,;!?]+)$", s, re.IGNORECASE)
    return _clean_info_location(m.group("location") if m else "")


def _extract_payload_for(span: dict, full_text: str) -> dict:
    """Build the per-family payload dict using regexes scoped to ``span``."""
    family = span["type"]
    s = span["span"]
    low = s.lower()

    if family == "info.time":
        location = _extract_time_location(s)
        return {
            "text": _clean_info_clause_text(s),
            "query": location,
            "location": location,
            "raw": s,
        }

    if family == "info.weather":
        location = _extract_weather_location(s)
        return {
            "text": _clean_info_clause_text(s),
            "query": location,
            "location": location,
            "raw": s,
        }

    if family in (
        "info.news",
        "info.search",
        "info.finance",
        "info.sports",
        "info.product",
        "info.location",
    ):
        query = _clean_info_clause_text(s)
        return {"query": query, "text": query, "raw": s}

    if family == "panel.navigate":
        n = _resolve_panel_number_in(s)
        if n is not None:
            return {"target": {"index": n}, "raw": s}
        # Title-based navigation ("go to the Vietnam War panel").
        m = re.search(r"(?:to|use|back\s+to)\s+(?:the\s+)?(?P<title>.+?)\s+panel\b", s, re.IGNORECASE)
        if m:
            return {"target": {"title": m.group("title").strip()}, "raw": s}
        return {"target": None, "raw": s}

    if family == "panel.open":
        return {"raw": s}

    if family == "panel.close":
        # "close panel 1 and panel 3", "close the first two panels", "close all other panels"
        targets: list[Any] = []
        if re.search(r"\ball\s+(?:other\s+)?panels\b", low):
            targets = ["all_other"]
        else:
            for m in re.finditer(r"panel\s+(\d+)", low):
                targets.append({"index": int(m.group(1))})
            # bare numbers in "panel 1 and 3" after the first panel number
            base_match = re.search(r"panel\s+\d+\s+and\s+(?P<rest>\d+(?:\s*,\s*\d+)*(?:\s+and\s+\d+)*)", low)
            if base_match:
                for n in re.findall(r"\d+", base_match.group("rest")):
                    candidate = {"index": int(n)}
                    if candidate not in targets:
                        targets.append(candidate)
            if not targets:
                m = re.search(r"the\s+(?P<ord>first|second|third|fourth|last)\s+(?:panel|two|three|four|panels)", low)
                if m:
                    targets.append({"ordinal": m.group("ord")})
                elif re.search(r"\bthis\s+panel\b", low):
                    targets.append({"index": "current"})
        return {"targets": targets, "raw": s}

    if family == "music.play":
        # The planner delegates all "play X" normalization to the shared
        # ``normalize_music_play_request`` verdict so both the single-action
        # and multi-action paths route by ``play_kind`` instead of
        # re-parsing the raw span downstream. Examples:
        #
        #   "play yea in my playlist"     → playlist_by_name / query="yea"
        #   "play Feather by Sabrina C."  → track / query="Feather …"
        #   "play the album Blonde …"     → album / query="Blonde …"
        #   "play lo-fi"                  → builtin / query="lo-fi"
        #
        # The legacy ``query`` / ``playlist_scope`` / ``playlist_query``
        # fields are still emitted alongside the new ``music_intent``
        # object so older NDJSON consumers keep working unchanged.
        intent = normalize_music_play_request(s)
        query = intent.get("query", "")
        # 2026-06-02 — degenerate-query guard. If parsing ended up with a
        # bare stop-word like "the" / "a" / "an" / "it" / "that" /
        # "this" / "some" (or an empty query) we mark the payload as
        # degenerate so the planner can drop the action entirely instead
        # of letting it hit Spotify search. Without this guard, the
        # search returns a real-but-unrequested track and the combined
        # voice reply looks hallucinated. The narrow anchor lookahead
        # already blocks the most common shape ("play the next song"),
        # but a future regression in extraction or intent parsing
        # cannot leak a stop-word query through this set.
        degenerate_play_query = _is_degenerate_play_query(query)
        payload: dict[str, Any] = {
            "query": query,
            "raw": s,
            "music_intent": {
                "play_kind": intent.get("play_kind") or "track",
                "source": intent.get("source") or "spotify",
                "query": query,
                "raw_span": intent.get("raw_span") or s,
                "query_before_cleanup": intent.get("query_before_cleanup") or "",
                "query_after_cleanup": intent.get("query_after_cleanup") or query,
                "playlist_scope_phrase": intent.get("playlist_scope_phrase") or "",
                "confidence": float(intent.get("confidence") or 0.0),
            },
            "play_kind": intent.get("play_kind") or "track",
            "source": intent.get("source") or "spotify",
        }
        if degenerate_play_query:
            payload["_drop_degenerate_query"] = True
            payload["clarification_prompt"] = "What would you like me to play?"
        if intent.get("play_kind") == "playlist_by_name":
            payload["playlist_scope"] = True
            payload["playlist_query"] = query
            if intent.get("playlist_scope_phrase"):
                payload["playlist_scope_phrase"] = intent["playlist_scope_phrase"]
        if intent.get("builtin_match"):
            payload["builtin_match"] = intent["builtin_match"]
        # Delayed/conditional/recurring "play X in 10 minutes" is not honored.
        # Annotate so the pre-execution gate can block the whole compound
        # (Option A) instead of starting playback immediately.
        if intent.get("status") == "unsupported":
            meta = detect_music_unsupported_modifier(s, "music.play")
            if meta is not None:
                payload["unsupported_music_modifier"] = meta
        return payload

    if family == "music.volume":
        m_set = _VOLUME_SET_RE.search(s)
        if m_set:
            payload = {"direction": "set", "level": int(m_set.group("level")), "raw": s}
        elif _VOLUME_UP_RE.search(s):
            payload = {"direction": "up", "raw": s}
        elif _VOLUME_DOWN_RE.search(s):
            payload = {"direction": "down", "raw": s}
        else:
            payload = {"direction": None, "raw": s}
        meta = detect_music_unsupported_modifier(s, "music.volume")
        if meta is not None:
            payload["unsupported_music_modifier"] = meta
        return payload

    if family in ("music.pause", "music.resume", "music.next", "music.previous"):
        payload = {"raw": s}
        meta = detect_music_unsupported_modifier(s, family)
        if meta is not None:
            payload["unsupported_music_modifier"] = meta
        return payload

    if family == "checklist.add":
        # Strip leading "add" / "put" and trailing checklist tail
        # ("to/on/in the checklist|list|plan|to-do"). _CHECKLIST_TAIL_RE
        # covers all four boundary phrases from the spec plus their `my`/
        # `our`/`this` determiner variants.
        body = re.sub(r"^\s*(?:add|put)\s+", "", s, count=1, flags=re.IGNORECASE)
        body = _CHECKLIST_TAIL_RE.split(body)[0].strip()
        body = _CHECKLIST_TAIL_PREP_RE.split(body)[0].strip()
        # Split on commas / "and" — but ONLY within the body (we already
        # cut at the checklist-tail boundary above, so this won't eat the
        # downstream sibling action).
        items = _split_checklist_items(body)
        return {"items": items, "raw": s}

    if family in ("checklist.remove", "checklist.complete"):
        targets = _extract_checklist_targets(s)
        return {"targets": targets, "raw": s}

    if family == "checklist.sync":
        return {"raw": s}

    if family == "timer.set":
        # Pull the numeric duration so the executor doesn't have to
        # re-parse the span. We still echo the raw text so dispatch can
        # fall back to ``_try_work_mode_timer_core`` (which handles
        # ``"set a timer for ten minutes"`` word-number phrasing).
        dur = _parse_timer_duration_seconds(s)
        try:
            print(
                "[timer_parse] "
                + json.dumps(
                    {"stage": "planner_extract", "span": (s or "")[:200]},
                    ensure_ascii=False,
                ),
                flush=True,
            )
            print(
                "[timer_duration_extracted] "
                + json.dumps(
                    {
                        "stage": "planner_extract",
                        "span": (s or "")[:200],
                        "duration_seconds": dur,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        return {"duration_seconds": dur, "raw": s}

    if family == "timer.cancel":
        return {"raw": s}

    if family == "reasoning.request":
        return {"text": s, "raw": s}

    if family == "voice.answer":
        return {"text": _clean_info_clause_text(s), "raw": s}

    return {"raw": s}


def _split_checklist_items(body: str) -> list[str]:
    """Split an "add A and B and C" body into ["A", "B", "C"].

    Note: this is scoped to the body AFTER we stripped "to checklist". It
    intentionally permits ``and``/``,``/``+`` because the spec example
    "milk and eggs" must yield two items.

    Belt-and-suspenders: each item also gets `_CHECKLIST_TAIL_RE` /
    `_CHECKLIST_TAIL_PREP_RE` stripped from it. Without this strip a span
    like ``add hello on the checklist`` (where the body extraction split
    on the wrong prep) would emit the item ``"hello on the checklist"``
    instead of ``"hello"``. We also strip a leading article
    ("the eggs" → "eggs") for cleaner item text in the UI.
    """
    if not body:
        return []
    parts = re.split(r"\s*(?:,|;|&|\+|\band\b|\bas\s+well\s+as\b)\s*", body, flags=re.IGNORECASE)
    out: list[str] = []
    for p in parts:
        clean = (p or "").strip().strip(".,;:!?")
        if not clean:
            continue
        # Boundary-strip: drop a trailing/embedded checklist tail.
        clean = _CHECKLIST_TAIL_RE.sub("", clean).strip()
        clean = _CHECKLIST_TAIL_PREP_RE.sub("", clean).strip()
        # Drop a leading article when followed by a real word.
        clean = re.sub(r"^(?:the|a|an|some)\s+(?=\S)", "", clean, flags=re.IGNORECASE).strip()
        clean = clean.strip(".,;:!?").strip()
        if clean:
            out.append(clean)
    return out


def _extract_checklist_targets(span: str) -> list[Any]:
    """Pull "first", "second", "third and fifth", or quoted text targets out."""
    low = span.lower()
    targets: list[Any] = []
    for m in re.finditer(
        r"\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\b",
        low,
    ):
        targets.append({"ordinal": m.group(1)})
    for m in re.finditer(r"item\s+(\d+)|#\s*(\d+)", low):
        n = m.group(1) or m.group(2)
        if n:
            targets.append({"index": int(n)})
    # Bare quoted text: "remove 'homework' from the checklist"
    quoted = re.findall(r"['\"]([^'\"]{1,80})['\"]", span)
    for q in quoted:
        targets.append({"text": q})
    # If we still have nothing, capture the rest of the span after the verb
    # ("remove homework", "delete the eggs item").
    if not targets:
        m = re.match(
            r"^\s*(?:remove|delete|drop|mark|check\s+off|complete)\s+(?:the\s+)?(?P<rest>.+)",
            span,
            re.IGNORECASE,
        )
        if m:
            rest = m.group("rest")
            rest = re.split(r"\bfrom\b|\bon\b|\bin\b|\bto\b", rest, maxsplit=1)[0].strip()
            if rest:
                targets.append({"text": rest.rstrip(".,;:")})
    return targets


def _rewrite_in_panel_suffix(text: str) -> tuple[str, dict | None]:
    """If text ends with ``in panel N`` (or includes it after a reasoning
    verb), rewrite it so the planner sees an explicit panel.navigate +
    a reasoning.request whose target is N. Returns (new_text, panel_target_dict)."""
    m = _PANEL_TARGET_SUFFIX_RE.search(text)
    if not m:
        return text, None
    token = m.group("num").lower()
    n = int(token) if token.isdigit() else _ORDINAL_TO_INT.get(token)
    if n is None:
        return text, None
    return text, {"index": n}


def _rewrite_after_gerund(text: str) -> str:
    """Rewrite "X after playing Y" → "play Y and then X" so anchor order
    matches semantic order. We keep the original substring around so the
    span we attribute to each action remains traceable."""
    m = _AFTER_GERUND_RE.search(text)
    if not m:
        return text
    verb_g = m.group("verb")
    obj = m.group("obj").strip()
    # Map gerund → bare verb.
    gerund_map = {
        "playing": "play",
        "opening": "open",
        "closing": "close",
        "adding": "add",
        "removing": "remove",
        "explaining": "explain",
        "solving": "solve",
        "writing": "write",
        "summarizing": "summarize",
        "summarising": "summarise",
        "analyzing": "analyze",
        "analysing": "analyse",
        "pausing": "pause",
        "resuming": "resume",
        "skipping": "skip",
    }
    bare = gerund_map.get(verb_g.lower(), verb_g.lower())
    head = text[:m.start()].strip().rstrip(",.;: ").strip()
    return f"{bare} {obj} and then {head}"


_REASONING_IN_PANEL_STRIP_RE = re.compile(
    r"\s*\bin\s+(?:the\s+)?panel\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b",
    re.IGNORECASE,
)

_NEW_PANEL_NOUN_PAT = (
    r"(?:"
    r"(?:new|fresh|blank|empty)\s+"
    r"(?:(?:reasoning|work|answer|explanation)\s+)?"
    r"(?:panel|space|tab)"
    r"|"
    r"(?:reasoning|work|answer|explanation)\s+"
    r"(?:panel|space|tab)"
    r"|"
    r"(?:panel|space|tab)"
    r")"
)
_NEW_PANEL_CONTENT_FIRST_RE = re.compile(
    rf"(?is)^\s*(?:please\s+)?"
    rf"(?:(?:can|could|would|will)\s+you\s+)?"
    rf"(?P<task>.+?)\s+"
    rf"(?:in|inside|within|on)\s+(?:a|the)\s+{_NEW_PANEL_NOUN_PAT}\s*[?.!]*\s*$"
)
_NEW_PANEL_PREFIX_RE = re.compile(
    rf"(?is)^\s*(?:please\s+)?"
    rf"(?:(?:can|could|would|will)\s+you\s+)?"
    rf"(?:in|inside|within|on)\s+(?:a|the)\s+{_NEW_PANEL_NOUN_PAT}"
    rf"\s*,?\s*(?P<task>.+?)\s*[?.!]*\s*$"
)
_OPEN_NEW_PANEL_WITH_TASK_RE = re.compile(
    rf"(?is)^\s*(?:please\s+)?"
    rf"(?:(?:can|could|would|will)\s+you\s+)?"
    rf"(?P<panel>(?:open|create|start|make|add)\s+(?:up\s+)?"
    rf"(?:a|another|one\s+more|the)?\s*{_NEW_PANEL_NOUN_PAT})"
    rf"\s+(?P<link>and|then|for|to)\s+(?P<task>.+?)\s*[?.!]*\s*$"
)
_NEW_PANEL_TASK_VERB_RE = re.compile(
    r"(?is)^\s*(?:please\s+)?(?:"
    r"explain|solve|write|summari[sz]e|analy[sz]e|describe|teach|"
    r"compare|outline|walk\s+me\s+through|tell\s+me\s+about|"
    r"break\s+down|derive|prove|draft|brainstorm|critique|review|"
    r"edit|revise|continue|research|investigate|work\s+on|help\s+me|"
    r"plan|think\s+through|talk\s+through|reason\s+through|run\s+through|"
    rf"make\s+(?:a|an|the)?\s*(?:[\w'-]+\s+){{0,6}}"
    rf"(?:{_MAKE_REASONING_ARTIFACT_NOUNS})"
    r")\b"
)

# 2026-06-02 — narrow command-intent shape gate for the panel-suffix
# reasoning fallback below. Only fires when the cleaned text BEFORE the
# ``in panel N`` suffix clearly looks like a request directed AT VERA
# (polite "can/could/would you", a leading reasoning verb, or a bare
# imperative like "Do this"/"Make a plan"). Bare statements like
# "The picture in panel 3 is broken." must NOT match — they're factual,
# not reasoning requests.
_PANEL_REASONING_FALLBACK_INTENT_RE = re.compile(
    r"^\s*(?:please\s+|hey\s+vera[\s,]+|vera[\s,]+)?"
    r"(?:"
    # Polite request frames: "Can you work through this", "Could you draft a memo".
    r"(?:can|could|would|will)\s+(?:you\s+)?(?:please\s+)?\w|"
    # Bare imperatives with a clear command verb.
    r"(?:do|make|build|create|prepare|generate|sketch|plot|draft|"
    r"figure|work|walk|run|think|talk|reason|go|brainstorm|outline|"
    r"plan|compare|describe|teach|tell|show|help|continue|"
    r"explain|solve|write|summari[sz]e|analy[sz]e|review|edit|revise)\b"
    r")",
    re.IGNORECASE,
)


def _strip_panel_phrase_from_reasoning_text(text: str) -> str:
    """Remove a trailing/embedded ``in panel N`` phrase from a reasoning
    prompt. Used when target propagation has resolved the panel index — the
    cleaned text is what we send to ``/work_mode/reasoning_stream`` so the
    model never sees the panel-routing token. Whitespace and trailing
    punctuation are normalized."""
    if not text:
        return ""
    cleaned = _REASONING_IN_PANEL_STRIP_RE.sub("", text)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    cleaned = cleaned.rstrip(".,;: ")
    return cleaned


def _clean_new_panel_content_task(task: str, *, allow_bare_topic: bool = False) -> str:
    """Return the reasoning prompt from a "new panel" routing modifier."""
    t = re.sub(r"\s+", " ", str(task or "")).strip(" \t\r\n,.;:!?")
    if not t:
        return ""
    t = re.sub(r"(?i)^(?:please\s+)?(?:can|could|would|will)\s+you\s+", "", t).strip()
    if _NEW_PANEL_TASK_VERB_RE.match(t):
        return t
    if allow_bare_topic and len(t) >= 2:
        return f"work on {t}"
    return ""


def _new_panel_content_plan(text: str, *, emit_logs: bool = True) -> dict | None:
    """Build [panel.open, reasoning.request] for "task in a new panel".

    The panel phrase is a placement modifier, not the task itself. Plain
    "open a new panel" intentionally returns None so existing single-action
    panel-open behavior stays unchanged.
    """
    raw = str(text or "").strip()
    if not raw:
        return None

    panel_span = "open a new panel"
    task = ""
    reason = ""

    m = _NEW_PANEL_CONTENT_FIRST_RE.match(raw)
    if m:
        task = _clean_new_panel_content_task(m.group("task") or "")
        reason = "new_panel_content_suffix"
    if not task:
        m = _NEW_PANEL_PREFIX_RE.match(raw)
        if m:
            task = _clean_new_panel_content_task(m.group("task") or "")
            reason = "new_panel_content_prefix"
    if not task:
        m = _OPEN_NEW_PANEL_WITH_TASK_RE.match(raw)
        if m:
            panel_span = re.sub(r"\s+", " ", (m.group("panel") or "").strip())
            link = (m.group("link") or "").strip().lower()
            task_raw = m.group("task") or ""
            if _PANEL_TARGET_SUFFIX_RE.search(task_raw):
                return None
            task = _clean_new_panel_content_task(
                task_raw,
                allow_bare_topic=(link == "for"),
            )
            reason = f"open_new_panel_{link}_content"
    if not task:
        return None
    new_panel_request_id = f"new_panel_{uuid.uuid4().hex}"

    if emit_logs:
        try:
            print(
                "[workmode_route] "
                + json.dumps(
                    {
                        "ui_action": "open_new_panel",
                        "content_task": task,
                        "target_panel": "new",
                "new_panel_request_id": new_panel_request_id,
                        "reason": reason,
                        "raw_user_text": raw[:240],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            print(
                "[content_task_extracted] "
                + json.dumps(
                    {
                        "content_task": task,
                        "panel_modifier": "new_panel",
                        "new_panel_request_id": new_panel_request_id,
                        "raw_user_text": raw[:240],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass

    return {
        "is_multi_action": True,
        "actions": [
            {
                "type": "panel.open",
                "span": panel_span,
                "payload": {
                    "raw": panel_span,
                    "target": "new",
                    "content_task": task,
                    "new_panel_request_id": new_panel_request_id,
                },
                "order": 1,
                "confidence": 0.95,
            },
            {
                "type": "reasoning.request",
                "span": task,
                "payload": {
                    "text": task,
                    "raw": task,
                    "target": {"new": True},
                    "target_panel": "new",
                    "target_from": "new_panel_modifier",
                    "new_panel_request_id": new_panel_request_id,
                    # Explicit panel destination: the user said "in a new
                    # panel", so the content task must be routed to the
                    # reasoning panel even if it is otherwise a simple ask.
                    "explicit_panel_destination": True,
                    "panel_target": "new",
                    "content_task": task,
                },
                "order": 2,
                "confidence": 0.95,
            },
        ],
        "clarification_needed": False,
        "clarification_question": None,
        "reason": reason or "new_panel_content_modifier",
        "raw_user_text": raw,
        "_raw_user_text": raw,
    }


def _wire_compound_open_panel_reasoning(
    spans: list[dict],
    raw: str,
    *,
    emit_logs: bool = True,
) -> None:
    """Link ``panel.open`` + trailing ``reasoning.request`` for compound open-and-task.

    Anchor splitting can produce the right action types without the
    ``new_panel_request_id`` hand-off that ``_new_panel_content_plan`` adds.
    Without this step the voice layer speaks two panel-open acknowledgements.
    """
    if len(spans) < 2:
        return
    open_idx = next(
        (i for i, sp in enumerate(spans) if sp.get("type") == "panel.open"),
        None,
    )
    if open_idx is None:
        return
    reasoning_idx = next(
        (
            i
            for i, sp in enumerate(spans[open_idx + 1 :], start=open_idx + 1)
            if sp.get("type") == "reasoning.request"
        ),
        None,
    )
    if reasoning_idx is None:
        return

    open_sp = spans[open_idx]
    reasoning_sp = spans[reasoning_idx]
    open_payload = open_sp.setdefault("payload", {})
    reasoning_payload = reasoning_sp.setdefault("payload", {})

    if open_payload.get("new_panel_request_id") or reasoning_payload.get("new_panel_request_id"):
        return
    if reasoning_payload.get("target") or reasoning_payload.get("explicit_panel_destination"):
        existing_target = reasoning_payload.get("target")
        if isinstance(existing_target, dict) and existing_target.get("index"):
            return

    task = (
        reasoning_payload.get("text")
        or reasoning_payload.get("content_task")
        or reasoning_sp.get("span")
        or ""
    ).strip()
    if not task:
        return

    new_panel_request_id = f"new_panel_{uuid.uuid4().hex}"
    panel_span = (open_sp.get("span") or "open a new panel").strip()

    open_payload.update({
        "raw": panel_span,
        "target": "new",
        "content_task": task,
        "new_panel_request_id": new_panel_request_id,
    })
    reasoning_payload.update({
        "text": task,
        "raw": task,
        "target": {"new": True},
        "target_panel": "new",
        "target_from": "compound_open_panel_reasoning",
        "new_panel_request_id": new_panel_request_id,
        "explicit_panel_destination": True,
        "panel_target": "new",
        "content_task": task,
    })
    reasoning_sp["span"] = task

    if emit_logs:
        try:
            print(
                "[workmode_route] "
                + json.dumps(
                    {
                        "ui_action": "open_new_panel",
                        "content_task": task[:160],
                        "target_panel": "new",
                        "new_panel_request_id": new_panel_request_id,
                        "reason": "compound_open_panel_reasoning",
                        "raw_user_text": raw[:240],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            print(
                "[content_task_extracted] "
                + json.dumps(
                    {
                        "content_task": task[:160],
                        "panel_modifier": "compound_open_panel",
                        "new_panel_request_id": new_panel_request_id,
                        "raw_user_text": raw[:240],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass


def _confidence_for_anchors(
    anchors: list[tuple[int, str, int]],
    text: str,
    spans: list[dict],
) -> float:
    """Heuristic confidence: 1.0 = every span has a clear anchor and a
    non-empty payload-bearing field. We dock 0.1 per span without a clear
    payload, and floor at 0.4 so the dispatcher still has the option to
    surface clarification rather than execute."""
    if not anchors:
        return 0.0
    base = 0.85 if len(anchors) >= 2 else 0.92
    for span in spans:
        family = span["type"]
        payload = span.get("payload") or {}
        keys = _ACTION_PAYLOAD_KEYS.get(family, ())
        for k in keys:
            v = payload.get(k)
            if v in (None, "", [], {}):
                base -= 0.1
                break
    return max(0.4, min(1.0, round(base, 2)))


def _heuristic_plan(text: str) -> dict:
    """Pure-Python planner. No LLM, no network. Deterministic for tests."""
    raw = (text or "").strip()
    if not raw:
        return _empty_plan(raw, reason="empty_text")

    new_panel_plan = _new_panel_content_plan(raw)
    if new_panel_plan is not None:
        return new_panel_plan

    # 1) Pre-process semantic reorder + panel-suffix tagging.
    reordered = _rewrite_after_gerund(raw)
    _, panel_suffix_target = _rewrite_in_panel_suffix(reordered)

    # 2) Find anchors.
    anchors = _find_action_anchors(reordered)

    # 3) Reject checklist anchors that lack a checklist tail.
    cleaned_anchors: list[tuple[int, str, int]] = []
    for start, family, end in anchors:
        if family == "checklist.add":
            if not _checklist_anchor_is_valid(reordered, start, end):
                continue
        if family == "panel.open":
            if not _is_panel_open_anchor_valid(reordered, start, end):
                continue
        cleaned_anchors.append((start, family, end))
    anchors = cleaned_anchors

    # 4) Detect ambiguity: a "to checklist" tail with a music-play verb
    # inside its body (and NO sibling action after the tail). Then we
    # cannot tell whether the user meant "add [hello] and [play lo-fi mix]
    # to checklist" or "add hello [end] then play lo-fi mix".
    amb_q = _detect_checklist_play_ambiguity(reordered, anchors)
    if amb_q is not None:
        return {
            "is_multi_action": False,
            "actions": [],
            "clarification_needed": True,
            "clarification_question": amb_q,
            "reason": "checklist_play_ambiguity",
        }

    # 4.5) Multi-panel reasoning shape: "Explain X in panel 1 and Y in
    # panel 2." We currently only attach ONE panel target per reasoning
    # span via _rewrite_in_panel_suffix / target-propagation, so silently
    # picking panel 1 and dropping the panel-2 half would be wrong. The
    # spec asks us to either split into two reasoning.request actions or
    # surface a clarification — reliable text splitting requires more
    # work (the second clause is verb-less: "problem 2 in panel 2") so
    # we choose clarification for now and let the user rephrase.
    if (
        anchors
        and any(a[1] == "reasoning.request" for a in anchors)
        and _MULTI_PANEL_REASONING_RE.search(reordered)
    ):
        return {
            "is_multi_action": False,
            "actions": [],
            "clarification_needed": True,
            "clarification_question": (
                "I can only route one reasoning request to one panel at a "
                "time. Should I do both in the same panel, or do you want "
                "to send them as two separate requests?"
            ),
            "reason": "multi_panel_reasoning_target_ambiguous",
        }

    # 5) Split into spans (or one full-text span if nothing matched).
    spans = _split_into_spans(reordered, anchors) if anchors else []
    if _CONNECTORS_RE.search(raw):
        _log_compound_segments(
            raw_text=raw,
            reordered_text=reordered,
            anchors=anchors,
            spans=spans,
        )

    # 5.5) 2026-06-02 — Panel-suffix → reasoning fallback.
    #
    # If the text has an "in panel N" suffix AND
    #   (a) nothing anchored (spans is empty), or
    #   (b) only a voice.answer anchor fired,
    # AND the cleaned text BEFORE the panel suffix has a command-intent
    # shape (polite "Can you …", or a clear imperative verb), then
    # treat the whole utterance as panel-targeted reasoning. The cleaned
    # text becomes the reasoning prompt and the existing step-7 logic
    # below injects the panel.navigate(N) at the front.
    #
    # This is the safety net for phrasings that don't match any reasoning
    # verb anchor today (e.g. a future "Do this in panel 3.",
    # "Make a plan in panel 2."). It is intentionally narrow:
    # statements like "The picture in panel 3 is broken." don't match
    # the command-intent regex and continue to voice.answer.
    only_voice_answer_spans = bool(spans) and all(
        s.get("type") == "voice.answer" for s in spans
    )
    if (
        panel_suffix_target is not None
        and (not spans or only_voice_answer_spans)
    ):
        cleaned_text = _strip_panel_phrase_from_reasoning_text(reordered).strip()
        if cleaned_text and _PANEL_REASONING_FALLBACK_INTENT_RE.match(cleaned_text):
            spans = [
                {
                    "type": "reasoning.request",
                    "span": cleaned_text,
                    "payload": {
                        "text": cleaned_text,
                        "target": panel_suffix_target,
                        "raw": cleaned_text,
                        "target_from": "panel_suffix_reasoning_fallback",
                    },
                    "_anchor_start": 0,
                    "_anchor_end": len(cleaned_text),
                }
            ]
            try:
                _emit_planner_log_line({
                    "tag": "panel_suffix_reasoning_fallback_applied",
                    "raw_user_text": text[:240],
                    "cleaned_reasoning_prompt": cleaned_text[:240],
                    "target_panel_index_1based": panel_suffix_target.get("index"),
                })
            except Exception:
                pass

    # If we couldn't anchor anything, treat the utterance as a single
    # voice/reasoning action — the dispatcher's existing single-action
    # heuristic will pick the right family.
    if not spans:
        return _single_action_fallback(raw)

    # 6) Extract payloads.
    for sp in spans:
        sp["payload"] = _extract_payload_for(sp, reordered)

    # 6.5) 2026-06-02 — Drop degenerate music.play spans.
    #
    # ``_extract_payload_for`` marks any music.play action whose query
    # parsed to a stop word like "the" / "it" / "that" with
    # ``_drop_degenerate_query=True``. The narrow anchor lookahead already
    # blocks the most common shape ("play the next/previous/prev"), so
    # these only appear when a future regression slips through. Dropping
    # the action upstream means we never call Spotify search for the
    # stop word — which is what produced the apparent hallucination of a
    # real-but-unrequested track in the buggy multi-action reply.
    #
    # Each drop emits a single audit-trail log line so live regressions
    # are visible. If a drop empties the plan we fall back to the single-
    # action heuristic (which will turn the original utterance into a
    # voice.answer clarification at most), so the user still hears a
    # response instead of silence.
    pre_drop_count = len(spans)
    kept_spans: list[dict] = []
    for sp in spans:
        sp_payload = sp.get("payload") or {}
        if sp.get("type") == "music.play" and sp_payload.get("_drop_degenerate_query"):
            try:
                _emit_planner_log_line({
                    "tag": "music_play_degenerate_query_dropped",
                    "raw_user_text": text[:240],
                    "music_play_span": str(sp.get("span") or "")[:120],
                    "degenerate_query": str(sp_payload.get("query") or "")[:60],
                    "remaining_action_types_preview": [
                        s.get("type") or "?"
                        for s in spans
                        if s is not sp
                    ],
                })
            except Exception:
                pass
            continue
        kept_spans.append(sp)
    if kept_spans:
        spans = kept_spans
    elif pre_drop_count > 0:
        # Dropping emptied the plan. Fall back to single-action so the
        # dispatcher still produces a sensible reply (typically the
        # clarification stub baked into ``music.play`` payload via the
        # ``clarification_prompt`` key). We never let the user hit a
        # silent code path.
        return _single_action_fallback(raw)

    # 7) If "in panel N" suffix was detected, prepend a panel.navigate
    # action and attach target=N to any reasoning.request spans.
    if panel_suffix_target is not None:
        any_reasoning = any(s["type"] == "reasoning.request" for s in spans)
        if any_reasoning:
            # Inject panel.navigate at the front IF the first action isn't
            # already a panel.navigate/open to the same panel.
            first = spans[0]
            already_panel = first["type"] in ("panel.navigate", "panel.open") and (
                first.get("payload", {}).get("target") == panel_suffix_target
                or first["type"] == "panel.open"
            )
            if not already_panel:
                # Inject a synthetic panel.navigate whose span is a
                # fully-formed command ("go to panel N") so the dispatcher's
                # existing single-action panel-navigation detector can route
                # the span without modification. A bare "to panel N" span
                # would not match the dispatcher's regex.
                spans.insert(
                    0,
                    {
                        "type": "panel.navigate",
                        "span": f"go to panel {panel_suffix_target['index']}",
                        "payload": {"target": panel_suffix_target, "raw": "in panel suffix"},
                        "_anchor_start": -1,
                        "_anchor_end": -1,
                    },
                )
            for sp in spans:
                if sp["type"] == "reasoning.request":
                    sp["payload"]["target"] = panel_suffix_target
                    # Clean the prompt text so the downstream reasoning
                    # stream never sees "in panel N" routing tokens.
                    raw_text = (sp["payload"].get("text") or sp.get("span") or "")
                    cleaned = _strip_panel_phrase_from_reasoning_text(raw_text)
                    if cleaned and cleaned != raw_text:
                        sp["payload"]["text"] = cleaned
                        sp["payload"]["text_before_panel_strip"] = raw_text
                    # Explicit panel destination ("... in panel N"): the
                    # content task must be routed INTO that panel as a
                    # reasoning request, overriding the simple-chat
                    # shortcut downstream. See the open_and_stream
                    # dispatcher + reasoning gate force-route.
                    _idx = panel_suffix_target.get("index")
                    sp["payload"]["explicit_panel_destination"] = True
                    sp["payload"]["panel_target"] = _idx
                    sp["payload"]["content_task"] = sp["payload"].get("text") or ""
                    try:
                        _emit_planner_log_line({
                            "tag": "explicit_panel_destination",
                            "explicit_panel_destination": True,
                            "panel_target": _idx,
                            "content_task": (sp["payload"].get("text") or "")[:160],
                            "raw_user_text": raw[:240],
                        })
                        _emit_planner_log_line({
                            "tag": "content_task_extracted",
                            "content_task": (sp["payload"].get("text") or "")[:160],
                            "panel_modifier": "in_panel_number",
                            "panel_target": _idx,
                        })
                        _emit_planner_log_line({
                            "tag": "panel_target_resolved",
                            "panel_target": _idx,
                            "resolved_from": "in_panel_suffix",
                        })
                    except Exception:
                        pass

    # 7.5) Propagate panel.navigate target → sibling reasoning.request.
    # Spec PART 2: "go to panel 2, explain the Vietnam War and play lo-fi"
    # plans as [panel.navigate(2), reasoning.request("explain the Vietnam War"),
    # music.play(...)]. The reasoning.request span has no explicit "in panel N"
    # suffix, so without this propagation step the dispatcher cannot tell
    # which panel the explanation should land in. The rule: for every
    # reasoning.request that has NO explicit target, inherit the index from
    # the FIRST earlier panel.navigate in the plan that has a numeric
    # target.index. This is conservative — we never overwrite an existing
    # target (e.g. set by the "in panel N" rewrite above) and we never
    # propagate from a title-only target ({"title": "..."}). One log line
    # per propagation makes the dataflow grep-friendly.
    earlier_nav_index: int | None = None
    for sp in spans:
        if sp["type"] == "panel.navigate":
            tgt = (sp.get("payload") or {}).get("target") or {}
            if isinstance(tgt, dict):
                idx = tgt.get("index")
                if isinstance(idx, int) and idx > 0:
                    # Capture the FIRST navigation; later navigates in the
                    # same plan don't override an earlier inheritance.
                    if earlier_nav_index is None:
                        earlier_nav_index = idx
            continue
        if sp["type"] == "reasoning.request" and earlier_nav_index is not None:
            payload = sp.get("payload") or {}
            existing_target = payload.get("target")
            existing_idx = None
            if isinstance(existing_target, dict):
                existing_idx = existing_target.get("index")
            if existing_idx is None:
                payload["target"] = {"index": earlier_nav_index}
                payload["target_inherited_from"] = "sibling_panel_navigate"
                # An earlier panel.navigate(N) is itself an explicit panel
                # destination, so the inheriting reasoning.request is a
                # panel-targeted request that must override simple-chat.
                payload["explicit_panel_destination"] = True
                payload["panel_target"] = earlier_nav_index
                # Clean the prompt text so the reasoning stream never sees
                # "in panel N" routing tokens.
                raw_text = payload.get("text") or sp.get("span") or ""
                cleaned = _strip_panel_phrase_from_reasoning_text(raw_text)
                if cleaned and cleaned != raw_text:
                    payload["text"] = cleaned
                    payload["text_before_panel_strip"] = raw_text
                payload["content_task"] = payload.get("text") or ""
                sp["payload"] = payload
                try:
                    _emit_planner_log_line({
                        "tag": "reasoning_target_inherited_from_panel_navigate",
                        "reasoning_span": (sp.get("span") or "")[:160],
                        "reasoning_prompt_after_strip": (payload.get("text") or "")[:160],
                        "target_panel_index_1based": earlier_nav_index,
                    })
                except Exception:
                    pass

    _wire_compound_open_panel_reasoning(spans, raw)

    # 8) Stamp order and confidence.
    for i, sp in enumerate(spans):
        sp["order"] = i + 1
    is_multi = len(spans) > 1
    confidence = _confidence_for_anchors(anchors, reordered, spans)
    for sp in spans:
        sp["confidence"] = confidence

    # Trim internal keys.
    public_actions = [
        {
            "type": sp["type"],
            "span": sp["span"],
            "payload": sp["payload"],
            "order": sp["order"],
            "confidence": sp["confidence"],
        }
        for sp in spans
    ]
    return {
        "is_multi_action": is_multi,
        "actions": public_actions,
        "clarification_needed": False,
        "clarification_question": None,
        "reason": (
            "heuristic_multi_action_plan"
            if is_multi
            else "heuristic_single_action_plan"
        ),
    }


def _empty_plan(text: str, *, reason: str) -> dict:
    return {
        "is_multi_action": False,
        "actions": [],
        "clarification_needed": False,
        "clarification_question": None,
        "reason": reason,
    }


def _single_action_fallback(text: str) -> dict:
    """When nothing anchors, defer to the dispatcher with a single-action
    voice.answer/reasoning.request hint based on whether the text looks
    like a question vs. an explainer command."""
    t = text.strip()
    if not t:
        return _empty_plan(t, reason="empty_text")
    is_question = bool(re.search(r"\?|^(?:what|who|where|when|why|how|is|are|was|were|did|do|does|can|could|will)\b", t, re.IGNORECASE))
    family = "voice.answer" if is_question else "voice.answer"
    return {
        "is_multi_action": False,
        "actions": [
            {
                "type": family,
                "span": t,
                "payload": {"text": t},
                "order": 1,
                "confidence": 0.5,
            }
        ],
        "clarification_needed": False,
        "clarification_question": None,
        "reason": "no_action_anchor_found_defer_to_voice_answer",
    }


def _detect_checklist_play_ambiguity(text: str, anchors: list[tuple[int, str, int]]) -> str | None:
    """Return a clarification question when checklist boundary is ambiguous.

    Case we care about (test 11):
        "Add hello and play lo-fi mix to checklist"
    Here the checklist tail is at the END, and there's an embedded "play"
    BEFORE the tail. We can't tell if the user meant two list items
    ("hello", "play lo-fi mix") or two actions (checklist.add[hello] +
    music.play[lo-fi mix]). The safe move is to ask.

    We deliberately do NOT trigger when:
        "Add hello to the checklist and play lo-fi"
    (the tail is in the middle, so "play lo-fi" is unambiguously a sibling
    action) — that case is handled by ordinary anchor splitting.
    """
    m = _CHECKLIST_TAIL_RE.search(text)
    if not m:
        return None
    # Tail must be at the *end* of the utterance (allowing only trailing
    # punctuation / whitespace) — that's what creates the ambiguity.
    trailing = text[m.end():].strip().rstrip(".,;:!?")
    if trailing:
        return None
    # Look for a music-play verb in the body BEFORE the tail (not counting
    # the leading add/put).
    body = text[:m.start()].strip()
    body_low = body.lower()
    if not body_low.startswith(("add ", "put ")):
        return None
    # Strip leading "add"/"put" before scanning.
    body_after_verb = re.sub(r"^(?:add|put)\s+", "", body, flags=re.IGNORECASE)
    # Need an embedded action verb. "play" + " and " before the play.
    if re.search(r"\band\s+play\b", body_after_verb, re.IGNORECASE):
        return (
            "Do you want me to add both items to the checklist, or add the "
            "first one and play the second?"
        )
    return None


# ---------------------------------------------------------------------------
# Optional LLM upgrade hook
# ---------------------------------------------------------------------------


def _llm_plan(text: str, vera: Any) -> dict | None:
    """Ask the VERA LLM for a structured plan. Returns None on any failure
    so the deterministic fallback takes over without bubbling errors.

    The prompt deliberately mirrors the spec schema so the JSON parses
    directly. We never trust the model blindly: ``plan_user_actions`` runs
    deterministic planning AS WELL and uses the LLM result only when it
    parses cleanly AND its action count matches (or beats) the heuristic
    count — that way a hallucinated extra action can't sneak through.
    """
    if vera is None or not hasattr(vera, "build_messages") or not hasattr(vera, "generate"):
        return None
    prompt = (
        "You are a structured action planner for a voice assistant.\n\n"
        "Given the user's utterance, return ONE JSON object (no prose, no "
        "markdown) with this shape:\n"
        "{\n"
        '  "is_multi_action": bool,\n'
        '  "actions": [ { "type": <one of: panel.navigate, panel.open, '
        "panel.close, music.play, music.pause, music.resume, music.next, "
        "music.previous, music.volume, checklist.add, checklist.remove, "
        "checklist.complete, checklist.sync, voice.answer, reasoning.request>,\n"
        '    "span": <substring of the utterance>,\n'
        '    "payload": <small object with fields like target/items/query/text/direction>,\n'
        '    "order": <1-based int>,\n'
        '    "confidence": <float in [0,1]> } ],\n'
        '  "clarification_needed": bool,\n'
        '  "clarification_question": <string or null>,\n'
        '  "reason": <short snake_case string>\n'
        "}\n\n"
        "Rules:\n"
        "- 'and' inside 'milk and eggs to checklist' joins items, not actions.\n"
        "- 'and' before an action verb (play, open, close, turn up, explain, …) splits.\n"
        "- 'X after playing Y' means play Y FIRST, then X.\n"
        "- 'explain X in panel 2' means: panel.navigate(2), then reasoning.request(X, target=2).\n"
        "- If you cannot disambiguate (e.g. 'add hello and play lo-fi mix to checklist'),\n"
        "  set clarification_needed=true and write a short clarification_question.\n\n"
        f"Utterance: {text}\n\n"
        "JSON:"
    )
    try:
        msgs = vera.build_messages([], prompt)
        raw, _t = vera.generate(msgs)
    except Exception:
        return None
    # Strip code fences / leading commentary defensively.
    candidate = raw.strip()
    fence = re.search(r"\{.*\}", candidate, re.DOTALL)
    if not fence:
        return None
    try:
        parsed = json.loads(fence.group(0))
    except Exception:
        return None
    if not isinstance(parsed, dict) or "actions" not in parsed:
        return None
    # Light schema check: every action has "type".
    actions = parsed.get("actions") or []
    if not all(isinstance(a, dict) and "type" in a for a in actions):
        return None
    return parsed


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_plan(plan: dict) -> tuple[bool, list[str], str | None]:
    """Check that every action in ``plan`` has the payload its family needs.

    Returns ``(ok, errors, clarification_question)``. The clarification
    question is non-None only when validation thinks we should re-ask the
    user (currently: any missing required payload).
    """
    if not isinstance(plan, dict):
        return False, ["plan_is_not_dict"], None
    if plan.get("clarification_needed"):
        return True, [], plan.get("clarification_question")
    actions = plan.get("actions") or []
    if not actions:
        return True, [], None
    errors: list[str] = []
    for i, action in enumerate(actions):
        family = action.get("type")
        if family not in _ACTION_PAYLOAD_KEYS:
            errors.append(f"action_{i}_unknown_family_{family}")
            continue
        payload = action.get("payload") or {}
        required = _ACTION_PAYLOAD_KEYS[family]
        for key in required:
            v = payload.get(key)
            if v in (None, "", [], {}):
                # checklist.complete / .remove can also use ordinals embedded
                # in "targets"; treat empty payload as missing.
                errors.append(f"action_{i}_{family}_missing_{key}")
        if family == "music.volume":
            if not payload.get("direction") and payload.get("level") is None:
                errors.append(f"action_{i}_music_volume_missing_direction_or_level")
        if family == "panel.navigate":
            target = payload.get("target") or {}
            if not target or (target.get("index") is None and not target.get("title")):
                errors.append(f"action_{i}_panel_navigate_missing_target")
    if errors:
        return False, errors, (
            "I'm not sure I got every part — could you say which "
            "command(s) you want first?"
        )
    return True, [], None


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def plan_user_actions(
    text: str, *, vera: Any | None = None, context: dict | None = None
) -> dict:
    """Return a structured action plan for ``text``.

    Always returns a dict matching the schema documented at the top of this
    module. Never raises (any internal failure is logged + downgrades to the
    deterministic backbone or a single-action fallback).

    2026-05-29 Option B note: the ``vera`` argument is accepted for API
    compatibility but is IGNORED unless the module-level flag
    ``ENABLE_LLM_MULTI_ACTION_PLANNER`` is True. With the flag at its
    default value (False), every call returns the deterministic backbone
    plan and ``_choose_plan`` is reduced to a passthrough. This guarantees
    live ``/infer`` execution sees exactly what the smoke tests see.
    """
    raw = (text or "").strip()
    if not raw:
        return _empty_plan(raw, reason="empty_text")

    triggered, trigger_reason = should_trigger_planner(raw)

    det_plan = _heuristic_plan(raw)

    # 2026-05-29 Option B — the LLM upgrade hook is OFF by default. The
    # deterministic backbone is the source of truth for live execution.
    # The flag ``ENABLE_LLM_MULTI_ACTION_PLANNER`` (top of module) lets
    # us re-enable the hook later once the prompt + ``_choose_plan``
    # acceptance logic are hardened, without touching call sites.
    llm_plan = None
    if (
        ENABLE_LLM_MULTI_ACTION_PLANNER
        and vera is not None
        and (triggered or det_plan["is_multi_action"])
    ):
        try:
            llm_plan = _llm_plan(raw, vera)
        except Exception:
            llm_plan = None

    chosen, choice_reason = _choose_plan(det_plan, llm_plan, triggered=triggered)

    # Always attach the trigger reason so the dispatcher's log can show why
    # we even ran the planner.
    chosen.setdefault("reason", choice_reason)
    chosen["trigger_reason"] = trigger_reason
    try:
        print(
            "[multi_action_plan] "
            + json.dumps(
                {
                    "raw_user_text": raw[:240],
                    "triggered": bool(triggered),
                    "trigger_reason": trigger_reason,
                    "is_multi_action": bool(chosen.get("is_multi_action")),
                    "actions": [
                        {
                            "type": (a or {}).get("type"),
                            "span": ((a or {}).get("span") or "")[:160],
                            "payload": (a or {}).get("payload") or {},
                            "confidence": (a or {}).get("confidence"),
                        }
                        for a in (chosen.get("actions") or [])
                    ],
                    "reason": chosen.get("reason") or "",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass

    # Diagnostic: gate fired but only one (or zero) anchor matched. This
    # is the symptom pattern from the live music-volume bug — the user
    # said something like "turn up the music and then play X", the gate
    # fired on the "and play" RHS, but only one anchor was found because
    # "turn up the music" wasn't a known volume wording. The text before
    # the first anchor (or after the last one) is silently dropped by
    # the splitter, so flagging it here helps catch future regressions
    # without needing live repro.
    if triggered and trigger_reason in (
        "connector_with_action_verb_rhs",
        "connector_and_multi_family",
        "after_gerund_connector",
    ):
        try:
            anchors_dbg = _find_action_anchors(raw)
            actions_dbg = chosen.get("actions") or []
            if len(anchors_dbg) <= 1:
                dropped_prefix = ""
                dropped_suffix = ""
                if anchors_dbg:
                    first_start = anchors_dbg[0][0]
                    last_end = anchors_dbg[-1][2]
                    dropped_prefix = raw[:first_start]
                    if last_end < len(raw):
                        # Last span by convention extends to end-of-text in
                        # _split_into_spans, so this is usually empty. We
                        # still surface it for completeness.
                        dropped_suffix = ""
                else:
                    dropped_prefix = raw
                log_obj = {
                    "tag": "planner_single_anchor_in_connector_text",
                    "transcript": raw[:240],
                    "trigger_reason": trigger_reason,
                    "anchors_found": len(anchors_dbg),
                    "spans_found": len(actions_dbg),
                    "dropped_prefix_text": dropped_prefix[:160],
                    "dropped_suffix_text": dropped_suffix[:160],
                    "final_plan_actions": [a.get("type") for a in actions_dbg],
                }
                _emit_planner_log_line(log_obj)
        except Exception:
            pass

    # Diagnostic: ``music.volume`` anchor matched — surface the wording
    # target (music vs volume) and the resolved direction so live logs
    # show whether the planner is making the colloquial "turn up the
    # music" / "turn up the volume" distinction we widened the regex for.
    try:
        for a in chosen.get("actions") or []:
            if a.get("type") == "music.volume":
                span_txt = (a.get("span") or "").lower()
                target = "music" if re.search(r"\bmusic\b", span_txt) else (
                    "volume" if re.search(r"\bvolume\b", span_txt) else "unknown"
                )
                pay = a.get("payload") or {}
                _emit_planner_log_line({
                    "tag": "music_volume_anchor_matched",
                    "music_volume_target": target,
                    "music_volume_direction": pay.get("direction"),
                    "music_volume_level": pay.get("level"),
                    "span": (a.get("span") or "")[:160],
                    "planner_actions": [x.get("type") for x in chosen.get("actions") or []],
                    "planner_trigger_reason": trigger_reason,
                })
    except Exception:
        pass

    return chosen


def _emit_planner_log_line(obj: dict) -> None:
    """Write a single ``[planner] {json}`` line. Never raises."""
    try:
        import json as _json
        import sys as _sys
        print(f"[planner] {_json.dumps(obj, ensure_ascii=False)}", file=_sys.stdout, flush=True)
    except Exception:
        pass


def _choose_plan(
    det_plan: dict, llm_plan: dict | None, *, triggered: bool
) -> tuple[dict, str]:
    """Pick between LLM and deterministic plans.

    Preference order:
      1. If LLM produced a parseable multi-action plan with action count
         >= deterministic AND every action is a known family, use it.
      2. Otherwise use the deterministic plan.

    With ``ENABLE_LLM_MULTI_ACTION_PLANNER`` False (the 2026-05-29 Option
    B default), ``plan_user_actions`` never passes a non-None
    ``llm_plan`` here, so the function degrades to a passthrough that
    returns the deterministic plan with ``reason="deterministic_plan"``.
    """
    if llm_plan is not None:
        actions = llm_plan.get("actions") or []
        if (
            isinstance(actions, list)
            and all(a.get("type") in _ACTION_PAYLOAD_KEYS for a in actions)
            and len(actions) >= len(det_plan.get("actions") or [])
        ):
            llm_plan.setdefault("is_multi_action", len(actions) > 1)
            llm_plan.setdefault("clarification_needed", False)
            llm_plan.setdefault("clarification_question", None)
            return llm_plan, "llm_plan_accepted"
        return det_plan, "llm_plan_rejected_used_deterministic"
    return det_plan, ("deterministic_plan" if triggered else "deterministic_single_action_or_no_trigger")


# ---------------------------------------------------------------------------
# Structured log
# ---------------------------------------------------------------------------


def log_planner(
    *,
    raw_user_text: str,
    plan: dict,
    triggered: bool,
    trigger_reason: str,
    validation_results: dict | None = None,
    context_before: dict | None = None,
    context_after: dict | None = None,
    greedy_router_skipped: bool = False,
    final_confirmation: str = "",
    note: str = "",
) -> None:
    """Single grep target ``[planner]``. Emits one JSON line.

    Fields mirror the spec:
        raw_user_text, planner_triggered, planner_trigger_reason,
        planner_json, is_multi_action, actions_planned,
        action_validation_results, planner_confidence,
        clarification_needed, execution_order,
        context_before_each_action, context_after_each_action,
        greedy_router_skipped, final_confirmation.
    """
    try:
        actions = plan.get("actions") or []
        confidence = 0.0
        if actions:
            confidence = sum(float(a.get("confidence") or 0) for a in actions) / max(
                1, len(actions)
            )
        payload = {
            "raw_user_text": (raw_user_text or "")[:240],
            "planner_triggered": bool(triggered),
            "planner_trigger_reason": (trigger_reason or "")[:80],
            "is_multi_action": bool(plan.get("is_multi_action")),
            "actions_planned": [
                {
                    "order": a.get("order"),
                    "type": a.get("type"),
                    "span": (a.get("span") or "")[:120],
                    "payload": _slim_payload(a.get("payload") or {}),
                    "confidence": a.get("confidence"),
                }
                for a in actions
            ],
            "action_validation_results": validation_results or {},
            "planner_confidence": round(confidence, 3),
            "clarification_needed": bool(plan.get("clarification_needed")),
            "clarification_question": plan.get("clarification_question"),
            "execution_order": [a.get("order") for a in actions],
            "context_before_each_action": context_before or {},
            "context_after_each_action": context_after or {},
            "greedy_router_skipped": bool(greedy_router_skipped),
            "final_confirmation": (final_confirmation or "")[:200],
            "planner_reason": (plan.get("reason") or "")[:80],
            "note": (note or "")[:160],
            "ts": int(time.time() * 1000),
        }
        print("[planner] " + json.dumps(payload, ensure_ascii=False), flush=True)
    except Exception:
        try:
            print("[planner] log_serialization_failed", flush=True)
        except Exception:
            pass


def _slim_payload(payload: dict) -> dict:
    """Drop noisy/internal keys from the logged payload so the line stays
    readable in a terminal tail."""
    drop = {"raw"}
    out: dict[str, Any] = {}
    for k, v in (payload or {}).items():
        if k in drop:
            continue
        if isinstance(v, str) and len(v) > 80:
            out[k] = v[:80] + "…"
        else:
            out[k] = v
    return out


# Backwards-compat aliases — keep the underscore-prefixed name working in case
# other modules already grep for it.
_log_planner = log_planner


__all__ = [
    "should_trigger_planner",
    "plan_user_actions",
    "validate_plan",
    "log_planner",
    "ACTION_ANCHORS",
    "ENABLE_LLM_MULTI_ACTION_PLANNER",
]
