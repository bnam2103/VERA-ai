"""Structured music actions: open panel + search-first play via client-credentials API."""

from __future__ import annotations

import json
import re

from actions.spotify_search import (
    SpotifyNotConfiguredError,
    SpotifyUpstreamError,
    search_albums_normalized,
    search_tracks_normalized,
)


def artist_line(track: dict) -> str:
    artists = track.get("artists") or []
    names = [a.get("name", "") for a in artists if isinstance(a, dict) and a.get("name")]
    return ", ".join(names)


def build_music_search_query(slots: dict) -> str:
    track = (slots.get("track") or slots.get("song") or "").strip()
    artist = (slots.get("artist") or "").strip()
    query_slot = (slots.get("query") or "").strip()
    if query_slot:
        return query_slot
    if track and artist:
        return f"{track} {artist}"
    return track or artist


def build_music_album_query(slots: dict) -> str:
    album = (slots.get("album") or slots.get("album_name") or "").strip()
    artist = (slots.get("artist") or "").strip()
    query_slot = (slots.get("query") or "").strip()
    if query_slot:
        return query_slot
    if album and artist:
        return f"{album} {artist}"
    return album or artist


def build_music_playlist_name_query(slots: dict) -> str:
    s = (
        slots.get("playlist")
        or slots.get("playlist_name")
        or slots.get("name")
        or slots.get("query")
        or ""
    ).strip()
    s = re.sub(r"\s+in\s+my\s+playlist\s*[?.!]*\s*$", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"^(?:play\s+)+", "", s, flags=re.IGNORECASE).strip()
    return s


def parse_title_by_artist(text: str) -> tuple[str, str | None]:
    """Split ``… by …`` (track/album title vs artist) from a single user string."""
    s = (text or "").strip().strip("?.!")
    if not s:
        return "", None
    m = re.search(r"^(.+?)\s+by\s+(.+)$", s, flags=re.IGNORECASE)
    if not m:
        return s, None
    return m.group(1).strip(), m.group(2).strip()


def _artist_hint_in_line(artist_hint: str, artist_line: str) -> bool:
    ah = (artist_hint or "").lower().strip()
    line = (artist_line or "").lower()
    if not ah or not line:
        return False
    if ah in line:
        return True
    for token in re.split(r"[^\w]+", ah):
        if len(token) >= 3 and token in line:
            return True
    return False


def _pick_track_by_artist_hint(
    items: list[dict], artist_hint: str, title_hint: str | None
) -> dict | None:
    if not items or not (artist_hint or "").strip():
        return None
    ah = artist_hint.strip()
    th = (title_hint or "").strip().lower()
    best: dict | None = None
    best_score = 0
    for it in items:
        line = artist_line(it)
        name = (it.get("name") or "").lower()
        score = 0
        if _artist_hint_in_line(ah, line):
            score += 80
        if th and th in name:
            score += 40
        if th and name.strip() == th:
            score += 60
        if score > best_score:
            best_score = score
            best = it
    if best is not None and best_score >= 80:
        return best
    return None


def _pick_album_by_artist_hint(items: list[dict], artist_hint: str) -> dict | None:
    if not items or not (artist_hint or "").strip():
        return None
    for it in items:
        if _artist_hint_in_line(artist_hint, artist_line(it) if it.get("artists") else ""):
            return it
    return None


_FIRST_PERSON_POSSESSIVE_RE = re.compile(r"\b(my|mine|our|ours)\b", re.IGNORECASE)
_FIRST_PERSON_POSSESSIVE_MAP = {
    "my": "your",
    "mine": "yours",
    "our": "your",
    "ours": "yours",
}


def _second_person_scope_phrase(phrase: str) -> str:
    """Convert a user's playlist/library scope phrase to the second person.

    VERA never owns the playlist, liked songs, music, or library, so it must
    not echo the user's first-person possessive back to them. Examples:

        "in my playlist"      -> "in your playlist"
        "from my liked songs" -> "from your liked songs"
        "in my music"         -> "in your music"
        "in my library"       -> "in your library"
        "in the playlist"     -> "in the playlist"   (no possessive, unchanged)
    """
    s = (phrase or "").strip()
    if not s:
        return ""
    return _FIRST_PERSON_POSSESSIVE_RE.sub(
        lambda m: _FIRST_PERSON_POSSESSIVE_MAP.get(m.group(1).lower(), m.group(1)),
        s,
    )


