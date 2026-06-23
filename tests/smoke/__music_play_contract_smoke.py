"""Smoke for the shared music.play contract (Phase 1, 2026-06-14).

Verifies that ``normalize_music_play_request`` is the single source of truth
for music.play routing and that the single-action (legacy) path and the
multi-action planner path produce the SAME verdict for the same span.

Covers:
  * Normalizer verdict matrix: ready/track/album/builtin, needs_clarification,
    unsupported (scheduling/recurrence/conditional), not_music transport/idioms.
  * ``listen to X`` normalizes like ``play X``.
  * Single-vs-multi parity: standalone ``play Feather`` == the ``play Feather``
    span the planner extracts from ``play Feather and turn up the volume``.
  * Legacy route (``heuristic_route_action``): title-only ``play Feather`` now
    routes to music.play_track instead of falling to general chat; builtin
    still wins over Spotify; album-cue routing stays consistent; transport
    phrasing ("play the next song") is NOT hijacked; ``play music in 15
    minutes`` routes to music.play_unsupported (no playback).

Run:  py -3 tests/smoke/__music_play_contract_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions import multi_action_planner as P  # noqa: E402
from actions.music_intent import normalize_music_play_request  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


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


# ============================================================================
# 1) Normalizer verdict matrix
# ============================================================================
section("normalize_music_play_request — verdict matrix")

# (text, status, play_kind, query, unsupported_reason, artist, album)
MATRIX = [
    ("play Feather",                "ready",               "track",            "Feather",                        None,         None,                None),
    ("play Feather by Sabrina Carpenter", "ready",         "track",            "Feather by Sabrina Carpenter",   None,         "Sabrina Carpenter", None),
    ("play the album Short n Sweet by Sabrina Carpenter", "ready", "album",     "Short n Sweet by Sabrina Carpenter", None,     "Sabrina Carpenter", "Short n Sweet"),
    ("play Short n Sweet by Sabrina Carpenter", "ready",   "track",            "Short n Sweet by Sabrina Carpenter", None,     "Sabrina Carpenter", None),
    ("play lofi",                   "ready",               "builtin",          "lofi",                           None,         None,                None),
    ("play brown noise",            "ready",               "builtin",          "brown noise",                    None,         None,                None),
    ("listen to Feather",           "ready",               "track",            "Feather",                        None,         None,                None),
    ("play It's Cool by Sabrina Carpenter", "ready",       "track",            "It's Cool by Sabrina Carpenter", None,         "Sabrina Carpenter", None),
    ("play Cool by Dua Lipa",        "ready",               "track",            "Cool by Dua Lipa",                None,         "Dua Lipa",           None),
    ("play Cool",                   "ready",               "track",            "Cool",                           None,         None,                None),
    ("play Cool for the Summer",    "ready",               "track",            "Cool for the Summer",            None,         None,                None),
    ("play PEAK in my playlist",    "ready",               "playlist_by_name", "PEAK",                           None,         None,                None),
    ("play something",              "needs_clarification", "track",            "something",                      None,         None,                None),
    ("play",                        "needs_clarification", "track",            "",                               None,         None,                None),
    ("play music in 15 minutes",    "unsupported",         "track",            None,                             "scheduling", None,                None),
    ("play music every morning",    "unsupported",         "track",            None,                             "recurrence", None,                None),
    ("play music when the timer ends", "unsupported",      "track",            None,                             "conditional", None,               None),
    ("play the next song",          "not_music",           None,               None,                             None,         None,                None),
    ("play next",                   "not_music",           None,               None,                             None,         None,                None),
    ("play the previous track",     "not_music",           None,               None,                             None,         None,                None),
    ("play it cool",                "not_music",           None,               None,                             None,         None,                None),
    ("Can you play it cool?",       "not_music",           None,               None,                             None,         None,                None),
    ("please play it cool",         "not_music",           None,               None,                             None,         None,                None),
    ("play dumb",                   "not_music",           None,               None,                             None,         None,                None),
    ("play nice",                   "not_music",           None,               None,                             None,         None,                None),
    ("play safe",                   "not_music",           None,               None,                             None,         None,                None),
    ("play hard to get",            "not_music",           None,               None,                             None,         None,                None),
    ("play by ear",                 "not_music",           None,               None,                             None,         None,                None),
    ("play along",                  "not_music",           None,               None,                             None,         None,                None),
]

for text, status, kind, query, unsup, artist, album in MATRIX:
    v = normalize_music_play_request(text)
    ok(v.get("status") == status, f"{text!r} -> status == {status}", detail=str(v))
    if kind is not None:
        ok(v.get("play_kind") == kind, f"{text!r} -> play_kind == {kind}", detail=str(v))
    if query is not None:
        ok((v.get("query") or "") == query, f"{text!r} -> query == {query!r}", detail=str(v))
    ok(v.get("unsupported_reason") == unsup, f"{text!r} -> unsupported_reason == {unsup}", detail=str(v))
    if artist is not None:
        ok(v.get("artist") == artist, f"{text!r} -> artist == {artist!r}", detail=str(v))
    if album is not None:
        ok(v.get("album") == album, f"{text!r} -> album == {album!r}", detail=str(v))

# Unsupported scheduling must NOT emit a playable verdict.
ok(normalize_music_play_request("play music in 15 minutes").get("status") == "unsupported",
   "play music in 15 minutes is unsupported (no playback verdict)")

# needs_clarification carries the spec clarification question.
ok(normalize_music_play_request("play something").get("clarification_question")
   == "What would you like me to play?",
   "play something -> clarification question matches spec wording")


# ============================================================================
# 2) Single-vs-multi parity — the heart of Phase 1
# ============================================================================
section("single-action vs multi-action parity")

KEYS = ("status", "play_kind", "source", "query", "unsupported_reason",
        "artist", "album", "playlist_scope_phrase")


def _subset(v: dict) -> dict:
    return {k: v.get(k) for k in KEYS}


standalone = normalize_music_play_request("play Feather")
compound = P.plan_user_actions("play Feather and turn up the volume")
music_actions = [a for a in (compound.get("actions") or []) if a["type"] == "music.play"]
ok(len(music_actions) == 1, "compound splits out exactly one music.play span",
   detail=str([a["type"] for a in (compound.get("actions") or [])]))

span = (music_actions[0].get("span") or "") if music_actions else ""
span_verdict = normalize_music_play_request(span)
ok(_subset(span_verdict) == _subset(standalone),
   "play span verdict == standalone 'play Feather' verdict",
   detail=f"span={span!r} span_verdict={_subset(span_verdict)} standalone={_subset(standalone)}")

# The planner payload's music_intent must agree with the standalone verdict.
mi = (music_actions[0].get("payload") or {}).get("music_intent") if music_actions else {}
ok((mi or {}).get("play_kind") == standalone["play_kind"]
   and (mi or {}).get("query") == standalone["query"],
   "planner payload music_intent agrees with standalone verdict",
   detail=str(mi))


# ============================================================================
# 3) Legacy route — heuristic_route_action (imports app; slower)
# ============================================================================
section("legacy route — heuristic_route_action")

import app  # noqa: E402

# (text, expected action_name)  -- None means "falls through to general"
ROUTE_CASES = [
    ("play Feather",                                     "music.play_track"),
    ("play Feather by Sabrina Carpenter",                "music.play_track"),
    ("play the album Short n Sweet by Sabrina Carpenter", "music.play_album"),
    ("play Short n Sweet by Sabrina Carpenter",          "music.play_track"),
    ("play lofi",                                        "music.play_builtin"),
    ("play brown noise",                                 "music.play_builtin"),
    ("listen to Feather",                                "music.play_track"),
    ("play PEAK in my playlist",                         "music.play_playlist"),
    ("play music in 15 minutes",                         "music.play_unsupported"),
    ("play the next song",                               "music.skip_next"),
    ("play it cool",                                     None),
    ("Can you play it cool?",                            None),
    ("please play it cool",                              None),
]
for text, expected in ROUTE_CASES:
    r = app.heuristic_route_action(text)
    got = (r or {}).get("action_name") if r else None
    ok(got == expected, f"{text!r} -> {expected}", detail=f"got={got} route={r}")

# title-only request no longer downgraded to general anywhere in the route.
feather = app.route_action_request("smoke-music-contract", "play Feather")
ok(feather.get("action_name") == "music.play_track" and feather.get("is_action_request"),
   "route_action_request('play Feather') == music.play_track (not general)",
   detail=str(feather))

# builtin still wins over Spotify track search.
lofi = app.route_action_request("smoke-music-contract", "play lofi")
ok(lofi.get("action_name") == "music.play_builtin",
   "route_action_request('play lofi') == music.play_builtin (builtin over Spotify)",
   detail=str(lofi))

# unsupported single-action speaks a no-playback message.
res, _ = app.execute_structured_action(
    "smoke-music-contract", "play music in 15 minutes",
    app.normalize_route(app.heuristic_route_action("play music in 15 minutes")),
)
ok(isinstance(res, dict) and not res.get("ui_payload")
   and "can't schedule" in (res.get("spoken_reply") or "").lower(),
   "unsupported scheduling -> spoken 'can't schedule' message, no ui_payload",
   detail=str(res))

# If the LLM router tries to override an idiom into music.play_track, the
# post-LLM finalizer must consult the normalizer and downgrade it before any
# Spotify/playback handler can run.
section("music.play idiom — post-LLM route guard")


class _FakeMusicLLMRouter:
    def route_action(self, text, **kwargs):
        return {
            "domain": "music",
            "is_action_request": True,
            "action_name": "music.play_track",
            "slots": {"query": "it cool", "track_query": "it cool"},
            "needs_followup": False,
            "missing_slot": None,
        }


_orig_vera = app.vera
_orig_should_use_search_planner = app._should_use_search_planner
_orig_handle_music_play_for_user_text_for_idiom = app.handle_music_play_for_user_text


def _idiom_spotify_should_not_be_called(*args, **kwargs):
    raise AssertionError("Spotify/playback handler should not be called for play-it-cool idiom")


app.vera = _FakeMusicLLMRouter()
app._should_use_search_planner = lambda *args, **kwargs: (False, "smoke_music_idiom_force_skip")
app.handle_music_play_for_user_text = _idiom_spotify_should_not_be_called
try:
    idiom_route = app.route_action_request("smoke-music-idiom-llm-override", "Can you play it cool?")
    ok(idiom_route.get("action_name") == "general" and not idiom_route.get("is_action_request"),
       "post-LLM music.play_track for 'Can you play it cool?' downgrades to general",
       detail=str(idiom_route))

    idiom_full = app.resolve_reply_if_not_general_llm(
        "smoke-music-idiom-full",
        "Can you play it cool?",
        [],
    )
    ok(idiom_full is None,
       "'Can you play it cool?' full sync route avoids action execution/playback",
       detail=str(idiom_full))
finally:
    app.vera = _orig_vera
    app._should_use_search_planner = _orig_should_use_search_planner
    app.handle_music_play_for_user_text = _orig_handle_music_play_for_user_text_for_idiom

# needs_clarification must execute in the dedicated music.play_clarify branch,
# not fall through to the general LLM.
section("music.play_clarify — execution and full sync route")

_orig_handle_music_play_for_user_text = app.handle_music_play_for_user_text


def _spotify_should_not_be_called(*args, **kwargs):
    raise AssertionError("Spotify/playback handler should not be called for music.play_clarify")


app.handle_music_play_for_user_text = _spotify_should_not_be_called
try:
    for text in ("Can you play something?", "play something"):
        route = app.route_action_request(f"smoke-music-clarify-route-{text}", text)
        ok(route.get("action_name") == "music.play_clarify",
           f"{text!r} -> route action_name=music.play_clarify",
           detail=str(route))
        ok(route.get("needs_followup") is False,
           f"{text!r} -> music.play_clarify needs_followup=False",
           detail=str(route))

        direct_result, _ = app.execute_structured_action(
            f"smoke-music-clarify-direct-{text}",
            text,
            app.normalize_route(route),
        )
        ok(isinstance(direct_result, dict),
           f"{text!r} direct execute returns action_result",
           detail=str(direct_result))
        ok((direct_result or {}).get("spoken_reply") == "What would you like me to play?",
           f"{text!r} direct execute asks clarification",
           detail=str(direct_result))
        ok(not (direct_result or {}).get("ui_payload"),
           f"{text!r} direct execute emits no playback payload",
           detail=str(direct_result))

        full = app.resolve_reply_if_not_general_llm(
            f"smoke-music-clarify-full-{text}",
            text,
            [],
        )
        ok(full is not None,
           f"{text!r} full sync route returns before general LLM",
           detail=str(full))
        if full is not None:
            reply, _, action_result = full
            ok(reply == "What would you like me to play?",
               f"{text!r} full sync reply asks clarification",
               detail=str(full))
            ok(isinstance(action_result, dict) and not action_result.get("ui_payload"),
               f"{text!r} full sync emits no playback payload",
               detail=str(action_result))
finally:
    app.handle_music_play_for_user_text = _orig_handle_music_play_for_user_text


print(f"\n{PASS} passed, {FAIL} failed")
if FAIL:
    print("Failures: " + ", ".join(FAILED))
    raise SystemExit(1)
raise SystemExit(0)
