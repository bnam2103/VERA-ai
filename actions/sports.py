"""Sport-aware intent classifier and search executor.

The legacy implementation treated sports as a flat fallback to ``web.search`` with
an NBA-heavy team-name regex. That collapsed every sports utterance into the same
generic ``media_tabs`` panel labeled "Search Results", lost any cross-turn topic,
and could not tell "is X still in the tournament" from "did X win the game".

This module replaces that with an explicit sports classifier and execution layer:

  * ``classify_sports_intent`` — deterministic detector. Returns a structured
    intent ``{sport, entity, entity_type, query_type, tournament_or_league,
    confidence, reason}`` plus a follow-up resolution block.
  * ``resolve_sports_followup`` — handles "how about Sinner?" / "who did they
    play?" / "did he win?" against a stored ``recent_sports_context``.
  * ``build_sports_search_query`` — sport- and query-type-aware Serper query
    construction (e.g. tennis tournament status adds the round / draw terms;
    "next match" adds the schedule terms).
  * ``prepare_sports_streaming`` / ``handle_sports_request`` — execution. Uses
    Serper /search + /news together, builds a sport-specific prompt that forces
    the LLM to either give a clear yes/no answer or admit it can't, stamps the
    panel as ``result_kind="sports"`` / ``"tournament"``, and emits the
    ``[sports_intent]`` log + ``[sports_query_web_fallback_low_confidence]``
    warning when the snippets do not support a confident answer.

No structured sports API is plumbed in. The "structured lookup" surface is the
``structured_lookup`` adapter slot (returns ``None`` today); when a real API is
plugged in later, the executor will prefer its answer and demote Serper to a
backup. The honest fallback wording is mandatory whenever the executor relies
purely on web snippets and could not match a strong tournament-status / score
signal.

Generalization design notes:
  * Entity dictionaries are extensible. Adding more players/tournaments/teams
    does NOT require any router change.
  * NO Lakers-specific code lives here. The NBA team list is the same shape
    as the soccer / MLB / NFL / NHL lists.
  * Query-type detection is regex-only and fires on phrasing, not entity.
    Pronoun-only utterances with no recent context return
    ``clarification_needed`` rather than fabricating a topic.
"""

from __future__ import annotations

import json
import re
import time as _time
from typing import Any

# --------------------------------------------------------------------------
# Module-level entity catalog. Each entry is (canonical_name, sport, tags).
# Tags carry the tournament/league association so a single token resolves
# both ``sport`` and ``tournament_or_league`` in one pass.
# --------------------------------------------------------------------------

# NBA teams. Keep aliases (city, mascot, nickname) on the same canonical name.
_NBA_TEAMS = [
    ("Lakers", "nba", ["los angeles lakers", "la lakers", "lakers"]),
    ("Clippers", "nba", ["los angeles clippers", "la clippers", "clippers"]),
    ("Warriors", "nba", ["golden state warriors", "warriors", "dubs"]),
    ("Celtics", "nba", ["boston celtics", "celtics"]),
    ("Knicks", "nba", ["new york knicks", "ny knicks", "knicks"]),
    ("Heat", "nba", ["miami heat", "heat"]),
    ("Bulls", "nba", ["chicago bulls", "bulls"]),
    ("Spurs", "nba", ["san antonio spurs", "spurs"]),
    ("Nets", "nba", ["brooklyn nets", "nets"]),
    ("76ers", "nba", ["philadelphia 76ers", "philly 76ers", "sixers", "76ers"]),
    ("Raptors", "nba", ["toronto raptors", "raptors"]),
    ("Bucks", "nba", ["milwaukee bucks", "bucks"]),
    ("Mavericks", "nba", ["dallas mavericks", "mavericks", "mavs"]),
    ("Nuggets", "nba", ["denver nuggets", "nuggets"]),
    ("Suns", "nba", ["phoenix suns", "suns"]),
    ("Kings", "nba", ["sacramento kings", "kings"]),
    ("Pelicans", "nba", ["new orleans pelicans", "pelicans"]),
    ("Jazz", "nba", ["utah jazz", "jazz"]),
    ("Wizards", "nba", ["washington wizards", "wizards"]),
    ("Hawks", "nba", ["atlanta hawks", "hawks"]),
    ("Hornets", "nba", ["charlotte hornets", "hornets"]),
    ("Magic", "nba", ["orlando magic", "magic"]),
    ("Grizzlies", "nba", ["memphis grizzlies", "grizzlies"]),
    ("Thunder", "nba", ["oklahoma city thunder", "okc thunder", "thunder"]),
    ("Rockets", "nba", ["houston rockets", "rockets"]),
    ("Timberwolves", "nba", ["minnesota timberwolves", "timberwolves", "wolves"]),
    ("Trail Blazers", "nba", ["portland trail blazers", "trail blazers", "blazers"]),
    ("Pacers", "nba", ["indiana pacers", "pacers"]),
    ("Pistons", "nba", ["detroit pistons", "pistons"]),
    ("Cavaliers", "nba", ["cleveland cavaliers", "cavaliers", "cavs"]),
]

# NFL teams. Aliased so "niners" → 49ers etc.
_NFL_TEAMS = [
    ("49ers", "nfl", ["san francisco 49ers", "49ers", "niners"]),
    ("Patriots", "nfl", ["new england patriots", "patriots", "pats"]),
    ("Eagles", "nfl", ["philadelphia eagles", "eagles"]),
    ("Cowboys", "nfl", ["dallas cowboys", "cowboys"]),
    ("Chiefs", "nfl", ["kansas city chiefs", "kc chiefs", "chiefs"]),
    ("Packers", "nfl", ["green bay packers", "packers"]),
    ("Bears", "nfl", ["chicago bears", "bears"]),
    ("Bills", "nfl", ["buffalo bills", "bills"]),
    ("Steelers", "nfl", ["pittsburgh steelers", "steelers"]),
    ("Ravens", "nfl", ["baltimore ravens", "ravens"]),
    ("Broncos", "nfl", ["denver broncos", "broncos"]),
    ("Raiders", "nfl", ["las vegas raiders", "raiders"]),
    ("Chargers", "nfl", ["los angeles chargers", "chargers"]),
    ("Jets", "nfl", ["new york jets", "jets"]),
    ("Saints", "nfl", ["new orleans saints", "saints"]),
    ("Falcons", "nfl", ["atlanta falcons", "falcons"]),
    ("Panthers", "nfl", ["carolina panthers", "panthers"]),
    ("Buccaneers", "nfl", ["tampa bay buccaneers", "buccaneers", "bucs"]),
    ("Seahawks", "nfl", ["seattle seahawks", "seahawks"]),
    ("Rams", "nfl", ["los angeles rams", "la rams", "rams"]),
    ("Vikings", "nfl", ["minnesota vikings", "vikings"]),
    ("Lions", "nfl", ["detroit lions", "lions"]),
]

# MLB teams. "Giants" is ambiguous between NY Giants (NFL) and SF Giants (MLB);
# we tag MLB Giants here and resolve by surrounding sport/league cues at runtime.
_MLB_TEAMS = [
    ("Yankees", "mlb", ["new york yankees", "ny yankees", "yankees"]),
    ("Red Sox", "mlb", ["boston red sox", "red sox"]),
    ("Dodgers", "mlb", ["los angeles dodgers", "la dodgers", "dodgers"]),
    ("Cubs", "mlb", ["chicago cubs", "cubs"]),
    ("Mets", "mlb", ["new york mets", "ny mets", "mets"]),
    ("Astros", "mlb", ["houston astros", "astros"]),
    ("Braves", "mlb", ["atlanta braves", "braves"]),
    ("Phillies", "mlb", ["philadelphia phillies", "phillies"]),
    ("Orioles", "mlb", ["baltimore orioles", "orioles"]),
    ("Nationals", "mlb", ["washington nationals", "nationals", "nats"]),
    ("Cardinals", "mlb", ["st. louis cardinals", "st louis cardinals", "cardinals"]),
    ("Brewers", "mlb", ["milwaukee brewers", "brewers"]),
    ("Padres", "mlb", ["san diego padres", "padres"]),
    ("Angels", "mlb", ["los angeles angels", "la angels", "angels"]),
    ("Royals", "mlb", ["kansas city royals", "kc royals", "royals"]),
    ("Tigers", "mlb", ["detroit tigers", "tigers"]),
    ("Giants", "mlb", ["san francisco giants", "sf giants"]),
    # NFL "New York Giants" is matched as a separate string above; bare
    # "giants" stays mlb-default because MLB Giants are more common in voice.
]

# NHL teams (compact list; aliases follow same shape).
_NHL_TEAMS = [
    ("Maple Leafs", "nhl", ["toronto maple leafs", "leafs", "maple leafs"]),
    ("Canadiens", "nhl", ["montreal canadiens", "canadiens", "habs"]),
    ("Bruins", "nhl", ["boston bruins", "bruins"]),
    ("Rangers", "nhl", ["new york rangers", "rangers"]),
    ("Penguins", "nhl", ["pittsburgh penguins", "penguins"]),
    ("Capitals", "nhl", ["washington capitals", "capitals", "caps"]),
    ("Oilers", "nhl", ["edmonton oilers", "oilers"]),
    ("Flames", "nhl", ["calgary flames", "flames"]),
    ("Avalanche", "nhl", ["colorado avalanche", "avalanche", "avs"]),
    ("Golden Knights", "nhl", ["vegas golden knights", "golden knights"]),
]

# Soccer clubs from the major European leagues + a few MLS / international.
_SOCCER_CLUBS = [
    ("Real Madrid", "soccer_laliga", ["real madrid"]),
    ("Barcelona", "soccer_laliga", ["fc barcelona", "barcelona", "barca", "barça"]),
    ("Atletico Madrid", "soccer_laliga", ["atletico madrid", "atlético madrid", "atleti"]),
    ("Liverpool", "soccer_epl", ["liverpool fc", "liverpool"]),
    ("Arsenal", "soccer_epl", ["arsenal fc", "arsenal"]),
    ("Chelsea", "soccer_epl", ["chelsea fc", "chelsea"]),
    ("Tottenham", "soccer_epl", ["tottenham hotspur", "tottenham", "spurs"]),
    ("Manchester United", "soccer_epl", ["manchester united", "man united", "man utd"]),
    ("Manchester City", "soccer_epl", ["manchester city", "man city"]),
    ("Newcastle", "soccer_epl", ["newcastle united", "newcastle"]),
    ("Bayern Munich", "soccer_bundesliga", ["bayern munich", "bayern münchen", "bayern"]),
    ("Borussia Dortmund", "soccer_bundesliga", ["borussia dortmund", "bvb", "dortmund"]),
    ("PSG", "soccer_ligue1", ["paris saint-germain", "paris saint germain", "psg"]),
    ("Juventus", "soccer_seriea", ["juventus", "juve"]),
    ("Inter Milan", "soccer_seriea", ["inter milan", "internazionale"]),
    ("AC Milan", "soccer_seriea", ["ac milan", "milan"]),
    ("Napoli", "soccer_seriea", ["ssc napoli", "napoli"]),
]