def _spoken_quoted_pair(first_label: str, first: str, second: str | None) -> str:
    """e.g. ``Playing "Album" by "Artist".`` or ``Playing "Mix" in your playlist.``"""
    a = f'"{first}"' if first else ""
    if second:
        b = f'"{second}"'
        return f"Playing {a} {first_label} {b}."
    return f"Playing {a}." if a else "Playing that now."


def handle_music_open_panel() -> dict:
    return {
        "spoken_reply": "Opening the music panel.",
        "action_type": "music",
        "data": None,
        "ui_payload": {"panel_type": "music_control", "op": "open_panel"},
    }


def handle_music_close_panel() -> dict:
    return {
        "spoken_reply": "Closing the music panel.",
        "action_type": "music",
        "data": None,
        "ui_payload": {"panel_type": "music_control", "op": "close_panel"},
    }


def handle_music_pause() -> dict:
    return {
        "spoken_reply": "Paused the music.",
        "action_type": "music",
        "data": None,
        "ui_payload": {"panel_type": "music_control", "op": "pause"},
    }


def handle_music_resume() -> dict:
    return {
        "spoken_reply": "Resuming playback.",
        "action_type": "music",
        "data": None,
        "ui_payload": {"panel_type": "music_control", "op": "resume"},
    }


def _music_skip_tri_state(client_snapshot: dict | None, key: str) -> bool | None:
    """True / False from client snapshot, or None if unknown (older clients omit the key)."""
    if not isinstance(client_snapshot, dict):
        return None
    music = client_snapshot.get("music")
    if not isinstance(music, dict) or key not in music:
        return None
    return bool(music.get(key))


def handle_music_skip_next(client_snapshot: dict | None = None) -> dict:
    can = _music_skip_tri_state(client_snapshot, "skip_next_available")
    payload = {"panel_type": "music_control", "op": "skip_next"}
    if can is False:
        return {
            "spoken_reply": "No next track in the snapshot; skipping anyway.",
            "action_type": "music",
            "data": None,
            "ui_payload": payload,
        }
    return {
        "spoken_reply": "Okay, next track.",
        "action_type": "music",
        "data": None,
        "ui_payload": payload,
    }


def handle_music_skip_previous(client_snapshot: dict | None = None) -> dict:
    can = _music_skip_tri_state(client_snapshot, "skip_prev_available")
    payload = {"panel_type": "music_control", "op": "skip_previous"}
    if can is False:
        return {
            "spoken_reply": "Going back anyway — the snapshot may be wrong.",
            "action_type": "music",
            "data": None,
            "ui_payload": payload,
        }
    return {
        "spoken_reply": "Okay, going back.",
        "action_type": "music",
        "data": None,
        "ui_payload": payload,
    }


def handle_music_volume_up(step: float = 0.05) -> dict:
    return {
        "spoken_reply": "Turning the music up by 5 percent.",
        "action_type": "music",
        "data": None,
        "ui_payload": {"panel_type": "music_control", "op": "volume_delta", "delta": abs(float(step))},
    }


def handle_music_volume_down(step: float = 0.05) -> dict:
    return {
        "spoken_reply": "Turning the music down by 5 percent.",
        "action_type": "music",
        "data": None,
        "ui_payload": {"panel_type": "music_control", "op": "volume_delta", "delta": -abs(float(step))},
    }


def _fail_open_panel(spoken_reply: str, *, service_failure: bool = False) -> dict:
    """Fail-safe music response — opens the panel and speaks ``spoken_reply``.

    When ``service_failure`` is True the response is tagged so the client can
    surface the standard music-fallback bubble; the spoken reply itself is
    already set to the spec wording for those cases.
    """
    out = {
        "spoken_reply": spoken_reply,
        "action_type": "music",
        "data": None,
        "ui_payload": {"panel_type": "music_control", "op": "open_panel"},
    }
    if service_failure:
        out["service_failure"] = "music"
    return out


