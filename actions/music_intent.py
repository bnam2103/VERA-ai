"""actions/music_intent.py — shared normalizer for "play X" utterances.

The 2026-05-29 multi-action spec asks for a single normalized music intent
shared by:

  * ``actions.multi_action_planner`` — to fill the music.play payload with
    ``play_kind / source / query`` so the dispatcher can route by kind
    instead of guessing again from the raw span.

  * ``app._dispatch_planned_action_directly`` — to switch on ``play_kind``
    and call the same single-action handlers ("play X" said on its own
    used to take), keeping behavior parity between the single-action and
    multi-action code paths.

The normalized intent always carries the ORIGINAL raw span plus the
``query_before_cleanup`` / ``query_after_cleanup`` pair so the planner
log can show what we stripped. Tests and dispatcher code should treat
the returned dict as the source of truth — do NOT re-parse the raw span
downstream.

Output shape (all keys always present):

    {
      "play_kind": "builtin" | "track" | "album" | "playlist_by_name" | "resume",
      "source": "builtin" | "spotify",
      "query": str,
      "raw_span": str,
      "query_before_cleanup": str,
      "query_after_cleanup": str,
      "playlist_scope_phrase": str,   # "" unless an "in/from my playlist" tail fired
      "confidence": float in [0, 1],
    }

The parser is intentionally PURE-PYTHON. It tries to import the built-in
catalog detector from ``actions.music`` lazily; when that module isn't
importable yet (e.g. during unit tests that exercise the parser in
isolation), built-in detection downgrades to keyword matching and the
caller still gets a usable ``play_kind`` value.
"""

from __future__ import annotations

import re
from typing import Any

# Strip leading "play" verb + the polite filler that often precedes it.
# We intentionally accept "start", "put on", "turn on" because those map
# to the same "play X" intent in spoken language.
# Leading verb + polite filler stripper. Captures the matched verb so the
# verdict layer can tell STRONG media verbs (play / put on / listen to / throw
# on / queue up / spin up / start playing / begin playing — title-only OK) from
# WEAK verbs (start / begin / turn on — only music with an explicit cue). Mirrors
# the coverage of the old ``play X by Y`` route regex: optional "hey vera," lead
# in, and "(can|could|would|will) you (please)?" / "please" courtesy prefixes.
# Longer verbs ("start playing") are listed BEFORE their bare forms ("start").
_LEADING_PLAY_RE = re.compile(
    r"^\s*(?:hey\s+vera[,\s]+)?(?:please\s+)?"
    r"(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|please\s+)?"
    r"(?P<verb>play|put\s+on|listen\s+to|throw\s+on|queue\s+up|spin\s+up|"
    r"start\s+playing|begin\s+playing|start|begin|turn\s+on)\b\s*",
    re.IGNORECASE,
)

# Verbs that, on their own, do NOT imply music — they only count as a play
# request when paired with a music cue (builtin/album/playlist phrasing or a
# music-domain noun). Keeps "start a timer" / "turn on the lights" out of music.
_WEAK_PLAY_VERBS = frozenset({"start", "begin", "turn on"})

_MUSIC_CUE_NOUN_RE = re.compile(
    r"\b(?:music|song|songs|track|tracks|album|albums|playlist|playlists|"
    r"lo[-\s]?fi|lofi|spotify|playback|tune|tunes|radio|station|mix|beats|"
    r"white\s*noise|brown\s*noise|rain\s*sounds?|ambient)\b",
    re.IGNORECASE,
)

# Resume-only verb. Must match the whole span so "resume Spotify and
# turn up the volume" doesn't get classified as resume (the planner
# already split that out before calling us).
_RESUME_FULL_RE = re.compile(
    r"^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?"
    r"(?:resume|continue|unpause)\s*"
    r"(?:spotify|music|the\s+music|playback|the\s+playback|"
    r"the\s+track|the\s+song|built[-\s]?in|builtin)?\s*[?.!]*\s*$",
    re.IGNORECASE,
)