# Tennis players (top ATP + WTA). Keep canonical with surname-only alias so
# voice transcripts like "djokovic" or "alcaraz" resolve. "Sinner" is a real
# player name that overlaps a sports verb; it is still safe because the
# classifier requires the surrounding question shape OR explicit
# tournament-status terms before promoting it to a sports entity (see
# ``_resolve_entity_in_text`` below).
_TENNIS_PLAYERS = [
    ("Novak Djokovic", "tennis_atp", ["novak djokovic", "djokovic", "novak"]),
    ("Carlos Alcaraz", "tennis_atp", ["carlos alcaraz", "alcaraz"]),
    ("Jannik Sinner", "tennis_atp", ["jannik sinner", "sinner"]),
    ("Daniil Medvedev", "tennis_atp", ["daniil medvedev", "medvedev"]),
    ("Alexander Zverev", "tennis_atp", ["alexander zverev", "zverev"]),
    ("Stefanos Tsitsipas", "tennis_atp", ["stefanos tsitsipas", "tsitsipas"]),
    ("Holger Rune", "tennis_atp", ["holger rune", "rune"]),
    ("Casper Ruud", "tennis_atp", ["casper ruud", "ruud"]),
    ("Andrey Rublev", "tennis_atp", ["andrey rublev", "rublev"]),
    ("Hubert Hurkacz", "tennis_atp", ["hubert hurkacz", "hurkacz"]),
    ("Taylor Fritz", "tennis_atp", ["taylor fritz", "fritz"]),
    ("Frances Tiafoe", "tennis_atp", ["frances tiafoe", "tiafoe"]),
    ("Ben Shelton", "tennis_atp", ["ben shelton", "shelton"]),
    ("Iga Swiatek", "tennis_wta", ["iga swiatek", "iga świątek", "swiatek"]),
    ("Aryna Sabalenka", "tennis_wta", ["aryna sabalenka", "sabalenka"]),
    ("Coco Gauff", "tennis_wta", ["coco gauff", "gauff"]),
    ("Elena Rybakina", "tennis_wta", ["elena rybakina", "rybakina"]),
    ("Jessica Pegula", "tennis_wta", ["jessica pegula", "pegula"]),
    ("Ons Jabeur", "tennis_wta", ["ons jabeur", "jabeur"]),
    ("Naomi Osaka", "tennis_wta", ["naomi osaka", "osaka"]),
    ("Emma Raducanu", "tennis_wta", ["emma raducanu", "raducanu"]),
    ("Madison Keys", "tennis_wta", ["madison keys"]),
]

# Top soccer players. Same canonical+alias shape.
_SOCCER_PLAYERS = [
    ("Lionel Messi", "soccer", ["lionel messi", "messi"]),
    ("Cristiano Ronaldo", "soccer", ["cristiano ronaldo", "ronaldo"]),
    ("Kylian Mbappe", "soccer", ["kylian mbappe", "kylian mbappé", "mbappe", "mbappé"]),
    ("Erling Haaland", "soccer", ["erling haaland", "haaland"]),
    ("Vinicius Junior", "soccer", ["vinicius junior", "vinicius jr", "vinicius"]),
    ("Jude Bellingham", "soccer", ["jude bellingham", "bellingham"]),
    ("Bukayo Saka", "soccer", ["bukayo saka", "saka"]),
    ("Harry Kane", "soccer", ["harry kane", "kane"]),
    ("Mohamed Salah", "soccer", ["mohamed salah", "mo salah", "salah"]),
    ("Robert Lewandowski", "soccer", ["robert lewandowski", "lewandowski"]),
    ("Kevin De Bruyne", "soccer", ["kevin de bruyne", "de bruyne"]),
]

# Tournaments and majors. Tag carries both sport and tournament name so a
# single match populates both ``sport`` and ``tournament_or_league``.
_TOURNAMENTS = [
    ("Roland Garros", "tennis", "Roland Garros", ["roland garros", "french open"]),
    ("Wimbledon", "tennis", "Wimbledon", ["wimbledon"]),
    ("US Open (Tennis)", "tennis", "US Open", ["us open tennis", "us open"]),
    ("Australian Open", "tennis", "Australian Open", ["australian open", "aussie open"]),
    ("ATP Finals", "tennis_atp", "ATP Finals", ["atp finals", "year-end finals"]),
    ("WTA Finals", "tennis_wta", "WTA Finals", ["wta finals"]),
    ("UEFA Champions League", "soccer", "UEFA Champions League",
        ["champions league", "uefa champions league", "ucl"]),
    ("UEFA Europa League", "soccer", "UEFA Europa League",
        ["europa league", "uefa europa league"]),
    ("FIFA World Cup", "soccer", "FIFA World Cup", ["fifa world cup", "world cup"]),
    ("Premier League", "soccer_epl", "Premier League",
        ["english premier league", "premier league", "epl"]),
    ("La Liga", "soccer_laliga", "La Liga", ["la liga", "laliga"]),
    ("Serie A", "soccer_seriea", "Serie A", ["serie a"]),
    ("Bundesliga", "soccer_bundesliga", "Bundesliga", ["bundesliga"]),
    ("Ligue 1", "soccer_ligue1", "Ligue 1", ["ligue 1", "ligue un"]),
    ("MLS Cup", "soccer_mls", "MLS Cup", ["mls cup"]),
    ("MLS", "soccer_mls", "MLS", ["mls", "major league soccer"]),
    ("NBA Finals", "nba", "NBA Finals", ["nba finals"]),
    ("NBA Playoffs", "nba", "NBA Playoffs", ["nba playoffs"]),
    ("NBA", "nba", "NBA", ["nba", "national basketball association"]),
    ("Super Bowl", "nfl", "Super Bowl", ["super bowl", "superbowl"]),
    ("NFL Playoffs", "nfl", "NFL Playoffs", ["nfl playoffs"]),
    ("NFL", "nfl", "NFL", ["nfl", "national football league"]),
    ("World Series", "mlb", "World Series", ["world series"]),
    ("MLB Playoffs", "mlb", "MLB Playoffs", ["mlb playoffs"]),
    ("MLB", "mlb", "MLB", ["mlb", "major league baseball"]),
    ("Stanley Cup", "nhl", "Stanley Cup", ["stanley cup"]),
    ("NHL Playoffs", "nhl", "NHL Playoffs", ["nhl playoffs"]),
    ("NHL", "nhl", "NHL", ["nhl", "national hockey league"]),
    ("Masters Tournament", "golf", "Masters Tournament", ["the masters", "masters tournament"]),
    ("Formula 1", "f1", "Formula 1", ["formula 1", "formula one", "f1"]),
]


def _build_alias_index() -> list[tuple[str, str, str, str]]:
    """Flatten the catalogs into a single longest-first alias index.

    Returns rows of (alias_lower, canonical, entity_type, sport_or_tag,
    tournament_or_league). ``tournament_or_league`` is non-empty only for
    tournament entries; for teams/players it's "".

    Sorting longest-first matters so "manchester united" matches before the
    bare "manchester" or "united" tokens — same logic ``re.search`` greediness
    can't give us across multiple regex alternatives.
    """
    rows: list[tuple[str, str, str, str, str]] = []
    for canonical, sport, aliases in _NBA_TEAMS + _NFL_TEAMS + _MLB_TEAMS + _NHL_TEAMS:
        for a in aliases:
            rows.append((a.lower(), canonical, "team", sport, ""))
    for canonical, sport, aliases in _SOCCER_CLUBS:
        for a in aliases:
            rows.append((a.lower(), canonical, "team", sport, ""))
    for canonical, sport, aliases in _TENNIS_PLAYERS + _SOCCER_PLAYERS:
        for a in aliases:
            rows.append((a.lower(), canonical, "player", sport, ""))
    for canonical, sport, tournament, aliases in _TOURNAMENTS:
        for a in aliases:
            rows.append((a.lower(), canonical, "tournament", sport, tournament))
    # Longest alias first so multi-word names match before sub-substrings.
    rows.sort(key=lambda r: -len(r[0]))
    # Drop the extra column we used during construction.
    return [(alias, canonical, entity_type, sport, tournament)
            for (alias, canonical, entity_type, sport, tournament) in rows]


_ALIAS_INDEX: list[tuple[str, str, str, str, str]] = _build_alias_index()


# --------------------------------------------------------------------------
# Phrasing-driven detectors
# --------------------------------------------------------------------------

# Latest result / win-lose questions: "did X win", "X score", "result of X",
# "how did X do (last night|yesterday|tonight)". Excludes "win the trophy" /
# "win the title" — those are tournament_status when paired with a tournament.
_LATEST_RESULT_RE = re.compile(
    r"\b(?:"
    r"did\s+(?:the\s+)?\S[^?]{0,60}?\s+(?:win|won|lose|lost|beat|tie|tied|draw|drew)\b"
    r"|how\s+did\s+\S[^?]{0,40}?\s+(?:do|play|score)"
    r"|(?:final|game|match)\s+score"
    r"|did\s+\S[^?]{0,40}?\s+game"
    r"|(?:results?|final\s+score|box\s+score)\s+(?:of|for)"
    r"|(?:won|lost|beat|score(?:d)?)\s+(?:the\s+)?(?:game|match|series|fixture)"
    r"|recent\s+game"
    r")",
    re.IGNORECASE,
)

# Tournament status / draw status: "is X still in", "did X lose in the
# (round|semis|final|quarters|quarterfinal|semifinal|final)", "is X out of",
# "did X get knocked out", "did X advance".
_TOURNAMENT_STATUS_RE = re.compile(
    r"\b(?:"
    r"(?:still|already|finally)\s+in\b"
    r"|(?:still|already)\s+(?:in|playing|alive)\s+(?:the\s+)?(?:draw|tournament|playoffs|finals?|bracket)"
    r"|in\s+the\s+(?:draw|tournament|playoffs|finals?|bracket)"
    r"|(?:out\s+of|knocked\s+out|eliminated\s+from|exited\s+from|crashed\s+out\s+of)\s+(?:the\s+)?"
    r"|(?:advanced?|advance|through)\s+to\s+the\s+(?:next\s+round|round\s+of|quarter|semis?|semifinals?|final|finals)"
    r"|(?:lose|lost|beaten|defeated|knocked\s+out)\s+(?:in|at)\s+(?:the\s+)?"
    r"(?:first\s+round|second\s+round|third\s+round|fourth\s+round|round\s+of\s+(?:16|32|64|128)|"
    r"quarter|quarters|quarterfinals?|semis?|semifinals?|final|finals)"
    r"|reach(?:ed)?\s+(?:the\s+)?(?:quarter|semi|final)"
    r"|(?:tournament|draw|bracket)\s+status"
    r")",
    re.IGNORECASE,
)

# Schedule / next match: "who does X play next", "next match", "X next game",
# "X next fixture", "when does X play next", "X schedule".
_SCHEDULE_RE = re.compile(
    r"\b(?:"
    r"(?:who|when|where)\s+(?:does|do)\s+\S[^?]{0,40}?\s+play(?:\s+next)?"
    r"|play(?:s|ing)?\s+next"
    r"|next\s+(?:match|game|fixture|opponent|round)"
    r"|when\s+is\s+(?:the\s+)?(?:next\s+)?(?:match|game|fixture)"
    r"|(?:upcoming|schedule)\s+(?:match|game|fixture|games?|matches)"
    r"|(?:fixture|schedule)\s+for\s+"
    r")",
    re.IGNORECASE,
)