def _music_service_unavailable_response() -> dict:
    """Standard fallback used when Spotify upstream is broken or unreachable.

    Logged once per failure so admins can see how often the fallback fires.
    """
    try:
        from safety_limits import FallbackMessages as _SF, log_safety_block as _sl
        _sl(reason="music_failure", mode="non_work", feature="music",
            extra={"source": "spotify"})
        msg = _SF.MUSIC_FAILURE
    except Exception:
        msg = "Music playback is not available right now."
    return _fail_open_panel(msg, service_failure=True)


def match_builtin_productivity_music(q: str) -> dict | None:
    """Map common productivity phrases to ``Free_music`` catalog ids before Spotify.

    Playlists use folder names (e.g. ``lofi_mix``). Root ambience tracks use file stems
    (``brown_noise``, ``white_noise``, ``rain_sound``).
    """
    raw = (q or "").strip()
    if not raw:
        return None
    raw_l = raw.lower()

    if re.search(r"\b(brown\s*noise)\b", raw_l):
        return {"kind": "sound", "id": "brown_noise"}
    if re.search(r"\b(white\s*noise)\b", raw_l):
        return {"kind": "sound", "id": "white_noise"}
    if re.search(
        r"\b("
        r"rain\s*(?:and|,|&|n)\s*(?:thunder|storm)"
        r"|rain(?:ing)?\s+sound|raining"
        r"|rain\s+noise|thunder\s*storm|thunder\s+and\s+rain"
        r")\b",
        raw_l,
    ):
        return {"kind": "sound", "id": "rain_sound"}

    tail = re.sub(
        r"^(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+|will\s+you\s+)?"
        r"(?:play|start|put\s+on|turn\s+on)\s+",
        "",
        raw_l,
    )
    tail = re.sub(r"^(?:the|a|an)\s+", "", tail)
    tail = re.sub(r"[.!?]+$", "", tail).strip()
    if tail in (
        "lofi mix",
        "lofi",
        "lofi music",
        "lo-fi mix",
        "lo fi mix",
        "lofi playlist",
        "the lofi mix",
        "lofi beats",
    ):
        return {"kind": "playlist", "id": "lofi_mix"}
    if re.search(r"\b(lofi\s*mix|lo-fi\s*mix|lo\s+fi\s+mix|lofi\s+playlist|study\s+beats)\b", raw_l):
        return {"kind": "playlist", "id": "lofi_mix"}
    if re.search(r"\b(lofi|lo-fi|lo\s+fi)\b", raw_l) and re.search(
        r"\b(mix|playlist|beats|radio|station)\b", raw_l
    ):
        return {"kind": "playlist", "id": "lofi_mix"}

    return None


def handle_music_play_builtin(
    *, playlist_id: str | None = None, sound_id: str | None = None
) -> dict:
    pid = (playlist_id or "").strip()
    sid = (sound_id or "").strip()
    ui: dict = {"panel_type": "music_control", "op": "play_builtin", "playlist_id": "", "sound_id": ""}
    if pid:
        ui["playlist_id"] = pid
        label = pid.replace("_", " ").strip() or "playlist"
        spoken = f"Playing the built-in {label}."
    elif sid:
        ui["sound_id"] = sid
        spoken = f"Playing {sid.replace('_', ' ')}."
    else:
        return _fail_open_panel("I am not sure which built-in track to play.")

    return {
        "spoken_reply": spoken,
        "action_type": "music",
        "data": {"builtin": True, "playlist_id": pid or None, "sound_id": sid or None},
        "ui_payload": ui,
    }


def handle_music_play_track(slots: dict, search_limit: int = 8) -> dict:
    q = build_music_search_query(slots)
    return handle_music_play_for_query(q, search_limit=search_limit, slots=slots)


