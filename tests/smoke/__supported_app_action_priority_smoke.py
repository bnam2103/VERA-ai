"""Smoke tests for the supported-app-action priority guard (2026-06-01).

Patch goal: supported VERA actions (music / checklist / timer / panel) must
always be checked BEFORE generic info.search / web.search / Serper. Specific
live bug: "Can you play Feather by Sabrina Carpenter?" was leaking to
general_web_search_tool via the mini-LLM search planner because
heuristic_route_action had no `play X by Y` heuristic.

Priority order per the patch spec:
  1. Supported app actions:
        music.play / pause / resume / next / previous / volume
        checklist.add / remove / complete
        timer.set / cancel
        panel.open / close / navigate
  2. Dedicated live-info actions:
        info.weather / info.finance / info.news / info.sports /
        info.product / info.time / info.location
  3. Generic info.search (web.search) only when no supported action matches.

This file exercises:
  * `looks_like_supported_app_action(text)` - the bucket-1 detector
  * `heuristic_route_action` - the new `play X by Y` -> music.play_track
    direct-dispatch path
  * `_classify_info_tool_deterministic` short-circuit (returns route=
    "uncertain" with reason="defer_to_supported_app_action_intent")
  * `classify_info_tool` (wrapper that also runs the mini-LLM search
    planner) still returns route="uncertain" for app actions
  * `build_route_from_info_tool` defense-in-depth (general_web_search_tool
    branch returns None when supported app action detected)

Run:  py -3 tests/smoke/__supported_app_action_priority_smoke.py
"""
from __future__ import annotations

import os as _os, sys as _sys
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..')))

import io
import os
import sys
import types

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

_TTS_STUB_NAMES = (
    "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
    "transcribe_long", "load_model", "warmup", "speak_to_file",
    "split_sentences_for_tts", "pop_first_complete_segment",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload",
)
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _TTS_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

import app  # noqa: E402

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


# ---------------------------------------------------------------------------
# Suite A - looks_like_supported_app_action POSITIVE cases
# ---------------------------------------------------------------------------
section("Suite A - looks_like_supported_app_action POSITIVE cases (bucket-1 app actions)")
POSITIVE_CASES = [
    # music.play - canonical "play X by Y" + variants
    ("Can you play Feather by Sabrina Carpenter?", "music.play_track"),
    ("Play Feather by Sabrina Carpenter", "music.play_track"),
    ("Could you please play Bohemian Rhapsody by Queen?", "music.play_track"),
    ("Put on Wonderwall by Oasis", "music.play_track"),
    ("Play some lo-fi music", "music.play (generic)"),
    ("Start playing the playlist", "music.play_playlist"),
    ("Throw on some music", "music.play (generic)"),
    ("Play music on Spotify", "music.play"),
    ("Play something from my playlist", "music.play (library)"),
    # music transport
    ("Pause the music", "music.pause"),
    ("Pause please", "music.pause"),
    ("Stop the song", "music.pause"),
    ("Unpause the music", "music.resume"),
    ("Resume", "music.resume"),
    ("Continue playing the music", "music.resume"),
    # music skip / volume
    ("Next song please", "music.next"),
    ("Skip this track", "music.next"),
    ("Previous song", "music.previous"),
    ("Go back to the previous song", "music.previous"),
    ("Turn up the volume", "music.volume_up"),
    ("Lower the volume", "music.volume_down"),
    ("Mute the music", "music.volume_mute"),
    ("Crank up the music", "music.volume_up"),
    # checklist
    ("Add buy milk to the checklist", "checklist.add"),
    ("Put 'finish report' on my todo list", "checklist.add"),
    ("Remove buy milk from the checklist", "checklist.remove"),
    ("Cross off buy milk from the list", "checklist.remove"),
    ("Mark item 2 as complete", "checklist.complete"),
    ("Check off the first item", "checklist.complete"),
    # timer
    ("Set a 5 minute timer", "timer.set"),
    ("Start a timer for 10 minutes", "timer.set"),
    ("Create a work mode timer", "timer.set"),
    ("Remind me in 10 minutes", "timer.set"),
    ("Cancel the timer", "timer.cancel"),
    ("Stop the work mode timer", "timer.cancel"),
    ("Clear my timer", "timer.cancel"),
    # panel
    ("Open a new reasoning panel", "panel.open"),
    ("Create another panel", "panel.open"),
    ("Reopen the last closed panel", "panel.open"),
    ("Close panel 2", "panel.close"),
    ("Close this panel", "panel.close"),
    ("Close all panels", "panel.close"),
    ("Go to panel 3", "panel.navigate"),
    ("Switch to the second panel", "panel.navigate"),
    ("Jump to the previous panel", "panel.navigate"),
]
for tx, label in POSITIVE_CASES:
    res = app.looks_like_supported_app_action(tx)
    ok(res is True, f"POS '{tx}' -> True ({label})", detail=f"got {res}")