# Standings / league table.
_STANDINGS_RE = re.compile(
    r"\b(?:"
    r"standings?|league\s+table|league\s+position|league\s+standings?|table\s+position"
    r"|where\s+(?:does|do)\s+\S[^?]{0,40}?\s+stand"
    r"|how\s+(?:are|is)\s+\S[^?]{0,40}?\s+doing\s+in\s+the\s+(?:standings?|league|table)"
    r")",
    re.IGNORECASE,
)

# News / updates about a sports entity.
_NEWS_RE = re.compile(
    r"\b(?:"
    r"(?:any\s+)?news\s+(?:on|about)\s+\S"
    r"|update[s]?\s+(?:on|about)\s+\S"
    r"|what(?:'?s|s|\s+is)\s+(?:the\s+)?(?:latest|news)\s+(?:on|about)\s+\S"
    r")",
    re.IGNORECASE,
)

# Player status (broad): "what is X status", "is X playing", "is X injured",
# "X injury status", "is X back from injury".
_PLAYER_STATUS_RE = re.compile(
    r"\b(?:"
    r"(?:is|are)\s+\S[^?]{0,40}?\s+(?:playing|injured|fit|back|out|active|starting|benched)"
    r"|injury\s+status"
    r"|injury\s+update"
    r"|status\s+of\s+\S"
    r"|out\s+for\s+(?:the\s+)?season"
    r")",
    re.IGNORECASE,
)

# Pronoun lead — used for follow-up detection.
_PRONOUN_RE = re.compile(
    r"^\s*(?:and\s+|but\s+|so\s+|what\s+about\s+|how\s+about\s+)?"
    r"(?:he|she|they|them|him|her|his|hers|their|that|this|those|these|it)\b",
    re.IGNORECASE,
)

# "How about X?" / "What about X?" follow-up — extracts the entity slot.
_HOW_ABOUT_RE = re.compile(
    r"^\s*(?:and|but|so)?\s*(?:how|what)\s+about\s+(?P<rest>[^?.,;:!]+)\??\s*$",
    re.IGNORECASE,
)

# Bare-pronoun follow-up: "did they win?", "who did they play?", "who did he play?".
_BARE_PRONOUN_FOLLOWUP_RE = re.compile(
    r"\b(?:did|does|do|is|was|were|has|have)\s+(?:they|he|she|it|them|him|her)\b",
    re.IGNORECASE,
)

# 2026-05-30 SPORTS QUERY NORMALIZER — phrasing primitives -----------------
#
# Opponent claim regex. Captures the verb plus the opponent name for
# match-result-verification turns like:
#   * "I thought he lost to Joao Fonseca"
#   * "im pretty sure he lost to joao fonseca?"
#   * "did Sinner beat Alcaraz?"
#   * "Djokovic vs Alcaraz final"
#   * "Real Madrid against Barcelona last weekend"
# The opponent group accepts up to 4 capitalized tokens so two-part names
# like "Joao Fonseca" / "De Bruyne" survive. The match is intentionally
# case-insensitive because voice transcripts come back in lower-case.
_OPPONENT_CLAIM_RE = re.compile(
    r"\b(?P<verb>"
    r"lost\s+to|lose\s+to|losing\s+to|"
    r"beaten\s+by|defeated\s+by|"
    r"beats?|beating|defeats?|defeating|"
    r"against|vs\.?|versus|"
    r"played\s+against|playing\s+against|"
    r"played|playing|plays"
    r")\s+"
    r"(?P<opp>[A-Za-z][A-Za-z'\-]+(?:\s+[A-Za-z][A-Za-z'\-]+){0,3})",
    re.IGNORECASE,
)

# Pronoun anywhere (not just at the start) — required so "im pretty sure he
# lost to X" inherits prior ctx even though `he` isn't the first token.
_PRONOUN_ANYWHERE_RE = re.compile(
    r"\b(?:he|she|they|them|him|her|his|hers|their)\b",
    re.IGNORECASE,
)

# Year handling. Voice transcripts may carry an explicit "2026" or a relative
# token like "this year" / "current season" / "this season" / "currently".
_EXPLICIT_YEAR_RE = re.compile(r"\b(20\d{2})\b")
_YEAR_TOKENS_CURRENT_RE = re.compile(
    r"\b(?:this\s+year|current\s+year|this\s+season|current\s+season|"
    r"current\s+tournament|currently|right\s+now|at\s+the\s+moment)\b",
    re.IGNORECASE,
)
_YEAR_TOKENS_LAST_RE = re.compile(
    r"\b(?:last\s+year|previous\s+year|last\s+season|previous\s+season)\b",
    re.IGNORECASE,
)

# Stopwords that should never be treated as the trailing token of a captured
# opponent name. Voice transcripts often append a sentence-final adverb after
# the opponent ("did he lose to fonseca yesterday?").
_OPPONENT_TRAILING_STOPWORDS: frozenset[str] = frozenset(
    {
        "the", "a", "an", "today", "tonight", "yesterday", "tomorrow",
        "again", "already", "really", "honestly", "actually", "still",
        "now", "then", "before", "after", "earlier", "later", "soon",
        "again", "though", "right", "ok", "okay",
    }
)


def _current_year() -> int:
    """Return the calendar year used as the default 'this year' tag."""
    from datetime import datetime
    return datetime.now().year


def _extract_explicit_year(text: str) -> str:
    m = _EXPLICIT_YEAR_RE.search(text or "")
    return m.group(1) if m else ""


def _normalize_year(text: str, *, default_to_current: bool) -> str:
    """Resolve the season/year tag for a sports query.

    Precedence:
        1. Explicit four-digit year in ``text`` (e.g. "2025").
        2. Relative tokens — "this year"/"current season" -> current year,
           "last year"/"last season" -> current_year-1.
        3. If ``default_to_current`` is True and the question is a
           current-event-style turn (tournament_status / schedule / etc.),
           use the current year as a *soft* term.
        4. Otherwise return "" (no year forced into the query).
    """
    if not text:
        text = ""
    explicit = _extract_explicit_year(text)
    if explicit:
        return explicit
    if _YEAR_TOKENS_CURRENT_RE.search(text):
        return str(_current_year())
    if _YEAR_TOKENS_LAST_RE.search(text):
        return str(_current_year() - 1)
    if default_to_current:
        return str(_current_year())
    return ""


# Sport-tag -> canonical league label. Used when ``tournament_or_league``
# isn't populated (e.g. NBA team turn without an explicit "NBA" mention)
# so we can still tag the query with the competition context.
_SPORT_TO_LEAGUE_NAME = {
    "nba": "NBA",
    "nfl": "NFL",
    "mlb": "MLB",
    "nhl": "NHL",
    "soccer_epl": "Premier League",
    "soccer_laliga": "La Liga",
    "soccer_seriea": "Serie A",
    "soccer_bundesliga": "Bundesliga",
    "soccer_ligue1": "Ligue 1",
    "soccer_mls": "MLS",
    "tennis_atp": "ATP",
    "tennis_wta": "WTA",
    "f1": "Formula 1",
    "golf": "PGA Tour",
    "soccer": "",  # generic soccer; rely on tournament slot instead.
}


def _league_label_for_intent(intent: dict) -> str:
    """Return the best competition-context label for ``intent``.

    Tournament wins over sport-derived league name because the user is
    usually asking about the specific tournament when one is detected.
    """
    tournament = (intent.get("tournament_or_league") or "").strip()
    if tournament:
        return tournament
    sport = (intent.get("sport") or "").strip().lower()
    return _SPORT_TO_LEAGUE_NAME.get(sport, "")


def _extract_opponent_claim(
    text: str, *, current_entity: str = ""
) -> tuple[str, str, str]:
    """Return ``(opponent_raw, verb_norm, full_match)`` or ``("", "", "")``.

    ``verb_norm`` is one of:
        * ``"lost_to"`` -- "X lost to Y", "X lose to Y", "X losing to Y"
        * ``"beaten_by"`` -- "X beaten by Y", "X defeated by Y"
        * ``"beat"`` -- "X beat Y", "X defeated Y"
        * ``"vs"`` -- "X vs Y", "X versus Y"
        * ``"against"`` -- "X against Y", "X played against Y"
        * ``"played"`` -- "X played Y", "X plays Y"
    """
    if not text:
        return ("", "", "")
    m = _OPPONENT_CLAIM_RE.search(text)
    if not m:
        return ("", "", "")
    verb_raw = (m.group("verb") or "").strip().lower()
    opp = (m.group("opp") or "").strip(" ?.,!;:")
    if not opp:
        return ("", "", "")
    # Trim trailing stopwords (e.g. "joao fonseca yesterday" -> "joao fonseca").
    opp_tokens = [t for t in re.split(r"\s+", opp) if t]
    while opp_tokens and opp_tokens[-1].strip(",.;:?!'\"").lower() in _OPPONENT_TRAILING_STOPWORDS:
        opp_tokens.pop()
    if not opp_tokens:
        return ("", "", "")
    raw_opp = " ".join(opp_tokens)
    if current_entity and raw_opp.lower() == current_entity.lower():
        return ("", "", "")
    # Verb normalization.
    if "lost to" in verb_raw or "lose to" in verb_raw or "losing to" in verb_raw:
        verb_norm = "lost_to"
    elif "beaten by" in verb_raw or "defeated by" in verb_raw:
        verb_norm = "beaten_by"
    elif verb_raw.startswith("beat") or verb_raw.startswith("defeat"):
        verb_norm = "beat"
    elif verb_raw in ("vs", "vs.", "versus"):
        verb_norm = "vs"
    elif "against" in verb_raw:
        verb_norm = "against"
    elif verb_raw.startswith("play"):
        verb_norm = "played"
    else:
        verb_norm = "against"
    return (raw_opp, verb_norm, m.group(0))


def _resolve_opponent_canonical(raw_opp: str) -> str:
    """Map a free-text opponent name to its canonical form via the catalog
    when possible, falling back to a title-cased free-text version.
    """
    if not raw_opp:
        return ""
    hit = _resolve_entity_in_text(raw_opp, allow_unsafe_short_aliases=True)
    if hit and hit.get("entity_type") in ("player", "team"):
        return hit.get("canonical") or raw_opp.title()
    return " ".join(w.capitalize() for w in raw_opp.split() if w)


def _has_pronoun_anywhere(text: str) -> bool:
    return bool(_PRONOUN_ANYWHERE_RE.search(text or ""))


def _is_generic_draw_pages_only(items: list[dict]) -> bool:
    """Return True when the result list looks like generic Roland-Garros /
    ATP / ESPN draw pages with no match-specific outcome terms.

    We treat the snippet bundle as "draw-only" when at least 2 of the top-8
    items mention draw/bracket/seed terms but none mention concrete result
    terms (score/won/lost/defeated/beat/knocked out/eliminated/advanced).
    """
    if not items:
        return False
    draw_terms = re.compile(
        r"\b(?:draw|bracket|seedings?|seeds?|fixture\s+list)\b", re.IGNORECASE,
    )
    result_terms = re.compile(
        r"\b(?:score|won|lost|defeated|beat|beaten|knocked\s+out|eliminated|"
        r"advanced|reach(?:ed)?|semifinal|quarterfinal|final(?:ist)?)\b",
        re.IGNORECASE,
    )
    draw_hits = 0
    result_hits = 0
    for it in items[:8]:
        blob = (str(it.get("title") or "") + " " + str(it.get("summary") or ""))
        if draw_terms.search(blob):
            draw_hits += 1
        if result_terms.search(blob):
            result_hits += 1
    return draw_hits >= 2 and result_hits == 0