def handle_music_play_for_query(q: str, search_limit: int = 8, slots: dict | None = None) -> dict:
    slots = dict(slots or {})
    raw = (q or "").strip()
    if not raw:
        return _fail_open_panel("What would you like me to play?")

    # 2026-06-02 — Defense-in-depth degenerate-query guard.
    #
    # Stop-word queries like "the" / "a" / "an" / "it" / "that" /
    # "this" / "some" produce real but meaningless Spotify results
    # (e.g. "the cure by Olivia Rodrigo" for query="the"). The planner
    # already drops these upstream via ``_drop_degenerate_query``, but a
    # direct caller (legacy single-action router, a future regression,
    # a unit test, etc.) could still reach this handler with a
    # stop-word query. We refuse to call Spotify search in that case
    # and surface the same clarification the planner would have.
    _q_norm = re.sub(r"[\.\!\?\,;:]+$", "", raw.lower()).strip()
    if _q_norm in {"the", "a", "an", "some", "it", "that", "this"}:
        try:
            print(
                "[music_play_degenerate_query_refused] "
                f"q={raw!r} normalized={_q_norm!r}",
                flush=True,
            )
        except Exception:
            pass
        return _fail_open_panel("What would you like me to play?")

    builtin = match_builtin_productivity_music(raw)
    if builtin:
        if builtin["kind"] == "playlist":
            return handle_music_play_builtin(playlist_id=builtin["id"], sound_id="")
        return handle_music_play_builtin(playlist_id="", sound_id=builtin["id"])

    title_h = (slots.get("track") or slots.get("song") or "").strip()
    artist_h = (slots.get("artist") or "").strip()
    parsed_title, parsed_artist = parse_title_by_artist(raw)
    if parsed_artist:
        title_h = title_h or parsed_title
        artist_h = artist_h or parsed_artist

    search_q = raw
    used_track_artist_fields = False
    if title_h and artist_h:
        search_q = f"track:{title_h} artist:{artist_h}"
        used_track_artist_fields = True
    lim = max(int(search_limit), 25) if artist_h else int(search_limit)

    pick_title = title_h or parsed_title or None

    def _search_tracks(qs: str) -> list[dict]:
        return search_tracks_normalized(qs, lim)

    try:
        items = _search_tracks(search_q)
    except SpotifyNotConfiguredError:
        return _fail_open_panel("Spotify search is not configured on this server yet.")
    except SpotifyUpstreamError:
        return _music_service_unavailable_response()

    if not items and used_track_artist_fields:
        try:
            items = _search_tracks(raw)
        except SpotifyNotConfiguredError:
            return _fail_open_panel("Spotify search is not configured on this server yet.")
        except SpotifyUpstreamError:
            return _music_service_unavailable_response()

    if not items:
        return _fail_open_panel("I could not find a track matching that. Try another title or artist.")

    first: dict
    if artist_h:
        picked = _pick_track_by_artist_hint(items, artist_h, pick_title)
        if not picked and used_track_artist_fields and search_q != raw:
            try:
                items_broad = _search_tracks(raw)
            except (SpotifyNotConfiguredError, SpotifyUpstreamError):
                items_broad = []
            picked = _pick_track_by_artist_hint(items_broad, artist_h, pick_title)
            if picked:
                items = items_broad
        if picked:
            first = picked
        elif used_track_artist_fields and len(items) == 1:
            first = items[0]
        else:
            return _fail_open_panel(
                "I could not find that track by that artist. Try spelling the artist or song title differently."
            )
    else:
        first = items[0]

    title = first.get("name") or ""
    artist = artist_line(first)
    uri = first.get("uri") or ""
    if artist:
        spoken = f"Playing {title} by {artist}."
    else:
        spoken = f"Playing {title}."

    return {
        "spoken_reply": spoken,
        "action_type": "music",
        "data": {"track": first, "query": raw},
        "ui_payload": {
            "panel_type": "music_control",
            "op": "play_track",
            "uri": uri,
            "title": title,
            "artist": artist,
            "preview_url": first.get("preview_url") or "",
            "open_url": first.get("open_url") or "",
        },
    }


def handle_music_play_for_user_text(text: str, search_limit: int = 8) -> dict:
    return handle_music_play_for_query(text.strip(), search_limit=search_limit, slots={})


