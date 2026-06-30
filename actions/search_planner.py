"""Adaptive mini-LLM search planner for info / search queries (2026-05-31).

The deterministic ``classify_info_tool`` cascade in ``app.py`` is the source
of truth for ROUTE selection across every domain (time / weather / finance /
news / sports / web / location / product). It is fast, predictable, and
easy to unit-test.

But the deterministic cascade is regex-driven, so it can produce *messy*
queries for *messy* input — phrasings full of follow-up tokens (``that``,
``cheaper``, ``next``), product recommendations without explicit category
words, news follow-ups whose topic lives in the previous turn, or sports
turns that need both subject and opponent names in the Serper query.

This module adds an ADAPTIVE second pass. It runs ONLY when the
deterministic classifier returns low confidence or a follow-up shape that
needs semantic reasoning. The planner asks the local LLM to emit a single
JSON object with a structured search plan; the existing search / news /
sports / product / location handlers then execute the planner's
``normalized_queries`` instead of (or in addition to) the deterministic
ones.

Strict scope guarantees:
    * The planner is for INFO / SEARCH queries only.
    * It is NEVER invoked for app actions (music, checklist, timer, panel
      navigation, reasoning panel routing) — those routes are owned by the
      deterministic multi-action planner and we don't touch them here.
    * The planner does NOT answer the user; it only emits route / query
      metadata. Final answer composition still happens in the existing
      assistant LLM call from retrieved Serper results.

Diagnostics (one structured line per ``classify_info_tool`` invocation):

    [search_planner_trace] {
        "session_id": "...",
        "raw_user_text": "...",
        "search_planner_considered": true,
        "search_planner_called": true|false,
        "search_planner_skipped_reason": "...",
        "deterministic_confidence": 0.84,
        "deterministic_route": "sports_tool",
        "search_planner_latency_ms": 412,
        "search_planner_intent_type": "sports.match_result",
        "search_planner_normalized_queries": ["..."],
        "search_planner_answer_policy": "...",
        "deterministic_fallback_used": false,
        "final_search_queries": ["..."],
        "final_result_kind": "tournament",
        "answer_confidence": "medium",
    }
"""
from __future__ import annotations

import json
import re
import time as _time


# --------------------------------------------------------------------------
# Schema constants
# --------------------------------------------------------------------------

ALLOWED_INTENT_TYPES = (
    "sports.next_match",
    "sports.tournament_status",
    "sports.match_result",
    "news.topic",
    "product.research",
    "location.places",
    "finance.quote",
    "weather.current",
    "time.current",
    "web.current_fact",
    "unknown",
)

# Routes the planner NEVER touches. classify_info_tool only emits info
# routes today (it doesn't produce music / checklist / timer / panel routes),
# but we still list them defensively so a future wider call site never
# accidentally double-plans an app action.
_APP_ACTION_ROUTES: frozenset[str] = frozenset({
    "music_tool",
    "checklist_tool",
    "timer_tool",
    "panel_navigation",
    "reasoning_panel",
    "reasoning_panel_routing",
    "llm_only",
})

# Follow-up tokens that flag context-dependent queries. The presence of any
# of these in the raw text is by itself enough to invoke the planner (per
# spec, even at high deterministic confidence).
_FOLLOWUP_TOKENS: tuple[str, ...] = (
    "that", "this", "him", "her", "they", "them", "those", "there", "it",
    "cheaper", "next", "still", "recent",
)
_FOLLOWUP_RE = re.compile(
    r"\b(?:" + "|".join(re.escape(t) for t in _FOLLOWUP_TOKENS) + r")\b",
    re.IGNORECASE,
)

# Mapping planner intent_type -> deterministic route, used only when
# deterministic was "uncertain" and the planner has a confident pick.
_INTENT_TO_ROUTE: dict[str, str] = {
    "sports.next_match": "sports_tool",
    "sports.tournament_status": "sports_tool",
    "sports.match_result": "sports_tool",
    "news.topic": "news_search_tool",
    "product.research": "general_web_search_tool",
    "location.places": "general_web_search_tool",
    "finance.quote": "finance_tool",
    "weather.current": "weather_tool",
    "time.current": "time_tool",
    "web.current_fact": "general_web_search_tool",
}


# --------------------------------------------------------------------------
# Decision logic
# --------------------------------------------------------------------------

