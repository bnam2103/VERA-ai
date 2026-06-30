"""Smoke tests for the sport-aware router (2026-05-30).

Covers the 11 test cases the user enumerated in the sports-router
generalization spec (PART 7) plus a handful of detector-shape contracts.

What this asserts:
  * The new ``actions.sports.classify_sports_intent`` recognizes:
      - NBA teams, NFL teams, MLB teams, and EU soccer clubs as ``team`` entities,
      - Top ATP/WTA tennis players and top soccer players as ``player`` entities,
      - Roland Garros, Wimbledon, Champions League etc. as ``tournament`` entities.
  * The classifier picks the right ``query_type`` from phrasing alone:
      - "Did the Lakers win?"             → latest_result
      - "Is Djokovic still in Roland Garros?"      → tournament_status
      - "Who does Alcaraz play next?"               → schedule
      - "Did Real Madrid win their last game?"     → latest_result
      - "Who does Arsenal play next?"               → schedule
  * Follow-ups inherit sport + tournament + query_type from the prior context:
      - After Djokovic / Roland Garros context, "how about Sinner?"
        produces (entity=Jannik Sinner, tournament=Roland Garros,
        query_type=tournament_status).
      - After Lakers latest_result context, "who did they play?" inherits
        Lakers and query_type=latest_result.
  * Pure-pronoun follow-ups without any context return
    ``needs_clarification=True`` (NEVER fabricate a topic).
  * ``classify_info_tool`` routes the sports turns to ``route="sports_tool"``
    with the matching ``web.sports_*`` action name.

Run:  py -3 tests/smoke/__sports_router_smoke.py
"""
from __future__ import annotations

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")))

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

# Heavy audio modules — stub the same way other smoke tests do so `import app`
# does not pull TTS/ASR side effects on Windows.
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

from actions.sports import (  # noqa: E402
    classify_sports_intent,
    build_sports_search_queries,
    action_name_for_intent,
)
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


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


# ---------------------------------------------------------------------------
# NBA — Test 1, 2, 3
# ---------------------------------------------------------------------------
section("NBA — Lakers latest result")
i = classify_sports_intent("Did the Lakers win?")
ok(i["is_sports"], "Did the Lakers win? → is_sports", str(i))
ok(i["entity"] == "Lakers", "entity=Lakers", str(i))
ok(i["entity_type"] == "team", "entity_type=team", str(i))
ok(i["sport"] == "nba", "sport=nba", str(i))
ok(i["query_type"] == "latest_result", "query_type=latest_result", str(i))
ok(action_name_for_intent(i) == "web.sports_score", "action_name=web.sports_score")

i = classify_sports_intent("Do you know if the Lakers won the recent game?")
ok(i["is_sports"] and i["entity"] == "Lakers" and i["query_type"] == "latest_result",
   "recent game → Lakers latest_result", str(i))

# Test 3: follow-up "who did they play?" with prior Lakers latest_result context.
section("NBA — Lakers follow-up inherits team from context")
ctx_lakers = {
    "sport": "nba", "entity": "Lakers", "entity_type": "team",
    "tournament_or_league": "", "query_type": "latest_result",
    "created_at": 0.0, "timestamp": 0.0,
}
i = classify_sports_intent("who did they play?", recent_sports_context=ctx_lakers)
ok(i["is_sports"] and i["entity"] == "Lakers",
   "'who did they play?' inherits Lakers", str(i))
ok(i["followup_used"], "followup_used=True", str(i))
ok(i["query_type"] in ("latest_result", "schedule"),
   "query_type ∈ {latest_result, schedule}", str(i))

# ---------------------------------------------------------------------------
# Tennis — Test 4, 5, 6, 7
# ---------------------------------------------------------------------------
section("Tennis — Djokovic / Roland Garros tournament status")
i = classify_sports_intent("Is Djokovic still in Roland Garros?")
ok(i["is_sports"], "is_sports", str(i))
ok(i["entity"] == "Novak Djokovic", "entity=Novak Djokovic", str(i))
ok(i["entity_type"] == "player", "entity_type=player", str(i))
ok("tennis" in (i["sport"] or ""), "sport ∋ tennis", str(i))
ok(i["tournament_or_league"] == "Roland Garros", "tournament=Roland Garros", str(i))
ok(i["query_type"] == "tournament_status", "query_type=tournament_status", str(i))
ok(action_name_for_intent(i) == "web.sports_tournament_status",
   "action_name=web.sports_tournament_status")

