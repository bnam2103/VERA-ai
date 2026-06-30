"""Smoke for actions.multi_action_planner (2026-05-29 spec).

Covers the 11 manual tests from the planner spec PLUS:
  * Heuristic gate true/false matrix.
  * Validation layer (missing payload, bad target, ambiguous music.volume).
  * Same-family multi-action: music+music, panel+panel, checklist+checklist.
  * Semantic reorder for "after Y" / "before Y".
  * "X in panel N" suffix injection.
  * LLM-upgrade choice logic when the LLM returns a richer plan vs.
    when it hallucinates an unknown family.

Run:  py -3 tests/smoke/__multi_action_planner_smoke.py
"""

from __future__ import annotations

import os
import sys

# Make project root importable when running from inside tests/smoke.
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions import multi_action_planner as P  # noqa: E402

# ============================================================================
# Tiny ANSI test harness (same style as __info_tool_router_smoke.py).
# ============================================================================
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


def plan(text: str, *, vera=None):
    return P.plan_user_actions(text, vera=vera)


def types_of(p: dict) -> list[str]:
    return [a["type"] for a in (p.get("actions") or [])]


# ============================================================================
# Heuristic gate sanity
# ============================================================================
section("Heuristic gate — should_trigger_planner")
for text, expected in [
    ("play lo-fi", False),
    ("what time is it", False),
    ("add milk and eggs to the checklist", False),  # single checklist with internal AND
    ("explain the Vietnam War in panel 2", True),
    ("play lo-fi and turn down the volume", True),
    ("go to panel 2 and explain the Vietnam War", True),
    ("close panel 1 and panel 3", True),
    ("turn up the volume after playing Feather by Sabrina Carpenter", True),
    ("add hello to the checklist and play lo-fi", True),
]:
    triggered, reason = P.should_trigger_planner(text)
    ok(triggered == expected,
       f"{text!r} → triggered={expected}",
       detail=f"got triggered={triggered}, reason={reason}")

# ============================================================================
# Manual Test 1 — checklist + music boundary
# ============================================================================
section("Manual 1 — checklist + music")
p1 = plan("Can you add hello to the checklist and play the lo-fi mix?")
ok(p1["is_multi_action"], "is_multi_action=True", detail=str(p1))
ok(types_of(p1) == ["checklist.add", "music.play"],
   "actions == [checklist.add, music.play]",
   detail=str(types_of(p1)))
a1_add = p1["actions"][0]["payload"]
a1_play = p1["actions"][1]["payload"]
ok(a1_add.get("items") == ["hello"],
   "checklist.add items == ['hello']",
   detail=str(a1_add))
ok("lo-fi" in (a1_play.get("query") or "").lower(),
   "music.play query contains 'lo-fi'",
   detail=str(a1_play))
ok("play lo-fi" not in " ".join(a1_add.get("items") or []).lower(),
   "checklist.add does NOT contain 'play lo-fi'",
   detail=str(a1_add))

# ============================================================================
# Manual Test 2 — single checklist with internal AND
# ============================================================================
section("Manual 2 — 'add milk and eggs to the checklist' stays one action")
p2 = plan("Add milk and eggs to the checklist.")
ok(not p2["is_multi_action"], "is_multi_action=False")
ok(types_of(p2) == ["checklist.add"], "one checklist.add",
   detail=str(types_of(p2)))
ok(p2["actions"][0]["payload"].get("items") == ["milk", "eggs"],
   "items == ['milk', 'eggs']",
   detail=str(p2["actions"][0]["payload"]))

# ============================================================================
# Manual Test 3 — panel.navigate + reasoning ordering
# ============================================================================
section("Manual 3 — 'go to panel 2 and explain the Vietnam War'")
p3 = plan("Can you go to panel 2 and explain the Vietnam War?")
t3 = types_of(p3)
ok(t3 == ["panel.navigate", "reasoning.request"],
   "actions == [panel.navigate, reasoning.request]",
   detail=str(t3))
ok(p3["actions"][0]["payload"].get("target", {}).get("index") == 2,
   "panel.navigate target index = 2",
   detail=str(p3["actions"][0]["payload"]))
ok("vietnam" in p3["actions"][1]["payload"].get("text", "").lower(),
   "reasoning.request text contains 'vietnam'")

# ============================================================================
# Manual Test 4 — 'explain X in panel N' (panel at end)
# ============================================================================
section("Manual 4 — 'explain the Vietnam War in panel 2'")
p4 = plan("Can you explain the Vietnam War in panel 2?")
t4 = types_of(p4)
ok(t4 == ["reasoning.request"],
   "reasoning.request only — open_and_stream owns panel target (no redundant panel.navigate)",
   detail=str(t4))
ok(p4["actions"][0]["payload"].get("target", {}).get("index") == 2,
   "reasoning.request target attached = 2",
   detail=str(p4["actions"][0]["payload"]))
ok(p4["actions"][0]["payload"].get("explicit_panel_destination") is True,
   "explicit_panel_destination == True")

# ============================================================================
# Manual Test 5 — 'open a new panel and explain Black-Scholes delta'
# ============================================================================
section("Manual 5 — open new panel + reasoning")
p5 = plan("Open a new panel and explain Black-Scholes delta.")
t5 = types_of(p5)
ok(t5 == ["panel.open", "reasoning.request"],
   "actions == [panel.open, reasoning.request]",
   detail=str(t5))
ok("black-scholes" in p5["actions"][1]["payload"]["text"].lower()
   or "black" in p5["actions"][1]["payload"]["text"].lower(),
   "reasoning.request mentions Black-Scholes",
   detail=str(p5["actions"][1]["payload"]))

# ============================================================================
# Manual Test 6 — music.play + music.volume
# ============================================================================
section("Manual 6 — 'play Feather ... and turn up the volume'")
p6 = plan("Play Feather by Sabrina Carpenter and turn up the volume.")
t6 = types_of(p6)
ok(t6 == ["music.play", "music.volume"],
   "actions == [music.play, music.volume]",
   detail=str(t6))
ok("feather" in p6["actions"][0]["payload"]["query"].lower(),
   "music.play query contains 'feather'")
ok(p6["actions"][1]["payload"].get("direction") == "up",
   "music.volume direction = up")

# ============================================================================
# Manual Test 7 — semantic reorder: 'X after playing Y'
# ============================================================================
section("Manual 7 — 'turn up the volume after playing Feather ...'")
p7 = plan("Turn up the volume after playing Feather by Sabrina Carpenter.")
t7 = types_of(p7)
ok(t7 == ["music.play", "music.volume"],
   "actions reordered to [music.play, music.volume]",
   detail=str(t7))
ok("feather" in p7["actions"][0]["payload"]["query"].lower(),
   "play action runs first with 'feather' query",
   detail=str(p7["actions"][0]["payload"]))
ok(p7["actions"][1]["payload"].get("direction") == "up",
   "volume action follows, direction=up")

# ============================================================================
# Manual Test 8 — same-family music
# ============================================================================
section("Manual 8 — 'play lo-fi and turn the volume down'")
p8 = plan("Play lo-fi and turn the volume down.")
t8 = types_of(p8)
ok(t8 == ["music.play", "music.volume"], "two-action plan", detail=str(t8))
ok("lo-fi" in p8["actions"][0]["payload"]["query"].lower(),
   "music.play query = 'lo-fi'")
ok(p8["actions"][1]["payload"].get("direction") == "down",
   "music.volume direction = down")

# ============================================================================
# Manual Test 9 — same-family checklist
# ============================================================================
section("Manual 9 — 'remove the first item and add homework to the checklist'")
p9 = plan("Remove the first item and add homework to the checklist.")
t9 = types_of(p9)
ok(t9 == ["checklist.remove", "checklist.add"],
   "actions == [checklist.remove, checklist.add]",
   detail=str(t9))
ok(any((t.get("ordinal") == "first") for t in (p9["actions"][0]["payload"].get("targets") or [])),
   "remove targets first item",
   detail=str(p9["actions"][0]["payload"]))
ok(p9["actions"][1]["payload"].get("items") == ["homework"],
   "add items == ['homework']",
   detail=str(p9["actions"][1]["payload"]))