def should_use_search_planner(
    text: str,
    classification: dict,
    *,
    recent_news_context: dict | None = None,
    recent_sports_context: dict | None = None,
) -> tuple[bool, str]:
    """Return ``(use_planner, skip_reason)``.

    The decision is *adaptive*:

      * For app-action routes / clarifications / llm_only — never.
      * For sports turns with follow-up shape, opponent claim, or
        confidence < 0.85 — always.
      * For any turn with follow-up tokens (``that``, ``cheaper``, ``next``,
        …) — always.
      * For any turn with deterministic confidence < 0.75 — always.
      * For product-recommendation classifications — always.
      * For news follow-ups not already merged by the deterministic
        info_normalizer — always.
      * For simple direct fast paths (time / weather / finance / places /
        explicit news with complete topic) — never, unless deterministic
        confidence is low (caught by the < 0.75 branch above).
    """
    raw = (text or "").strip()
    if not raw:
        return False, "empty_text"
    if not isinstance(classification, dict):
        return False, "no_classification"

    route = str(classification.get("route") or "").strip()
    confidence = float(classification.get("confidence") or 0.0)
    reason = str(classification.get("reason") or "")

    # Never: app actions or clarifications.
    if route in _APP_ACTION_ROUTES:
        return False, "app_action_route"
    if route in ("sports_clarification_needed", "clarification_needed"):
        return False, "clarification_route_planner_unhelpful"

    # Fast-path skips for SIMPLE DIRECT routes when deterministic
    # confidence is high. Per spec, these turns ("what time is it in
    # Tokyo?", "weather in Irvine", "Apple stock price", "coffee shops in
    # Fountain Valley", "news about OpenAI") must NOT incur LLM latency
    # even though they may contain follow-up tokens like "it" in the
    # phrasing — the deterministic route already nailed the intent. The
    # fast-path skips only apply when confidence >= 0.75; lower
    # confidence drops through to the planner-use branches below.
    if confidence >= 0.75:
        if route == "time_tool":
            return False, "fast_path_time"
        if route == "weather_tool":
            return False, "fast_path_weather"
        if route == "finance_tool":
            return False, "fast_path_finance"
        if route == "general_web_search_tool" and reason.startswith("local_venue"):
            return False, "fast_path_location_places"
        if route == "news_search_tool" and reason == "explicit_news_request":
            return False, "fast_path_explicit_news"
        if route == "news_search_tool" and classification.get("news_pre_normalized"):
            return False, "fast_path_news_pre_normalized"

    # Sports: planner only when the deterministic sports normalizer is
    # ambiguous (follow-up shape, opponent claim, or below high-confidence
    # band). Clean direct sports turns already produce excellent targeted
    # queries — skip to keep latency down.
    sports_intent = classification.get("sports_intent")
    if isinstance(sports_intent, dict) and sports_intent.get("is_sports"):
        s_conf = float(sports_intent.get("confidence") or 0.0)
        followup_used = bool(sports_intent.get("followup_used"))
        opponent = bool(sports_intent.get("opponent"))
        if s_conf < 0.85 or followup_used or opponent:
            return True, "sports_followup_or_low_confidence"
        return False, "fast_path_sports_high_confidence"

    # Product recommendation flags. Checked BEFORE the generic follow-up
    # token branch so a product turn like "any cheaper ones?" is reported
    # as ``product_recommendation_needs_normalization`` rather than the
    # less-specific ``followup_terms_present``.
    if isinstance(classification.get("product_intent"), dict):
        return True, "product_recommendation_needs_normalization"
    if route == "general_web_search_tool" and reason in (
        "shopping_or_recommendation_web_search",
        "product_recommendation_intent",
    ):
        return True, "product_recommendation_needs_normalization"

    # News follow-up branches: the deterministic info_normalizer already
    # merges prior topic + new location for the "give me news on that"
    # turn (stamps news_pre_normalized=True). For other news routes, only
    # use the planner when the request looks contextual.
    if route == "news_search_tool":
        if classification.get("news_pre_normalized"):
            return False, "fast_path_news_pre_normalized"
        if reason == "explicit_news_request":
            return False, "fast_path_explicit_news"
        return True, "news_followup_needs_planner"

    # Follow-up tokens (deictic / comparative) — semantic reasoning helps.
    if _FOLLOWUP_RE.search(raw):
        return True, "followup_terms_present"

    # Low deterministic confidence — always invoke planner.
    if confidence < 0.75:
        return True, "low_deterministic_confidence"

    # Default: high-confidence non-app route that doesn't fit any "always
    # use" bucket above — skip planner.
    return False, "high_confidence_no_planner_needed"


# --------------------------------------------------------------------------
# Prompt + LLM invocation
# --------------------------------------------------------------------------