# --------------------------------------------------------------------------
# Entity resolution
# --------------------------------------------------------------------------

_COMMON_WORD_SAFETY_REQUIRED = {"sinner", "kane", "saka", "haaland"}


def _alias_passes_safety_check(alias: str, low_text: str) -> bool:
    """Return True when a short, common-word surname alias is allowed to
    resolve to its sports canonical given the surrounding text.

    Lifts the safety requirement when the text shows clear sports context
    (sports verb, tournament alias, or schedule/standings phrasing). Used
    by the direct resolver below and by the follow-up resolver so that
    "how about Sinner?" after a Roland Garros turn produces the right
    canonical even though the candidate alone is "sinner".
    """
    if alias not in _COMMON_WORD_SAFETY_REQUIRED:
        return True
    return bool(
        _LATEST_RESULT_RE.search(low_text)
        or _TOURNAMENT_STATUS_RE.search(low_text)
        or _SCHEDULE_RE.search(low_text)
        or _STANDINGS_RE.search(low_text)
        or _PLAYER_STATUS_RE.search(low_text)
        or any(
            a in low_text
            for a, _c, et, _s, _t in _ALIAS_INDEX
            if et == "tournament" and a != alias
        )
    )


def _resolve_entity_in_text(
    text: str, *, allow_unsafe_short_aliases: bool = False
) -> dict | None:
    """Find the highest-priority sports entity present in ``text``.

    Priority order, looked up in two passes:
      1. **Player/team** aliases (longest-first within this group).
      2. **Tournament** aliases (longest-first within this group).

    This is what makes "Is Djokovic still in Roland Garros?" resolve to
    *Djokovic* (player) rather than *Roland Garros* (tournament). The
    tournament is still surfaced separately by ``tournament_in_text``
    detection in the public classifier so the tournament_or_league slot
    populates correctly.

    A bare surname like ``"sinner"`` only resolves to the tennis player when:
      * the text has sports phrasing (win/lose/round/draw/play next/...) OR
      * the text mentions a tournament alias OR
      * ``allow_unsafe_short_aliases`` is True (set by the "how about X"
        follow-up resolver when ctx already establishes a sports topic).
    """
    if not text:
        return None
    low = text.lower()

    player_team_rows = [
        row for row in _ALIAS_INDEX if row[2] in ("team", "player")
    ]
    tournament_rows = [row for row in _ALIAS_INDEX if row[2] == "tournament"]

    # 2026-05-30: position-aware player/team resolution.
    #   * For sentences like "did Sinner beat Alcaraz?" the earlier-mentioned
    #     player is almost always the subject (entity), the later one is the
    #     opponent. The pre-normalizer fix iterated the catalog in source
    #     order, which made Alcaraz win because his alias appeared first in
    #     `_ALIAS_INDEX`. Sorting matches by `start()` lets us inherit the
    #     subject correctly without breaking single-entity turns (only one
    #     candidate -> still wins).
    player_team_matches: list[tuple[int, int, tuple]] = []
    for row in player_team_rows:
        alias, canonical, entity_type, sport, tournament = row
        m = re.search(r"\b" + re.escape(alias) + r"\b", low)
        if not m:
            continue
        if not allow_unsafe_short_aliases and not _alias_passes_safety_check(alias, low):
            continue
        # Sort key: earlier-in-text wins, then longest alias as tiebreaker.
        player_team_matches.append((m.start(), -len(alias), row))
    if player_team_matches:
        player_team_matches.sort(key=lambda t: (t[0], t[1]))
        _, _, row = player_team_matches[0]
        alias, canonical, entity_type, sport, tournament = row
        return {
            "canonical": canonical,
            "entity_type": entity_type,
            "sport": sport,
            "tournament_or_league": tournament or "",
            "matched_alias": alias,
        }

    for alias, canonical, entity_type, sport, tournament in tournament_rows:
        if not re.search(r"\b" + re.escape(alias) + r"\b", low):
            continue
        return {
            "canonical": canonical,
            "entity_type": entity_type,
            "sport": sport,
            "tournament_or_league": tournament or "",
            "matched_alias": alias,
        }

    return None


def _detect_query_type(text: str, tournament_in_text: bool) -> str:
    """Classify the question type from phrasing.

    Returns one of: ``latest_result``, ``schedule``, ``standings``,
    ``tournament_status``, ``player_status``, ``news``, or ``""``.

    Note: tournament_status outranks latest_result when both shapes match
    AND the text references a tournament — "did X win Roland Garros" is a
    tournament_status / final-round question, not a single-game result.
    """
    if not text:
        return ""
    low = text.lower()
    if _NEWS_RE.search(low):
        return "news"
    if _TOURNAMENT_STATUS_RE.search(low):
        return "tournament_status"
    if _SCHEDULE_RE.search(low):
        return "schedule"
    if _STANDINGS_RE.search(low):
        return "standings"
    if _LATEST_RESULT_RE.search(low):
        if tournament_in_text and re.search(
            r"\bwon\s+(?:the\s+)?(?:title|trophy|championship|cup|final|finals)\b",
            low,
        ):
            return "tournament_status"
        return "latest_result"
    if _PLAYER_STATUS_RE.search(low):
        return "player_status"
    return ""


# --------------------------------------------------------------------------
# Public classifier
# --------------------------------------------------------------------------