section("Tennis — Djokovic lost in the third round")
i = classify_sports_intent("Did Djokovic lose in the third round?")
ok(i["is_sports"], "is_sports", str(i))
ok(i["entity"] == "Novak Djokovic", "entity=Novak Djokovic", str(i))
ok(i["query_type"] == "tournament_status", "query_type=tournament_status", str(i))

# Test 6: "how about Sinner?" follow-up after Djokovic/Roland Garros.
section("Tennis — 'how about Sinner?' inherits Roland Garros")
ctx_dj = {
    "sport": "tennis_atp", "entity": "Novak Djokovic", "entity_type": "player",
    "tournament_or_league": "Roland Garros", "query_type": "tournament_status",
    "created_at": 0.0, "timestamp": 0.0,
}
i = classify_sports_intent("how about Sinner?", recent_sports_context=ctx_dj)
ok(i["is_sports"], "is_sports", str(i))
ok(i["entity"] == "Jannik Sinner", "entity=Jannik Sinner", str(i))
ok(i["tournament_or_league"] == "Roland Garros", "tournament inherited", str(i))
ok(i["query_type"] == "tournament_status", "query_type inherited", str(i))

# Test 7: Alcaraz schedule.
section("Tennis — Alcaraz schedule")
i = classify_sports_intent("Who does Alcaraz play next?")
ok(i["is_sports"], "is_sports", str(i))
ok(i["entity"] == "Carlos Alcaraz", "entity=Carlos Alcaraz", str(i))
ok(i["query_type"] == "schedule", "query_type=schedule", str(i))
ok(action_name_for_intent(i) == "web.sports_schedule",
   "action_name=web.sports_schedule")

# ---------------------------------------------------------------------------
# Soccer — Test 8, 9
# ---------------------------------------------------------------------------
section("Soccer — Real Madrid latest result")
i = classify_sports_intent("Did Real Madrid win their last game?")
ok(i["is_sports"], "is_sports", str(i))
ok(i["entity"] == "Real Madrid", "entity=Real Madrid", str(i))
ok(i["entity_type"] == "team", "entity_type=team", str(i))
ok(i["query_type"] == "latest_result", "query_type=latest_result", str(i))

section("Soccer — Arsenal next fixture")
i = classify_sports_intent("Who does Arsenal play next?")
ok(i["is_sports"], "is_sports", str(i))
ok(i["entity"] == "Arsenal", "entity=Arsenal", str(i))
ok(i["query_type"] == "schedule", "query_type=schedule", str(i))

# ---------------------------------------------------------------------------
# Ambiguous — Test 10, 11
# ---------------------------------------------------------------------------
section("Ambiguous — pure pronoun without any sports context")
i = classify_sports_intent("Did they win?")  # no context
ok(i["is_sports"], "still flagged as sports (we know the shape)", str(i))
ok(i["needs_clarification"], "needs_clarification=True", str(i))
ok(i["entity"] == "" and i["query_type"] == "", "entity/query_type empty", str(i))

i = classify_sports_intent("how about him?")  # no context
ok(i["is_sports"], "how about him? still flagged as sports", str(i))
ok(i["needs_clarification"], "needs_clarification=True", str(i))

# ---------------------------------------------------------------------------
# Non-sports — guards against false positives.
# ---------------------------------------------------------------------------
section("Non-sports — guards")
ok(not classify_sports_intent("I'm a sinner trying to make it right")["is_sports"],
   "religious 'sinner' rejected without sports context")
ok(not classify_sports_intent("the kane mutiny was a book about leadership")["is_sports"],
   "non-sports 'kane' rejected")
ok(not classify_sports_intent("what time is it?")["is_sports"], "time question not sports")
ok(not classify_sports_intent("play some lo-fi")["is_sports"], "music command not sports")

# ---------------------------------------------------------------------------
# Query-construction sanity.
# ---------------------------------------------------------------------------
section("Query construction")
intent = classify_sports_intent("Is Djokovic still in Roland Garros?")
qs = build_sports_search_queries(intent, "Is Djokovic still in Roland Garros?")
ok(len(qs) >= 1, "at least one query built", str(qs))
joined = " | ".join(qs).lower()
ok("djokovic" in joined and "roland garros" in joined,
   "query mentions both entity and tournament", str(qs))
