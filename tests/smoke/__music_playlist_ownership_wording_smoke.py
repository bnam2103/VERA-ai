"""Smoke for music playlist-ownership wording.

The playlist (and liked songs / music / library) belongs to the USER, never
to VERA, so the confirmation must say "your playlist", not "my playlist".

Verifies (wording/template only — no Spotify, normalization, or routing
changes):
  * "play PEAK in my playlist"  -> 'Playing "PEAK" in your playlist.'
  * spelling-resolved title is preserved verbatim ("PEAK" not "Peek").
  * "play the next track in my playlist" uses "your playlist".
  * the first-person -> second-person scope converter handles playlist,
    liked songs, music, and library, and leaves non-possessive phrases alone.
  * no reply ever contains "my playlist" / "my liked songs" / "my music" /
    "my library".

Run:  py -3 tests/smoke/__music_playlist_ownership_wording_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions.music import (  # noqa: E402
    _second_person_scope_phrase,
    handle_music_play_playlist,
)
from actions.music_intent import parse_music_play_intent  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(cond: bool, name: str, *, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}")
        if detail:
            print(f"         {detail[:600]}")


_FORBIDDEN = ("my playlist", "my liked songs", "my music", "my library", "my list")


def _reply(slots: dict) -> str:
    return str(handle_music_play_playlist(slots).get("spoken_reply") or "")


def _intent_slots(text: str) -> dict:
    intent = parse_music_play_intent(text)
    return {
        "playlist_name": intent.get("query") or "",
        "playlist_scope_phrase": intent.get("playlist_scope_phrase") or "",
    }


def _no_first_person(reply: str) -> bool:
    low = reply.lower()
    return not any(bad in low for bad in _FORBIDDEN)


def main() -> int:
    # --- helper conversions ---
    ok(_second_person_scope_phrase("in my playlist") == "in your playlist", "scope: in my playlist -> in your playlist")
    ok(_second_person_scope_phrase("from my liked songs") == "from your liked songs", "scope: from my liked songs -> from your liked songs")
    ok(_second_person_scope_phrase("in my music") == "in your music", "scope: in my music -> in your music")
    ok(_second_person_scope_phrase("in my library") == "in your library", "scope: in my library -> in your library")
    ok(_second_person_scope_phrase("from my list") == "from your list", "scope: from my list -> from your list")
    ok(_second_person_scope_phrase("in the playlist") == "in the playlist", "scope: non-possessive unchanged")
    ok(_second_person_scope_phrase("") == "", "scope: empty stays empty")

    # --- spec acceptance tests ---
    r1 = _reply({"playlist_name": "PEAK", "playlist_scope_phrase": "in my playlist"})
    ok(r1 == 'Playing "PEAK" in your playlist.', "play PEAK in my playlist", detail=r1)
    ok(_no_first_person(r1), "PEAK: no first-person possessive", detail=r1)

    r2 = _reply({"playlist_name": "Peek", "playlist_scope_phrase": "in my playlist"})
    ok(r2 == 'Playing "Peek" in your playlist.', "play Peek in my playlist (title preserved)", detail=r2)

    # Resolved title preserved verbatim (rule #3): PEAK must stay PEAK.
    r3 = _reply(_intent_slots("play PEAK in my playlist"))
    ok('"PEAK"' in r3, "resolved title 'PEAK' preserved (not 'Peek')", detail=r3)
    ok("in your playlist" in r3, "intent-path: uses 'in your playlist'", detail=r3)
    ok(_no_first_person(r3), "intent-path: no first-person possessive", detail=r3)

    # "next track in my playlist" -> uses your playlist.
    r4 = _reply(_intent_slots("play the next track in my playlist"))
    ok("your playlist" in r4 and _no_first_person(r4), "next track in my playlist -> your playlist", detail=r4)

    # Default fallback when scope phrase is stripped upstream.
    r5 = _reply({"playlist_name": "PEAK"})
    ok(r5 == 'Playing "PEAK" in your playlist.', "default scope -> in your playlist", detail=r5)

    # Liked songs / music / library scope phrasing flows through verbatim (2nd person).
    r6 = _reply({"playlist_name": "PEAK", "playlist_scope_phrase": "from my liked songs"})
    ok(r6 == 'Playing "PEAK" from your liked songs.' and _no_first_person(r6), "liked songs scope -> your liked songs", detail=r6)

    print(f"\n{PASS} passed, {FAIL} failed")
    if FAIL:
        print("Failures: " + ", ".join(FAILED))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