# "switch back to built-in" / "play built-in music" → resume builtin if
# something was suspended, otherwise built-in is handled by the standard
# play_kind=builtin path. We only mark resume for the explicit "resume"
# verb to keep the contract narrow (per spec rule 4).
_RESUME_SOURCE_HINT_RE = re.compile(
    r"\b(?:spotify|builtin|built[-\s]?in)\b",
    re.IGNORECASE,
)

# Playlist-scope tail: "X in my playlist", "X from the playlist", etc.
# Per the 2026-05-29 spec, this means X IS THE PLAYLIST NAME — not a
# track search inside an unspecified playlist. We capture the matched
# phrase so the planner can echo it back in its debug log.
_PLAYLIST_SCOPE_RE = re.compile(
    r"\b(?P<phrase>(?:in|from|on|within)\s+(?:my|the|this|that|our)\s+playlist|"
    r"(?:in|from|on|within)\s+playlist|"
    r"(?:in|from)\s+(?:my|the|this|that|our)\s+list)\b",
    re.IGNORECASE,
)

# "playlist X" / "my playlist X" / "play playlist Peak".
_PLAYLIST_PREFIX_RE = re.compile(
    r"^(?:my\s+|the\s+)?playlist\s+(?P<name>.+?)\s*$",
    re.IGNORECASE,
)

# "my X playlist" / "the X playlist" — possessive/determiner + name + noun.
_NAMED_PLAYLIST_SUFFIX_RE = re.compile(
    r"^(?:my|the|our)\s+(?P<name>.+?)\s+playlist\s*$",
    re.IGNORECASE,
)

# "the album X" / "album X by Y". Captures everything after "album ".
_ALBUM_PREFIX_RE = re.compile(
    r"^(?:the\s+)?album\s+(?P<rest>.+)$",
    re.IGNORECASE,
)

# Leading article we don't want to send to Spotify's search.
# Mirrors the planner's _MUSIC_QUERY_LEADING_ARTICLE_RE so they agree
# on whether "the lo-fi mix" → "lo-fi mix" (yes) vs "The Beatles" → keep.
_LEADING_ARTICLE_RE = re.compile(
    r"^(?:the|a|an|some)\s+(?=[a-z0-9])",
)

# Trailing punctuation / "and …" we want to drop after splitting on the
# playlist-scope phrase. The planner already trims most of this but the
# parser is also called directly from the dispatcher for safety.
_TRAILING_NOISE_RE = re.compile(
    r"\s+(?:and|then|after\s+that|also|plus|but|so|next)\s*$",
    re.IGNORECASE,
)

