"""Smoke for the 2026-06-02 music multi-action patch.

The spec covers two narrow planner gaps that combined to corrupt the
multi-action reply for utterances like

    "Unpause the music, play the next song, and crank it up."

Two issues were fixed:
  1. "crank it up" / "crank it down" did not anchor as ``music.volume``,
     so the volume action was silently dropped from the plan and the
     spoken reply omitted the volume change.
  2. The ``music.play`` anchor lookahead only blocked the literal
     "next"/"previous"/"prev" tokens, so "play the next song" anchored
     a bogus ``music.play(query="the")`` action. That action then ran a
     Spotify search for "the" and returned a real-but-unrequested track
     such as "The Cure by Olivia Rodrigo", which surfaced as apparent
     hallucination in the combined voice reply.

This smoke verifies:
  * the new ``crank it up/down`` anchor + connector + extraction support,
  * the widened ``music.play`` lookahead (and the mirroring expansion of
    ``music.next`` / ``music.previous``),
  * the planner-side degenerate-query drop (audit log only — no
    Spotify side effects),
  * the defense-in-depth handler-side guard in actions/music.py,
  * all 7 spec acceptance tests pass,
  * negative regressions: real "play X" queries (Feather, Blonde, lo-fi)
    still produce ``music.play`` actions.

Run:  py -3 tests/smoke/__music_crank_it_and_play_next_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions import multi_action_planner as P  # noqa: E402
from actions.music import handle_music_play_for_query  # noqa: E402

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


def _plan(text: str) -> dict:
    return P.plan_user_actions(text, vera=None)


def _actions(plan: dict) -> list[dict]:
    return list(plan.get("actions") or [])


def _types(actions: list[dict]) -> list[str]:
    return [a.get("type") or "" for a in actions]


def _vol_direction(actions: list[dict]) -> str:
    for a in actions:
        if a.get("type") == "music.volume":
            return str((a.get("payload") or {}).get("direction") or "")
    return ""


def _play_query(actions: list[dict]) -> str:
    for a in actions:
        if a.get("type") == "music.play":
            return str((a.get("payload") or {}).get("query") or "")
    return ""


# ----------------------------------------------------------------------
# Section A — spec planner acceptance tests
# ----------------------------------------------------------------------
section("planner acceptance tests")

# Test 1: "crank it up" → music.volume(direction="up")
plan = _plan("crank it up")
acts = _actions(plan)
ok("music.volume" in _types(acts), "1. 'crank it up' anchors music.volume")
ok(_vol_direction(acts) == "up", "1. direction=up", detail=f"got={_vol_direction(acts)}")

# Test 2: "crank it down" → music.volume(direction="down")
plan = _plan("crank it down")
acts = _actions(plan)
ok("music.volume" in _types(acts), "2. 'crank it down' anchors music.volume")
ok(_vol_direction(acts) == "down", "2. direction=down", detail=f"got={_vol_direction(acts)}")

# Test 3: "Pause and then crank it up." → music.pause + music.volume(up)
plan = _plan("Pause and then crank it up.")
acts = _actions(plan)
types = _types(acts)
ok(plan.get("is_multi_action") is True, "3. is_multi_action=True", detail=f"types={types}")
ok(types == ["music.pause", "music.volume"], "3. exact order [pause, volume]", detail=f"got={types}")
ok(_vol_direction(acts) == "up", "3. direction=up", detail=f"got={_vol_direction(acts)}")

# Test 4: "Unpause the music, play the next song, and crank it up."
# Expected: music.resume + music.next + music.volume(up). NO music.play.
plan = _plan("Unpause the music, play the next song, and crank it up.")
acts = _actions(plan)
types = _types(acts)
ok(plan.get("is_multi_action") is True, "4. is_multi_action=True", detail=f"types={types}")
ok(types == ["music.resume", "music.next", "music.volume"], "4. exact order [resume, next, volume]", detail=f"got={types}")
ok(_vol_direction(acts) == "up", "4. direction=up", detail=f"got={_vol_direction(acts)}")
ok("music.play" not in types, "4. NO music.play in plan", detail=f"got={types}")
ok(_play_query(acts) == "", "4. NO bogus music.play query", detail=f"got={_play_query(acts)!r}")

# Test 5: "Play the next song and raise the volume." → music.next + music.volume(up). NO music.play.
plan = _plan("Play the next song and raise the volume.")
acts = _actions(plan)
types = _types(acts)
ok(plan.get("is_multi_action") is True, "5. is_multi_action=True", detail=f"types={types}")
ok(types == ["music.next", "music.volume"], "5. exact order [next, volume]", detail=f"got={types}")
ok(_vol_direction(acts) == "up", "5. direction=up", detail=f"got={_vol_direction(acts)}")
ok("music.play" not in types, "5. NO music.play in plan", detail=f"got={types}")
ok(_play_query(acts) != "the", "5. query is NOT 'the' (bogus stop-word)", detail=f"got={_play_query(acts)!r}")

# Test 6: "Play the previous song." → music.previous. NO music.play.
plan = _plan("Play the previous song.")
acts = _actions(plan)
types = _types(acts)
ok("music.previous" in types, "6. has music.previous")
ok("music.play" not in types, "6. NO music.play in plan", detail=f"got={types}")
ok(_play_query(acts) == "", "6. NO music.play query", detail=f"got={_play_query(acts)!r}")

# Test 7: "Play lo-fi." → music.play(query='lo-fi'). Still works.
plan = _plan("Play lo-fi.")
acts = _actions(plan)
types = _types(acts)
ok("music.play" in types, "7. 'Play lo-fi.' STILL anchors music.play")
ok("lo-fi" in _play_query(acts).lower(), "7. music.play query includes 'lo-fi'", detail=f"got={_play_query(acts)!r}")

# ----------------------------------------------------------------------
# Section B — bonus phrasings covered by widened anchors.
# ----------------------------------------------------------------------
section("bonus play-the-{next,previous,prev} routing")

NEXT_PREV_CASES = [
    ("play next", "music.next"),
    ("play the next", "music.next"),
    ("play the next song", "music.next"),
    ("play the next track", "music.next"),
    ("play previous", "music.previous"),
    ("play the previous", "music.previous"),
    ("play the previous song", "music.previous"),
    ("play the previous track", "music.previous"),
    ("play prev", "music.previous"),
    ("play the prev", "music.previous"),
]
for text, want in NEXT_PREV_CASES:
    plan = _plan(text)
    types = _types(_actions(plan))
    ok(want in types, f"{text!r} routes to {want}", detail=f"got={types}")
    ok("music.play" not in types, f"{text!r} does NOT also fire music.play", detail=f"got={types}")
    ok(_play_query(_actions(plan)) == "", f"{text!r} produces no music.play query", detail=f"got={_play_query(_actions(plan))!r}")

# ----------------------------------------------------------------------
# Section C — degenerate music.play queries are dropped upstream.
# ----------------------------------------------------------------------
section("degenerate music.play query drop (planner)")

DEGEN_TEXTS = [
    "play the",
    "play a",
    "play an",
    "play some",
    "play it",
    "play that",
    "play this",
]
for text in DEGEN_TEXTS:
    plan = _plan(text)
    types = _types(_actions(plan))
    ok(
        "music.play" not in types,
        f"{text!r} drops music.play (stop-word query)",
        detail=f"got={types}",
    )

# Real queries still survive.
REAL_PLAY_CASES = [
    ("Play Feather by Sabrina Carpenter.", "feather"),
    ("Play the album Blonde by Frank Ocean.", "blonde"),
    ("Play yea in my playlist.", "yea"),
    ("Play lo-fi.", "lo-fi"),
    ("Play Bohemian Rhapsody.", "bohemian"),
]
for text, want_substring in REAL_PLAY_CASES:
    plan = _plan(text)
    types = _types(_actions(plan))
    ok("music.play" in types, f"{text!r} keeps music.play", detail=f"got={types}")
    q = _play_query(_actions(plan)).lower()
    ok(want_substring in q, f"{text!r} query contains {want_substring!r}", detail=f"got_query={q!r}")

# ----------------------------------------------------------------------
# Section D — _is_degenerate_play_query helper.
# ----------------------------------------------------------------------
section("_is_degenerate_play_query helper")

DEGEN_YES = ["the", "a", "an", "some", "it", "that", "this", "THE", "  the. ", "", " "]
DEGEN_NO = ["lo-fi", "feather", "Blonde", "the cure", "a tribe called quest", "feather by sabrina"]
for q in DEGEN_YES:
    ok(P._is_degenerate_play_query(q) is True, f"degenerate: {q!r}")
for q in DEGEN_NO:
    ok(P._is_degenerate_play_query(q) is False, f"NOT degenerate: {q!r}")

# ----------------------------------------------------------------------
# Section E — handler-side defense-in-depth guard.
# ----------------------------------------------------------------------
section("handle_music_play_for_query refuses degenerate queries")

CLARIFY = "What would you like me to play?"
for q in ("the", "a", "an", "it", "that", "this", "some", "THE", "  the. ", "  "):
    r = handle_music_play_for_query(q)
    ok(r.get("spoken_reply") == CLARIFY, f"handler clarifies for q={q!r}", detail=f"got={r.get('spoken_reply')!r}")
    ui = r.get("ui_payload") or {}
    ok(ui.get("panel_type") == "music_control", f"handler emits music_control panel for q={q!r}", detail=f"ui={ui}")
    ok(ui.get("op") == "open_panel", f"handler emits open_panel op (NOT play_track) for q={q!r}", detail=f"ui={ui}")
    ok("play_track" not in str(ui), f"handler does NOT emit play_track payload for q={q!r}", detail=f"ui={ui}")
    ok(r.get("data") is None, f"handler emits no data block for q={q!r}", detail=f"data={r.get('data')!r}")

# ----------------------------------------------------------------------
# Section F — _ACTION_VERB_RHS_RE accepts the new crank-it form so the
# trigger gate fires on connector-led second clauses.
# ----------------------------------------------------------------------
section("connector trigger fires for '… and crank it up'")

# "Pause and then crank it up." must trigger via
# ``connector_with_action_verb_rhs`` so the planner runs for voice
# transcripts too.
triggered, reason = P.should_trigger_planner("Pause and then crank it up.")
ok(triggered is True, "trigger=True for 'Pause and then crank it up.'", detail=f"reason={reason}")
ok(
    reason in {"connector_with_action_verb_rhs", "connector_and_multi_family"},
    "trigger reason is connector-based",
    detail=f"got={reason}",
)

triggered, reason = P.should_trigger_planner("play lo-fi and crank it down")
ok(triggered is True, "trigger=True for 'play lo-fi and crank it down'", detail=f"reason={reason}")

# ----------------------------------------------------------------------
# Section G — full compound utterance reaches all three actions in
# the correct ORDER, in the actions list. Order matters because
# execute_planned_actions dispatches sequentially and the spoken reply
# is concatenated in that order.
# ----------------------------------------------------------------------
section("dispatch order preservation")

plan = _plan("Unpause the music, play the next song, and crank it up.")
acts = _actions(plan)
types = _types(acts)
ok(types == ["music.resume", "music.next", "music.volume"], "exact order [resume, next, volume]", detail=f"got={types}")

# Check span boundaries — each action's span should reference the right
# part of the original utterance so the dispatcher logs are traceable.
spans = [a.get("span") or "" for a in acts]
ok("unpause" in spans[0].lower(), "span[0] mentions unpause", detail=f"got={spans[0]!r}")
ok("next" in spans[1].lower(), "span[1] mentions next", detail=f"got={spans[1]!r}")
ok("crank" in spans[2].lower(), "span[2] mentions crank", detail=f"got={spans[2]!r}")

# Combined utterance reply must NOT mention an unrequested track/artist.
# We can't run the full backend here, but we CAN check that no
# music.play action exists (and therefore no spoken_reply with a track
# title gets injected by handle_music_play_for_query).
for a in acts:
    if a.get("type") == "music.play":
        q = (a.get("payload") or {}).get("query") or ""
        ok(False, f"music.play should not exist; got query={q!r}")

# ----------------------------------------------------------------------
# Section H — regression sweep: existing volume / playback wording.
# ----------------------------------------------------------------------
section("regression — pre-existing volume wording still works")

EXISTING_VOLUME = [
    ("turn it up", "up"),
    ("turn it down", "down"),
    ("turn up the music", "up"),
    ("turn down the volume", "down"),
    ("raise the volume", "up"),
    ("lower the volume", "down"),
    ("crank up the music", "up"),
    ("crank down the volume", "down"),
    ("make it louder", "up"),
    ("make it quieter", "down"),
]
for text, want_dir in EXISTING_VOLUME:
    plan = _plan(text)
    acts = _actions(plan)
    ok("music.volume" in _types(acts), f"{text!r} anchors music.volume")
    ok(_vol_direction(acts) == want_dir, f"{text!r} direction={want_dir}", detail=f"got={_vol_direction(acts)}")

# ----------------------------------------------------------------------
print()
print(f"PASS {PASS}  FAIL {FAIL}")
if FAILED:
    print("Failed tests:")
    for name in FAILED:
        print(f"  - {name}")
sys.exit(0 if FAIL == 0 else 1)