# ============================================================================
# Manual Test 10 — multi panel close
# ============================================================================
section("Manual 10 — 'close panel 1 and panel 3'")
p10 = plan("Close panel 1 and panel 3.")
ok("panel.close" in types_of(p10), "panel.close emitted",
   detail=str(types_of(p10)))
close_payload = p10["actions"][0]["payload"]
ids = [t.get("index") for t in (close_payload.get("targets") or []) if isinstance(t, dict)]
ok(set(ids) == {1, 3} or ids == [1, 3],
   "close targets resolve to [1, 3] before mutation",
   detail=str(close_payload))

# ============================================================================
# Manual Test 11 — ambiguity → clarification
# ============================================================================
section("Manual 11 — 'add hello and play lo-fi mix to checklist' → clarification")
p11 = plan("Add hello and play lo-fi mix to checklist.")
ok(p11["clarification_needed"] is True,
   "ambiguous compound asks for clarification",
   detail=str(p11))
ok(isinstance(p11.get("clarification_question"), str)
   and "both" in p11["clarification_question"].lower(),
   "clarification mentions 'both'",
   detail=str(p11.get("clarification_question")))

# ============================================================================
# Validation layer
# ============================================================================
section("Validation — required payload + clarification fallback")
ok_v, errors_v, cq_v = P.validate_plan({"actions": [{"type": "music.play", "payload": {}, "order": 1}]})
ok(not ok_v and "music.play_missing_query" in " ".join(errors_v),
   "missing music.play query → validation failure",
   detail=str(errors_v))

ok_v2, errors_v2, _ = P.validate_plan({
    "actions": [
        {"type": "panel.navigate", "payload": {"target": {"index": 2}}, "order": 1},
        {"type": "reasoning.request", "payload": {"text": "explain"}, "order": 2},
    ],
    "clarification_needed": False,
})
ok(ok_v2 and not errors_v2, "valid plan validates", detail=str(errors_v2))

ok_v3, errors_v3, _ = P.validate_plan({
    "actions": [{"type": "music.volume", "payload": {}, "order": 1}],
})
ok(not ok_v3 and any("music_volume" in e for e in errors_v3),
   "music.volume without direction/level → validation error",
   detail=str(errors_v3))

# ============================================================================
# Pure single-action paths still produce sane plans
# ============================================================================
section("Single-action commands keep the dispatcher in the loop")
ps = plan("play rock and roll")
ok(types_of(ps) == ["music.play"], "'play rock and roll' stays one music.play",
   detail=str(ps))
ok(not ps["is_multi_action"], "is_multi_action=False")
ok("rock and roll" in ps["actions"][0]["payload"]["query"].lower(),
   "query preserves 'rock and roll'")

ps2 = plan("explain supply and demand")
ok(types_of(ps2) == ["reasoning.request"],
   "'explain supply and demand' stays reasoning.request",
   detail=str(ps2))
ok("supply and demand" in ps2["actions"][0]["payload"]["text"].lower(),
   "text preserves 'supply and demand'")

ps3 = plan("write pros and cons of remote work")
ok(types_of(ps3) == ["reasoning.request"],
   "'write pros and cons …' stays reasoning.request",
   detail=str(ps3))

ps4 = plan("compare VGT and QQQ")
ok(types_of(ps4) == ["reasoning.request"],
   "'compare VGT and QQQ' stays reasoning.request",
   detail=str(ps4))

# ============================================================================
# Optional LLM upgrade hook
# ============================================================================
section("LLM upgrade hook — _choose_plan picks LLM when it parses cleanly")


class _FakeVeraLLM:
    """Stub that returns a hand-crafted JSON plan for testing _llm_plan."""

    def __init__(self, json_str: str):
        self.json_str = json_str

    def build_messages(self, history, prompt):
        return [{"role": "system", "content": prompt}]

    def generate(self, messages):
        return self.json_str, 0.0


good_llm = _FakeVeraLLM(
    '{"is_multi_action": true,'
    ' "actions": ['
    '  {"type": "music.play", "span": "play lo-fi", "payload": {"query": "lo-fi mix"}, "order": 1, "confidence": 0.9},'
    '  {"type": "music.volume", "span": "turn down the volume", "payload": {"direction": "down"}, "order": 2, "confidence": 0.9}'
    ' ],'
    ' "clarification_needed": false, "clarification_question": null,'
    ' "reason": "llm_split"}'
)
p_llm_ok = P.plan_user_actions(
    "Play lo-fi and turn the volume down.", vera=good_llm
)
ok(p_llm_ok.get("reason") in ("llm_split", "llm_plan_accepted")
   or types_of(p_llm_ok) == ["music.play", "music.volume"],
   "good LLM plan is honored",
   detail=str(p_llm_ok))

bad_llm = _FakeVeraLLM(
    '{"actions": [{"type": "totally.bogus.family", "payload": {}}]}'
)
p_llm_bad = P.plan_user_actions(
    "Play lo-fi and turn the volume down.", vera=bad_llm
)
ok(types_of(p_llm_bad) == ["music.play", "music.volume"],
   "bad LLM plan is rejected; deterministic backbone wins",
   detail=str(p_llm_bad))

unparseable_llm = _FakeVeraLLM("sorry I cannot help with that")
p_llm_garbage = P.plan_user_actions(
    "Play lo-fi and turn the volume down.", vera=unparseable_llm
)
ok(types_of(p_llm_garbage) == ["music.play", "music.volume"],
   "unparseable LLM output → falls back to deterministic plan",
   detail=str(p_llm_garbage))

# ============================================================================
# Structured [planner] log emission
# ============================================================================
section("Structured log — [planner] line includes spec fields")
import io
import contextlib

buf = io.StringIO()
plan_for_log = plan("Play lo-fi and turn the volume down.")
triggered, trigger_reason = P.should_trigger_planner("Play lo-fi and turn the volume down.")
ok_v_log, errors_v_log, cq_log = P.validate_plan(plan_for_log)
with contextlib.redirect_stdout(buf):
    P.log_planner(
        raw_user_text="Play lo-fi and turn the volume down.",
        plan=plan_for_log,
        triggered=triggered,
        trigger_reason=trigger_reason,
        validation_results={"ok": ok_v_log, "errors": errors_v_log},
        greedy_router_skipped=False,
    )
log_line = buf.getvalue()
ok("[planner] " in log_line, "log line uses [planner] tag")
for field in (
    "raw_user_text",
    "planner_triggered",
    "planner_trigger_reason",
    "is_multi_action",
    "actions_planned",
    "action_validation_results",
    "planner_confidence",
    "clarification_needed",
    "execution_order",
    "greedy_router_skipped",
):
    ok(field in log_line,
       f"log line includes {field}",
       detail=log_line[:300])

# ============================================================================
# Cleanup — checklist tail variants + item strip + span trim + music article
# ============================================================================
section("Cleanup — checklist tail variants (on/in/to + the/my)")
for utt in (
    "Add hello to the checklist and play lofi",
    "Add hello to checklist and play lofi",
    "Add hello on the checklist and play lofi",
    "Add hello in the checklist and play lofi",
    "Add hello to my list and play lofi",
    "Add hello on my plan and play lofi",
    "Add hello into the todo and play lofi",
    "Add hello to the to-do list and play lofi",
):
    p = plan(utt)
    types_seen = types_of(p)
    ok(types_seen == ["checklist.add", "music.play"],
       f"{utt!r} splits into [checklist.add, music.play]",
       detail=str(types_seen))
    ok(p["actions"][0]["payload"].get("items") == ["hello"],
       f"{utt!r} → items == ['hello']",
       detail=str(p["actions"][0]["payload"]))

section("Cleanup — trailing connector stripped from span")
p_clean_span = plan("Can you add hello to the checklist and play the lo-fi mix?")
checklist_span = p_clean_span["actions"][0]["span"]
ok(not checklist_span.rstrip().lower().endswith(" and"),
   "checklist span does NOT end with trailing 'and'",
   detail=repr(checklist_span))
ok(checklist_span.lower() == "add hello to the checklist",
   "checklist span == 'add hello to the checklist'",
   detail=repr(checklist_span))