ok("draw" in joined or "round" in joined or "eliminated" in joined,
   "tournament_status keywords appended", str(qs))

intent = classify_sports_intent("Did the Lakers win?")
qs = build_sports_search_queries(intent, "Did the Lakers win?")
joined = " | ".join(qs).lower()
ok("lakers" in joined, "lakers query has Lakers")
ok("score" in joined or "result" in joined, "latest_result keywords appended")

# ---------------------------------------------------------------------------
# Router integration — classify_info_tool routes to sports_tool.
# ---------------------------------------------------------------------------
section("Router integration — classify_info_tool/build_route_from_info_tool")
c = app.classify_info_tool(
    "Is Djokovic still in Roland Garros?",
    recent_news_context=None,
    recent_sports_context=None,
    session_id="smoke-sports",
)
ok(c["route"] == "sports_tool", f"route=sports_tool got={c['route']}", str(c))
ok(c.get("sports_intent", {}).get("entity") == "Novak Djokovic",
   "sports_intent.entity=Novak Djokovic", str(c))
built = app.build_route_from_info_tool(
    "Is Djokovic still in Roland Garros?", c, session_id="smoke-sports"
)
ok(built is not None, "build_route_from_info_tool returned a route")
ok(built and built.get("action_name") == "web.sports_tournament_status",
   "action_name=web.sports_tournament_status",
   str(built and built.get("action_name")))

c = app.classify_info_tool(
    "Did the Lakers win?",
    recent_news_context=None,
    recent_sports_context=None,
    session_id="smoke-sports",
)
ok(c["route"] == "sports_tool", "Lakers → sports_tool", str(c))
built = app.build_route_from_info_tool("Did the Lakers win?", c, session_id="smoke-sports")
ok(built and built.get("action_name") == "web.sports_score",
   "action_name=web.sports_score",
   str(built and built.get("action_name")))

c = app.classify_info_tool(
    "Who does Alcaraz play next?",
    recent_news_context=None,
    recent_sports_context=None,
    session_id="smoke-sports",
)
ok(c["route"] == "sports_tool", "Alcaraz next → sports_tool", str(c))
built = app.build_route_from_info_tool(
    "Who does Alcaraz play next?", c, session_id="smoke-sports"
)
ok(built and built.get("action_name") == "web.sports_schedule",
   "action_name=web.sports_schedule",
   str(built and built.get("action_name")))

c = app.classify_info_tool(
    "Did they win?",
    recent_news_context=None,
    recent_sports_context=None,
    session_id="smoke-sports",
)
ok(c["route"] == "sports_clarification_needed",
   "pronoun without ctx → sports_clarification_needed", str(c))

# ---------------------------------------------------------------------------
# Recent sports context helpers + TTL cleanup wiring.
# ---------------------------------------------------------------------------
section("recent_sports_context helpers")
sid = "smoke-sports-ctx"
app.recent_sports_context.pop(sid, None)
ar = {
    "spoken_reply": "Yes, the Lakers beat the Celtics 110-105.",
    "action_type": "web_search",
    "data": {"answer_confidence": "high"},
}
intent_obj = {
    "is_sports": True,
    "sport": "nba",
    "entity": "Lakers",
    "entity_type": "team",
    "tournament_or_league": "",
    "query_type": "latest_result",
    "confidence": 0.92,
    "reason": "entity_plus_result_shape",
}
app.set_recent_sports_context_from_action_result(sid, "did the lakers win?", intent_obj, ar)
ctx = app.get_recent_sports_context(sid)
ok(ctx is not None, "ctx persisted")
ok(ctx.get("entity") == "Lakers", "ctx entity=Lakers", str(ctx))
ok(ctx.get("sport") == "nba", "ctx sport=nba", str(ctx))
ok(ctx.get("query_type") == "latest_result", "ctx query_type=latest_result", str(ctx))

# Follow-up "how about Warriors?" should inherit query_type from ctx.
i = classify_sports_intent("how about the Warriors?", recent_sports_context=ctx)
ok(i["is_sports"] and i["entity"] == "Warriors", "Warriors entity resolved", str(i))
ok(i["query_type"] == "latest_result", "inherits latest_result", str(i))
ok(i["followup_used"], "followup_used=True", str(i))

# ---------------------------------------------------------------------------
print(f"\n{GREEN}PASS{RESET}: {PASS}    {RED}FAIL{RESET}: {FAIL}")
if FAIL:
    print(f"{RED}Failed cases:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