def classify_sports_intent(
    text: str,
    *,
    recent_sports_context: dict | None = None,
) -> dict:
    """Return a structured sports intent for ``text``.

    Output schema:
        {
            "is_sports": bool,
            "sport": str,
            "entity": str,
            "entity_type": "team" | "player" | "tournament" | "league" | "",
            "tournament_or_league": str,
            "query_type": "latest_result" | "schedule" | "standings"
                          | "tournament_status" | "player_status" | "news" | "",
            "confidence": float,
            "reason": str,
            "followup_used": bool,
            "needs_clarification": bool,
            "clarification_reason": str,
            "context_before": dict | None,
        }

    Side-effect free. Determinism makes this safe to call from any router
    path / smoke test.
    """
    ctx = recent_sports_context if isinstance(recent_sports_context, dict) else None
    out = {
        "is_sports": False,
        "sport": "",
        "entity": "",
        "entity_type": "",
        "tournament_or_league": "",
        "query_type": "",
        "confidence": 0.0,
        "reason": "no_signal",
        "followup_used": False,
        "needs_clarification": False,
        "clarification_reason": "",
        "context_before": dict(ctx) if ctx else None,
        # 2026-05-30 SPORTS QUERY NORMALIZER fields. Always present so
        # downstream consumers can read them unconditionally.
        "opponent": "",
        "opponent_verb": "",
        "season_or_year": "",
        "normalized_entity": "",
    }
    raw = (text or "").strip()
    if not raw:
        out["reason"] = "empty_text"
        return out
    low = raw.lower()

    # 1) Try direct entity resolution.
    entity_hit = _resolve_entity_in_text(raw)

    # 2) Detect follow-up shape FIRST so the flag fires even when the entity
    #    also resolves directly. "how about the Warriors?" is still a
    #    follow-up turn even though "Warriors" resolves on its own.
    how_about = _HOW_ABOUT_RE.match(raw)
    bare_pronoun_followup = bool(_BARE_PRONOUN_FOLLOWUP_RE.search(low))
    pronoun_lead = bool(_PRONOUN_RE.match(raw))
    is_followup_shape = bool(how_about) or pronoun_lead or bare_pronoun_followup

    if how_about and not entity_hit:
        # "how about Sinner?" after a Roland Garros turn — the bare "sinner"
        # alias would normally fail the safety check, but we know ctx already
        # establishes a sports topic, so we allow short common-word aliases
        # to resolve. Without ctx the broader sports-shape check is what
        # determines whether we treat this as sports at all.
        candidate = (how_about.group("rest") or "").strip(" ?.,!")
        if candidate:
            allow_unsafe = bool(ctx) or _alias_passes_safety_check(
                "sinner", low  # cheapest sentinel; checks the surrounding text
            )
            entity_hit = _resolve_entity_in_text(
                candidate, allow_unsafe_short_aliases=allow_unsafe
            )
            if entity_hit:
                out["followup_used"] = True

    # If still no entity but we have prior sports context AND the turn is a
    # pronoun follow-up, inherit the entity from ctx.
    if not entity_hit and ctx and (pronoun_lead or bare_pronoun_followup):
        ctx_entity = (ctx.get("entity") or "").strip()
        if ctx_entity:
            entity_hit = {
                "canonical": ctx_entity,
                "entity_type": ctx.get("entity_type") or "team",
                "sport": ctx.get("sport") or "",
                "tournament_or_league": ctx.get("tournament_or_league") or "",
                "matched_alias": ctx_entity.lower(),
            }
            out["followup_used"] = True

    # 2026-05-30 SPORTS QUERY NORMALIZER: opponent-claim follow-up.
    # "im pretty sure he lost to joao fonseca?" / "I thought he lost to X"
    # — the pronoun lives mid-sentence so `pronoun_lead` and
    # `bare_pronoun_followup` both miss. We catch the shape with a pair of
    # softer signals (any pronoun anywhere + an opponent-claim verb) and,
    # when prior sports ctx exists, inherit the ctx entity. Without this
    # branch the turn returned `is_sports=False` even though there was a
    # clear sports topic in flight.
    if not entity_hit and ctx and _OPPONENT_CLAIM_RE.search(raw) and _has_pronoun_anywhere(low):
        ctx_entity = (ctx.get("entity") or "").strip()
        if ctx_entity:
            entity_hit = {
                "canonical": ctx_entity,
                "entity_type": ctx.get("entity_type") or "player",
                "sport": ctx.get("sport") or "",
                "tournament_or_league": ctx.get("tournament_or_league") or "",
                "matched_alias": ctx_entity.lower(),
            }
            out["followup_used"] = True
            out["reason"] = "opponent_claim_followup_inherited_ctx"

    # If "how about X" without a sports-known entity but we DO have ctx,
    # treat the candidate as a generic player/team string + inherit ctx's
    # sport + tournament. This lets the same router handle uncommon
    # players/teams not in the catalog without giving up the topic.
    if not entity_hit and ctx and how_about:
        candidate = (how_about.group("rest") or "").strip(" ?.,!")
        if candidate:
            entity_hit = {
                "canonical": candidate.title(),
                "entity_type": "player",  # default heuristic when ctx is tennis
                "sport": ctx.get("sport") or "",
                "tournament_or_league": ctx.get("tournament_or_league") or "",
                "matched_alias": candidate.lower(),
            }
            out["followup_used"] = True
            out["reason"] = "how_about_followup_inherited_ctx"

    # 3) Special-case "how about <pronoun>" / pure pronoun follow-ups WITH
    #    no resolvable entity AND no ctx — we still want clarification, even
    #    though there's no sports verb. The "how about <pronoun>" shape is
    #    near-exclusively a follow-up pattern, so flag it as such. This runs
    #    BEFORE the broader looks_sports_shaped guard below so we don't
    #    short-circuit on "no sports verb here".
    if not entity_hit and how_about:
        candidate = (how_about.group("rest") or "").strip(" ?.,!").lower()
        if candidate in {"him", "her", "them", "they", "it"} and not ctx:
            out.update(
                is_sports=True,
                needs_clarification=True,
                clarification_reason="pronoun_followup_without_context",
                confidence=0.6,
                reason="how_about_pronoun_no_context",
            )
            return out

    # 3b) If still no entity AND it's clearly a pronoun-only turn with no ctx,
    #     ask for clarification — but ONLY when the message looks sports-shaped.
    #     Bare auxiliary+pronoun ("is it") also matches things like "what time
    #     is it" / "is it raining", which we must not flag as sports.
    if not entity_hit and (pronoun_lead or bare_pronoun_followup) and not ctx:
        looks_sports_shaped = bool(
            _LATEST_RESULT_RE.search(low)
            or _TOURNAMENT_STATUS_RE.search(low)
            or _SCHEDULE_RE.search(low)
            or _STANDINGS_RE.search(low)
            or _PLAYER_STATUS_RE.search(low)
            or re.search(
                r"\b(?:win|won|lose|lost|beat|beating|score|scored|game|games|"
                r"match|matches|play(?:ing|ed)?|tournament|draw|round|fixture|"
                r"playoff|playoffs|final|finals|semifinal|quarterfinal)\b",
                low,
            )
        )
        if looks_sports_shaped:
            out.update(
                is_sports=True,
                needs_clarification=True,
                clarification_reason="pronoun_followup_without_context",
                confidence=0.6,
                reason="ambiguous_pronoun_followup_no_context",
            )
            return out
        return out  # not a sports turn

    # 2026-05-30: `[sports_followup_context_missed]` regression alarm.
    # If we got here with NO entity_hit but the turn carries follow-up shape
    # (pronoun_lead / bare_pronoun_followup / how_about / pronoun_anywhere
    # paired with an opponent claim) AND we have prior sports ctx, then we
    # SHOULD have inherited the entity above. Reaching this branch means a
    # detection rule regressed.
    if not entity_hit and ctx:
        followup_shape_seen = bool(
            pronoun_lead or bare_pronoun_followup or how_about or (
                _OPPONENT_CLAIM_RE.search(raw) and _has_pronoun_anywhere(low)
            )
        )
        if followup_shape_seen:
            try:
                _log_sports_followup_context_missed(
                    session_id="",
                    text=raw,
                    has_pronoun=bool(pronoun_lead or bare_pronoun_followup
                                     or _has_pronoun_anywhere(low)),
                    has_how_about=bool(how_about),
                    ctx_view=_ctx_log_view(ctx),
                )
            except Exception:
                pass

    if not entity_hit:
        return out  # not a sports turn

    if is_followup_shape and not out["followup_used"]:
        # We resolved the entity directly but the surface form is still a
        # follow-up shape ("how about the Warriors?"). Mark it so downstream
        # diagnostics can tell direct-entity-hits in follow-up phrasing apart
        # from cold-start direct hits.
        out["followup_used"] = True

    # 4a) Populate tournament_or_league for player/team hits when the text
    #     ALSO mentions a tournament alias. "Is Djokovic still in Roland
    #     Garros?" should produce (entity=Djokovic, tournament=Roland Garros)
    #     — the resolver above intentionally prefers the player as the
    #     primary entity, but the tournament slot still has to populate.
    if entity_hit.get("entity_type") in ("player", "team") and not entity_hit.get("tournament_or_league"):
        for alias, _c, et, _s, tournament_canonical in _ALIAS_INDEX:
            if et != "tournament":
                continue
            if re.search(r"\b" + re.escape(alias) + r"\b", low):
                entity_hit["tournament_or_league"] = tournament_canonical or ""
                # Also adopt the tournament's sport when the player's tag is
                # already aligned (e.g. tennis_atp + tennis Roland Garros);
                # we keep the more specific player sport tag.
                break

    # 4b) 2026-05-30 SPORTS QUERY NORMALIZER: ctx-tournament inheritance.
    #     "who does alcaraz play next?" after a Roland Garros turn should
    #     keep the tournament context. The entity resolves directly from
    #     the text, but the tournament doesn't, so the legacy 4a branch
    #     leaves the slot empty. We now inherit the tournament from ctx
    #     when:
    #       * we have a player/team entity with no tournament populated,
    #       * ctx carries a tournament_or_league, and
    #       * the sport tags overlap at the family level (tennis_atp /
    #         tennis_wta both map to "tennis"; soccer_epl / soccer_laliga
    #         both map to "soccer"; NBA stays NBA, etc.).
    if (
        entity_hit.get("entity_type") in ("player", "team")
        and not entity_hit.get("tournament_or_league")
        and ctx
        and (ctx.get("tournament_or_league") or "").strip()
    ):
        ctx_sport = (ctx.get("sport") or "").strip().lower()
        entity_sport = (entity_hit.get("sport") or "").strip().lower()
        ctx_family = ctx_sport.split("_", 1)[0] if ctx_sport else ""
        entity_family = entity_sport.split("_", 1)[0] if entity_sport else ""
        if (
            entity_sport
            and ctx_sport
            and (entity_sport == ctx_sport or (ctx_family and ctx_family == entity_family))
        ):
            entity_hit["tournament_or_league"] = (
                ctx.get("tournament_or_league") or ""
            )
            # This is a soft follow-up — mark the flag so confidence logic
            # and diagnostics know ctx influenced the slot.
            out["followup_used"] = True
            out["reason"] = out.get("reason") or "ctx_tournament_inherited"

    # 4) Determine query type. tournament_in_text is true when any
    #    tournament alias appears OR when ctx carried a tournament.
    tournament_in_text = bool(entity_hit.get("tournament_or_league"))
    if not tournament_in_text:
        for alias, _c, et, _s, _t in _ALIAS_INDEX:
            if et == "tournament" and re.search(r"\b" + re.escape(alias) + r"\b", low):
                tournament_in_text = True
                break

    query_type = _detect_query_type(raw, tournament_in_text)

    # Follow-up entity inherited from ctx but no explicit query phrasing →
    # inherit query_type too. This is what makes "how about Sinner?" mean
    # "what's Sinner's tournament_status?" after a Djokovic/Roland Garros turn.
    if not query_type and out["followup_used"] and ctx:
        query_type = (ctx.get("query_type") or "").strip()

    # If still no query_type and we have a tournament context, default to
    # tournament_status (the user typically wants draw/round info).
    if not query_type:
        if tournament_in_text or (
            entity_hit.get("entity_type") == "player" and ctx
            and (ctx.get("tournament_or_league") or "")
        ):
            query_type = "tournament_status"
        else:
            query_type = "latest_result"

    # If the matching alias was a tournament itself (no team/player), bump
    # entity_type to "tournament" and route as tournament_status by default.
    if entity_hit["entity_type"] == "tournament" and query_type in ("", "latest_result"):
        query_type = "tournament_status"

    # 6) Opponent extraction (sports query normalizer).
    #    Pulls the opponent name from "lost to X" / "beat X" / "vs X" /
    #    "against X" phrasings. We do NOT extract the same name as the
    #    primary entity (avoids "Sinner beat Sinner" self-matches).
    primary_entity_canonical = entity_hit.get("canonical") or ""
    opponent_raw, opponent_verb, _opp_match = _extract_opponent_claim(
        raw, current_entity=primary_entity_canonical
    )
    opponent_canonical = (
        _resolve_opponent_canonical(opponent_raw) if opponent_raw else ""
    )

    # 7) Match-result-verification override. A clear opponent claim is
    #    almost always a "did X beat / lose to Y" verification — that
    #    question wants both names in the search, not generic draw pages.
    if opponent_canonical:
        query_type = "match_result_verification"

    # 8) Year / season tag. tournament_status / schedule / match-result-
    #    verification / standings / latest_result are current-event style,
    #    so default to the current year when no explicit year is present.
    default_year_query_types = {
        "tournament_status", "schedule", "next_match",
        "match_result_verification", "standings", "latest_result",
        "player_status",
    }
    season_or_year = _normalize_year(
        raw, default_to_current=(query_type in default_year_query_types)
    )
    # Inherit ctx year when this turn didn't carry one and ctx has one.
    if not season_or_year and ctx and (ctx.get("season_or_year") or "").strip():
        season_or_year = str(ctx.get("season_or_year") or "").strip()

    # 9) Confidence (computed AFTER potential match-result-verification
    #    upgrade so verification turns get a stable confidence band).
    if query_type == "match_result_verification":
        # Verification needs both names; we don't know if they're in
        # snippets yet, but the structural signal is strong.
        confidence = 0.86 if opponent_canonical else 0.7
        reason = "match_result_verification_claim"
    elif out["followup_used"]:
        confidence = 0.75
        reason = out.get("reason") or "followup_with_ctx"
    elif tournament_in_text and entity_hit["entity_type"] in ("player", "team"):
        confidence = 0.92
        reason = "entity_plus_tournament"
    elif query_type in ("tournament_status", "schedule", "standings"):
        confidence = 0.88
        reason = "entity_plus_query_phrasing"
    elif query_type == "latest_result":
        confidence = 0.86
        reason = "entity_plus_result_shape"
    else:
        confidence = 0.7
        reason = "entity_only"

    out.update(
        is_sports=True,
        sport=entity_hit.get("sport") or "",
        entity=primary_entity_canonical,
        entity_type=entity_hit.get("entity_type") or "",
        tournament_or_league=entity_hit.get("tournament_or_league")
            or (ctx.get("tournament_or_league") if (ctx and out["followup_used"]) else "")
            or "",
        query_type=query_type,
        confidence=confidence,
        reason=reason,
    )
    out["opponent"] = opponent_canonical
    out["opponent_verb"] = opponent_verb
    out["season_or_year"] = season_or_year
    out["normalized_entity"] = primary_entity_canonical
    return out


# --------------------------------------------------------------------------
# Query construction
# --------------------------------------------------------------------------

# Common round terms — included for tournament_status queries so Serper
# returns round-by-round draw pages.
_ROUND_TERMS = (
    "first round", "second round", "third round", "fourth round",
    "round of 16", "round of 32", "quarterfinal", "semifinal", "final",
    "draw", "bracket",
)