def handle_music_play_album(slots: dict, search_limit: int = 8) -> dict:
    album_h = (slots.get("album") or slots.get("album_name") or "").strip()
    artist_h = (slots.get("artist") or "").strip()
    raw = (build_music_album_query(slots) or "").strip()
    if not raw:
        return _fail_open_panel("Which album should I play?")

    parsed_album, parsed_artist = parse_title_by_artist(raw)
    if parsed_artist:
        album_h = album_h or parsed_album
        artist_h = artist_h or parsed_artist
    elif not album_h:
        album_h = parsed_album

    search_q = raw
    used_album_artist_fields = False
    if album_h and artist_h:
        search_q = f"album:{album_h} artist:{artist_h}"
        used_album_artist_fields = True
    lim = max(int(search_limit), 20) if (album_h and artist_h) else int(search_limit)

    try:
        items = search_albums_normalized(search_q, lim)
    except SpotifyNotConfiguredError:
        return _fail_open_panel("Spotify search is not configured on this server yet.")
    except SpotifyUpstreamError:
        return _music_service_unavailable_response()

    if not items and used_album_artist_fields:
        try:
            items = search_albums_normalized(raw, lim)
        except SpotifyNotConfiguredError:
            return _fail_open_panel("Spotify search is not configured on this server yet.")
        except SpotifyUpstreamError:
            return _music_service_unavailable_response()

    if not items:
        return _fail_open_panel("I could not find that album. Try another title or artist.")

    first: dict
    if artist_h:
        picked = _pick_album_by_artist_hint(items, artist_h)
        if not picked and used_album_artist_fields and search_q != raw:
            try:
                items_broad = search_albums_normalized(raw, lim)
            except (SpotifyNotConfiguredError, SpotifyUpstreamError):
                items_broad = []
            picked = _pick_album_by_artist_hint(items_broad, artist_h)
            if picked:
                items = items_broad
        if picked:
            first = picked
        elif used_album_artist_fields and len(items) == 1:
            first = items[0]
        else:
            return _fail_open_panel(
                "I could not find that album by that artist. Try spelling the artist or album title differently."
            )
    else:
        first = items[0]

    album_name = first.get("name") or ""
    artist = artist_line(first) if first.get("artists") else ""
    uri = first.get("uri") or ""
    spoken = _spoken_quoted_pair("by", album_name, artist or None)

    return {
        "spoken_reply": spoken,
        "action_type": "music",
        "data": {"album": first, "query": raw},
        "ui_payload": {
            "panel_type": "music_control",
            "op": "play_album",
            "uri": uri,
            "title": album_name,
            "artist": artist,
            "open_url": first.get("open_url") or "",
        },
    }


def handle_music_play_playlist(slots: dict) -> dict:
    name = build_music_playlist_name_query(slots)
    if not name:
        return _fail_open_panel("Which playlist should I play?")

    builtin = match_builtin_productivity_music(name)
    if builtin:
        if builtin["kind"] == "playlist":
            return handle_music_play_builtin(playlist_id=builtin["id"], sound_id="")
        return handle_music_play_builtin(playlist_id="", sound_id=builtin["id"])

    # The playlist belongs to the USER, never to VERA. Phrase the
    # confirmation in the second person: echo the user's own scope wording
    # ("in my playlist" / "from my liked songs" / "in my library") with the
    # first-person possessive converted to "your", or fall back to the
    # generic "in your playlist" when the scope phrase was stripped upstream.
    scope_phrase = _second_person_scope_phrase(
        str(slots.get("playlist_scope_phrase") or "")
    ) or "in your playlist"
    spoken = f'Playing "{name}" {scope_phrase}.'
    try:
        print(
            "[music_response_template] "
            + json.dumps(
                {
                    "resolved_track_title": name,
                    "playlist_context": str(slots.get("playlist_scope_phrase") or ""),
                    "final_confirmation_text": spoken,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass

    return {
        "spoken_reply": spoken,
        "action_type": "music",
        "data": {"playlist_name": name},
        "ui_payload": {
            "panel_type": "music_control",
            "op": "play_playlist_by_name",
            "playlist_name": name,
        },
    }