_PLANNER_SYSTEM_PROMPT = """\
You are the SEARCH PLANNER for VERA, a voice assistant. Read the user's
info/search query plus optional prior context and emit ONE compact JSON
object that helps the backend pick the right search endpoint and generate
a targeted, year-aware, opponent-aware search query.

You DO NOT answer the user. You ONLY emit JSON. Output ONLY the JSON
object — no prose, no markdown fences, no commentary.

Schema (every field is REQUIRED; use null where unknown):
{
  "intent_type": one of [
      "sports.next_match", "sports.tournament_status", "sports.match_result",
      "news.topic", "product.research", "location.places",
      "finance.quote", "weather.current", "time.current",
      "web.current_fact", "unknown"
  ],
  "entity": string|null,
  "entity_type": string|null,
  "sport": string|null,
  "league_or_tournament": string|null,
  "location": string|null,
  "time_context": string|null,
  "product_category": string|null,
  "use_case": string|null,
  "budget": string|null,
  "normalized_queries": [1-3 strings],
  "answer_policy": short string,
  "confidence": number 0.0-1.0,
  "needs_clarification": boolean,
  "clarification_question": string|null
}

Rules:
- For sports.match_result with an opponent claim ("lost to X", "beat X"),
  every normalized query MUST include BOTH names + tournament + year.
- For sports.tournament_status and sports.next_match, include the current
  year (2026) as a soft term unless the user gave a different year.
- For product.research, include the use case and the category in the
  query (e.g. "best webcam for Zoom meeting 2026").
- For news.topic follow-ups (deictic), merge prior topic + new
  location/entity into one query (e.g. "Garden Grove Orange County
  chemical leak news").
- For location.places, use "{category} in {location}" form.
- For time/weather/finance/time, a canonical short form is fine ("time in
  Tokyo", "weather in Irvine", "AAPL stock price").
- normalized_queries MUST NOT contain conversational filler ("can you",
  "do you know", "please") or trailing punctuation.
- If you genuinely cannot tell what the user wants, set
  intent_type="unknown", needs_clarification=true, and write a short
  one-sentence clarification_question.

Output only the JSON object.
"""


def _build_planner_prompt(
    raw_text: str,
    *,
    classification: dict | None,
    recent_news_context: dict | None,
    recent_sports_context: dict | None,
) -> str:
    """Compose the user-facing prompt body that follows the system
    instructions. We append a compact context block so the model doesn't
    have to re-derive prior topic / entity / tournament from scratch.
    """
    ctx_lines: list[str] = []
    if isinstance(recent_sports_context, dict) and recent_sports_context.get("entity"):
        ctx_lines.append(
            "Prior sports context: "
            f"entity={recent_sports_context.get('entity')!r}, "
            f"sport={recent_sports_context.get('sport') or ''!r}, "
            f"tournament={recent_sports_context.get('tournament_or_league') or ''!r}, "
            f"season={recent_sports_context.get('season_or_year') or ''!r}, "
            f"last_query_type={recent_sports_context.get('query_type') or ''!r}, "
            f"opponent={recent_sports_context.get('opponent') or ''!r}"
        )
    if isinstance(recent_news_context, dict) and (
        recent_news_context.get("topic") or recent_news_context.get("entity")
    ):
        ctx_lines.append(
            "Prior news context: "
            f"topic={recent_news_context.get('topic') or ''!r}, "
            f"location={recent_news_context.get('location') or ''!r}, "
            f"entity={recent_news_context.get('entity') or ''!r}"
        )
    if isinstance(classification, dict):
        ctx_lines.append(
            "Deterministic guess: "
            f"route={classification.get('route') or ''!r}, "
            f"confidence={float(classification.get('confidence') or 0.0):.2f}, "
            f"reason={classification.get('reason') or ''!r}"
        )
    ctx_block = "\n".join(ctx_lines) if ctx_lines else "(no prior context)"
    return (
        _PLANNER_SYSTEM_PROMPT
        + "\n\nContext:\n"
        + ctx_block
        + "\n\nUser query: "
        + raw_text
        + "\n\nJSON:"
    )