section("Cleanup — music.play query strips leading article")
ok(p_clean_span["actions"][1]["payload"]["query"].lower() == "lo-fi mix",
   "music.play query == 'lo-fi mix' (leading 'the' stripped)",
   detail=str(p_clean_span["actions"][1]["payload"]))
p_keep_proper = plan("play The Beatles")
ok("the beatles" in p_keep_proper["actions"][0]["payload"]["query"].lower(),
   "music.play 'play The Beatles' still includes 'The Beatles'",
   detail=str(p_keep_proper["actions"][0]["payload"]))

section("Cleanup — items leak guard (belt-and-suspenders strip)")
# Synthetic call straight into the splitter to prove the per-item strip works
# even when an upstream change accidentally leaves the tail in the body.
items_leak = P._split_checklist_items("hello to the checklist")
ok(items_leak == ["hello"],
   "_split_checklist_items strips 'to the checklist' from individual items",
   detail=str(items_leak))
items_leak2 = P._split_checklist_items("the eggs and milk on my list")
ok(items_leak2 == ["eggs", "milk"],
   "_split_checklist_items strips leading article + 'on my list'",
   detail=str(items_leak2))

# ============================================================================
# Playlist-name intent — "in/from my playlist" must NOT global-search tracks
# ============================================================================
section("Playlist-name intent — phrase detection + query trim")
for utt, expected_query, expected_phrase_substr in (
    ("play peak in my playlist", "peak", "in my playlist"),
    ("play peak from my playlist", "peak", "from my playlist"),
    ("play peak in the playlist", "peak", "in the playlist"),
    ("play peak from the playlist", "peak", "from the playlist"),
    ("play peak in my list", "peak", "in my list"),
):
    psc = plan(utt)
    music = next(a for a in psc["actions"] if a["type"] == "music.play")
    pl = music["payload"]
    ok(pl.get("playlist_scope") is True,
       f"{utt!r} sets playlist_scope=True",
       detail=str(pl))
    ok(expected_phrase_substr in (pl.get("playlist_scope_phrase") or "").lower(),
       f"{utt!r} captures '{expected_phrase_substr}' as scope_phrase",
       detail=str(pl))
    ok((pl.get("query") or "").lower() == expected_query,
       f"{utt!r} → query == '{expected_query}' (scope phrase stripped)",
       detail=str(pl))
    ok((pl.get("playlist_query") or "").lower() == expected_query,
       f"{utt!r} → playlist_query == '{expected_query}'",
       detail=str(pl))

section("Playlist-name intent — generic play does NOT set scope")
for utt in (
    "play peak",
    "play Feather by Sabrina Carpenter",
    "play lo-fi",
    "play the lo-fi mix",
):
    pn = plan(utt)
    music = next(a for a in pn["actions"] if a["type"] == "music.play")
    pl = music["payload"]
    ok(not pl.get("playlist_scope"),
       f"{utt!r} does NOT set playlist_scope",
       detail=str(pl))

section("Playlist-name intent — multi-action checklist + playlist-name music")
pms = plan("Add milk and eggs to the checklist and play peak in my playlist.")
tms = types_of(pms)
ok(tms == ["checklist.add", "music.play"],
   "splits into [checklist.add, music.play]",
   detail=str(tms))
checklist_items = pms["actions"][0]["payload"].get("items") or []
ok(checklist_items == ["milk", "eggs"],
   "checklist.add items == ['milk', 'eggs'] (no 'play peak…' leak)",
   detail=str(checklist_items))
music_payload = pms["actions"][1]["payload"]
ok(music_payload.get("playlist_scope") is True,
   "music.play has playlist_scope=True",
   detail=str(music_payload))
ok((music_payload.get("query") or "").lower() == "peak",
   "music.play query == 'peak' (no 'in my playlist' tail)",
   detail=str(music_payload))

section("Playlist-name intent — playlist noun variants stay single music.play")
for utt in (
    "play my Peak playlist",
    "play playlist Peak",
    "play the Peak playlist",
):
    ppv = plan(utt)
    ok(types_of(ppv) == ["music.play"],
       f"{utt!r} is one music.play action",
       detail=str(types_of(ppv)))
    ok("peak" in (ppv["actions"][0]["payload"].get("query") or "").lower(),
       f"{utt!r} keeps Peak in the planner query",
       detail=str(ppv["actions"][0]["payload"]))

# ============================================================================
# 2026-05-29 spec — normalized music intent (PART 1)
# ============================================================================
from actions.music_intent import parse_music_play_intent  # noqa: E402

section("Normalized music intent — parse_music_play_intent direct")
intent_cases = [
    ("play lo-fi",                       "builtin",         "builtin", "lo-fi"),
    ("play Feather by Sabrina Carpenter","track",           "spotify", "Feather by Sabrina Carpenter"),
    ("play the album Blonde by Frank Ocean", "album",       "spotify", "Blonde by Frank Ocean"),
    ("play Peak in my playlist",         "playlist_by_name","spotify", "Peak"),
    ("play yea in my playlist",          "playlist_by_name","spotify", "yea"),
    ("play study mix from my playlist",  "playlist_by_name","spotify", "study mix"),
    ("play my Peak playlist",            "playlist_by_name","spotify", "Peak"),
    ("play playlist Peak",               "playlist_by_name","spotify", "Peak"),
    ("play the Peak playlist",           "playlist_by_name","spotify", "Peak"),
    ("play peak",                        "track",           "spotify", "peak"),
    ("play The Beatles",                 "track",           "spotify", "The Beatles"),
    ("resume Spotify",                   "resume",          "spotify", ""),
    ("resume music",                     "resume",          "spotify", ""),
    ("resume built-in",                  "resume",          "builtin", ""),
]
for utt, kind, src, q in intent_cases:
    mi = parse_music_play_intent(utt)
    ok(mi.get("play_kind") == kind,
       f"{utt!r} → play_kind == {kind}",
       detail=str(mi))
    ok(mi.get("source") == src,
       f"{utt!r} → source == {src}",
       detail=str(mi))
    ok((mi.get("query") or "") == q,
       f"{utt!r} → query == {q!r}",
       detail=str(mi))

section("Normalized music intent — exposed in planner payload")
for utt, kind in (
    ("play yea in my playlist", "playlist_by_name"),
    ("play Feather by Sabrina Carpenter", "track"),
    ("play the album Blonde by Frank Ocean", "album"),
    ("play lo-fi", "builtin"),
):
    pp = plan(utt)
    a = next(a for a in pp["actions"] if a["type"] == "music.play")
    mi = (a.get("payload") or {}).get("music_intent")
    ok(isinstance(mi, dict) and mi.get("play_kind") == kind,
       f"{utt!r} planner payload music_intent.play_kind == {kind}",
       detail=str(a.get("payload")))
    ok((a.get("payload") or {}).get("play_kind") == kind,
       f"{utt!r} planner payload top-level play_kind == {kind}",
       detail=str(a.get("payload")))

section("Normalized music intent — multi-action checklist + playlist_by_name")
mai = plan("can you add hello to checklist and play yea in my playlist")
mai_types = types_of(mai)
ok(mai_types == ["checklist.add", "music.play"],
   "splits into [checklist.add, music.play]",
   detail=str(mai_types))
ok((mai["actions"][0]["payload"].get("items") or []) == ["hello"],
   "checklist.add items == ['hello']",
   detail=str(mai["actions"][0]["payload"]))
music_action = mai["actions"][1]
mi = (music_action.get("payload") or {}).get("music_intent") or {}
ok(mi.get("play_kind") == "playlist_by_name",
   "music.play music_intent.play_kind == playlist_by_name",
   detail=str(music_action.get("payload")))
ok(mi.get("query") == "yea",
   "music.play music_intent.query == 'yea' (no 'in my' leak)",
   detail=str(music_action.get("payload")))

section("Checklist shorthand before music — no explicit checklist tail")
bare_multi = plan("can you add hello and play yea in my playlist")
bare_types = types_of(bare_multi)
ok(bare_types == ["checklist.add", "music.play"],
   "bare 'add hello and play…' still splits into checklist + music",
   detail=str(bare_types))