# ---------------------------------------------------------------------------
# Suite B - looks_like_supported_app_action NEGATIVE cases
# ---------------------------------------------------------------------------
section("Suite B - looks_like_supported_app_action NEGATIVE cases (info, chitchat)")
NEGATIVE_CASES = [
    # info questions about app state (carve-out)
    ("What's the next song?", "info question (next song)"),
    ("What's the volume right now?", "info question (volume)"),
    ("Which panel am I in?", "info question (panel)"),
    ("Is the timer still running?", "info question (timer)"),
    ("Is the music paused?", "info question (music state)"),
    # dedicated info actions
    ("What's the weather in New York?", "info.weather"),
    ("What time is it?", "info.time"),
    ("Tell me about the news", "info.news"),
    ("Stock price of NVDA", "info.finance"),
    ("Did the Lakers win last night?", "info.sports"),
    ("Coffee shops near me", "info.location"),
    # generic chat / non-action
    ("Hello", "greeting"),
    ("Tell me a joke", "general chat"),
    ("How are you?", "greeting"),
    ("What is the capital of France?", "knowledge question"),
    ("Explain photosynthesis", "reasoning"),
    # idioms that contain "play" but are not music
    ("Play it cool", "idiom"),
    ("Hard to play hard to get", "idiom"),
    # emotional / personal
    ("I just heard bad news", "emotional"),
    ("My friend just passed away", "emotional"),
    # empty / None
    ("", "empty"),
    ("    ", "whitespace"),
]
for tx, label in NEGATIVE_CASES:
    res = app.looks_like_supported_app_action(tx)
    ok(res is False, f"NEG '{tx}' -> False ({label})", detail=f"got {res}")

ok(app.looks_like_supported_app_action(None) is False, "None safety -> False")


# ---------------------------------------------------------------------------
# Suite C - _classify_info_tool_deterministic short-circuit
# ---------------------------------------------------------------------------
section("Suite C - _classify_info_tool_deterministic returns 'uncertain' for supported app actions")
DETERMINISTIC_DEFER_CASES = [
    "Can you play Feather by Sabrina Carpenter?",
    "Pause the music",
    "Skip this track",
    "Set a 10 minute timer",
    "Open a new reasoning panel",
    "Close panel 2",
    "Mark item 3 as complete",
    "Remove buy milk from my checklist",
]
for tx in DETERMINISTIC_DEFER_CASES:
    res = app._classify_info_tool_deterministic(tx)
    ok(
        res.get("route") == "uncertain",
        f"'{tx}' -> route='uncertain'",
        detail=str(res.get("route")),
    )
    ok(
        res.get("reason") == "defer_to_supported_app_action_intent",
        f"'{tx}' -> reason='defer_to_supported_app_action_intent'",
        detail=str(res.get("reason")),
    )


# ---------------------------------------------------------------------------
# Suite D - classify_info_tool wrapper preserves the short-circuit
# ---------------------------------------------------------------------------
section("Suite D - classify_info_tool wrapper (with planner) still defers for app actions")
# The wrapper runs `_maybe_apply_search_planner` which CAN override the
# route. We patch out the search planner so the test is deterministic and
# doesn't depend on the LLM being initialized. The deterministic cascade
# alone must return route=uncertain so the planner has nothing to overwrite.
import importlib  # noqa: E402

_orig_should_use_search_planner = app._should_use_search_planner

def _force_skip_planner(*args, **kwargs):
    return False, "smoke_test_force_skip"

app._should_use_search_planner = _force_skip_planner
try:
    for tx in DETERMINISTIC_DEFER_CASES:
        res = app.classify_info_tool(tx)
        ok(
            res.get("route") == "uncertain",
            f"wrapper: '{tx}' -> route='uncertain'",
            detail=str(res.get("route")),
        )
        ok(
            res.get("reason") == "defer_to_supported_app_action_intent",
            f"wrapper: '{tx}' -> defer reason",
            detail=str(res.get("reason")),
        )
finally:
    app._should_use_search_planner = _orig_should_use_search_planner


