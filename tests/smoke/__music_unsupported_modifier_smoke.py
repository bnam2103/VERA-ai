"""Smoke for the music-family unsupported-modifier guard (Option A, 2026-06-15).

VERA can play / pause / resume / skip / change volume *now*, but it cannot
schedule those for later, on a recurrence, or on a condition. This suite
proves that a delayed/conditional/recurring music command never executes
immediately and never claims success.

Covers:
  * ``detect_music_unsupported_modifier`` matrix across every music family
    (delay / absolute-or-relative time / recurrence / conditional), including
    the broadened song/track conditionals.
  * Planner annotates transport/volume payloads with
    ``unsupported_music_modifier`` (and preserves volume ``direction``).
  * ``_scan_plan_for_unsupported_music`` + spoken builder produce the
    action-specific wording, including the mixed "play Feather now, but ..."
    reply and the peeled-conditional ("pause when the timer ends") case.
  * Pre-execution plan gate (``try_execute_planned_actions_for_text``) blocks
    the WHOLE compound before any dispatch — no playback / pause payload.
  * Single-action LLM/heuristic routes downgrade to ``music.unsupported``
    (no music_control payload); valid immediate commands are untouched.

Run:  py -3 tests/smoke/__music_unsupported_modifier_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions import multi_action_planner as P  # noqa: E402
from actions.music_intent import detect_music_unsupported_modifier  # noqa: E402

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
# 1) detect_music_unsupported_modifier — verdict matrix
# ============================================================================
section("detect_music_unsupported_modifier — matrix")

# (span, family, expect_unsupported, expect_timing_kind)
MATRIX = [
    # delay
    ("pause in 10 minutes",          "music.pause",    True,  "scheduling"),
    ("resume after 5 minutes",       "music.resume",   True,  "scheduling"),
    ("skip in 30 seconds",           "music.next",     True,  "scheduling"),
    ("turn volume up after an hour", "music.volume",   True,  "scheduling"),
    # absolute / relative time
    ("pause at 5pm",                 "music.pause",    True,  "scheduling"),
    ("pause tonight",                "music.pause",    True,  "scheduling"),
    ("resume later",                 "music.resume",   True,  "scheduling"),
    # recurrence
    ("pause every morning",          "music.pause",    True,  "recurrence"),
    ("skip every 10 minutes",        "music.next",     True,  "recurrence"),
    ("pause daily",                  "music.pause",    True,  "recurrence"),
    # conditionals (timer + song/track)
    ("pause when the timer ends",    "music.pause",    True,  "conditional"),
    ("pause after the timer",        "music.pause",    True,  "conditional"),
    ("pause once this song ends",    "music.pause",    True,  "conditional"),
    ("pause after this song",        "music.pause",    True,  "conditional"),
    ("pause when this track finishes", "music.pause",  True,  "conditional"),
    # valid immediate — NOT unsupported
    ("pause the music",              "music.pause",    False, None),
    ("resume playback",             "music.resume",   False, None),
    ("turn volume up",               "music.volume",   False, None),
    ("skip to the next track",       "music.next",     False, None),
    ("go to the previous song",      "music.previous", False, None),
]
for span, fam, expect_unsupported, expect_kind in MATRIX:
    meta = detect_music_unsupported_modifier(span, fam)
    if expect_unsupported:
        good = bool(meta) and meta.get("timing_kind") == expect_kind
        ok(good, f"{span!r} ({fam}) -> unsupported/{expect_kind}", detail=str(meta))
    else:
        ok(meta is None, f"{span!r} ({fam}) -> immediate (no modifier)", detail=str(meta))

# music.play one-word titles ("Tomorrow"/"Tonight") stay protected.
ok(detect_music_unsupported_modifier("play Tomorrow", "music.play") is None,
   "'play Tomorrow' (title) is NOT flagged as scheduling")
ok(detect_music_unsupported_modifier("play music in 15 minutes", "music.play") is not None,
   "'play music in 15 minutes' IS flagged for music.play")


# ============================================================================
# 2) Planner annotates transport / volume payloads
# ============================================================================
section("planner payload annotation")


def _plan_actions(text: str) -> list[dict]:
    return P.plan_user_actions(text, vera=None).get("actions") or []


def _find(actions: list[dict], fam: str) -> dict | None:
    for a in actions:
        if a.get("type") == fam:
            return a
    return None


acts = _plan_actions("play Feather and pause in 10 minutes")
pause = _find(acts, "music.pause")
ok(pause is not None and (pause.get("payload") or {}).get("unsupported_music_modifier"),
   "compound pause-in-10 annotates music.pause payload", detail=str(pause))
play = _find(acts, "music.play")
ok(play is not None and not (play.get("payload") or {}).get("unsupported_music_modifier"),
   "compound play span stays valid (no modifier on play)", detail=str(play))

acts = _plan_actions("play Feather and turn volume up in 10 minutes")
vol = _find(acts, "music.volume")
ok(vol is not None
   and (vol.get("payload") or {}).get("direction") == "up"
   and (vol.get("payload") or {}).get("unsupported_music_modifier"),
   "volume-up-in-10 preserves direction=up AND annotates modifier", detail=str(vol))

acts = _plan_actions("play Feather and pause")
pause = _find(acts, "music.pause")
ok(pause is not None and not (pause.get("payload") or {}).get("unsupported_music_modifier"),
   "valid 'play Feather and pause' leaves pause unannotated", detail=str(pause))


# ============================================================================
# 3) Scan + spoken builder (imports app)
# ============================================================================
section("scan + spoken wording")

import app  # noqa: E402


def _scan_spoken(text: str):
    plan = P.plan_user_actions(text, vera=None)
    res = app._scan_plan_for_unsupported_music(plan.get("actions") or [])
    if res is None:
        return None
    (fam, meta), valid = res
    return app._music_unsupported_spoken(fam, phrase=meta.get("phrase") or "", valid_clause=valid)


ok(_scan_spoken("play Feather and pause in 10 minutes")
   == "I can play Feather now, but I can't schedule pausing in 10 minutes yet.",
   "mixed play+pause -> exact spec wording",
   detail=str(_scan_spoken("play Feather and pause in 10 minutes")))

s_vol = _scan_spoken("play Feather and turn volume up in 10 minutes")
ok(s_vol is not None and "play Feather" in s_vol and "volume change" in s_vol,
   "mixed play+volume -> mentions unsupported volume change", detail=str(s_vol))

s_cond = _scan_spoken("play Feather and pause when the timer ends")
ok(s_cond is not None and "play Feather" in s_cond and "when the timer ends" in s_cond,
   "mixed play+conditional-pause -> mentions conditional pause", detail=str(s_cond))

ok(_scan_spoken("play Feather and pause") is None,
   "valid 'play Feather and pause' is NOT blocked by the scan")

# Scheduled music.play must NOT repeat the timing phrase before "now".
PLAY_WORDING = [
    ("play music tomorrow",        "I can play music now, but I can't schedule music to start later yet."),
    ("play Feather tomorrow",      "I can play Feather now, but I can't schedule music to start later yet."),
    ("play music in 10 minutes",   "I can play music now, but I can't schedule music to start later yet."),
    ("play Feather in 10 minutes", "I can play Feather now, but I can't schedule music to start later yet."),
]
for text, expected in PLAY_WORDING:
    got = _scan_spoken(text)
    ok(got == expected, f"{text!r} -> clean 'now' clause (no repeated timing phrase)",
       detail=f"got={got!r}")

# single-action wording
ok(app._music_unsupported_spoken("music.pause", phrase="in 10 minutes")
   == "I can pause music now, but I can't schedule pausing in 10 minutes yet.",
   "single pause -> exact spec wording")
ok(app._music_unsupported_spoken("music.resume", phrase="in 10 minutes")
   == "I can resume playback now, but I can't schedule resuming later yet.",
   "single resume wording")
ok(app._music_unsupported_spoken("music.volume", phrase="in 10 minutes")
   == "I can change the volume now, but I can't schedule volume changes yet.",
   "single volume wording")
ok(app._music_unsupported_spoken("music.next", phrase="in 10 minutes")
   == "I can skip tracks now, but I can't schedule track changes yet.",
   "single next wording")


# ============================================================================
# 4) Pre-execution plan gate — blocks the WHOLE compound, no dispatch
# ============================================================================
section("pre-execution plan gate (try_execute_planned_actions_for_text)")

_orig_execute_planned_actions = app.execute_planned_actions


def _dispatch_must_not_run(*args, **kwargs):
    raise AssertionError("execute_planned_actions must NOT run for a blocked plan")


app.execute_planned_actions = _dispatch_must_not_run
try:
    BLOCK_CASES = [
        ("play Feather and pause in 10 minutes", "pausing in 10 minutes"),
        ("play Feather and turn volume up in 10 minutes", "volume change"),
        ("play Feather and pause when the timer ends", "when the timer ends"),
        ("pause in 10 minutes", "pausing in 10 minutes"),
        ("turn volume up in 10 minutes", "volume change"),
    ]
    for text, needle in BLOCK_CASES:
        out = app.try_execute_planned_actions_for_text(
            text=text, session_id=f"smoke-unsupp-{text}", history=[],
        )
        ok(out is not None, f"{text!r} -> plan gate returns a blocked reply", detail=str(out))
        if out is not None:
            reply, _t, action_result = out
            ok(needle in reply.lower() or needle in reply,
               f"{text!r} reply mentions the unsupported modifier",
               detail=str(reply))
            ok(isinstance(action_result, dict)
               and not action_result.get("ui_payload")
               and not action_result.get("ui_payloads"),
               f"{text!r} emits NO playback/pause payload", detail=str(action_result))
            ok("paused the music" not in reply.lower(),
               f"{text!r} does NOT claim 'Paused the music.'", detail=str(reply))
finally:
    app.execute_planned_actions = _orig_execute_planned_actions

# Valid compound still reaches the dispatcher (scan returns None).
_dispatch_calls: list[dict] = []


def _dispatch_marker(*, plan, **kwargs):
    _dispatch_calls.append(plan)
    return "DISPATCHED", 0.0, {"spoken_reply": "ok", "ui_payload": None}


app.execute_planned_actions = _dispatch_marker
try:
    out = app.try_execute_planned_actions_for_text(
        text="play Feather and pause", session_id="smoke-unsupp-valid", history=[],
    )
    ok(out is not None and out[0] == "DISPATCHED" and len(_dispatch_calls) == 1,
       "valid 'play Feather and pause' still dispatches normally", detail=str(out))
finally:
    app.execute_planned_actions = _orig_execute_planned_actions


# ============================================================================
# 5) Single-action route guard (heuristic + LLM) + execute
# ============================================================================
section("single-action route guard + execute")

# Heuristic path: volume-up matches heuristic, then finalize downgrades it.
vol_route = app.route_action_request("smoke-unsupp-vol", "turn volume up in 10 minutes")
ok(vol_route.get("action_name") == "music.unsupported",
   "'turn volume up in 10 minutes' -> music.unsupported (heuristic+finalize)",
   detail=str(vol_route))

# Valid immediate volume command is untouched.
vol_ok = app.route_action_request("smoke-unsupp-vol2", "turn volume up")
ok(vol_ok.get("action_name") == "music.volume_up",
   "'turn volume up' -> music.volume_up (immediate, untouched)", detail=str(vol_ok))


# LLM path: stub the router to return music.pause for a delayed pause; the
# finalize guard must downgrade it before any pause executes.
class _FakePauseRouter:
    def route_action(self, text, **kwargs):
        return {
            "domain": "music",
            "is_action_request": True,
            "action_name": "music.pause",
            "slots": {},
            "needs_followup": False,
            "missing_slot": None,
        }


_orig_vera = app.vera
app.vera = _FakePauseRouter()
try:
    pause_route = app.route_action_request("smoke-unsupp-pause", "pause when the timer ends")
    ok(pause_route.get("action_name") == "music.unsupported",
       "'pause when the timer ends' -> music.unsupported (LLM+finalize)",
       detail=str(pause_route))
finally:
    app.vera = _orig_vera

# Execute music.unsupported -> no payload, action-specific message.
res, _ = app.execute_structured_action(
    "smoke-unsupp-exec", "pause in 10 minutes",
    app.normalize_route({
        "domain": "music", "is_action_request": True, "action_name": "music.unsupported",
        "slots": {"family": "music.pause", "phrase": "in 10 minutes", "timing_kind": "scheduling"},
        "needs_followup": False, "missing_slot": None,
    }),
)
ok(isinstance(res, dict) and not res.get("ui_payload")
   and "can't schedule" in (res.get("spoken_reply") or "").lower()
   and "paused the music" not in (res.get("spoken_reply") or "").lower(),
   "execute music.unsupported -> 'can't schedule' message, no ui_payload", detail=str(res))


print(f"\n{PASS} passed, {FAIL} failed")
if FAIL:
    print("Failures: " + ", ".join(FAILED))
    raise SystemExit(1)
raise SystemExit(0)