def build_sports_search_queries(intent: dict, original_text: str) -> list[str]:
    """Return up to 3 Serper queries tailored to ``intent.query_type``.

    2026-05-30 normalization update:
        * Queries now include the season/year tag when present (defaults to
          the current year for current-event-style turns).
        * ``match_result_verification`` is a new branch that always puts the
          opponent name in the query so generic draw pages can't dominate
          the result list.
        * When no tournament is in the intent, we fall back to a sport-
          derived league label so "Lakers" -> "Lakers NBA 2026 latest
          result" instead of "Lakers latest tournament result".
        * Generic "{entity} latest tournament result" is no longer emitted
          when a tournament is known. The hard warning
          ``[sports_query_too_generic]`` fires if a tournament_status /
          match_result_verification query ends up without the player or
          tournament. ``[sports_claim_not_verified]`` fires when both
          names should be present but aren't.
    """
    entity = (intent.get("entity") or "").strip()
    tournament = (intent.get("tournament_or_league") or "").strip()
    sport = (intent.get("sport") or "").strip()
    query_type = (intent.get("query_type") or "").strip()
    opponent = (intent.get("opponent") or "").strip()
    year = (intent.get("season_or_year") or "").strip()
    raw = (original_text or "").strip()
    if not entity:
        return [raw] if raw else []

    league_label = tournament or _SPORT_TO_LEAGUE_NAME.get(sport.lower(), "")
    # Helper: compose a clean space-separated query, dropping empty parts.
    def _q(*parts: str) -> str:
        return " ".join(p.strip() for p in parts if p and p.strip()).strip()

    queries: list[str] = []

    if query_type == "match_result_verification" and opponent:
        queries.append(_q(entity, opponent, league_label, year, "result"))
        queries.append(_q(entity, "lost to", opponent, league_label, year))
        queries.append(_q(opponent, "beat", entity, league_label, year))
    elif query_type == "tournament_status":
        queries.append(_q(entity, league_label, year, "latest result draw status"))
        queries.append(_q(entity, league_label, year, "latest match result"))
        queries.append(_q(entity, league_label, year, "eliminated advanced knocked out"))
    elif query_type in ("schedule", "next_match"):
        queries.append(_q(entity, league_label, year, "next match"))
        queries.append(_q(entity, "upcoming match", league_label, year))
        if league_label:
            queries.append(_q(entity, league_label, year, "draw next round"))
    elif query_type == "standings":
        league = league_label or sport
        queries.append(_q(entity, league, year, "standings table position"))
        queries.append(_q(league, year, "standings"))
    elif query_type == "latest_result":
        if league_label:
            queries.append(_q(entity, league_label, year, "latest result"))
            queries.append(_q(entity, "final score recent match", league_label, year))
            queries.append(_q(entity, league_label, year, "result"))
        else:
            queries.append(_q(entity, year, "latest result"))
            queries.append(_q(entity, "final score recent game", year))
    elif query_type == "player_status":
        queries.append(_q(entity, "status injury playing", year))
        queries.append(_q(entity, "latest update", year))
        if league_label:
            queries.append(_q(entity, league_label, year, "status"))
    elif query_type == "news":
        queries.append(_q(entity, league_label, year, "latest news update"))
        if league_label:
            queries.append(_q(entity, league_label, year, "news"))
    else:
        queries.append(_q(entity, league_label, year, "latest"))

    # Always include the raw user text as a final-tiebreaker query —
    # Serper's answer-box logic sometimes gives a clean direct answer for
    # the exact phrasing even when our keyword-engineered queries don't.
    if raw and raw.lower() not in {q.lower() for q in queries}:
        queries.append(raw)

    # Dedupe (case-insensitive, preserve order).
    seen: set[str] = set()
    dedup: list[str] = []
    for q in queries:
        k = q.lower().strip()
        if not k or k in seen:
            continue
        seen.add(k)
        dedup.append(q)
    dedup = dedup[:3]

    # ---- Hard warnings ------------------------------------------------
    # `[sports_query_too_generic]` fires when a status/result/verification
    # query doesn't carry the player name OR (for tournament-bound turns)
    # the tournament name. This is a regression alarm; we should never ship
    # those without both.
    try:
        if query_type in ("tournament_status", "match_result_verification"):
            joined = " | ".join(dedup).lower()
            entity_missing = entity and entity.lower() not in joined
            tournament_missing = bool(league_label) and league_label.lower() not in joined
            if entity_missing or tournament_missing:
                _log_sports_query_too_generic(
                    query_type=query_type,
                    queries=dedup,
                    entity=entity,
                    tournament=league_label,
                    entity_missing=bool(entity_missing),
                    tournament_missing=bool(tournament_missing),
                )
        if query_type == "match_result_verification" and opponent:
            joined = " | ".join(dedup).lower()
            entity_missing = entity and entity.lower() not in joined
            opponent_missing = opponent.lower() not in joined
            if entity_missing or opponent_missing:
                _log_sports_claim_not_verified(
                    queries=dedup,
                    entity=entity,
                    opponent=opponent,
                    entity_missing=bool(entity_missing),
                    opponent_missing=bool(opponent_missing),
                )
    except Exception:
        pass
    return dedup


# --------------------------------------------------------------------------
# Prompt construction
# --------------------------------------------------------------------------

_SPORTS_PROMPT_PREAMBLE = (
    "You are answering a SPORTS question for a voice assistant using web-search snippets.\n"
    "\n"
    "Honesty rules — non-negotiable:\n"
    "  * If the snippets clearly state a result/status, answer directly with one\n"
    "    short sentence (e.g. 'Yes, the Lakers won 118-110 against the Warriors').\n"
    "  * If the snippets are vague, contradictory, or out of date, say so plainly:\n"
    "    'The snippets don't show a clear result; the most recent reliable mention\n"
    "     is …'. Do NOT invent scores, rounds, or opponents.\n"
    "  * Never fabricate scores, opponents, dates, or rounds that are not in the\n"
    "    snippets.\n"
    "  * If the user asked a yes/no question (won, lost, still in, eliminated),\n"
    "    answer yes or no FIRST, then the qualifier. If you cannot determine yes\n"
    "    or no, say 'I can't tell from the snippets' first.\n"
    "  * Voice-friendly tone. 2-4 short sentences. No markdown, no bullets.\n"
    "\n"
)