ok((bare_multi["actions"][0]["payload"].get("items") or []) == ["hello"],
   "bare checklist.add items == ['hello']",
   detail=str(bare_multi["actions"][0]["payload"]))
bare_music = bare_multi["actions"][1]
bare_mi = (bare_music.get("payload") or {}).get("music_intent") or {}
ok(bare_mi.get("play_kind") == "playlist_by_name",
   "bare multi music intent stays playlist_by_name",
   detail=str(bare_music.get("payload")))
ok(bare_mi.get("query") == "yea",
   "bare multi playlist query == 'yea'",
   detail=str(bare_music.get("payload")))

# ============================================================================
# Extra coverage — 'open a new panel and solve this'
# ============================================================================
section("Extra — 'open a new panel and solve this'")
px = plan("Open a new panel and solve this.")
tx = types_of(px)
ok(tx == ["panel.open", "reasoning.request"],
   "panel.open then reasoning.request",
   detail=str(tx))

# ============================================================================
# Extra coverage — pause+next same-family
# ============================================================================
section("Extra — 'pause music and skip to next'")
ppn = plan("Pause music and skip to next.")
tpn = types_of(ppn)
ok(tpn == ["music.pause", "music.next"], "[pause, next]", detail=str(tpn))

# ============================================================================
# 2026-05-29 PART 3 — timer family + connector trigger
# ============================================================================
section("Timer family — anchors recognize set/cancel verbiage")
for utt, expected_family in (
    ("set a timer for 10 seconds",                "timer.set"),
    ("set timer for 5 minutes",                   "timer.set"),
    ("start a timer for 1 hour",                  "timer.set"),
    ("remind me in 10 minutes",                   "timer.set"),
    ("cancel the timer",                          "timer.cancel"),
    ("erase timer",                               "timer.cancel"),
    ("stop the timer",                            "timer.cancel"),
    ("remove the timer",                          "timer.cancel"),  # timer.cancel beats checklist.remove
    ("turn off the timer",                        "timer.cancel"),
):
    pt = plan(utt)
    tt = types_of(pt)
    ok(expected_family in tt,
       f"{utt!r} → {expected_family} present",
       detail=str(tt))

section("Timer family — duration_seconds parsed into payload")
for utt, expected_seconds in (
    ("set a timer for 10 seconds",  10),
    ("set a timer for 5 minutes",   5 * 60),
    ("start a timer for 1 hour",    3600),
    ("remind me in 15 minutes",     15 * 60),
):
    pt = plan(utt)
    ts = next(a for a in pt["actions"] if a["type"] == "timer.set")
    ok(ts["payload"].get("duration_seconds") == expected_seconds,
       f"{utt!r} → duration_seconds == {expected_seconds}",
       detail=str(ts["payload"]))

# 2026-06-13 — duration-before-noun + countdown grammar. These phrasings
# used to fall through to voice.answer because the timer.set anchor only
# matched the timer NOUN immediately after the verb/article.
section("Timer family — duration-before-noun + countdown grammar")
for utt, expected_seconds in (
    ("Can you start a 10 minute timer?",          10 * 60),
    ("Set a 30 second timer",                      30),
    ("Start a 1 hour timer",                       3600),
    ("Start a 1 hour and 30 minute timer",         90 * 60),
    ("Set 10 minute timer",                        10 * 60),
    ("Count down 10 minutes",                      10 * 60),
    ("start a countdown for 10 minutes",           10 * 60),
    ("set a countdown for 30 seconds",             30),
    ("Start timer for 10 minutes",                 10 * 60),
):
    pt = plan(utt)
    tt = types_of(pt)
    ok("timer.set" in tt, f"{utt!r} → timer.set anchored", detail=str(tt))
    ts = next((a for a in pt.get("actions") or [] if a.get("type") == "timer.set"), None)
    ok(ts is not None and ts["payload"].get("duration_seconds") == expected_seconds,
       f"{utt!r} → duration_seconds == {expected_seconds}",
       detail=str(ts["payload"] if ts else tt))

section("Timer family — multi-action: timer.set + music.pause")
ptmp = plan("Can you set a timer for 10 seconds and pause the music?")
ttmp = types_of(ptmp)
ok(ttmp == ["timer.set", "music.pause"],
   "[timer.set, music.pause]",
   detail=str(ttmp))
ok(ptmp["actions"][0]["payload"].get("duration_seconds") == 10,
   "timer duration_seconds = 10",
   detail=str(ptmp["actions"][0]["payload"]))

section("Timer family — multi-action: checklist.complete + music.resume (unpause)")
pccu = plan("Can you mark the first item complete and unpause the music?")
tccu = types_of(pccu)
ok(tccu == ["checklist.complete", "music.resume"],
   "[checklist.complete, music.resume]",
   detail=str(tccu))

# ============================================================================
# 2026-05-29 PART 4 — unpause / resume / continue priority
# ============================================================================
section("Unpause priority — single-action utterances resolve to music.resume")
for utt in (
    "unpause the music",
    "un pause the music",  # spacing variant
    "resume music",
    "resume the music",
    "continue the music",
    "continue playing",
):
    pu = plan(utt)
    tu = types_of(pu)
    ok("music.resume" in tu and "music.pause" not in tu,
       f"{utt!r} → music.resume (no pause)",
       detail=str(tu))

section("Pause priority — bare pause still resolves to music.pause")
for utt in (
    "pause the music",
    "pause music",
    "stop the music",
):
    pp = plan(utt)
    tp = types_of(pp)
    ok("music.pause" in tp and "music.resume" not in tp,
       f"{utt!r} → music.pause (no resume)",
       detail=str(tp))

# ============================================================================
# 2026-05-29 — full-path manual tests from the live-route fix spec
# ============================================================================
section("Live-route spec — 'remove the first item and play peak in my playlist'")
prf = plan("can you remove the first item and play peak in my playlist")
trf = types_of(prf)
ok(trf == ["checklist.remove", "music.play"],
   "[checklist.remove, music.play]",
   detail=str(trf))
mi_rf = (prf["actions"][1]["payload"] or {}).get("music_intent") or {}
ok(mi_rf.get("play_kind") == "playlist_by_name",
   "music.play play_kind == playlist_by_name",
   detail=str(mi_rf))
ok((mi_rf.get("query") or "").lower() == "peak",
   "music.play playlist query == 'peak'",
   detail=str(mi_rf))

section("Live-route spec — 'turn down the volume and play peak in my playlist'")
pvm = plan("can you turn down the volume and play peak in my playlist?")
tvm = types_of(pvm)
ok(tvm == ["music.volume", "music.play"],
   "[music.volume, music.play]",
   detail=str(tvm))
ok(pvm["actions"][0]["payload"].get("direction") == "down",
   "music.volume direction == down")
mi_vm = (pvm["actions"][1]["payload"] or {}).get("music_intent") or {}
ok(mi_vm.get("play_kind") == "playlist_by_name" and (mi_vm.get("query") or "").lower() == "peak",
   "music.play resolves to playlist_by_name('peak')",
   detail=str(mi_vm))

# ============================================================================
# 2026-05-29 PART 5 — shared timer duration parser (word + digit forms)
# ============================================================================
section("Timer duration — shared parser accepts word numbers")
from actions.timer_duration import parse_timer_duration_seconds as _dur  # noqa: E402

for text, expected in (
    ("one second",                       1),
    ("a second",                         1),
    ("ten seconds",                     10),
    ("twenty seconds",                  20),
    ("thirty seconds",                  30),
    ("one minute",                      60),
    ("a minute",                        60),
    ("ten minutes",                    600),
    ("an hour",                       3600),
    ("one hour",                      3600),
    ("two hours",                     7200),
    ("ninety minutes",                5400),
    ("one hour and thirty minutes",   5400),
    ("1 hour and 30 minutes",         5400),
    ("for 2 hours",                   7200),
    ("twenty-one seconds",              21),
    ("twenty one seconds",              21),
    ("set a timer",                   None),
    ("the timer",                     None),
):
    got = _dur(text)
    ok(got == expected,
       f"shared duration parser {text!r} == {expected}",
       detail=f"got {got!r}")