# ---------------------------------------------------------------------------
# Suite E - heuristic_route_action 'play X by Y' direct dispatch
# ---------------------------------------------------------------------------
section("Suite E - heuristic_route_action direct music.play_track for 'play X by Y'")
PLAY_BY_CASES = [
    ("Can you play Feather by Sabrina Carpenter?", "Feather by Sabrina Carpenter"),
    ("Play Feather by Sabrina Carpenter", "Feather by Sabrina Carpenter"),
    ("Could you please play Bohemian Rhapsody by Queen?", "Bohemian Rhapsody by Queen"),
    ("Please play Wonderwall by Oasis.", "Wonderwall by Oasis"),
    ("Hey Vera, play Feather by Sabrina Carpenter.", "Feather by Sabrina Carpenter"),
    ("Will you play Toxic by Britney Spears?", "Toxic by Britney Spears"),
    ("Put on Hotel California by the Eagles", "Hotel California by the Eagles"),
    ("Throw on Mr Brightside by The Killers", "Mr Brightside by The Killers"),
    ("Spin up Yesterday by The Beatles", "Yesterday by The Beatles"),
]
for tx, expected_substr in PLAY_BY_CASES:
    route = app.heuristic_route_action(tx)
    ok(isinstance(route, dict), f"route returned for '{tx}'")
    if not isinstance(route, dict):
        continue
    ok(
        route.get("action_name") == "music.play_track",
        f"'{tx}' -> action_name=music.play_track",
        detail=str(route.get("action_name")),
    )
    slots = route.get("slots") or {}
    q = (slots.get("query") or "").lower()
    ok(
        expected_substr.lower() in q,
        f"'{tx}' -> query includes '{expected_substr}'",
        detail=f"got query={q!r}",
    )

# Negative play heuristic - bare "play" (no `by`) must NOT match this rule.
NEGATIVE_PLAY_CASES = [
    "Play",
    "Play some music",  # generic, no artist
    "Play it cool",  # idiom
]
for tx in NEGATIVE_PLAY_CASES:
    route = app.heuristic_route_action(tx)
    # It's OK if the route is None or some OTHER music action - we just
    # must NOT be promoting "play it cool" / "play" alone to
    # music.play_track via the new heuristic.
    if isinstance(route, dict) and route.get("action_name") == "music.play_track":
        slots = route.get("slots") or {}
        # If by some chance the route IS music.play_track, the query must
        # be a non-trivial track name (not "it cool", not empty).
        q = (slots.get("query") or "").lower()
        ok(
            q != "" and "it cool" not in q,
            f"NEG '{tx}' did not promote to music.play_track (or has valid query)",
            detail=f"got query={q!r}",
        )
    else:
        ok(
            True,
            f"NEG '{tx}' did not route to music.play_track (action={route.get('action_name') if route else None})",
        )


# ---------------------------------------------------------------------------
# Suite F - build_route_from_info_tool defense-in-depth
# ---------------------------------------------------------------------------
section("Suite F - build_route_from_info_tool returns None for general_web_search_tool on app actions")
APP_ACTION_TURNS = [
    "Can you play Feather by Sabrina Carpenter?",
    "Pause the music",
    "Set a 10 minute timer",
    "Open a new reasoning panel",
    "Close panel 2",
    "Add buy milk to the checklist",
]
for tx in APP_ACTION_TURNS:
    # Synthesize a classification that pretends the planner picked
    # general_web_search_tool for this turn. This is what we want to be
    # nullified by the defense-in-depth check.
    poisoned = {
        "route": "general_web_search_tool",
        "tool": "web_search",
        "query": tx,
        "confidence": 0.9,
        "reason": "smoke_test_planner_simulated_pick",
    }
    built = app.build_route_from_info_tool(tx, poisoned, session_id="smoke")
    ok(built is None, f"'{tx}' -> build_route returns None (defer to LLM router)", detail=str(built))

# Negative: a genuine general web search request still produces web.search.
genuine_search = {
    "route": "general_web_search_tool",
    "tool": "web_search",
    "query": "best ergonomic chair under $500",
    "confidence": 0.9,
    "reason": "smoke_test_genuine_web_search",
}
built_genuine = app.build_route_from_info_tool(
    "what's the best ergonomic chair under $500",
    genuine_search,
    session_id="smoke",
)
ok(
    isinstance(built_genuine, dict) and built_genuine.get("action_name") == "web.search",
    "genuine web.search request still produces action_name=web.search",
    detail=str(built_genuine),
)


# ---------------------------------------------------------------------------
print(f"\n{YELLOW}== SUMMARY =={RESET}")
print(f"  {GREEN}passed: {PASS}{RESET}")
print(f"  {RED if FAIL else GREEN}failed: {FAIL}{RESET}")
if FAIL:
    print(f"\n{RED}First failures:{RESET}")
    for n in FAILED[:15]:
        print(f"  - {n}")
sys.exit(0 if FAIL == 0 else 1)