def run_search_planner(
    text: str,
    vera,
    *,
    classification: dict | None = None,
    recent_news_context: dict | None = None,
    recent_sports_context: dict | None = None,
    session_id: str = "",
) -> dict | None:
    """Invoke the mini LLM to produce a search plan.

    Returns:
        A dict matching the planner schema with two extra fields:
          * ``_latency_ms`` -- wall-clock LLM call latency.
          * ``_raw_reply``  -- first 600 chars of the model output (for
            diagnostics when JSON parsing fails or the schema is off).
        Returns ``None`` when ``vera`` is unavailable, the LLM call
        raises, or the response is not a JSON object.
    """
    if vera is None:
        return None
    raw = (text or "").strip()
    if not raw:
        return None
    prompt = _build_planner_prompt(
        raw,
        classification=classification,
        recent_news_context=recent_news_context,
        recent_sports_context=recent_sports_context,
    )
    start = _time.time()
    try:
        msgs = vera.build_messages([], prompt)
        raw_reply, _t = vera.generate(msgs)
    except Exception as exc:  # noqa: BLE001
        print(f"[search_planner_llm_error] {exc!r}", flush=True)
        return None
    latency_ms = int((_time.time() - start) * 1000)
    parsed = _parse_planner_json(raw_reply)
    if parsed is None:
        # Diagnostic: log raw reply head so an off-schema model is easy to spot.
        try:
            head = (raw_reply or "").strip()[:240]
            print(
                "[search_planner_parse_error] "
                + json.dumps(
                    {
                        "session_id": (session_id or "")[:64],
                        "raw_head": head,
                        "latency_ms": latency_ms,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        return None
    parsed["_latency_ms"] = latency_ms
    parsed["_raw_reply"] = (raw_reply or "")[:600]
    return parsed


def _parse_planner_json(raw: str | None) -> dict | None:
    """Best-effort JSON parsing of the planner reply.

    Strips trailing prose / code fences. Enforces the canonical schema for
    a small set of critical fields (``intent_type`` falls back to
    ``"unknown"``, ``normalized_queries`` clamps to <=3 stripped strings,
    ``confidence`` coerces to float).
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    s = raw.strip()
    m = re.search(r"\{.*\}", s, re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    intent_type = str(obj.get("intent_type") or "unknown").strip()
    if intent_type not in ALLOWED_INTENT_TYPES:
        intent_type = "unknown"
    obj["intent_type"] = intent_type
    nq = obj.get("normalized_queries") or []
    if not isinstance(nq, list):
        nq = []
    cleaned_nq: list[str] = []
    for q in nq:
        if not isinstance(q, str):
            continue
        # Strip whitespace AND trailing/leading punctuation together — a
        # raw model output like "a ?" should normalize to "a", not "a ".
        q = q.strip(" \t\r\n?.!,;:\"'")
        if q:
            cleaned_nq.append(q)
    obj["normalized_queries"] = cleaned_nq[:3]
    try:
        obj["confidence"] = float(obj.get("confidence") or 0.0)
    except Exception:
        obj["confidence"] = 0.0
    obj["needs_clarification"] = bool(obj.get("needs_clarification"))
    if obj.get("clarification_question") and not isinstance(
        obj.get("clarification_question"), str
    ):
        obj["clarification_question"] = str(obj.get("clarification_question") or "")
    return obj


# --------------------------------------------------------------------------
# Plan application
# --------------------------------------------------------------------------

def apply_search_plan(plan: dict | None, classification: dict) -> dict:
    """Merge a planner output into ``classification`` (mutated in place).

    Conservative merge policy:
      * If plan is None / empty / confidence < 0.5 -> no-op.
      * If plan asks for clarification -> stash the question but DO NOT
        change the deterministic route. Caller decides whether to ask.
      * For sports turns that already produced strong deterministic
        queries (sports_intent.confidence >= 0.85, no follow-up, no
        opponent), we still annotate the classification with the
        planner's view but DO NOT overwrite ``query`` (the deterministic
        ``build_sports_search_queries`` already produced targeted queries).
      * For every other case, the planner's first ``normalized_queries``
        entry becomes ``classification["query"]`` and the full list is
        exposed as ``classification["search_planner_normalized_queries"]``.
      * Route is only upgraded when the deterministic route was
        ``"uncertain"`` (the planner can fill in the slot that regex
        couldn't).

    The mutated ``classification`` is also returned for convenience.
    """
    if not isinstance(classification, dict):
        return classification
    if not isinstance(plan, dict):
        return classification

    classification["search_planner_applied"] = False
    classification["search_planner_intent_type"] = plan.get("intent_type") or "unknown"
    classification["search_planner_confidence"] = float(plan.get("confidence") or 0.0)
    classification["search_planner_answer_policy"] = plan.get("answer_policy") or ""
    classification["search_planner_latency_ms"] = plan.get("_latency_ms")

    if plan.get("needs_clarification"):
        classification["search_planner_clarification"] = (
            plan.get("clarification_question") or ""
        )
        return classification

    plan_conf = float(plan.get("confidence") or 0.0)
    if plan_conf < 0.5:
        return classification

    nq = list(plan.get("normalized_queries") or [])
    if not nq:
        return classification

    intent_type = plan.get("intent_type") or "unknown"

    # Determine whether the deterministic sports normalizer already
    # produced strong queries — if so, don't overwrite them.
    sports_intent = classification.get("sports_intent")
    deterministic_sports_strong = (
        isinstance(sports_intent, dict)
        and sports_intent.get("is_sports")
        and float(sports_intent.get("confidence") or 0.0) >= 0.85
        and not sports_intent.get("followup_used")
        and not sports_intent.get("opponent")
    )

    if not deterministic_sports_strong:
        classification["query"] = nq[0]
        classification["normalized_query"] = nq[0]
        classification["search_planner_normalized_queries"] = list(nq)

    # When deterministic route was uncertain AND the planner has a
    # confident intent_type, upgrade the route. This is what makes the
    # planner useful for catching "im pretty sure he lost to X" without
    # ctx — where deterministic returned route="uncertain". Sports
    # upgrades are skipped here because the sports handler downstream
    # relies on a fully populated ``sports_intent`` dict (entity, sport,
    # tournament, opponent, query_type) which the planner doesn't shape
    # to the deterministic schema; routing to sports_tool without a
    # real sports_intent would break ``prepare_sports_streaming``. For
    # sports.* planner intents we leave the deterministic route in
    # place and rely on the planner's normalized_query going to the web
    # search path instead.
    det_route = str(classification.get("route") or "")
    if det_route == "uncertain" and intent_type in _INTENT_TO_ROUTE:
        target_route = _INTENT_TO_ROUTE[intent_type]
        if target_route == "sports_tool":
            # Plan says sports but deterministic sports normalizer didn't
            # populate sports_intent — fall through to web.search so the
            # planner's targeted query still reaches Serper, just via the
            # web endpoint rather than the sports handler.
            target_route = "general_web_search_tool"
        classification["route"] = target_route
        classification["confidence"] = max(
            float(classification.get("confidence") or 0.0), plan_conf
        )
        classification["reason"] = (
            classification.get("reason") or ""
        ) + f"|search_planner_intent_{intent_type}"

    # News topic: stamp news_pre_normalized=True so the news.latest
    # downstream slot finalizer trusts the planner's merged query and
    # skips the deictic-rebuild branch that would otherwise discard it.
    if (
        str(classification.get("route") or "") == "news_search_tool"
        and intent_type == "news.topic"
        and not classification.get("news_pre_normalized")
    ):
        classification["news_pre_normalized"] = True

    classification["search_planner_applied"] = True
    return classification


# --------------------------------------------------------------------------
# Diagnostics
# --------------------------------------------------------------------------

def log_search_planner_decision(
    *,
    session_id: str = "",
    raw_user_text: str = "",
    search_planner_considered: bool = False,
    search_planner_called: bool = False,
    search_planner_skipped_reason: str = "",
    deterministic_confidence: float = 0.0,
    deterministic_route: str = "",
    search_planner_latency_ms: int | None = None,
    search_planner_intent_type: str = "",
    search_planner_normalized_queries: list[str] | None = None,
    search_planner_answer_policy: str = "",
    deterministic_fallback_used: bool = False,
    final_search_queries: list[str] | None = None,
    final_result_kind: str = "",
    answer_confidence: str = "",
) -> None:
    """Emit a structured ``[search_planner_trace]`` line.

    Always called once per ``classify_info_tool`` invocation that opted
    into search planning (whether the planner ran, was skipped, or
    parsed). The line carries the full diagnostic shape from the spec so
    operators can audit the routing + planning decisions from a single
    grep target.
    """
    try:
        payload = {
            "session_id": (session_id or "")[:64],
            "raw_user_text": (raw_user_text or "")[:240],
            "search_planner_considered": bool(search_planner_considered),
            "search_planner_called": bool(search_planner_called),
            "search_planner_skipped_reason": search_planner_skipped_reason or "",
            "deterministic_confidence": float(deterministic_confidence or 0.0),
            "deterministic_route": deterministic_route or "",
            "search_planner_latency_ms": search_planner_latency_ms,
            "search_planner_intent_type": search_planner_intent_type or "",
            "search_planner_normalized_queries": list(
                search_planner_normalized_queries or []
            )[:3],
            "search_planner_answer_policy": (search_planner_answer_policy or "")[:160],
            "deterministic_fallback_used": bool(deterministic_fallback_used),
            "final_search_queries": list(final_search_queries or [])[:3],
            "final_result_kind": final_result_kind or "",
            "answer_confidence": answer_confidence or "",
            "ts": round(_time.time(), 3),
        }
        print(
            "[search_planner_trace] "
            + json.dumps(payload, ensure_ascii=False),
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[search_planner_trace_error] {exc!r}", flush=True)