section("Timer family — planner timer.set payload picks up word durations")
for utt, expected_seconds in (
    ("set a timer for one hour",                            3600),
    ("set a timer for an hour",                             3600),
    ("set a timer for twenty seconds",                        20),
    ("set a timer for ninety minutes",                      5400),
    ("set a timer for one hour and thirty minutes",         5400),
):
    pt = plan(utt)
    ts_candidates = [a for a in pt.get("actions") or [] if a.get("type") == "timer.set"]
    if not ts_candidates:
        ok(False, f"{utt!r} → timer.set anchored", detail=str(types_of(pt)))
        continue
    payload = ts_candidates[0].get("payload") or {}
    ok(payload.get("duration_seconds") == expected_seconds,
       f"{utt!r} → duration_seconds == {expected_seconds}",
       detail=str(payload))

section("Timer + panel multi-action — word durations no longer collapse plan")
# Manual test #1 from the fix spec — historical failure mode.
ptp = plan("can you set a timer for one hour and go to the second panel?")
ttp = types_of(ptp)
ok(ttp == ["timer.set", "panel.navigate"],
   "[timer.set, panel.navigate]",
   detail=str(ttp))
ts_tp = next((a for a in ptp["actions"] if a["type"] == "timer.set"), None)
ok(ts_tp is not None and (ts_tp.get("payload") or {}).get("duration_seconds") == 3600,
   "timer.set duration_seconds == 3600",
   detail=str((ts_tp or {}).get("payload")))

# Manual test #2 — reversed order.
ppt = plan("go to the second panel and set a timer for one hour")
tpt = types_of(ppt)
ok(tpt == ["panel.navigate", "timer.set"],
   "[panel.navigate, timer.set]",
   detail=str(tpt))

# Manual test #3 — "an hour" + open panel.
poa = plan("set a timer for an hour and open a new panel")
toa = types_of(poa)
ok(toa == ["timer.set", "panel.open"],
   "[timer.set, panel.open]",
   detail=str(toa))
ts_oa = next((a for a in poa["actions"] if a["type"] == "timer.set"), None)
ok(ts_oa is not None and (ts_oa.get("payload") or {}).get("duration_seconds") == 3600,
   "an hour → duration_seconds == 3600",
   detail=str((ts_oa or {}).get("payload")))

# Manual test #4 — compound word duration + pause music.
phr = plan("set a timer for one hour and thirty minutes and pause the music")
thr = types_of(phr)
# Two valid orderings depending on connector splitting; both must surface
# timer.set and music.pause.
ok("timer.set" in thr and "music.pause" in thr,
   "{timer.set, music.pause} both present for 1h30m + pause",
   detail=str(thr))
ts_hr = next((a for a in phr["actions"] if a["type"] == "timer.set"), None)
ok(ts_hr is not None and (ts_hr.get("payload") or {}).get("duration_seconds") == 5400,
   "1 hour and 30 minutes → duration_seconds == 5400",
   detail=str((ts_hr or {}).get("payload")))

# Manual test #5 — existing numeric + playlist still works (regression guard).
pnp = plan("set a timer for 20 seconds and play peak in my playlist")
tnp = types_of(pnp)
ok(tnp == ["timer.set", "music.play"],
   "[timer.set, music.play] still works for digit durations",
   detail=str(tnp))

# ============================================================================
# 2026-05-29 PART 6 — music.volume wording: "music" as a volume target
# ============================================================================
section("Music volume wording — single-utterance anchors")
for utt, exp_direction in (
    ("turn up the music",       "up"),
    ("turn down the music",     "down"),
    ("turn the music up",       "up"),
    ("turn the music down",     "down"),
    ("music up",                "up"),
    ("music down",              "down"),
    ("raise the music",         "up"),
    ("lower the music",         "down"),
    ("crank up the music",      "up"),
    ("crank down the music",    "down"),
    # Backward-compat — existing "volume" wording must keep working.
    ("turn up the volume",      "up"),
    ("turn down the volume",    "down"),
    ("raise the volume",        "up"),
    ("lower the volume",        "down"),
):
    pv = plan(utt)
    tv = types_of(pv)
    if tv != ["music.volume"]:
        ok(False, f"{utt!r} → ['music.volume']", detail=str(tv))
        continue
    pay = (pv["actions"][0].get("payload") or {})
    ok(pay.get("direction") == exp_direction,
       f"{utt!r} → direction == {exp_direction}",
       detail=str(pay))

section("Music volume wording — 'set the music' must NOT be a volume command")
psm = plan("set the music")
ok("music.volume" not in types_of(psm),
   "'set the music' does not anchor music.volume",
   detail=str(types_of(psm)))

section("Music volume wording — level-set still requires the word 'volume'")
psv = plan("set the volume to 50%")
psv_types = types_of(psv)
ok(psv_types == ["music.volume"], "'set the volume to 50%' anchors music.volume", detail=str(psv_types))
psv_pay = (psv["actions"][0].get("payload") or {})
ok(psv_pay.get("direction") == "set" and psv_pay.get("level") == 50,
   "level-set payload {direction='set', level=50}",
   detail=str(psv_pay))

section("Music volume wording — multi-action regressions (user-reported live cases)")
# 1) Same-family volume + volume using the "music" wording.
pmm = plan("can you turn up the music and then turn down the music?")
tmm = types_of(pmm)
ok(tmm == ["music.volume", "music.volume"],
   "[music.volume, music.volume]",
   detail=str(tmm))
dirs_mm = [(a.get("payload") or {}).get("direction") for a in pmm["actions"]]
ok(dirs_mm == ["up", "down"], "directions == [up, down]", detail=str(dirs_mm))

# 2) Volume (music wording) + play track.
pvp = plan("can you turn up the music and then play feather by sabrina")
tvp = types_of(pvp)
ok(tvp == ["music.volume", "music.play"],
   "[music.volume, music.play]",
   detail=str(tvp))
ok((pvp["actions"][0].get("payload") or {}).get("direction") == "up",
   "music.volume direction == up",
   detail=str(pvp["actions"][0].get("payload")))
mi_vp = (pvp["actions"][1].get("payload") or {}).get("music_intent") or {}
ok((mi_vp.get("query") or "").lower() == "feather by sabrina",
   "music.play query == 'feather by sabrina'",
   detail=str(mi_vp))

# 3) Play track + volume (music wording).
ppv = plan("can you play feather by sabrina and turn up the music?")
tpv = types_of(ppv)
ok(tpv == ["music.play", "music.volume"],
   "[music.play, music.volume]",
   detail=str(tpv))
mi_pv = (ppv["actions"][0].get("payload") or {}).get("music_intent") or {}
ok((mi_pv.get("query") or "").lower() == "feather by sabrina",
   "music.play query == 'feather by sabrina'",
   detail=str(mi_pv))
ok((ppv["actions"][1].get("payload") or {}).get("direction") == "up",
   "music.volume direction == up",
   detail=str(ppv["actions"][1].get("payload")))

# 4) Backward-compat — "turn up the volume" wording still works after refactor.
ppl = plan("can you play fragile by laufey and turn up the volume?")
tpl = types_of(ppl)
ok(tpl == ["music.play", "music.volume"],
   "[music.play, music.volume] backward-compat",
   detail=str(tpl))

# ============================================================================
# 2026-05-29 spec PART 2 — panel.navigate → reasoning.request target prop
# ============================================================================
section("Target propagation — sibling panel.navigate → reasoning.request")

prop1 = plan("Can you go to panel 2, explain the Vietnam War and play the lo-fi mix?")
tprop1 = types_of(prop1)
ok(tprop1 == ["panel.navigate", "reasoning.request", "music.play"],
   "[panel.navigate, reasoning.request, music.play] for the spec failing command",
   detail=str(tprop1))
rprop1 = next(a for a in prop1["actions"] if a["type"] == "reasoning.request")
ok(rprop1["payload"].get("text") == "explain the Vietnam War",
   "clean reasoning prompt 'explain the Vietnam War' (no panel/music tokens)",
   detail=str(rprop1["payload"].get("text")))
ok(rprop1["payload"].get("target") == {"index": 2},
   "reasoning.request inherits target.index=2 from sibling panel.navigate",
   detail=str(rprop1["payload"].get("target")))
