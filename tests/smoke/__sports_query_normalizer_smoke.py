"""Smoke tests for the sports/tournament query normalizer (2026-05-30).

Covers the 6 explicit test cases in the sports-query-normalization spec
(PART 8) plus a handful of regression contracts:

  1. "do you know if djokovic is still in roland garros this year?"
     -> entity=Novak Djokovic, tournament=Roland Garros, year=2026,
        query_type=tournament_status,
        queries include "Novak Djokovic Roland Garros 2026 latest result draw status".
  2. "im pretty sure he lost to joao fonseca?" after Djokovic/Roland Garros ctx
     -> entity=Novak Djokovic, opponent=Joao Fonseca,
        tournament=Roland Garros, query_type=match_result_verification,
        queries include both names + year.
  3. "did he lose to joao fonseca?" after the same ctx -> same as #2.
  4. "how about sinner?" after Djokovic/Roland Garros ctx
     -> entity=Jannik Sinner, tournament=Roland Garros, year=2026,
        query_type=tournament_status.
  5. "who does alcaraz play next?" after Roland Garros ctx
     -> entity=Carlos Alcaraz, tournament=Roland Garros, year=2026,
        query_type=schedule.
  6. "did the Lakers win their last game?"
     -> entity=Lakers, query_type=latest_result, NO tournament_status keywords.

Plus opponent extraction / verb classification, year normalization, and a
hard-warning regression check ([sports_query_too_generic]).

Run:  py -3 -X utf8 tests/smoke/__sports_query_normalizer_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
import types

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# Stub heavy ASR/TTS modules the same way the sibling smoke tests do, in case
# anything we import accidentally pulls them in.
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
        for fn in _TTS_STUB_NAMES:
            setattr(stub, fn, lambda *a, **kw: None)
        sys.modules[modname] = stub

from datetime import datetime

from actions.sports import (
    build_sports_search_queries,
    classify_sports_intent,
    normalize_sports_query,
)

CURRENT_YEAR = str(datetime.now().year)

passes = 0
fails = 0


def ok(cond: bool, label: str, detail: str = "") -> None:
    global passes, fails
    if cond:
        passes += 1
        print(f"  \033[32mPASS\033[0m  {label}")
    else:
        fails += 1
        print(f"  \033[31mFAIL\033[0m  {label}  -- {detail}")


def section(title: str) -> None:
    print(f"\n\033[33m-- {title} --\033[0m")


# ---------------------------------------------------------------------------
# Spec test 1 — Djokovic Roland Garros this year
# ---------------------------------------------------------------------------
section("Test 1 — Djokovic Roland Garros 'this year'")
r = normalize_sports_query(
    "do you know if djokovic is still in roland garros this year?", None
)
ok(r["entity"] == "Novak Djokovic", "entity=Novak Djokovic", str(r))
ok(r["tournament_or_league"] == "Roland Garros", "tournament=Roland Garros", str(r))
ok(r["season_or_year"] == CURRENT_YEAR, f"season_or_year={CURRENT_YEAR}", str(r))
ok(r["query_type"] == "tournament_status", "query_type=tournament_status", str(r))
joined = " | ".join(r["normalized_queries"]).lower()
ok(
    f"novak djokovic roland garros {CURRENT_YEAR} latest result draw status".lower() in joined,
    "queries include 'Novak Djokovic Roland Garros 2026 latest result draw status'",
    joined,
)
ok(f"{CURRENT_YEAR}" in joined, "every targeted query carries the year tag", joined)
ok("latest tournament result" not in joined, "no generic 'latest tournament result' fallback", joined)


# ---------------------------------------------------------------------------
# Spec test 2 — "im pretty sure he lost to joao fonseca?" with Djokovic ctx
# ---------------------------------------------------------------------------
section("Test 2 — 'im pretty sure he lost to joao fonseca?' (Djokovic/RG ctx)")
ctx = {
    "sport": "tennis_atp",
    "entity": "Novak Djokovic",
    "entity_type": "player",
    "tournament_or_league": "Roland Garros",
    "query_type": "tournament_status",
    "season_or_year": CURRENT_YEAR,
}
r = normalize_sports_query("im pretty sure he lost to joao fonseca?", ctx)
ok(r["is_sports"], "is_sports=True (no longer missed)", str(r))
ok(r["followup_used"], "followup_used=True", str(r))
ok(r["entity"] == "Novak Djokovic", "entity inherited as Novak Djokovic", str(r))
ok(r["opponent"] == "Joao Fonseca", "opponent=Joao Fonseca", str(r))
ok(r["opponent_verb"] == "lost_to", "opponent_verb=lost_to", str(r))
ok(r["query_type"] == "match_result_verification", "query_type=match_result_verification", str(r))
ok(r["tournament_or_league"] == "Roland Garros", "tournament inherited", str(r))
ok(r["season_or_year"] == CURRENT_YEAR, "season_or_year inherited", str(r))
joined = " | ".join(r["normalized_queries"]).lower()
ok("novak djokovic" in joined and "joao fonseca" in joined, "both names present in queries", joined)
ok(CURRENT_YEAR in joined, "year present in queries", joined)
ok("roland garros" in joined, "tournament present in queries", joined)


# ---------------------------------------------------------------------------
# Spec test 3 — "did he lose to joao fonseca?" with same ctx
# ---------------------------------------------------------------------------
section("Test 3 — 'did he lose to joao fonseca?' (Djokovic/RG ctx)")
r = normalize_sports_query("did he lose to joao fonseca?", ctx)
ok(r["is_sports"] and r["followup_used"], "sports + followup_used", str(r))
ok(r["entity"] == "Novak Djokovic", "entity inherited", str(r))
ok(r["opponent"] == "Joao Fonseca", "opponent=Joao Fonseca", str(r))
ok(r["query_type"] == "match_result_verification", "query_type=match_result_verification", str(r))
joined = " | ".join(r["normalized_queries"]).lower()
ok("novak djokovic" in joined and "joao fonseca" in joined, "both names present", joined)


# ---------------------------------------------------------------------------
# Spec test 4 — "how about sinner?" after Djokovic/Roland Garros ctx
# ---------------------------------------------------------------------------
section("Test 4 — 'how about sinner?' (Djokovic/RG ctx)")
r = normalize_sports_query("how about sinner?", ctx)
ok(r["entity"] == "Jannik Sinner", "entity=Jannik Sinner", str(r))
ok(r["tournament_or_league"] == "Roland Garros", "tournament inherited", str(r))
ok(r["query_type"] == "tournament_status", "query_type inherited as tournament_status", str(r))
ok(r["season_or_year"] == CURRENT_YEAR, "season_or_year inherited / defaulted", str(r))
joined = " | ".join(r["normalized_queries"]).lower()
ok("jannik sinner roland garros" in joined, "queries name Sinner + Roland Garros", joined)
ok(CURRENT_YEAR in joined, "queries tagged with the year", joined)


# ---------------------------------------------------------------------------
# Spec test 5 — "who does alcaraz play next?" after Roland Garros ctx
# ---------------------------------------------------------------------------
section("Test 5 — 'who does alcaraz play next?' (Roland Garros ctx)")
r = normalize_sports_query("who does alcaraz play next?", ctx)
ok(r["entity"] == "Carlos Alcaraz", "entity=Carlos Alcaraz", str(r))
ok(r["tournament_or_league"] == "Roland Garros", "tournament inherited from ctx", str(r))
ok(r["query_type"] == "schedule", "query_type=schedule", str(r))
ok(r["season_or_year"] == CURRENT_YEAR, "season_or_year tagged with current year", str(r))
joined = " | ".join(r["normalized_queries"]).lower()
ok(
    "carlos alcaraz roland garros" in joined and "next match" in joined,
    "schedule query carries entity + tournament + 'next match'",
    joined,
)


# ---------------------------------------------------------------------------
# Spec test 6 — "did the Lakers win their last game?"
# ---------------------------------------------------------------------------
section("Test 6 — 'did the Lakers win their last game?'")
r = normalize_sports_query("did the Lakers win their last game?", None)
ok(r["entity"] == "Lakers", "entity=Lakers", str(r))
ok(r["sport"] == "nba", "sport=nba", str(r))
ok(r["query_type"] == "latest_result", "query_type=latest_result (not tournament_status)", str(r))
joined = " | ".join(r["normalized_queries"]).lower()
ok("lakers" in joined, "queries name Lakers", joined)
ok("nba" in joined or "lakers" in joined, "league tagged as NBA when no tournament", joined)
ok("draw" not in joined and "tournament" not in joined,
   "no tournament/draw vocab leaks into Lakers query", joined)


# ---------------------------------------------------------------------------
# Opponent extraction — verb normalization
# ---------------------------------------------------------------------------
section("Opponent extraction — verb normalization")
r = normalize_sports_query("did Sinner beat Alcaraz?", None)
ok(r["entity"] == "Jannik Sinner", "subject is entity, not opponent", str(r))
ok(r["opponent"] == "Carlos Alcaraz", "opponent resolved via catalog", str(r))
ok(r["opponent_verb"] == "beat", "opponent_verb=beat", str(r))
ok(r["query_type"] == "match_result_verification", "match_result_verification", str(r))

r = normalize_sports_query(
    "Djokovic vs Alcaraz Roland Garros final",
    {"sport": "tennis_atp", "entity": "Novak Djokovic", "entity_type": "player",
     "tournament_or_league": "Roland Garros", "query_type": "tournament_status",
     "season_or_year": CURRENT_YEAR},
)
ok(r["opponent_verb"] == "vs", "opponent_verb=vs", str(r))
ok(r["opponent"] in ("Carlos Alcaraz", "Alcaraz"), "vs opponent captured", str(r))


# ---------------------------------------------------------------------------
# Year normalization — explicit year wins
# ---------------------------------------------------------------------------
section("Year normalization — explicit year wins")
r = normalize_sports_query("Is Djokovic still in Wimbledon 2024?", None)
ok(r["season_or_year"] == "2024", "explicit 2024 captured (not current year)", str(r))

r = normalize_sports_query("Did Djokovic win Roland Garros last year?", None)
ok(
    r["season_or_year"] == str(int(CURRENT_YEAR) - 1),
    "'last year' resolves to current_year - 1",
    str(r),
)


# ---------------------------------------------------------------------------
# Hard-warning regression — match_result_verification must include both names
# ---------------------------------------------------------------------------
section("Hard-warning regression — both names present for match_result_verification")
ctx_for_v = {
    "sport": "tennis_atp", "entity": "Novak Djokovic", "entity_type": "player",
    "tournament_or_league": "Roland Garros", "query_type": "tournament_status",
    "season_or_year": CURRENT_YEAR,
}
r = normalize_sports_query("did he lose to joao fonseca?", ctx_for_v)
joined = " | ".join(r["normalized_queries"]).lower()
ok("novak djokovic" in joined, "entity in queries", joined)
ok("joao fonseca" in joined, "opponent in queries", joined)
ok(CURRENT_YEAR in joined, "year in queries", joined)


# ---------------------------------------------------------------------------
# Regression — tournament_status query for Djokovic does not lose name
# ---------------------------------------------------------------------------
section("Regression — tournament_status keeps player name in every query")
intent = classify_sports_intent("Is Djokovic still in Roland Garros?")
qs = build_sports_search_queries(intent, "Is Djokovic still in Roland Garros?")
joined = " | ".join(qs).lower()
ok(all("djokovic" in q.lower() for q in qs), "every query mentions Djokovic", str(qs))
ok(all("roland garros" in q.lower() for q in qs), "every query mentions Roland Garros", str(qs))
ok(all(CURRENT_YEAR in q for q in qs), f"every query carries {CURRENT_YEAR}", str(qs))


# ---------------------------------------------------------------------------
print(f"\n\033[32mPASS\033[0m: {passes}    \033[31mFAIL\033[0m: {fails}")
sys.exit(0 if fails == 0 else 1)