def _build_sports_prompt(
    intent: dict,
    original_text: str,
    items: list[dict],
    confidence_hint: str,
    *,
    generic_draw_pages_only: bool = False,
    match_verification_in_snippets: bool | None = None,
) -> str:
    """Build the prompt body that follows ``_SPORTS_PROMPT_PREAMBLE``.

    2026-05-30 normalization upgrades:
        * ``generic_draw_pages_only`` — surfaced from
          :func:`_is_generic_draw_pages_only`. The LLM is told explicitly
          not to assert "still in" from draw landing pages alone.
        * ``match_verification_in_snippets`` — for match-result-verification
          turns. False means we have no snippet that mentions both names
          together, so the LLM must say "I can't verify that from the
          snippets" instead of fabricating a result.
    """
    entity = (intent.get("entity") or "").strip()
    tournament = (intent.get("tournament_or_league") or "").strip()
    query_type = (intent.get("query_type") or "").strip()
    sport = (intent.get("sport") or "").strip()
    opponent = (intent.get("opponent") or "").strip()
    season = (intent.get("season_or_year") or "").strip()
    lines: list[str] = [
        f"User question (verbatim): {original_text}",
        f"Detected sport: {sport or 'unspecified'}",
        f"Detected entity: {entity} ({intent.get('entity_type') or 'unknown'})",
        f"Tournament / league: {tournament or 'unspecified'}",
        f"Season / year: {season or 'unspecified'}",
        f"Question type: {query_type or 'unspecified'}",
        f"Opponent (if any): {opponent or 'unspecified'}",
        f"Snippet confidence hint: {confidence_hint}",
    ]
    if items:
        lines.append("")
        lines.append("Web-search snippets (use only what is actually relevant):")
        for i, item in enumerate(items[:8], 1):
            tag = "[answer box] " if item.get("is_answer_box") else ""
            published = (item.get("published_display") or "").strip()
            ptag = f" (published {published})" if published else ""
            lines.append(
                f"{i}. {tag}{item.get('title', '')}{ptag}\n"
                f"Source: {item.get('source', '')}\n"
                f"Snippet: {item.get('summary', '')}"
            )
    else:
        lines.append("")
        lines.append(
            "No snippets came back from the sports search. Tell the user the "
            "search did not return useful results, suggest a more specific "
            "phrasing (e.g. include the tournament or date), and do NOT invent "
            "an answer."
        )
    if confidence_hint == "low":
        lines.append("")
        lines.append(
            "IMPORTANT: snippet confidence is LOW. Start the spoken answer with: "
            "\"I'm answering from web snippets, so treat this as a snippet-based "
            "read:\" and then state what you can / cannot determine."
        )
    if generic_draw_pages_only:
        lines.append("")
        lines.append(
            "GENERIC DRAW PAGES ONLY: the snippets look like generic "
            "tournament draw / bracket landing pages and do NOT show a "
            "specific match result. Do NOT confidently say the player is "
            "'still in' the tournament from these snippets alone. Say "
            "something like 'I'm seeing generic draw pages rather than a "
            "direct match result, so I wouldn't treat this as confirmed.'"
        )
    if (
        query_type == "match_result_verification"
        and match_verification_in_snippets is False
        and opponent
    ):
        lines.append("")
        lines.append(
            "CLAIM NOT VERIFIED IN SNIPPETS: the user is asking whether "
            f"{entity} played / lost to / beat {opponent}, but no snippet "
            "mentions both names together. Do NOT fabricate a result. Say "
            "you can't verify the claim from the search snippets and offer "
            "to look again with a more specific phrasing."
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------
# Execution
# --------------------------------------------------------------------------

def _score_snippet_confidence(intent: dict, items: list[dict]) -> str:
    """Return ``"high"`` / ``"medium"`` / ``"low"`` based on snippet evidence.

    Heuristic, intentionally conservative:
      * ``"high"`` — at least 2 snippets contain the entity name AND a
        query-type-specific keyword (score, round, draw, etc.).
      * ``"medium"`` — at least 1 snippet contains the entity AND a
        query-type-specific keyword.
      * ``"low"`` — otherwise (or empty results).

    Two 2026-05-30 normalizer additions:
      * ``match_result_verification`` requires BOTH entity AND opponent in
        the snippet for a "strong hit". If only one side is present, the
        snippet does not actually verify the claim and we treat it as
        unverified evidence.
      * ``tournament_status`` is automatically downgraded one level when
        the snippet bundle looks like generic draw pages only (no
        match-outcome terms anywhere). That stops the prompt from happily
        asserting "yes, still in" from a Roland-Garros draw landing page.
    """
    if not items:
        return "low"
    entity = (intent.get("entity") or "").lower()
    if not entity:
        return "low"
    query_type = (intent.get("query_type") or "").strip()
    opponent = (intent.get("opponent") or "").lower()
    keyword_re_by_type = {
        "tournament_status": re.compile(
            r"\b(?:round|draw|advanced|eliminated|knocked\s+out|defeated|beat|"
            r"semifinal|quarterfinal|final|reached)\b",
            re.IGNORECASE,
        ),
        "match_result_verification": re.compile(
            r"\b(?:lost|defeated|beat|beaten|score|result|final\s+score|"
            r"upset|set\s+\d|knocked\s+out|advanced|eliminated)\b",
            re.IGNORECASE,
        ),
        "schedule": re.compile(
            r"\b(?:next|upcoming|schedule|fixture|opponent|play|plays)\b",
            re.IGNORECASE,
        ),
        "next_match": re.compile(
            r"\b(?:next|upcoming|schedule|fixture|opponent|play|plays)\b",
            re.IGNORECASE,
        ),
        "standings": re.compile(
            r"\b(?:standings?|table|position|rank|place)\b",
            re.IGNORECASE,
        ),
        "latest_result": re.compile(
            r"\b(?:final\s+score|score|won|lost|defeated|beat|recap|highlights)\b",
            re.IGNORECASE,
        ),
        "player_status": re.compile(
            r"\b(?:injury|injured|status|out|active|fit|playing|return)\b",
            re.IGNORECASE,
        ),
        "news": re.compile(
            r"\b(?:said|reports?|announced|told|named|signed|hired|fired|news)\b",
            re.IGNORECASE,
        ),
    }
    key_re = keyword_re_by_type.get(query_type)
    strong_hits = 0
    for item in items[:6]:
        blob = " ".join([
            str(item.get("title") or ""),
            str(item.get("summary") or ""),
        ])
        low_blob = blob.lower()
        has_entity = entity in low_blob or any(
            tok in low_blob for tok in entity.split() if len(tok) > 3
        )
        if not has_entity:
            continue
        # For match-result-verification we ALSO require the opponent in the
        # snippet — otherwise the snippet doesn't actually verify the claim.
        if query_type == "match_result_verification" and opponent:
            has_opp = opponent in low_blob or any(
                tok in low_blob for tok in opponent.split() if len(tok) > 3
            )
            if not has_opp:
                continue
        if key_re is None or key_re.search(blob):
            strong_hits += 1
    if strong_hits >= 2:
        base = "high"
    elif strong_hits == 1:
        base = "medium"
    else:
        base = "low"

    # Generic-draw-pages-only downgrade for tournament_status turns.
    if query_type == "tournament_status" and _is_generic_draw_pages_only(items):
        if base == "high":
            base = "medium"
        elif base == "medium":
            base = "low"
    return base


def _build_panel_payload(
    intent: dict,
    *,
    items: list[dict],
    request_id: str,
    query_label: str,
) -> dict:
    """Stamp a media_tabs-shaped payload with the sport-aware title and
    ``result_kind="sports"`` / ``"tournament"`` so the frontend renders it as
    a Sports / Tournament Results panel instead of "Search Results"."""
    query_type = (intent.get("query_type") or "").strip()
    tournament = (intent.get("tournament_or_league") or "").strip()
    if query_type in (
        "tournament_status",
        "schedule",
        "next_match",
        "match_result_verification",
    ) and tournament:
        title = "Tournament Results"
        result_kind = "tournament"
    else:
        title = "Sports Results"
        result_kind = "sports"
    serialized = []
    for item in items[:8]:
        serialized.append({
            "title": item.get("title") or "",
            "summary": item.get("summary") or "",
            "published": "",
            "published_display": item.get("published_display") or "",
            "source": item.get("source") or "",
            "url": item.get("url") or "",
        })
    payload = {
        "panel_type": "media_tabs",
        "title": title,
        "query": query_label,
        "news_results": serialized,
        "images": [],
        "videos": [],
        "default_tab": "news",
        "result_kind": result_kind,
        "request_id": request_id,
        "created_at_ms": int(_time.time() * 1000),
        "sports_intent": {
            "sport": intent.get("sport") or "",
            "entity": intent.get("entity") or "",
            "entity_type": intent.get("entity_type") or "",
            "query_type": intent.get("query_type") or "",
            "tournament_or_league": intent.get("tournament_or_league") or "",
            "opponent": intent.get("opponent") or "",
            "season_or_year": intent.get("season_or_year") or "",
            "confidence": float(intent.get("confidence") or 0.0),
            "reason": intent.get("reason") or "",
        },
    }
    return payload


def _log_sports_intent(
    *,
    session_id: str,
    text: str,
    intent: dict,
    context_before: dict | None,
    context_after: dict | None,
    structured_attempted: bool,
    structured_success: bool,
    web_fallback_used: bool,
    confidence_hint: str,
    panel_result_kind: str,
) -> None:
    """One-line structured log: ``[sports_intent]``."""
    try:
        print(
            "[sports_intent] " + json.dumps(
                {
                    "session_id": (session_id or "")[:64],
                    "latest_user_text": (text or "")[:200],
                    "sports_intent_detected": bool(intent.get("is_sports")),
                    "sports_entity": intent.get("entity") or "",
                    "sports_entity_type": intent.get("entity_type") or "",
                    "sports_sport": intent.get("sport") or "",
                    "sports_query_type": intent.get("query_type") or "",
                    "sports_tournament_or_league": intent.get("tournament_or_league") or "",
                    "sports_context_used": bool(intent.get("followup_used")),
                    "sports_context_before": _ctx_log_view(context_before),
                    "sports_context_after": _ctx_log_view(context_after),
                    "structured_sports_lookup_attempted": bool(structured_attempted),
                    "structured_sports_lookup_success": bool(structured_success),
                    "web_fallback_used": bool(web_fallback_used),
                    "answer_confidence": confidence_hint,
                    "panel_result_kind": panel_result_kind,
                    "router_confidence": float(intent.get("confidence") or 0.0),
                    "router_reason": intent.get("reason") or "",
                    "needs_clarification": bool(intent.get("needs_clarification")),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def _log_sports_route_trace(
    *,
    session_id: str = "",
    raw_user_text: str = "",
    prior_sports_context: dict | None = None,
    sports_intent_detected: bool = False,
    sports_query_type: str = "",
    entity: str = "",
    normalized_entity: str = "",
    opponent: str = "",
    tournament_or_league: str = "",
    season_or_year: str = "",
    followup_used: bool = False,
    normalized_queries: list[str] | None = None,
    serper_endpoint_used: str = "",
    result_kind: str = "",
    panel_title: str = "",
    generic_draw_pages_only: bool | None = None,
    web_fallback_used: bool | None = None,
    answer_confidence: str = "",
    final_reply: str = "",
) -> None:
    """Emit a structured ``[sports_route_trace]`` log line.

    Grep target: ``[sports_route_trace]``. The shape mirrors the spec in
    the 2026-05-30 sports query normalizer brief so we can audit routing
    decisions + normalized queries from a single line per turn.
    """
    try:
        payload = {
            "session_id": (session_id or "")[:64],
            "raw_user_text": (raw_user_text or "")[:240],
            "prior_sports_context": _ctx_log_view(prior_sports_context) if prior_sports_context else None,
            "sports_intent_detected": bool(sports_intent_detected),
            "sports_query_type": sports_query_type or "",
            "entity": entity or "",
            "normalized_entity": normalized_entity or entity or "",
            "opponent": opponent or "",
            "tournament_or_league": tournament_or_league or "",
            "season_or_year": season_or_year or "",
            "followup_used": bool(followup_used),
            "normalized_queries": list(normalized_queries or [])[:6],
            "serper_endpoint_used": serper_endpoint_used or "",
            "result_kind": result_kind or "",
            "panel_title": panel_title or "",
            "generic_draw_pages_only": generic_draw_pages_only,
            "web_fallback_used": web_fallback_used,
            "answer_confidence": answer_confidence or "",
            "final_reply": (final_reply or "")[:240],
            "ts": round(_time.time(), 3),
        }
        print("[sports_route_trace] " + json.dumps(payload, ensure_ascii=False), flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[sports_route_trace_error] {exc!r}", flush=True)


def _log_sports_query_too_generic(
    *,
    query_type: str,
    queries: list[str],
    entity: str,
    tournament: str,
    entity_missing: bool,
    tournament_missing: bool,
) -> None:
    """Hard warning: built queries omit the player name or tournament for a
    status/verification turn. Grep target: ``[sports_query_too_generic]``.
    """
    try:
        print(
            "[sports_query_too_generic] " + json.dumps(
                {
                    "query_type": query_type,
                    "entity": entity,
                    "tournament": tournament,
                    "entity_missing": entity_missing,
                    "tournament_missing": tournament_missing,
                    "queries": queries[:3],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def _log_sports_claim_not_verified(
    *,
    queries: list[str],
    entity: str,
    opponent: str,
    entity_missing: bool,
    opponent_missing: bool,
) -> None:
    """Hard warning: a match-result-verification turn but the final queries
    don't actually carry both ``entity`` and ``opponent``. The LLM should
    treat such turns with low confidence. Grep target:
    ``[sports_claim_not_verified]``.
    """
    try:
        print(
            "[sports_claim_not_verified] " + json.dumps(
                {
                    "entity": entity,
                    "opponent": opponent,
                    "entity_missing": entity_missing,
                    "opponent_missing": opponent_missing,
                    "queries": queries[:3],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def _log_sports_followup_context_missed(
    *,
    session_id: str,
    text: str,
    has_pronoun: bool,
    has_how_about: bool,
    ctx_view: dict | None,
) -> None:
    """Hard warning: turn contains follow-up shape (pronoun / "how about X")
    AND recent_sports_context exists, but the classifier did NOT use that
    context. Grep target: ``[sports_followup_context_missed]``.
    """
    try:
        print(
            "[sports_followup_context_missed] " + json.dumps(
                {
                    "session_id": (session_id or "")[:64],
                    "latest_user_text": (text or "")[:200],
                    "has_pronoun": bool(has_pronoun),
                    "has_how_about": bool(has_how_about),
                    "ctx_view": ctx_view,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def normalize_sports_query(
    raw_user_text: str,
    sports_context: dict | None = None,
) -> dict:
    """Pure, side-effect-free entry point for the sports query normalizer.

    Returns a dict with the schema laid out in the 2026-05-30 spec:

        {
          "query_type": str,
          "entity": str,
          "normalized_entity": str,
          "entity_type": str,
          "opponent": str,
          "tournament_or_league": str,
          "season_or_year": str,
          "normalized_queries": list[str],
          "followup_used": bool,
          "confidence": float,
          "reason": str,
          "is_sports": bool,
        }

    The function composes :func:`classify_sports_intent` (which already
    handles entity resolution, ctx inheritance, opponent extraction, year
    normalization, and match-result-verification routing) with
    :func:`build_sports_search_queries` so callers can request both the
    structured intent and the concrete Serper query bundle in one step.
    """
    intent = classify_sports_intent(
        raw_user_text or "", recent_sports_context=sports_context
    )
    queries: list[str] = []
    if intent.get("is_sports") and not intent.get("needs_clarification"):
        queries = build_sports_search_queries(intent, raw_user_text or "")
    return {
        "query_type": intent.get("query_type") or "",
        "entity": intent.get("entity") or "",
        "normalized_entity": intent.get("normalized_entity")
            or intent.get("entity")
            or "",
        "entity_type": intent.get("entity_type") or "",
        "opponent": intent.get("opponent") or "",
        "opponent_verb": intent.get("opponent_verb") or "",
        "tournament_or_league": intent.get("tournament_or_league") or "",
        "season_or_year": intent.get("season_or_year") or "",
        "normalized_queries": queries,
        "followup_used": bool(intent.get("followup_used")),
        "confidence": float(intent.get("confidence") or 0.0),
        "reason": intent.get("reason") or "",
        "is_sports": bool(intent.get("is_sports")),
        "needs_clarification": bool(intent.get("needs_clarification")),
        "sport": intent.get("sport") or "",
    }


def _log_low_confidence_warning(
    *,
    session_id: str,
    text: str,
    intent: dict,
    confidence_hint: str,
) -> None:
    """Hard warning when answer is produced from generic snippets without a
    clear result. Grep target: ``[sports_query_web_fallback_low_confidence]``."""
    if confidence_hint != "low":
        return
    try:
        print(
            "[sports_query_web_fallback_low_confidence] " + json.dumps(
                {
                    "session_id": (session_id or "")[:64],
                    "latest_user_text": (text or "")[:200],
                    "sports_entity": intent.get("entity") or "",
                    "sports_query_type": intent.get("query_type") or "",
                    "tournament_or_league": intent.get("tournament_or_league") or "",
                    "router_confidence": float(intent.get("confidence") or 0.0),
                    "router_reason": intent.get("reason") or "",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def _ctx_log_view(ctx: dict | None) -> dict | None:
    if not isinstance(ctx, dict):
        return None
    return {
        "entity": ctx.get("entity") or "",
        "sport": ctx.get("sport") or "",
        "tournament_or_league": ctx.get("tournament_or_league") or "",
        "query_type": ctx.get("query_type") or "",
        "last_result_summary": (ctx.get("last_result_summary") or "")[:120],
    }


def structured_sports_lookup(intent: dict) -> dict | None:
    """Adapter slot for a future structured sports API.

    Returns ``None`` today (no API plumbed in). When a real provider (ESPN,
    TheSportsDB, API-SPORTS, …) is wired in, this function should return a
    dict with at minimum ``{summary, items, source, confidence}`` and the
    executor will prefer it over Serper snippets.
    """
    return None


def prepare_sports_streaming(
    vera,
    *,
    intent: dict,
    original_text: str,
    session_id: str = "",
    request_id: str = "",
):
    """Streaming entry. Returns ``(messages, ui_payload, finalize)`` or
    ``None`` on a hard failure. Mirrors the shape of
    ``prepare_web_search_streaming``.
    """
    if not intent.get("is_sports"):
        return None

    queries = build_sports_search_queries(intent, original_text)
    request_id = request_id or f"req_{int(_time.time() * 1000)}"

    items: list[dict] = []
    # Lazy import to avoid circulars; web_search already manages the cache.
    try:
        from actions.web_search import _serper_search_organic, _normalize_results
        for q in queries:
            try:
                payload = _serper_search_organic(q)
                items.extend(_normalize_results(payload) or [])
            except Exception as exc:  # noqa: BLE001
                print("[sports] serper error (continuing):", exc, flush=True)
    except Exception as exc:  # noqa: BLE001
        print("[sports] serper import error (continuing without snippets):", exc, flush=True)

    # Dedupe by url.
    seen_urls: set[str] = set()
    dedup_items: list[dict] = []
    for it in items:
        url = (it.get("url") or "").strip().lower()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        dedup_items.append(it)

    # Augment with Serper /news so we get freshness signals for "recent game".
    # 2026-05-30: compose the freshness query with the league/tournament +
    # season tag instead of passing the bare entity. The legacy code sent
    # "Novak Djokovic" by itself, which the news refiner then rewrote into
    # "latest developments in Novak Djokovic" — entity-only and tournament-
    # free. We now build "Novak Djokovic Roland Garros 2026 latest ..." so
    # the refiner sees an existing freshness token and leaves it alone.
    try:
        from actions.news import search_news_results
        _freshness_parts: list[str] = []
        _entity_for_news = (intent.get("entity") or "").strip()
        if _entity_for_news:
            _freshness_parts.append(_entity_for_news)
        _opponent_for_news = (intent.get("opponent") or "").strip()
        if _opponent_for_news:
            _freshness_parts.append(_opponent_for_news)
        _league_for_news = _league_label_for_intent(intent)
        if _league_for_news:
            _freshness_parts.append(_league_for_news)
        _year_for_news = (intent.get("season_or_year") or "").strip()
        if _year_for_news:
            _freshness_parts.append(_year_for_news)
        # Include "latest" so actions.news._refine_news_search_query keeps
        # the query as-is instead of prepending "latest developments in".
        _freshness_parts.append("latest")
        _freshness_query = " ".join(p for p in _freshness_parts if p).strip()
        if not _freshness_query:
            _freshness_query = intent.get("entity") or original_text
        news_items = search_news_results(_freshness_query)
        for it in news_items or []:
            url = (it.get("url") or "").strip().lower()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            dedup_items.append({
                "title": it.get("title") or "",
                "summary": it.get("summary") or "",
                "source": it.get("source") or "",
                "url": it.get("url") or "",
                "is_answer_box": False,
                "published_display": it.get("published_display") or "",
            })
    except Exception as exc:  # noqa: BLE001
        print("[sports] news fetch error (continuing without news items):", exc, flush=True)

    confidence_hint = _score_snippet_confidence(intent, dedup_items)
    # 2026-05-30: surface the generic-draw-pages-only signal as a separate
    # flag so the prompt can warn the LLM explicitly and the trace log can
    # capture it for offline analysis. Match-result-verification turns get
    # an extra "claim verified in snippets?" flag for the same reason.
    is_generic_draw = (
        intent.get("query_type") == "tournament_status"
        and _is_generic_draw_pages_only(dedup_items)
    )
    match_verification_in_snippets: bool | None = None
    if intent.get("query_type") == "match_result_verification" and intent.get("opponent"):
        entity_low = (intent.get("entity") or "").lower()
        opp_low = (intent.get("opponent") or "").lower()
        match_verification_in_snippets = False
        for it in dedup_items[:8]:
            blob = (str(it.get("title") or "") + " " + str(it.get("summary") or "")).lower()
            if entity_low and entity_low in blob and opp_low and opp_low in blob:
                match_verification_in_snippets = True
                break

    structured = structured_sports_lookup(intent)
    structured_attempted = True
    structured_success = bool(structured)
    web_fallback_used = not structured_success

    query_label = (intent.get("entity") or original_text or "Sports").strip()
    ui_payload = _build_panel_payload(
        intent, items=dedup_items, request_id=request_id, query_label=query_label
    )

    _log_sports_intent(
        session_id=session_id,
        text=original_text,
        intent=intent,
        context_before=intent.get("context_before"),
        context_after=None,  # set by caller after persisting recent_sports_context
        structured_attempted=structured_attempted,
        structured_success=structured_success,
        web_fallback_used=web_fallback_used,
        confidence_hint=confidence_hint,
        panel_result_kind=ui_payload.get("result_kind") or "",
    )
    _log_low_confidence_warning(
        session_id=session_id,
        text=original_text,
        intent=intent,
        confidence_hint=confidence_hint,
    )
    # 2026-05-30 sports_route_trace.
    try:
        _log_sports_route_trace(
            session_id=session_id,
            raw_user_text=original_text,
            prior_sports_context=intent.get("context_before"),
            sports_intent_detected=True,
            sports_query_type=intent.get("query_type") or "",
            entity=intent.get("entity") or "",
            normalized_entity=intent.get("normalized_entity") or intent.get("entity") or "",
            opponent=intent.get("opponent") or "",
            tournament_or_league=intent.get("tournament_or_league") or "",
            season_or_year=intent.get("season_or_year") or "",
            followup_used=bool(intent.get("followup_used")),
            normalized_queries=queries,
            serper_endpoint_used="/search + /news",
            result_kind=ui_payload.get("result_kind") or "",
            panel_title=ui_payload.get("title") or "",
            generic_draw_pages_only=bool(is_generic_draw),
            web_fallback_used=bool(web_fallback_used),
            answer_confidence=confidence_hint,
            final_reply="",
        )
    except Exception:
        pass

    prompt_body = _build_sports_prompt(
        intent,
        original_text,
        dedup_items,
        confidence_hint,
        generic_draw_pages_only=bool(is_generic_draw),
        match_verification_in_snippets=match_verification_in_snippets,
    )
    full_prompt = _SPORTS_PROMPT_PREAMBLE + prompt_body
    try:
        messages = vera.build_messages([], full_prompt)
    except Exception as exc:  # noqa: BLE001
        print("[sports] prompt error:", exc, flush=True)
        return None

    def finalize(response: str) -> dict:
        return {
            "spoken_reply": response,
            "action_type": "web_search",  # reuse the streaming action_type contract
            "data": {
                "query": query_label,
                "user_query": original_text,
                "request_id": request_id,
                "results": dedup_items,
                "sports_intent": intent,
                "answer_confidence": confidence_hint,
                "structured_sports_lookup_attempted": structured_attempted,
                "structured_sports_lookup_success": structured_success,
                "web_fallback_used": web_fallback_used,
                "panel_result_kind": ui_payload.get("result_kind") or "",
            },
            "ui_payload": ui_payload,
        }

    return messages, ui_payload, finalize


def handle_sports_request(
    vera,
    *,
    intent: dict,
    original_text: str,
    session_id: str = "",
) -> dict:
    """Synchronous executor. Mirrors ``handle_web_search_request`` shape."""
    if intent.get("needs_clarification"):
        prompt = (
            "Which team or player did you mean? I lost the previous sports topic."
            if intent.get("clarification_reason") == "pronoun_followup_without_context"
            else "Which team, player, or tournament are you asking about?"
        )
        return {
            "spoken_reply": prompt,
            "action_type": "web_search",
            "data": {
                "sports_intent": intent,
                "needs_clarification": True,
            },
            "ui_payload": None,
        }
    prepared = prepare_sports_streaming(
        vera, intent=intent, original_text=original_text, session_id=session_id
    )
    if prepared is None:
        return {
            "spoken_reply": "I couldn't reach the sports search service right now.",
            "action_type": "web_search",
            "data": None,
            "ui_payload": None,
            "service_failure": "sports",
        }
    messages, _ui, finalize = prepared
    response, _ = vera.generate(messages)
    return finalize(response)


# --------------------------------------------------------------------------
# Recent sports context helpers — used by app.py to persist + retrieve the
# per-session sports topic so follow-ups can resolve pronouns and "how about X".
# --------------------------------------------------------------------------

def build_context_from_intent_and_result(
    intent: dict, action_result: dict | None, original_text: str
) -> dict:
    """Build the recent_sports_context dict that app.py persists per-session.

    2026-05-30: also carries ``opponent``, ``season_or_year``, and
    ``last_result_or_match`` so a turn like "what about Fonseca?" can pick
    up the opponent the user just resolved against, and "what about
    Wimbledon?" can pick up the year the user just stated.
    """
    ar = action_result if isinstance(action_result, dict) else {}
    data = ar.get("data") if isinstance(ar.get("data"), dict) else {}
    return {
        "sport": intent.get("sport") or "",
        "entity": intent.get("entity") or "",
        "entity_type": intent.get("entity_type") or "",
        "tournament_or_league": intent.get("tournament_or_league") or "",
        "query_type": intent.get("query_type") or "",
        "opponent": intent.get("opponent") or "",
        "season_or_year": intent.get("season_or_year") or "",
        "last_user_text": (original_text or "")[:200],
        "last_result_summary": (ar.get("spoken_reply") or "")[:240],
        "last_result_or_match": (ar.get("spoken_reply") or "")[:240],
        "answer_confidence": data.get("answer_confidence") or "",
        "created_at": _time.time(),
        "timestamp": _time.time(),
    }


# --------------------------------------------------------------------------
# Small public registry — used by app.py to know which action_name values
# this module owns. Keeping it here means a future "add info.sports_news"
# does not need a parallel edit in app.py.
# --------------------------------------------------------------------------

SPORTS_ACTION_NAMES = (
    "web.sports_score",
    "web.sports_schedule",
    "web.sports_standings",
    "web.sports_tournament_status",
    "web.sports_player_status",
    "web.sports_news",
)

_QUERY_TYPE_TO_ACTION = {
    "latest_result": "web.sports_score",
    "schedule": "web.sports_schedule",
    "standings": "web.sports_standings",
    "tournament_status": "web.sports_tournament_status",
    "player_status": "web.sports_player_status",
    "news": "web.sports_news",
}


def action_name_for_intent(intent: dict) -> str:
    """Map a classified intent to a ``web.sports_*`` action name."""
    qt = (intent.get("query_type") or "").strip()
    return _QUERY_TYPE_TO_ACTION.get(qt, "web.sports_score")