ok(rprop1["payload"].get("target_inherited_from") == "sibling_panel_navigate",
   "target_inherited_from = sibling_panel_navigate",
   detail=str(rprop1["payload"].get("target_inherited_from")))

prop2 = plan("Go to panel 3, explain the squeeze theorem, and play lo-fi.")
rprop2 = next(a for a in prop2["actions"] if a["type"] == "reasoning.request")
ok(rprop2["payload"].get("target") == {"index": 3},
   "Panel 3 → reasoning.request.target.index=3",
   detail=str(rprop2["payload"].get("target")))

prop3 = plan("Explain the Vietnam War in panel 2 and play lo-fi.")
rprop3 = next(a for a in prop3["actions"] if a["type"] == "reasoning.request")
ok(rprop3["payload"].get("target") == {"index": 2},
   "'in panel 2' suffix → reasoning.request.target.index=2 (existing behavior preserved)",
   detail=str(rprop3["payload"].get("target")))
ok(rprop3["payload"].get("text") == "Explain the Vietnam War",
   "'in panel 2' suffix stripped from reasoning prompt (existing behavior)",
   detail=str(rprop3["payload"].get("text")))

prop4 = plan("Explain the Vietnam War and play lo-fi.")
rprop4 = next(a for a in prop4["actions"] if a["type"] == "reasoning.request")
ok(rprop4["payload"].get("target") is None,
   "no sibling panel.navigate → reasoning.request.target stays None",
   detail=str(rprop4["payload"].get("target")))

prop5 = plan("Go to panel 2 and explain the Vietnam War.")
rprop5 = next(a for a in prop5["actions"] if a["type"] == "reasoning.request")
ok(rprop5["payload"].get("target") == {"index": 2},
   "'go to panel 2 and explain X' → reasoning.request.target.index=2",
   detail=str(rprop5["payload"].get("target")))
ok(rprop5["payload"].get("text") == "explain the Vietnam War",
   "'go to panel 2 and explain X' → reasoning prompt is clean",
   detail=str(rprop5["payload"].get("text")))

# Earliest panel.navigate wins (don't override a later inheritance with a
# DIFFERENT panel.navigate that follows).
prop6 = plan("Go to panel 2, explain something and go to panel 3.")
rprop6 = next((a for a in prop6["actions"] if a["type"] == "reasoning.request"), None)
if rprop6 is not None:
    ok(rprop6["payload"].get("target") == {"index": 2},
       "first sibling panel.navigate wins for reasoning inheritance",
       detail=str(rprop6["payload"].get("target")))

# ============================================================================
# 2026-05-29 — info/tool actions are first-class planner families
# ============================================================================
section("Info/tool action families — time/weather/search/finance mixed with app actions")

info1 = plan("what time is it in Tokyo and pause the music")
tinfo1 = types_of(info1)
ok(tinfo1 == ["info.time", "music.pause"],
   "time + music.pause → [info.time, music.pause]",
   detail=str(tinfo1))
ok(info1["actions"][0]["payload"].get("location") == "Tokyo",
   "info.time extracts location Tokyo",
   detail=str(info1["actions"][0]["payload"]))

info2 = plan("tell me the weather in Irvine and play lo-fi")
tinfo2 = types_of(info2)
ok(tinfo2 == ["info.weather", "music.play"],
   "weather + music.play → [info.weather, music.play]",
   detail=str(tinfo2))
ok(info2["actions"][0]["payload"].get("location") == "Irvine",
   "info.weather extracts location Irvine",
   detail=str(info2["actions"][0]["payload"]))

info3 = plan("what time is it in Tokyo, play lo-fi, and go to panel 2")
tinfo3 = types_of(info3)
ok(tinfo3 == ["info.time", "music.play", "panel.navigate"],
   "time + music + panel → [info.time, music.play, panel.navigate]",
   detail=str(tinfo3))

info4 = plan("what time is it in Tokyo, set a timer for twenty seconds, play lo-fi, and go to panel 2")
tinfo4 = types_of(info4)
ok(tinfo4 == ["info.time", "timer.set", "music.play", "panel.navigate"],
   "time + timer + music + panel keeps every family",
   detail=str(tinfo4))
timer_info4 = next(a for a in info4["actions"] if a["type"] == "timer.set")
ok(timer_info4["payload"].get("duration_seconds") == 20,
   "timer word duration still parses when preceded by info.time",
   detail=str(timer_info4["payload"]))

info5 = plan("what's VGT trading at and open panel 2")
tinfo5 = types_of(info5)
ok(tinfo5 == ["info.finance", "panel.navigate"],
   "finance quote + panel 2 → [info.finance, panel.navigate]",
   detail=str(tinfo5))

info6 = plan("did the Lakers win and play lo-fi")
tinfo6 = types_of(info6)
ok(tinfo6 == ["info.sports", "music.play"],
   "current/sports fact + music → [info.sports, music.play]",
   detail=str(tinfo6))

info7 = plan("best wireless earbuds and open a new panel")
tinfo7 = types_of(info7)
ok(tinfo7 == ["info.product", "panel.open"],
   "product query + panel.open → [info.product, panel.open]",
   detail=str(tinfo7))

info8 = plan("coffee shops near me and play lo-fi")
tinfo8 = types_of(info8)
ok(tinfo8 == ["info.location", "music.play"],
   "location query + music → [info.location, music.play]",
   detail=str(tinfo8))

# ============================================================================
# Wording variant coverage (PART 3) — these MUST anchor as the family the
# user reasonably means even when the phrasing changes. Each block is a
# tiny matrix that pairs the action family with several common phrasings.
# Failures here surface as "anchor missing for variant X" which is the
# easiest signal to act on.
# ============================================================================

# ---- Music volume variants ----
volume_up_variants = [
    "turn up the music",
    "crank up the music",
    "raise the music",
    "increase the volume",
    "make it louder",
    "make the music louder",
    "turn it up",
]
for utt in volume_up_variants:
    p = plan(utt)
    ts = types_of(p)
    ok(ts == ["music.volume"],
       f"volume-up variant '{utt}' anchors music.volume",
       detail=str(ts))
    payload = p["actions"][0]["payload"] if p["actions"] else {}
    ok(payload.get("direction") == "up",
       f"volume-up variant '{utt}' direction == up",
       detail=str(payload))

volume_down_variants = [
    "turn down the music",
    "make the music quieter",
    "lower the music",
    "decrease the volume",
    "turn it down",
    "make it softer",
]
for utt in volume_down_variants:
    p = plan(utt)
    ts = types_of(p)
    ok(ts == ["music.volume"],
       f"volume-down variant '{utt}' anchors music.volume",
       detail=str(ts))
    payload = p["actions"][0]["payload"] if p["actions"] else {}
    ok(payload.get("direction") == "down",
       f"volume-down variant '{utt}' direction == down",
       detail=str(payload))

# ---- Music play variants ----
play_variants = [
    ("play Feather by Sabrina Carpenter", "music.play"),
    ("put on Feather by Sabrina", "music.play"),
    ("start lo-fi", "music.play"),
    ("play the lo-fi mix", "music.play"),
    ("start the lo-fi mix", "music.play"),
    ("begin playing lo-fi", "music.play"),
]
for utt, expected in play_variants:
    p = plan(utt)
    ts = types_of(p)
    ok(ts == [expected],
       f"play variant '{utt}' anchors {expected}",
       detail=str(ts))

# ---- Music control variants ----
control_variants = [
    ("pause the music", "music.pause"),
    ("stop the music", "music.pause"),
    ("resume the music", "music.resume"),
    ("unpause the music", "music.resume"),
    ("continue playback", "music.resume"),
    ("next song", "music.next"),
    ("skip to the next song", "music.next"),
    ("previous track", "music.previous"),
    ("go back a song", "music.previous"),
    ("go back one song", "music.previous"),
]
for utt, expected in control_variants:
    p = plan(utt)
    ts = types_of(p)
    ok(ts == [expected],
       f"control variant '{utt}' anchors {expected}",
       detail=str(ts))