# Last-resort built-in keywords used when ``actions.music`` isn't
# importable. The real catalog match runs first; this fallback is
# never the source of truth for production routing.
_BUILTIN_KEYWORDS_RE = re.compile(
    r"\b(?:lo[-\s]?fi(?:\s+(?:mix|beats|playlist|music))?|"
    r"brown\s*noise|white\s*noise|rain\s*(?:sound|noise)?|"
    r"thunder(?:storm)?|ambient(?:\s+mix)?)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# 2026-06-14 — shared music.play VERDICT layer.
#
# ``normalize_music_play_request`` is the single source of truth consumed by
# BOTH the multi-action planner and the legacy single-action route. It wraps
# the pure-Python ``_classify_play_span`` classifier (the historical
# ``parse_music_play_intent`` body) and adds a ``status`` verdict plus the
# unsupported / clarification detectors so callers no longer scatter their own
# regexes. ``parse_music_play_intent`` is now a thin wrapper that returns only
# the legacy-shaped subset, so existing consumers/tests are byte-for-byte
# unchanged.
# ---------------------------------------------------------------------------

_CLARIFY_QUESTION = "What would you like me to play?"

# Degenerate "play X" queries that must NEVER hit Spotify search — we ask the
# user what to play instead of guessing a top result (decision 1). Superset of
# the planner's stop-word set so "play something" clarifies on both paths.
_CLARIFY_PLAY_QUERY_SET = frozenset({
    "",
    "the", "a", "an", "some", "it", "that", "this",
    "something", "anything", "some music", "any music", "a song", "the song",
    "some songs", "a track", "some tunes", "whatever", "anything good",
})

# Common "play X" idioms that are NOT music requests. Returning ``not_music``
# lets the legacy route fall through to general chat exactly as it does today
# (the verb-stripped body is matched against this set, lowercased).
_IDIOM_PLAY_BODY_SET = frozenset({
    "it cool", "it safe", "safe", "it by ear", "by ear", "hard to get", "hard ball",
    "hardball", "along", "dumb", "dead", "house", "pretend", "nice", "fair",
    "favorites", "favourites", "the field", "devil's advocate",
    "devils advocate", "second fiddle", "matchmaker", "ball", "catch",
    "possum", "hooky", "god", "the victim", "the fool", "coy",
})

# Scheduling tails that VERA cannot honor yet ("play music in 15 minutes").
# Kept deliberately conservative so single-word song titles ("Tomorrow",
# "Tonight") do not get swallowed — the soft tokens only fire when preceded
# by other content (see ``_detect_unsupported_timing``).
_UNSUPPORTED_SCHED_HARD_RE = re.compile(
    r"\b(?:in|after)\s+\d+\s*(?:second|sec|minute|min|hour|hr|day|week)s?\b"
    r"|\b(?:in|after)\s+(?:a|an|half\s+an?|a\s+few|a\s+couple\s+of)\s+"
    r"(?:second|minute|hour|day|week)s?\b"
    r"|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b"
    r"|\bat\s+(?:noon|midnight)\b",
    re.IGNORECASE,
)
_UNSUPPORTED_RECUR_RE = re.compile(
    r"\bevery\s+(?:morning|day|night|evening|afternoon|hour|week|weekday|"
    r"weekend|other\s+day|\d+\s*(?:minute|hour|day)s?)\b"
    r"|\b(?:daily|hourly|weekly|nightly)\b"
    r"|\beach\s+(?:morning|day|night|evening)\b",
    re.IGNORECASE,
)
_UNSUPPORTED_COND_RE = re.compile(
    r"\b(?:when|after|once|as\s+soon\s+as)\s+"
    r"(?:the\s+|my\s+|this\s+|that\s+|current\s+)?"
    r"(?:timer|alarm|countdown|song|track|one)\b",
    re.IGNORECASE,
)
_UNSUPPORTED_SCHED_SOFT_RE = re.compile(
    r"\b(?:tomorrow|tonight|later|this\s+(?:morning|afternoon|evening|weekend)|"
    r"next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
    r"morning))\b",
    re.IGNORECASE,
)


# "play (the) next/previous/prev [song]" and "play (the) last song" are
# TRANSPORT commands, not media requests. Mirrors the planner's music.play
# anchor lookahead so the legacy single-action route defers these to the
# existing next/previous handlers instead of doing a bogus track search.
_PLAY_TRANSPORT_RE = re.compile(
    r"^\s*(?:please\s+)?"
    r"(?:(?:can|could|would|will)\s+(?:you|u)\s+(?:please\s+)?|please\s+)?"
    r"(?:play|put\s+on|go)\s+(?:to\s+)?(?:the\s+)?"
    r"(?:(?:next|previous|prev)(?:\s+(?:song|track|one))?"
    r"|last\s+(?:song|track|one))\b",
    re.IGNORECASE,
)


def _detect_timing_kind_and_phrase(
    body: str, *, require_content_before_soft: bool = True
) -> tuple[str | None, str]:
    """Return ``(timing_kind, phrase)`` for an unsupported scheduling tail.

    ``timing_kind`` is ``scheduling`` / ``recurrence`` / ``conditional`` or
    ``None``. ``phrase`` is the human-readable modifier span (e.g.
    ``"in 10 minutes"``, ``"when the timer ends"``) captured from the first
    match position to the end of ``body`` so the spoken reply can echo it.

    Soft tokens (tomorrow/tonight/later) only fire when there is real content
    before them IF ``require_content_before_soft`` — this protects one-word
    song titles for ``music.play``. Transport/volume families pass the whole
    span (the verb itself supplies the preceding content), so the guard still
    holds without stripping.
    """
    s = (body or "").strip()
    if not s:
        return None, ""
    m = _UNSUPPORTED_SCHED_HARD_RE.search(s)
    if m:
        return "scheduling", s[m.start():].strip()
    m = _UNSUPPORTED_RECUR_RE.search(s)
    if m:
        return "recurrence", s[m.start():].strip()
    m = _UNSUPPORTED_COND_RE.search(s)
    if m:
        return "conditional", s[m.start():].strip()
    m = _UNSUPPORTED_SCHED_SOFT_RE.search(s)
    if m and (not require_content_before_soft or s[: m.start()].strip()):
        return "scheduling", s[m.start():].strip()
    return None, ""


def _detect_unsupported_timing(body: str) -> str | None:
    """Return ``scheduling`` / ``recurrence`` / ``conditional`` or ``None``.

    Operates on the verb-stripped body so leading "play"/"listen to" never
    counts as content. Soft tokens (tomorrow/tonight/later) only fire when
    there is real content before them, protecting one-word titles.
    """
    return _detect_timing_kind_and_phrase(body)[0]


# Per-family capability reason strings surfaced in payload metadata so the
# pre-execution gate and logs can tell *why* an action was blocked.
_MUSIC_UNSUPPORTED_REASON: dict[str, str] = {
    "music.play": "delayed_play_not_supported",
    "music.pause": "delayed_transport_not_supported",
    "music.resume": "delayed_transport_not_supported",
    "music.next": "delayed_transport_not_supported",
    "music.previous": "delayed_transport_not_supported",
    "music.volume": "delayed_volume_not_supported",
}


def detect_music_unsupported_modifier(
    span: str, family: str
) -> dict[str, Any] | None:
    """Detect an unsupported scheduling/recurrence/conditional modifier.

    Shared by every immediate music action (play + transport + volume). Returns
    ``None`` when the span is a plain immediate command, otherwise::

        {
          "unsupported": True,
          "reason": "delayed_transport_not_supported",
          "timing_kind": "scheduling" | "recurrence" | "conditional",
          "phrase": "in 10 minutes",
          "family": "music.pause",
        }

    For ``music.play`` the leading play verb is stripped first so one-word
    titles ("Tomorrow") stay protected; transport/volume families scan the
    whole span (the verb supplies content before any soft token).
    """
    s = (span or "").strip()
    if not s:
        return None
    if family == "music.play":
        body = _LEADING_PLAY_RE.sub("", s, count=1).strip().strip(".,;:!?").strip()
        kind, phrase = _detect_timing_kind_and_phrase(
            body, require_content_before_soft=True
        )
    else:
        kind, phrase = _detect_timing_kind_and_phrase(
            s, require_content_before_soft=True
        )
    if not kind:
        return None
    return {
        "unsupported": True,
        "reason": _MUSIC_UNSUPPORTED_REASON.get(
            family, "delayed_music_action_not_supported"
        ),
        "timing_kind": kind,
        "phrase": phrase,
        "family": family,
    }


def _is_clarification_play_query(query: str) -> bool:
    s = (query or "").strip().lower()
    s = re.sub(r"[\.\!\?\,;:]+$", "", s).strip()
    return s in _CLARIFY_PLAY_QUERY_SET


def normalize_music_play_request(
    text: str, *, context: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Single source of truth for a ``play X`` request.

    Returns the legacy classifier dict (so ``play_kind`` / ``source`` /
    ``query`` / ``playlist_scope_phrase`` / ``builtin_match`` behave exactly as
    before) PLUS a verdict layer:

      * ``status``           — ``ready`` | ``needs_clarification`` |
                               ``unsupported`` | ``not_music``
      * ``unsupported_reason`` — ``scheduling`` | ``recurrence`` |
                               ``conditional`` | ``None``
      * ``clarification_question`` — text to speak, or ``None``
      * ``title`` / ``artist`` / ``album`` — split for track/album kinds
      * ``playlist_context`` — mirrors ``playlist_scope_phrase`` (or ``None``)

    The same verdict is produced for ``play Feather`` standalone and for the
    ``play Feather`` span the planner hands us inside a compound, guaranteeing
    single-action / multi-action parity.
    """
    raw = (text or "").strip()
    core = _classify_play_span(raw)

    verdict: dict[str, Any] = dict(core)
    verdict["status"] = "ready"
    verdict["unsupported_reason"] = None
    verdict["clarification_question"] = None
    verdict["title"] = None
    verdict["artist"] = None
    verdict["album"] = None
    verdict["playlist_context"] = core.get("playlist_scope_phrase") or None

    if not raw:
        verdict["status"] = "needs_clarification"
        verdict["clarification_question"] = _CLARIFY_QUESTION
        return verdict

    play_kind = core.get("play_kind")

    # Resume stays a ready transport command — no scheduling/clarify checks.
    if play_kind == "resume":
        return verdict

    m_lead = _LEADING_PLAY_RE.match(raw)
    leading_matched = bool(m_lead)
    verb = re.sub(r"\s+", " ", (m_lead.group("verb") if m_lead else "") or "").strip().lower()
    body = _LEADING_PLAY_RE.sub("", raw, count=1).strip().strip(".,;:!?").strip()
    body_l = body.lower()

    # Transport phrasing ("play next", "play the previous song", "play the last
    # track") is not a media request — defer to the next/previous handlers.
    if _PLAY_TRANSPORT_RE.match(raw):
        verdict["status"] = "not_music"
        return verdict

    # Not a music request: no play verb fired and no music cue resolved.
    if not leading_matched and play_kind == "track" and not core.get("builtin_match"):
        verdict["status"] = "not_music"
        return verdict

    # Weak verbs ("start"/"begin"/"turn on") only count as music when there is
    # an explicit cue — otherwise "start a timer" would become a track search.
    if verb in _WEAK_PLAY_VERBS:
        has_cue = bool(
            core.get("builtin_match")
            or play_kind in {"album", "playlist_by_name", "builtin"}
            or _MUSIC_CUE_NOUN_RE.search(body)
        )
        if not has_cue:
            verdict["status"] = "not_music"
            return verdict

    if body_l in _IDIOM_PLAY_BODY_SET:
        verdict["status"] = "not_music"
        return verdict

    # Unsupported scheduling / recurrence / conditional tail.
    reason = _detect_unsupported_timing(body)
    if reason:
        verdict["status"] = "unsupported"
        verdict["unsupported_reason"] = reason
        return verdict

    # Degenerate "play something" → ask what to play (decision 1).
    if _is_clarification_play_query(core.get("query") or ""):
        verdict["status"] = "needs_clarification"
        verdict["clarification_question"] = _CLARIFY_QUESTION
        return verdict

    # Split title/artist (track) or album/artist for richer downstream slots.
    if play_kind == "track":
        title, artist = parse_title_by_artist(core.get("query") or "")
        verdict["title"] = title or None
        verdict["artist"] = artist
    elif play_kind == "album":
        album, artist = parse_title_by_artist(core.get("query") or "")
        verdict["album"] = album or None
        verdict["artist"] = artist

    return verdict


def parse_title_by_artist(text: str) -> tuple[str, str | None]:
    """Split ``… by …`` (title vs artist) — local mirror of actions.music.

    Defined here (not imported) so the normalizer stays importable in isolated
    unit runs where ``actions.music`` may not load.
    """
    s = (text or "").strip().strip("?.!")
    if not s:
        return "", None
    m = re.search(r"^(.+?)\s+by\s+(.+)$", s, flags=re.IGNORECASE)
    if not m:
        return s, None
    return m.group(1).strip(), m.group(2).strip()


def parse_music_play_intent(raw_span: str) -> dict[str, Any]:
    """Thin wrapper — returns only the legacy-shaped subset of the verdict.

    Existing planner / dispatcher / test consumers read these keys; the verdict
    adds extra keys on top via ``normalize_music_play_request``.
    """
    verdict = normalize_music_play_request(raw_span)
    legacy = {
        "play_kind": verdict.get("play_kind"),
        "source": verdict.get("source"),
        "query": verdict.get("query"),
        "raw_span": verdict.get("raw_span"),
        "query_before_cleanup": verdict.get("query_before_cleanup"),
        "query_after_cleanup": verdict.get("query_after_cleanup"),
        "playlist_scope_phrase": verdict.get("playlist_scope_phrase"),
        "confidence": verdict.get("confidence"),
    }
    if verdict.get("builtin_match") is not None:
        legacy["builtin_match"] = verdict["builtin_match"]
    return legacy


def _classify_play_span(raw_span: str) -> dict[str, Any]:
    """Pure classifier (historical ``parse_music_play_intent`` body).

    Always returns valid legacy keys — empty strings / fallback confidence
    rather than raising — so the verdict layer can build on top.
    """
    raw_span_str = (raw_span or "").strip()
    if not raw_span_str:
        return {
            "play_kind": "track",
            "source": "spotify",
            "query": "",
            "raw_span": "",
            "query_before_cleanup": "",
            "query_after_cleanup": "",
            "playlist_scope_phrase": "",
            "confidence": 0.0,
        }

    # 1) Resume? Match against the whole span so "resume music and skip"
    #    doesn't sneak through (the planner already split that).
    m_resume = _RESUME_FULL_RE.match(raw_span_str)
    if m_resume:
        hint = _RESUME_SOURCE_HINT_RE.search(raw_span_str)
        source = "spotify"
        if hint and re.search(r"built[-\s]?in|builtin", hint.group(0), re.IGNORECASE):
            source = "builtin"
        return {
            "play_kind": "resume",
            "source": source,
            "query": "",
            "raw_span": raw_span_str,
            "query_before_cleanup": raw_span_str,
            "query_after_cleanup": "",
            "playlist_scope_phrase": "",
            "confidence": 0.95,
        }

    # 2) Strip the leading verb so further regexes can anchor on ^name.
    body = _LEADING_PLAY_RE.sub("", raw_span_str, count=1).strip().strip(".,;:!?").strip()
    query_before_cleanup = body
    if not body:
        return {
            "play_kind": "track",
            "source": "spotify",
            "query": "",
            "raw_span": raw_span_str,
            "query_before_cleanup": "",
            "query_after_cleanup": "",
            "playlist_scope_phrase": "",
            "confidence": 0.3,
        }

    # 3) Album phrasing wins before the bare-noun fallback because
    #    "album Blonde by Frank Ocean" would otherwise look like a track.
    m_album = _ALBUM_PREFIX_RE.match(body)
    if m_album:
        rest = m_album.group("rest").strip().strip(".,;:!?")
        return {
            "play_kind": "album",
            "source": "spotify",
            "query": rest,
            "raw_span": raw_span_str,
            "query_before_cleanup": query_before_cleanup,
            "query_after_cleanup": rest,
            "playlist_scope_phrase": "",
            "confidence": 0.9,
        }

    # 4) Playlist-scope tail: "play X in my playlist" / "from my list".
    #    Per the spec, X is the playlist name — strip the tail BEFORE
    #    other regexes run so the remaining `body` is just the name.
    m_scope = _PLAYLIST_SCOPE_RE.search(body)
    if m_scope:
        phrase = m_scope.group("phrase")
        stripped = (body[: m_scope.start()] + body[m_scope.end():]).strip()
        # Drop any trailing connector / punctuation that bled in from
        # the planner's split boundary.
        prev = None
        while stripped and stripped != prev:
            prev = stripped
            stripped = _TRAILING_NOISE_RE.sub("", stripped).strip(".,;:!? ").strip()
        # Strip a leading article ("the Peak" → "Peak").
        cleaned = _LEADING_ARTICLE_RE.sub("", stripped, count=1).strip()
        query = cleaned or stripped
        return {
            "play_kind": "playlist_by_name",
            "source": "spotify",
            "query": query,
            "raw_span": raw_span_str,
            "query_before_cleanup": query_before_cleanup,
            "query_after_cleanup": query,
            "playlist_scope_phrase": phrase,
            "confidence": 0.95,
        }

    # 5) Explicit playlist-prefix phrasing: "playlist Peak" / "my
    #    playlist Peak".
    m_prefix = _PLAYLIST_PREFIX_RE.match(body)
    if m_prefix:
        name = m_prefix.group("name").strip().strip(".,;:!?")
        return {
            "play_kind": "playlist_by_name",
            "source": "spotify",
            "query": name,
            "raw_span": raw_span_str,
            "query_before_cleanup": query_before_cleanup,
            "query_after_cleanup": name,
            "playlist_scope_phrase": "",
            "confidence": 0.9,
        }

    # 6) Named-playlist suffix: "my Peak playlist" / "the Peak playlist".
    m_named = _NAMED_PLAYLIST_SUFFIX_RE.match(body)
    if m_named:
        name = m_named.group("name").strip().strip(".,;:!?")
        return {
            "play_kind": "playlist_by_name",
            "source": "spotify",
            "query": name,
            "raw_span": raw_span_str,
            "query_before_cleanup": query_before_cleanup,
            "query_after_cleanup": name,
            "playlist_scope_phrase": "",
            "confidence": 0.85,
        }

    # 7) Built-in: check the production catalog first, fall back to a
    #    keyword regex so the parser works even if actions.music can't
    #    be imported (e.g. in isolated test runs).
    builtin_match: dict[str, Any] | None = None
    try:
        from actions.music import match_builtin_productivity_music  # local import
        builtin_match = match_builtin_productivity_music(body)
    except Exception:
        builtin_match = None
    if builtin_match is None and _BUILTIN_KEYWORDS_RE.search(body):
        builtin_match = {"kind": "playlist", "id": "lofi_mix", "_fallback": True}

    # Strip leading article so the track-search query reads cleanly.
    # (For built-in we keep the original `body` so the catalog matcher
    # still has a chance to fire downstream if needed.)
    cleaned_body = _LEADING_ARTICLE_RE.sub("", body, count=1).strip()
    if not cleaned_body:
        cleaned_body = body

    if builtin_match is not None:
        return {
            "play_kind": "builtin",
            "source": "builtin",
            "query": cleaned_body or body,
            "raw_span": raw_span_str,
            "query_before_cleanup": query_before_cleanup,
            "query_after_cleanup": cleaned_body or body,
            "playlist_scope_phrase": "",
            "builtin_match": builtin_match,
            "confidence": 0.9,
        }

    # 8) Default: Spotify track search.
    return {
        "play_kind": "track",
        "source": "spotify",
        "query": cleaned_body,
        "raw_span": raw_span_str,
        "query_before_cleanup": query_before_cleanup,
        "query_after_cleanup": cleaned_body,
        "playlist_scope_phrase": "",
        "confidence": 0.7,
    }


__all__ = [
    "normalize_music_play_request",
    "parse_music_play_intent",
    "parse_title_by_artist",
    "detect_music_unsupported_modifier",
]