# ---- Timer variants ----
timer_set_variants = [
    "set a timer for twenty seconds",
    "start a timer for one hour",
    "remind me in ten minutes",
]
for utt in timer_set_variants:
    p = plan(utt)
    ts = types_of(p)
    ok("timer.set" in ts,
       f"timer.set variant '{utt}' anchors timer.set",
       detail=str(ts))

timer_cancel_variants = [
    "cancel the timer",
    "erase the timer",
    "close the timer",
    "stop the timer",
]
for utt in timer_cancel_variants:
    p = plan(utt)
    ts = types_of(p)
    ok(ts == ["timer.cancel"],
       f"timer.cancel variant '{utt}' anchors timer.cancel",
       detail=str(ts))

# ---- Panel variants ----
panel_variants = [
    ("go to panel 2", "panel.navigate"),
    ("switch to the second panel", "panel.navigate"),
    ("open a new panel", "panel.open"),
    ("close panel 1", "panel.close"),
    ("close the current panel", "panel.close"),
    ("reopen the last panel", "panel.open"),
]
for utt, expected in panel_variants:
    p = plan(utt)
    ts = types_of(p)
    ok(ts == [expected],
       f"panel variant '{utt}' anchors {expected}",
       detail=str(ts))

# ---- Checklist variants ----
checklist_variants = [
    ("add milk to the checklist", "checklist.add"),
    ("put milk on the checklist", "checklist.add"),
    ("remove the first item", "checklist.remove"),
    ("delete homework from the checklist", "checklist.remove"),
    ("check off the first item", "checklist.complete"),
    ("check the first item in the checklist", "checklist.complete"),
    ("tick the first item", "checklist.complete"),
    ("mark the first item complete", "checklist.complete"),
    ("uncheck the first item", "checklist.uncomplete"),
]
for utt, expected in checklist_variants:
    p = plan(utt)
    ts = types_of(p)
    ok(expected in ts,
       f"checklist variant '{utt}' contains {expected}",
       detail=str(ts))

# ---- Semantic checklist extraction (2026-06-21) ----
section("Semantic checklist — add/complete/remove normalization")

def _cl_items(plan_obj):
    acts = plan_obj.get("actions") or []
    out = []
    for a in acts:
        if a.get("type") == "checklist.add":
            out.extend((a.get("payload") or {}).get("items") or [])
    return out

def _cl_complete_texts(plan_obj):
    acts = plan_obj.get("actions") or []
    out = []
    for a in acts:
        if a.get("type") == "checklist.complete":
            for t in (a.get("payload") or {}).get("targets") or []:
                if isinstance(t, dict) and t.get("text"):
                    out.append(t["text"])
    return out

def _cl_remove_texts(plan_obj):
    acts = plan_obj.get("actions") or []
    out = []
    for a in acts:
        if a.get("type") == "checklist.remove":
            for t in (a.get("payload") or {}).get("targets") or []:
                if isinstance(t, dict) and t.get("text"):
                    out.append(t["text"])
    return out

p_sem1 = plan("Add milk to my checklist and add eggs too")
ok(types_of(p_sem1) == ["checklist.add", "checklist.add"],
   "milk+eggs too → two checklist.add actions",
   detail=str(types_of(p_sem1)))
ok(_cl_items(p_sem1) == ["milk", "eggs"],
   "items == ['milk', 'eggs'] (no 'eggs too')",
   detail=str(_cl_items(p_sem1)))

p_sem2 = plan("Add milk and eggs to my checklist")
ok(_cl_items(p_sem2) == ["milk", "eggs"],
   "milk and eggs → ['milk', 'eggs']",
   detail=str(_cl_items(p_sem2)))

p_sem3 = plan("Add milk, eggs, and bread to my checklist")
ok(_cl_items(p_sem3) == ["milk", "eggs", "bread"],
   "comma list → milk, eggs, bread",
   detail=str(_cl_items(p_sem3)))

p_sem4 = plan("Add milk to my checklist, add eggs, and mark the homework item complete")
ok(types_of(p_sem4) == ["checklist.add", "checklist.add", "checklist.complete"],
   "compound add+complete → 3 actions",
   detail=str(types_of(p_sem4)))
ok(_cl_items(p_sem4) == ["milk", "eggs"],
   "compound adds milk + eggs only",
   detail=str(_cl_items(p_sem4)))
ok(_cl_complete_texts(p_sem4) == ["homework"],
   "complete target == homework (not 'homework item complete')",
   detail=str(_cl_complete_texts(p_sem4)))

p_sem5 = plan("mark the homework item complete")
ok(types_of(p_sem5) == ["checklist.complete"],
   "mark homework complete → single complete action",
   detail=str(types_of(p_sem5)))
ok(_cl_complete_texts(p_sem5) == ["homework"],
   "mark homework item complete → target homework",
   detail=str(_cl_complete_texts(p_sem5)))

p_sem6 = plan("check off the homework item")
ok(_cl_complete_texts(p_sem6) == ["homework"],
   "check off homework item → target homework",
   detail=str(_cl_complete_texts(p_sem6)))

p_sem7 = plan("Remove stat homework from my checklist and pause the music")
ok(types_of(p_sem7) == ["checklist.remove", "music.pause"],
   "remove + pause music",
   detail=str(types_of(p_sem7)))
ok(_cl_remove_texts(p_sem7) == ["stat homework"],
   "remove target == stat homework",
   detail=str(_cl_remove_texts(p_sem7)))

bad_items = {"eggs too", "the homework item complete", "mark the homework item complete"}
for bad in bad_items:
    ok(bad not in _cl_items(p_sem4) and bad not in _cl_complete_texts(p_sem4),
       f"does not create bad item/target {bad!r}")

# ---- Reasoning variants ----
reasoning_variants = [
    "explain the Vietnam War in panel 2",
    "use the reasoning space to explain the Vietnam War",
    "put an explanation of the Vietnam War in panel 2",
    "put this explanation in panel 2",
    "put the answer in panel 2",
    "explain the Vietnam War step by step",
    "give me a detailed explanation of the Vietnam War",
]
for utt in reasoning_variants:
    p = plan(utt)
    ts = types_of(p)
    ok("reasoning.request" in ts,
       f"reasoning variant '{utt}' contains reasoning.request",
       detail=str(ts))

# ---- Spec PART 4 — mixed wording variant + app-action combinations ----
spec4_cases = [
    ("crank up the music and then play Feather by Sabrina",
     ["music.volume", "music.play"], "up", None, "feather"),
    ("make the music quieter and play Peak in my playlist",
     ["music.volume", "music.play"], "down", "playlist_by_name", "peak"),
    ("start a timer for one hour and switch to the second panel",
     ["timer.set", "panel.navigate"], None, None, None),
    ("put milk on the checklist and start lo-fi",
     ["checklist.add", "music.play"], None, None, "lo-fi"),
    ("put milk on the checklist and play lo-fi",
     ["checklist.add", "music.play"], None, None, "lo-fi"),
    ("put an explanation of the squeeze theorem in panel 3 and play lo-fi",
     ["reasoning.request", "music.play"], None, None, "lo-fi"),
    ("what's VGT trading at and open a new panel",
     ["info.finance", "panel.open"], None, None, None),
]
for utt, expected_types, vol_dir, music_kind, music_q in spec4_cases:
    p = plan(utt)
    ts = types_of(p)
    ok(ts == expected_types,
       f"spec4 wording-variant case '{utt}' plans as {expected_types}",
       detail=str(ts))
    if vol_dir is not None:
        vol = next((a for a in p["actions"] if a["type"] == "music.volume"), None)
        if vol:
            ok(vol["payload"].get("direction") == vol_dir,
               f"spec4 '{utt}' music.volume direction == {vol_dir}",
               detail=str(vol["payload"]))
    if music_kind is not None or music_q is not None:
        mp_act = next((a for a in p["actions"] if a["type"] == "music.play"), None)
        if mp_act and music_kind is not None:
            mi = mp_act["payload"].get("music_intent") or {}
            ok((mi.get("play_kind") or mp_act["payload"].get("play_kind")) == music_kind,
               f"spec4 '{utt}' music.play kind == {music_kind}",
               detail=str(mp_act["payload"]))
        if mp_act and music_q is not None:
            q_low = (mp_act["payload"].get("query") or "").lower()
            ok(music_q in q_low,
               f"spec4 '{utt}' music.play query contains '{music_q}'",
               detail=str(mp_act["payload"]))

# Reasoning prompt cleanliness — the "use the reasoning space to explain X
# and play lo-fi" composite must anchor reasoning.request AND music.play
# AND keep the reasoning span free of music tokens.
spec4_reasoning_mix = plan(
    "use the reasoning space to explain the Vietnam War and play lo-fi"
)
spec4_reasoning_types = types_of(spec4_reasoning_mix)
ok("reasoning.request" in spec4_reasoning_types and "music.play" in spec4_reasoning_types,
   "spec4 reasoning + music mix → reasoning.request and music.play",
   detail=str(spec4_reasoning_types))
spec4_r = next(
    (a for a in spec4_reasoning_mix["actions"] if a["type"] == "reasoning.request"),
    None,
)
if spec4_r:
    spec4_r_text = (spec4_r["payload"].get("text") or spec4_r.get("span") or "").lower()
    ok("play lo-fi" not in spec4_r_text and "lo-fi" not in spec4_r_text,
       "spec4 reasoning prompt clean of music tokens",
       detail=spec4_r_text)

# ============================================================================
# Compound open reasoning panel + make/write task (2026-06-21)
# ============================================================================
section("Compound open panel + reasoning task")

def _panel_open_count(plan_obj) -> int:
    return sum(1 for a in (plan_obj.get("actions") or []) if a.get("type") == "panel.open")

def _reasoning_text(plan_obj) -> str:
    for a in plan_obj.get("actions") or []:
        if a.get("type") == "reasoning.request":
            return (a.get("payload") or {}).get("text") or a.get("span") or ""
    return ""

def _linked_new_panel_ids(plan_obj) -> tuple[str, str]:
    open_id = ""
    reasoning_id = ""
    for a in plan_obj.get("actions") or []:
        pl = a.get("payload") or {}
        if a.get("type") == "panel.open":
            open_id = str(pl.get("new_panel_request_id") or "")
        elif a.get("type") == "reasoning.request":
            reasoning_id = str(pl.get("new_panel_request_id") or "")
    return open_id, reasoning_id

p_make = plan(
    "Open a reasoning panel and make a one-sentence status update for my test project."
)
ok(types_of(p_make) == ["panel.open", "reasoning.request"],
   "open reasoning panel + make status update → panel.open + reasoning.request",
   detail=str(types_of(p_make)))
ok(_panel_open_count(p_make) == 1,
   "make compound: only one panel.open in plan",
   detail=str(types_of(p_make)))
ok("status update" in _reasoning_text(p_make).lower(),
   "make compound: reasoning carries status-update task",
   detail=_reasoning_text(p_make))
open_id, reasoning_id = _linked_new_panel_ids(p_make)
ok(bool(open_id) and open_id == reasoning_id,
   "make compound: reasoning linked to new panel via request id",
   detail=f"open={open_id} reasoning={reasoning_id}")

p_write = plan(
    "Open a reasoning panel and write a one-sentence status update for my test project."
)
ok(types_of(p_write) == ["panel.open", "reasoning.request"],
   "open reasoning panel + write status update → panel.open + reasoning.request",
   detail=str(types_of(p_write)))
ok(_panel_open_count(p_write) == 1,
   "write compound: only one panel.open in plan",
   detail=str(types_of(p_write)))

p_standalone = plan("write a one-sentence status update for my test project")
ok(types_of(p_standalone) == ["reasoning.request"],
   "standalone write status update stays reasoning.request only",
   detail=str(types_of(p_standalone)))

p_another = plan("Open a reasoning panel and another one.")
ok(types_of(p_another) == ["panel.open", "panel.open"],
   "open reasoning panel and another one → panel.open twice",
   detail=str(types_of(p_another)))

p_bigger = plan("Open a panel and make it bigger.")
ok(types_of(p_bigger) == ["panel.open"],
   "open panel and make it bigger stays panel.open only (not reasoning)",
   detail=str(types_of(p_bigger)))
ok("reasoning.request" not in types_of(p_bigger),
   "make it bigger does not add reasoning.request",
   detail=str(types_of(p_bigger)))

p_explain = plan("Open a panel and explain Q-learning.")
ok(types_of(p_explain) == ["panel.open", "reasoning.request"],
   "open panel and explain → panel.open + reasoning.request",
   detail=str(types_of(p_explain)))

# ============================================================================
# Deictic active-panel routing — "explain it in this panel"
# ============================================================================
section("Deictic panel — explain it in this panel")
deictic = plan("explain it in this panel")
deictic_types = types_of(deictic)
ok(
    deictic_types == ["reasoning.request"],
    "explain it in this panel → reasoning.request",
    detail=str(deictic_types),
)
deictic_rr = next((a for a in (deictic.get("actions") or []) if a.get("type") == "reasoning.request"), {})
deictic_payload = deictic_rr.get("payload") or {}
ok(
    bool(deictic_payload.get("explicit_panel_destination")),
    "deictic panel plan sets explicit_panel_destination",
    detail=str(deictic_payload),
)
triggered, trigger_reason = P.should_trigger_planner("explain it in this panel")
ok(triggered, "should_trigger_planner for deictic panel + explain", detail=trigger_reason)

# ============================================================================
# Explicit panel routing — compound question + "explain it in this panel"
# ============================================================================
section("Panel routing compound collapse — Nixon + in this panel")
nixon = plan(
    "is there any connection with president nixon? can you explain it in this panel?"
)
nixon_types = types_of(nixon)
ok(
    nixon_types == ["reasoning.request"],
    "Nixon compound → exactly one reasoning.request",
    detail=str(nixon_types),
)
nixon_rr = next((a for a in (nixon.get("actions") or []) if a.get("type") == "reasoning.request"), {})
nixon_payload = nixon_rr.get("payload") or {}
ok(
    "nixon" in str(nixon_payload.get("text") or "").lower(),
    "Nixon compound prompt retains substantive Nixon question",
    detail=str(nixon_payload.get("text")),
)
ok(
    not nixon.get("is_multi_action"),
    "Nixon compound is not multi-action after collapse",
    detail=str(nixon.get("is_multi_action")),
)

section("Panel routing — explain in this panel strips suffix")
vietnam = plan("can you explain Nixon connection to the Vietnam War in this panel?")
vietnam_types = types_of(vietnam)
ok(vietnam_types == ["reasoning.request"], "Vietnam panel → one reasoning.request", detail=str(vietnam_types))
vietnam_rr = next((a for a in (vietnam.get("actions") or []) if a.get("type") == "reasoning.request"), {})
vietnam_text = str((vietnam_rr.get("payload") or {}).get("text") or "").lower()
ok(
    "vietnam" in vietnam_text and "in this panel" not in vietnam_text,
    "Vietnam panel prompt strips in this panel",
    detail=vietnam_text,
)

section("Panel routing — explain it simply stays voice path")
simple = plan("explain it simply")
simple_types = types_of(simple)
ok(
    simple_types == ["voice.answer"] or simple_types == ["reasoning.request"],
    "explain it simply → no panel compound split",
    detail=str(simple_types),
)
ok(
    not any(t == "reasoning.request" and "panel" in str(a.get("span") or "").lower()
            for t, a in zip(simple_types, simple.get("actions") or [])),
    "explain it simply has no panel routing reasoning span",
    detail=str(simple_types),
)

section("Panel routing — open panel + explain Nixon")
open_nixon = plan("open a reasoning panel and explain Nixon connection")
open_types = types_of(open_nixon)
ok(
    "panel.open" in open_types and "reasoning.request" in open_types,
    "open panel + explain → panel.open + reasoning.request",
    detail=str(open_types),
)
ok(
    "voice.answer" not in open_types,
    "open panel + explain → no duplicate voice.answer",
    detail=str(open_types),
)

# ============================================================================
# Final tally
# ============================================================================
print(f"\n{'=' * 60}")
print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
if FAILED:
    print("\nFailing tests:")
    for n in FAILED:
        print(f"  - {n}")
    sys.exit(1)
print("All multi-action planner smoke tests passed.")
