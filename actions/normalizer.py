"""actions/normalizer.py — Stage A + Stage A.5 read-only semantic normalizer.

Stage A (2026-05-31):
    Provide an observability layer that takes the EXISTING deterministic
    router outputs (multi_action_planner, classify_info_tool,
    classify_sports_intent) and adapts them into a single unified
    ``NormalizedTurn`` shape.

Stage A.5 (2026-05-31, this file):
    Add an explicit *fallback route contract* on top of Stage A. Every
    NormalizedTurn now carries an authoritative ``route_type`` field with
    one of three values:

      - ``"action"``         a supported action can be executed.
      - ``"clarification"``  a supported action was identified, but
                             required payload fields are missing. The
                             ``intent`` field always points at one of
                             ``ALLOWED_ACTION_TYPES``.
      - ``"fallback"``       no supported action should be executed.
                             ``intent`` is ``None``. ``fallback_type``
                             explains why (``unsupported_capability``,
                             ``unknown_request``, ``out_of_scope``,
                             ``low_confidence``, ``invalid_router_output``).

    Stage A.5 invariants:
      * Clarification is ONLY allowed when the target intent is in
        ``ALLOWED_ACTION_TYPES``. Anything else becomes fallback.
      * Fallback never produces executable actions (top-level ``actions``
        is ``[]``).
      * The shape never enables new executable behavior on its own — it
        only observes. The endpoint and the test suite are still the
        only consumers.

    This module MUST NOT change live behavior:
      * It is never called from ``/infer`` or ``/text`` execution paths.
      * It never executes an action, mutates session state, or short-
        circuits any existing handler.
      * It never enables the disabled LLM upgrade hook in
        ``actions.multi_action_planner`` (``ENABLE_LLM_MULTI_ACTION_PLANNER``
        stays False).
      * It does not call ``CHAT3.route_action`` (which is LLM-backed) or
        ``app.route_action_request`` (which has state-side effects and
        dispatches downstream handlers). The deterministic anchors those
        routers rely on are already covered by the planner +
        classify_info_tool, so we can build a fully deterministic shadow
        without them.

Public API:

    build_normalized_turn(text, *, session_id=None, history=None,
                          context_snapshot=None,
                          recent_news_context=None,
                          recent_sports_context=None,
                          classify_info_tool=None,
                          classify_sports_intent=None,
                          plan_user_actions=None) -> dict

        Returns the spec'd NormalizedTurn shape. Optional callables let
        callers inject test doubles; defaults are loaded lazily from
        ``app.classify_info_tool`` / ``actions.sports.classify_sports_intent``
        / ``actions.multi_action_planner.plan_user_actions``.

    ALLOWED_ACTION_TYPES         frozenset of the executable action types
                                 from the Stage A.5 spec (25 entries —
                                 22 app/info families + voice.answer +
                                 reasoning.request).

    log_normalizer_trace(...)    emit one ``[semantic_normalizer_trace]``
                                 JSON line. Public so the FastAPI endpoint
                                 in app.py can log a different ``note``
                                 field without going through
                                 ``build_normalized_turn``.

    log_router_mismatch(...)     emit one ``[legacy_router_mismatch]`` JSON
                                 line when two deterministic routers
                                 disagree on the same text.

NormalizedTurn schema (Stage A + Stage A.5):

    {
      "is_compound": bool,
      "actions": [                          # always [] for clarification + fallback
        {
          "type": str,            # member of ALLOWED_ACTION_TYPES
          "span": str,
          "payload": dict,        # router-shape; Stage A.5 does not rewrite
          "confidence": float,
          "source": "deterministic",
          "order": int,
          "required_context": list[str],
        }
      ],
      # Stage A.5 route contract:
      "route_type": "action" | "clarification" | "fallback",
      "intent": str | None,                 # supported action type for
                                            # action+clarification; None
                                            # for fallback.
      "fallback_type": str | None,          # one of FALLBACK_TYPES; None
                                            # for action+clarification.
      "missing_slots": list[str],           # non-empty only for clarification
      "message": str | None,                # voice-friendly text; only
                                            # populated for clarification
                                            # + fallback.
      "observed_type": str | None,          # the raw (rejected) action.type
                                            # when fallback_type indicates
                                            # an unknown/unsupported family
                                            # member; None otherwise.
      # Stage A backward-compat fields:
      "clarification_needed": bool,         # == (route_type == "clarification")
      "clarification_question": str | None, # == message when clarification, else None
      "context_resolution": {
        "used_previous_turn": bool,
        "resolved_entities": dict[str, str],
        "pronouns_resolved": bool,
        "inherited_from": list[str],
      },
      "route_reason": str,
      "shadow_deterministic_actions": list[dict],
      "shadow_llm_actions": list[dict],     # always [] (Stage A invariant)
    }
"""
from __future__ import annotations

import json
import time as _time
from typing import Any, Callable


# ----------------------------------------------------------------------------
# ACTION-TYPE CATALOG (Stage A.5)
#
# These are exactly the executable action types listed in the Stage A.5
# spec. Anything outside this set is *unsupported* and must route to
# ``fallback`` (see ``_decide_route``). Do not add pseudo-intents like
# ``clarification.ask`` or ``fallback.unsupported`` to this set — they are
# represented by ``route_type`` instead.
# ----------------------------------------------------------------------------
ALLOWED_ACTION_TYPES: frozenset[str] = frozenset({
    # App / UI
    "panel.navigate", "panel.open", "panel.close",
    "music.play", "music.pause", "music.resume",
    "music.next", "music.previous", "music.volume",
    "checklist.add", "checklist.remove", "checklist.complete", "checklist.uncomplete",
    "timer.set", "timer.cancel",
    # Info / tool
    "info.time", "info.weather", "info.finance",
    "info.news", "info.search",
    "info.sports", "info.product", "info.location",
    # Conversation
    "voice.answer", "reasoning.request",
})


# Family prefixes used to classify *unsupported* action types proposed by
# a router: if an unknown type begins with one of these, it sounds like
# it belongs to a known family but the specific operation does not exist
# (e.g. ``music.shuffle``, ``checklist.uncomplete``), so we treat it as
# ``unsupported_capability``. Any other prefix is ``invalid_router_output``.
_KNOWN_FAMILY_PREFIXES: tuple[str, ...] = (
    "panel.", "music.", "checklist.", "timer.", "info.",
    "reasoning.", "voice.",
)


# Allowed values of NormalizedTurn.fallback_type. Strings are stable so
# operators can grep server logs.
FALLBACK_TYPES: frozenset[str] = frozenset({
    "unsupported_capability",
    "unknown_request",
    "out_of_scope",
    "low_confidence",
    "invalid_router_output",
})


# Allowed values of NormalizedTurn.route_type.
ROUTE_TYPES: frozenset[str] = frozenset({"action", "clarification", "fallback"})


# Voice-friendly default messages. Kept generic so live UX never claims
# execution that did not happen.
_MSG_UNKNOWN_REQUEST = "I'm not sure how to help with that yet."
_MSG_UNSUPPORTED_CAPABILITY = "That isn't one of my supported actions yet."
_MSG_INVALID_ROUTER_OUTPUT = (
    "Something didn't parse on my end — could you try saying that again?"
)
_MSG_LOW_CONFIDENCE = "I'm not sure I understood — could you rephrase?"
_MSG_OUT_OF_SCOPE = "That's outside what I can do here."


# Per-intent clarification prompts. Voice-friendly and short. Keep these
# generic — the executor decides the final wording at run-time. Used only
# when the planner did not already attach a clarification_question.
_CLARIFICATION_PROMPTS: dict[str, str] = {
    "music.play":        "What would you like me to play?",
    "panel.navigate":    "Which panel should I switch to?",
    "panel.open":        "Which panel should I open?",
    "panel.close":       "Which panel should I close?",
    "info.weather":      "Which city should I check the weather for?",
    "info.time":         "Which place's time would you like?",
    "info.news":         "What topic do you want news on?",
    "info.finance":      "Which stock, fund, or asset?",
    "info.sports":       "Which team, player, or tournament?",
    "info.product":      "What product or category should I look at?",
    "info.location":     "Where should I look — what city or area?",
    "info.search":       "What would you like me to look up?",
    "timer.set":         "How long should the timer be?",
    "timer.cancel":      "Which timer should I cancel?",
    "checklist.add":     "What should I add to the checklist?",
    "checklist.remove":  "Which item should I remove?",
    "checklist.complete":"Which item should I mark complete?",
    "checklist.uncomplete":"Which item should I mark incomplete?",
    "reasoning.request": "What would you like me to think through?",
    "voice.answer":      "Could you say a bit more?",
}


# Confidence floor below which a non-conversational action degrades to
# ``fallback(low_confidence)``. ``voice.answer`` (the planner's
# conversational fall-through) is exempt — the spec explicitly says to
# preserve that path.
_LOW_CONFIDENCE_THRESHOLD: float = 0.30


# ----------------------------------------------------------------------------
# classify_info_tool route -> NormalizedAction.type mapping
#
# Stage A.5 note: ``clarification_needed`` is NOT mapped to an action type.
# The route-decision pass converts it to ``route_type="clarification"``
# (or ``"fallback"`` when the target intent can't be inferred) — see
# ``_info_tool_clarification_target`` and ``_decide_route``.
# ----------------------------------------------------------------------------
_INFO_ROUTE_TO_TYPE: dict[str, str] = {
    "time_tool": "info.time",
    "weather_tool": "info.weather",
    "finance_quote_tool": "info.finance",
    "finance_search_tool": "info.finance",
    "news_search_tool": "info.news",
    "sports_tool": "info.sports",
    # general_web_search_tool is split into product / location / search by
    # the secondary signals in the classification (see
    # ``_info_tool_general_web_subtype``); handled separately.
}


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def _empty_turn(*, route_reason: str, fallback_type: str = "unknown_request",
                message: str | None = None) -> dict:
    """A NormalizedTurn with no executable actions and ``route_type="fallback"``.

    Used for empty input and for any path that bails out before the
    deterministic routers can fire.
    """
    return {
        "is_compound": False,
        "actions": [],
        "route_type": "fallback",
        "intent": None,
        "fallback_type": fallback_type,
        "missing_slots": [],
        "message": message,
        "observed_type": None,
        "clarification_needed": False,
        "clarification_question": None,
        "context_resolution": _empty_context_resolution(),
        "route_reason": route_reason,
        "shadow_deterministic_actions": [],
        "shadow_llm_actions": [],
    }


def _empty_context_resolution() -> dict:
    return {
        "used_previous_turn": False,
        "resolved_entities": {},
        "pronouns_resolved": False,
        "inherited_from": [],
    }


def _adapt_planner_action(
    action: dict, *, fallback_order: int
) -> dict | None:
    """Take one planner action dict and return a NormalizedAction dict.

    The planner already emits ``{"type", "span", "payload", "order",
    "confidence"}`` for every action — we just attach the Stage A fields
    (``source="deterministic"`` and an empty ``required_context``) and
    drop the action when its type isn't allowlisted.
    """
    if not isinstance(action, dict):
        return None
    atype = str(action.get("type") or "").strip()
    if atype not in ALLOWED_ACTION_TYPES:
        return None
    return {
        "type": atype,
        "span": str(action.get("span") or "").strip(),
        "payload": dict(action.get("payload") or {}),
        "confidence": float(action.get("confidence") or 0.0),
        "source": "deterministic",
        "order": int(action.get("order") or fallback_order),
        "required_context": [],
    }


def _info_tool_general_web_subtype(classification: dict) -> str:
    """Map ``general_web_search_tool`` -> info.product / info.location /
    info.search by inspecting the secondary signals the deterministic
    cascade attached. We never override; this is a read-only inspection.
    """
    if not isinstance(classification, dict):
        return "info.search"
    tool = str(classification.get("tool") or "").lower()
    if "product" in tool or "shopping" in tool:
        return "info.product"
    if "place" in tool or "location" in tool or "map" in tool:
        return "info.location"
    # The pre-news info normalizer sometimes attaches ``product_intent``
    # straight on the classification dict (when intent_type=="product").
    if classification.get("product_intent"):
        return "info.product"
    # ``normalize_info_request`` result echoed back on the dict.
    inner = classification.get("normalize_info_request_result")
    if isinstance(inner, dict):
        it = str(inner.get("intent_type") or "").lower()
        if it == "product":
            return "info.product"
        if it == "location":
            return "info.location"
    return "info.search"


def _build_info_tool_action(text: str, classification: dict) -> dict | None:
    """Adapt a ``classify_info_tool`` classification dict into a single
    NormalizedAction. Returns ``None`` for any route that does not map
    to a directly-executable action (``uncertain`` / ``llm_only`` /
    ``followup_llm`` / ``followup_search`` / ``clarification_needed`` /
    ``sports_clarification_needed``). The Stage A.5 route-decision pass
    handles the clarification routes — this function only builds the
    *executable* candidate.
    """
    if not isinstance(classification, dict):
        return None
    route = str(classification.get("route") or "")
    if route in (
        "", "uncertain", "llm_only", "followup_llm", "followup_search",
        "clarification_needed", "sports_clarification_needed",
    ):
        return None

    atype = _INFO_ROUTE_TO_TYPE.get(route)
    if atype is None and route == "general_web_search_tool":
        atype = _info_tool_general_web_subtype(classification)
    if atype is None:
        return None

    confidence = float(classification.get("confidence") or 0.0)
    classifier_query = str(classification.get("query") or "").strip()
    normalized_query = str(classification.get("normalized_query") or "").strip()
    raw = (text or "").strip()
    effective_query = normalized_query or classifier_query or raw

    payload: dict[str, Any] = {}
    if atype == "info.time":
        # The classifier stores the resolved location in ``query`` when
        # different from raw; otherwise leaves ``query`` == raw.
        loc = classifier_query if classifier_query and classifier_query != raw else None
        payload = {"location": loc}
    elif atype == "info.weather":
        loc = classifier_query if classifier_query and classifier_query != raw else None
        payload = {"location": loc, "date": None}
    elif atype == "info.finance":
        payload = {
            "symbol_or_asset": classifier_query or raw,
            "kind": "quote" if route == "finance_quote_tool" else "analytics",
        }
    elif atype == "info.news":
        payload = {
            "query": effective_query,
            "freshness_required": True,
            "topic_chain": list(classification.get("entities") or []),
        }
    elif atype == "info.sports":
        # Minimal placeholder — the sports enricher fills the rest.
        payload = {
            "entity": "",
            "query_type": "",
            "normalized_queries": [],
        }
    elif atype == "info.product":
        payload = {
            "query": effective_query,
            "constraints": {
                "budget": classification.get("product_budget"),
                "use_case": classification.get("product_use_case"),
                "category": classification.get("product_category"),
            },
        }
    elif atype == "info.location":
        payload = {
            "query": effective_query,
            "location": classification.get("location"),
            "category": classification.get("product_category"),
        }
    elif atype == "info.search":
        payload = {
            "query": effective_query,
            "freshness_required": False,
        }

    return {
        "type": atype,
        "span": raw,
        "payload": payload,
        "confidence": confidence,
        "source": "deterministic",
        "order": 1,
        "required_context": list(classification.get("required_context") or []),
        # Stage A.5: lets ``_validate_turn`` apply spec-shape payload
        # checks to adapter-built actions only (skipping planner actions
        # whose payloads use a different field vocabulary).
        "_built_by": "info_tool_adapter",
    }


def _enrich_sports_payload(action: dict, sports_intent: dict, text: str) -> dict:
    """When the primary action is ``info.sports``, fill its payload from
    ``actions.sports.classify_sports_intent`` output. Idempotent.
    """
    if action.get("type") != "info.sports":
        return action
    if not isinstance(sports_intent, dict):
        return action
    payload = action.setdefault("payload", {})
    entity = str(
        sports_intent.get("normalized_entity")
        or sports_intent.get("entity")
        or ""
    ).strip()
    if entity:
        payload["entity"] = entity
    for src_key, dest_key in (
        ("opponent", "opponent"),
        ("tournament_or_league", "tournament_or_league"),
        ("season_or_year", "season_or_year"),
        ("query_type", "query_type"),
        ("sport", "sport"),
        ("entity_type", "entity_type"),
    ):
        v = sports_intent.get(src_key)
        if v:
            payload[dest_key] = v
    # Preserve the planner's existing normalized_queries when present;
    # otherwise leave the slot empty so a future stage can fill it.
    payload.setdefault("normalized_queries", [])
    # Bump confidence to the higher of planner / classifier — sports
    # classifier is generally more confident than the planner's anchor.
    action["confidence"] = max(
        float(action.get("confidence") or 0.0),
        float(sports_intent.get("confidence") or 0.0),
    )
    return action


def _classify_compound(plan: dict | None, primary_actions: list[dict]) -> bool:
    """Compound iff the planner says so AND we kept ≥2 actions."""
    if not isinstance(plan, dict):
        return False
    if not plan.get("is_multi_action"):
        return False
    return len(primary_actions) >= 2


def _detect_router_mismatch(
    *, plan_actions: list[dict], info_action: dict | None, sports_intent: dict | None
) -> dict:
    """Compare action types from each router; return a summary.

    Two routers "agree" if their action-type sets overlap. Mismatch
    cases we surface:

      1. Planner anchored ≥1 action, info_tool also classified a route,
         but the info_tool type is NOT in the planner output. (e.g.
         planner says ``[music.play]``, info_tool says ``info.search``.)

      2. Sports classifier marked the text as sports but the info_tool
         picked something other than ``info.sports``.

    We deliberately do NOT flag ``planner=[voice.answer] vs info_tool=...``
    — planner's voice.answer is the explicit fall-through and the
    info_tool route is the expected resolution.
    """
    planner_types = [a.get("type") for a in plan_actions if a]
    planner_set = set(planner_types) - {"voice.answer"}
    info_type = info_action.get("type") if info_action else None
    sports_is_sports = bool(
        isinstance(sports_intent, dict) and sports_intent.get("is_sports")
    )
    reasons: list[str] = []
    mismatch = False

    if planner_set and info_type and info_type != "clarification.ask":
        if info_type not in planner_set:
            mismatch = True
            reasons.append(
                "planner=" + ",".join(sorted(planner_set))
                + " vs info_tool=" + info_type
            )

    if sports_is_sports and info_type and info_type != "info.sports":
        mismatch = True
        reasons.append("sports_classifier=info.sports vs info_tool=" + info_type)

    return {
        "mismatch": mismatch,
        "reasons": reasons,
        "planner_types": planner_types,
        "info_tool_type": info_type,
        "sports_is_sports": sports_is_sports,
    }


def _validate_turn(turn: dict) -> list[str]:
    """Stage A.5 schema validator — observability only.

    Returns a list of short grep-friendly error codes. Stage A.5 does
    NOT use these errors to drive ``route_type``; the authoritative
    missing-slot signal comes from the planner's own ``validate_plan``
    (see ``_decide_route``). This validator only:

      1. Flags ``unsupported_action:<type>`` if the chosen action type
         is not in ``ALLOWED_ACTION_TYPES``. The decision pass would have
         already converted that into a fallback, so this is defensive.
      2. Records observability-level mismatches between *spec-shape*
         payloads (the ones built by ``_build_info_tool_action``) and
         the field names downstream consumers expect (``query`` /
         ``symbol_or_asset`` / etc.). Planner-shaped payloads pass
         through verbatim and are NOT validated here — Stage C will
         introduce per-family schema adapters.
    """
    errors: list[str] = []
    info_tool_built_types = {
        # These are the only types ``_build_info_tool_action`` emits with
        # spec-shape payloads. For anything else (planner-built actions),
        # we skip payload validation so we don't false-positive against
        # the planner's own ``{"query": ...}`` / ``{"target": ...}`` etc.
        "info.time", "info.weather", "info.finance", "info.news",
        "info.search", "info.product", "info.location",
    }
    for a in turn.get("actions") or []:
        atype = a.get("type")
        if atype not in ALLOWED_ACTION_TYPES:
            errors.append(f"unsupported_action:{atype}")
            continue
        if float(a.get("confidence") or 0.0) < 0:
            errors.append(f"negative_confidence:{atype}")
        # Source-aware payload checks: only validate when the payload
        # was authored by our own adapter (spec shape).
        if a.get("_built_by") != "info_tool_adapter":
            continue
        if atype not in info_tool_built_types:
            continue
        payload = a.get("payload") or {}
        if atype in ("info.news", "info.search", "info.product", "info.location"):
            if not str(payload.get("query") or "").strip():
                errors.append(f"empty_query:{atype}")
        if atype == "info.finance":
            if not str(payload.get("symbol_or_asset") or "").strip():
                errors.append("empty_symbol:info.finance")
    return errors


# ----------------------------------------------------------------------------
# Stage A.5 — route decision
# ----------------------------------------------------------------------------
def _classify_unknown_type(unknown_type: str) -> str:
    """Map a router-proposed action type that is NOT in
    ``ALLOWED_ACTION_TYPES`` to a ``fallback_type``:

      * known family prefix (e.g. ``music.shuffle``) ->
        ``"unsupported_capability"``
      * everything else (e.g. ``email.send``) -> ``"invalid_router_output"``
    """
    if not unknown_type:
        return "invalid_router_output"
    for prefix in _KNOWN_FAMILY_PREFIXES:
        if unknown_type.startswith(prefix):
            return "unsupported_capability"
    return "invalid_router_output"


def _missing_slots_from_validate_errors(errors: list[str]) -> list[str]:
    """Parse ``validate_plan`` error strings of shape
    ``action_{i}_{family}_missing_{key}`` and return the unique slot
    names in first-seen order. Also handles the
    ``..._missing_direction_or_level`` special case used by
    ``music.volume``.
    """
    slots: list[str] = []
    seen: set[str] = set()
    for e in errors or []:
        if e.endswith("_missing_direction_or_level"):
            for k in ("direction", "level"):
                if k not in seen:
                    seen.add(k)
                    slots.append(k)
            continue
        if "_missing_" not in e:
            continue
        _, _, key = e.rpartition("_missing_")
        key = key.strip()
        if key and key not in seen:
            seen.add(key)
            slots.append(key)
    return slots


def _clarification_message_for(
    target: str, missing_slots: list[str], *, planner_hint: str | None = None
) -> str:
    """Pick a voice-friendly clarification message. The planner's own
    ``clarification_question`` (when supplied) always wins.
    """
    if planner_hint:
        return planner_hint
    return _CLARIFICATION_PROMPTS.get(target, _MSG_UNKNOWN_REQUEST)


def _info_tool_clarification_target(
    classification: dict,
) -> tuple[str | None, list[str]]:
    """Map a ``classify_info_tool`` clarification_needed result to
    ``(target_action_type, missing_slots)``.

    Today the only clarification path returns
    ``required_context=["location"]`` (the "near me" venue query without
    a known location), which we treat as ``info.location``. Anything
    that can't be confidently mapped returns ``(None, [])`` and the
    caller routes the turn to ``fallback(unknown_request)``.
    """
    if not isinstance(classification, dict):
        return None, []
    required = list(classification.get("required_context") or [])
    if not required:
        return None, []
    if "location" in required:
        return "info.location", required
    return None, []


def _decide_route(
    *,
    primary_actions: list[dict],
    plan: dict | None,
    info_classification: dict | None,
    sports_intent: dict | None,
    unsupported_router_types: list[str],
    validate_plan_fn,
) -> dict:
    """Return the Stage A.5 route decision.

    Output dict keys: ``route_type``, ``fallback_type``, ``intent``,
    ``missing_slots``, ``message``, ``observed_type``, ``why``. ``why``
    is a short tag for the trace ("planner_unknown_type",
    "info_tool_clarification", "validate_plan_missing", etc.).

    Pure — no logging, no I/O, no router calls.
    """
    # === 1) Any router proposed an unsupported action type. =================
    if unsupported_router_types:
        unknown = unsupported_router_types[0]
        fb = _classify_unknown_type(unknown)
        return {
            "route_type": "fallback",
            "fallback_type": fb,
            "intent": None,
            "missing_slots": [],
            "message": (
                _MSG_UNSUPPORTED_CAPABILITY
                if fb == "unsupported_capability"
                else _MSG_INVALID_ROUTER_OUTPUT
            ),
            "observed_type": unknown,
            "why": "router_proposed_unknown_action_type",
        }

    # === 2) No primary action at all. ======================================
    if not primary_actions:
        # info-tool clarification path — only honor when we can name a
        # supported target intent.
        if (
            isinstance(info_classification, dict)
            and info_classification.get("route") == "clarification_needed"
        ):
            target, missing = _info_tool_clarification_target(info_classification)
            if target and target in ALLOWED_ACTION_TYPES:
                return {
                    "route_type": "clarification",
                    "fallback_type": None,
                    "intent": target,
                    "missing_slots": missing,
                    "message": _clarification_message_for(target, missing),
                    "observed_type": None,
                    "why": "info_tool_clarification_with_target",
                }
        # planner ambiguity — no clear target intent.
        if isinstance(plan, dict) and plan.get("clarification_needed"):
            return {
                "route_type": "fallback",
                "fallback_type": "unknown_request",
                "intent": None,
                "missing_slots": [],
                "message": str(plan.get("clarification_question") or _MSG_UNKNOWN_REQUEST),
                "observed_type": None,
                "why": "planner_clarification_without_target",
            }
        return {
            "route_type": "fallback",
            "fallback_type": "unknown_request",
            "intent": None,
            "missing_slots": [],
            "message": _MSG_UNKNOWN_REQUEST,
            "observed_type": None,
            "why": "no_router_produced_action",
        }

    # === 3) Authoritative missing-slot signal from validate_plan. ==========
    # We trust the planner's own per-family payload-key requirements
    # (``_ACTION_PAYLOAD_KEYS`` in actions/multi_action_planner.py) so
    # the clarification path catches *real* missing slots and never
    # false-positives on adapter-shape mismatches.
    if validate_plan_fn is not None and isinstance(plan, dict):
        try:
            ok, errors, planner_q = validate_plan_fn(plan)
        except Exception:
            ok, errors, planner_q = True, [], None
        if not ok and errors:
            missing_only = [e for e in errors if "_missing_" in e]
            if missing_only:
                target = primary_actions[0].get("type")
                if target in ALLOWED_ACTION_TYPES:
                    missing_slots = _missing_slots_from_validate_errors(missing_only)
                    return {
                        "route_type": "clarification",
                        "fallback_type": None,
                        "intent": target,
                        "missing_slots": missing_slots,
                        "message": _clarification_message_for(
                            target, missing_slots, planner_hint=planner_q
                        ),
                        "observed_type": None,
                        "why": "validate_plan_missing_required_payload",
                    }

    # === 4) Low-confidence guard (exempts the conversational fallback). ===
    primary = primary_actions[0]
    primary_type = primary.get("type") or ""
    primary_conf = float(primary.get("confidence") or 0.0)
    if primary_type != "voice.answer" and primary_conf < _LOW_CONFIDENCE_THRESHOLD:
        return {
            "route_type": "fallback",
            "fallback_type": "low_confidence",
            "intent": None,
            "missing_slots": [],
            "message": _MSG_LOW_CONFIDENCE,
            "observed_type": primary_type or None,
            "why": "primary_action_confidence_below_threshold",
        }

    # === 5) Action route. =================================================
    intent = primary_actions[0].get("type") or None
    return {
        "route_type": "action",
        "fallback_type": None,
        "intent": intent,
        "missing_slots": [],
        "message": None,
        "observed_type": None,
        "why": "primary_action_validated",
    }


# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------
def log_normalizer_trace(
    *,
    text: str,
    turn: dict,
    session_id: str | None = None,
    validation_errors: list[str] | None = None,
    disagreement: dict | None = None,
    note: str = "",
) -> None:
    """Emit one ``[semantic_normalizer_trace]`` JSON line.

    Fields match the Stage A spec verbatim so an operator can grep on
    them. Never raises.
    """
    try:
        actions = turn.get("actions") or []
        final_types = [a.get("type") for a in actions]
        final_ops: list[str] = []
        for a in actions:
            atype = a.get("type") or ""
            payload = a.get("payload") or {}
            if atype == "music.volume":
                direction = payload.get("direction")
                if direction:
                    final_ops.append(f"{atype}.direction={direction}")
            elif atype == "info.finance":
                kind = payload.get("kind")
                if kind:
                    final_ops.append(f"{atype}.kind={kind}")
            elif atype == "info.news":
                final_ops.append(
                    f"{atype}.freshness_required={bool(payload.get('freshness_required'))}"
                )
            elif atype == "music.play":
                pk = payload.get("play_kind") or payload.get("music_intent", {}).get("play_kind")
                if pk:
                    final_ops.append(f"{atype}.play_kind={pk}")
            elif atype == "timer.set":
                if "duration_seconds" in payload:
                    final_ops.append(f"{atype}.duration_seconds={payload['duration_seconds']}")
        payload_log = {
            "transcript": (text or "")[:400],
            "session_id": (session_id or "")[:32],
            "normalized_actions": final_types,
            "deterministic_actions": final_types,
            "validation_errors": list(validation_errors or []),
            "clarification_needed": bool(turn.get("clarification_needed")),
            "context_entities": (turn.get("context_resolution") or {}).get(
                "resolved_entities"
            ) or {},
            "route_decision": turn.get("route_reason") or "",
            "legacy_router_bypassed": False,
            "final_action_types": final_types,
            "final_payload_ops": final_ops,
            "is_compound": bool(turn.get("is_compound")),
            "router_mismatch": bool(disagreement and disagreement.get("mismatch")),
            # Stage A.5 route contract fields (always present):
            "route_type": turn.get("route_type"),
            "intent": turn.get("intent"),
            "fallback_type": turn.get("fallback_type"),
            "missing_slots": list(turn.get("missing_slots") or []),
            "observed_type": turn.get("observed_type"),
            "message_present": bool(turn.get("message")),
            "note": note,
            "ts": _time.time(),
        }
        print(
            "[semantic_normalizer_trace] "
            + json.dumps(payload_log, ensure_ascii=False),
            flush=True,
        )
    except Exception:
        pass


def log_router_mismatch(
    *, text: str, disagreement: dict, session_id: str | None = None
) -> None:
    """Emit one ``[legacy_router_mismatch]`` JSON line. Never raises."""
    try:
        payload = {
            "transcript": (text or "")[:400],
            "session_id": (session_id or "")[:32],
            "planner_types": disagreement.get("planner_types") or [],
            "info_tool_type": disagreement.get("info_tool_type"),
            "sports_is_sports": bool(disagreement.get("sports_is_sports")),
            "reasons": disagreement.get("reasons") or [],
            "ts": _time.time(),
        }
        print(
            "[legacy_router_mismatch] " + json.dumps(payload, ensure_ascii=False),
            flush=True,
        )
    except Exception:
        pass


# ----------------------------------------------------------------------------
# Lazy default loaders
# ----------------------------------------------------------------------------
def _default_plan_user_actions() -> Callable | None:
    try:
        from actions.multi_action_planner import plan_user_actions
        return plan_user_actions
    except Exception:
        return None


def _default_classify_sports_intent() -> Callable | None:
    try:
        from actions.sports import classify_sports_intent
        return classify_sports_intent
    except Exception:
        return None


def _default_classify_info_tool() -> Callable | None:
    # Importing app is heavy (loads ML models in non-stub environments);
    # callers that don't want that — i.e. smoke tests — should inject
    # their own callable. The FastAPI endpoint in app.py wires it from
    # inside the module so no circular import happens.
    try:
        import app as _app
        return getattr(_app, "classify_info_tool", None)
    except Exception:
        return None


# ----------------------------------------------------------------------------
# Public entry point
# ----------------------------------------------------------------------------
def build_normalized_turn(
    text: str,
    *,
    session_id: str | None = None,
    history: list[dict] | None = None,
    context_snapshot: dict | None = None,
    recent_news_context: dict | None = None,
    recent_sports_context: dict | None = None,
    classify_info_tool: Callable | None = None,
    classify_sports_intent: Callable | None = None,
    plan_user_actions: Callable | None = None,
    note: str = "",
    emit_logs: bool = True,
) -> dict:
    """Stage A read-only normalizer.

    Calls the deterministic planner + classifiers and adapts their
    outputs into the proposed NormalizedTurn shape. Logs disagreements
    between routers via ``[legacy_router_mismatch]``. Never executes,
    mutates session state, or alters the live routing pipeline.

    Parameters that accept callables are injected so smoke tests can
    avoid heavy app imports. Defaults are loaded lazily.
    """
    raw = (text or "").strip()
    if not raw:
        turn = _empty_turn(route_reason="empty_text")
        if emit_logs:
            log_normalizer_trace(text=text, turn=turn, session_id=session_id, note=note)
        return turn

    # ---- 1) deterministic planner -----------------------------------------
    plan_fn = plan_user_actions or _default_plan_user_actions()
    plan: dict | None = None
    if plan_fn is not None:
        try:
            plan = plan_fn(raw, vera=None)
        except Exception as exc:
            print(f"[normalizer_planner_error] {exc!r}", flush=True)
            plan = None

    plan_actions: list[dict] = []
    # Stage A.5 — collect any action.type the planner proposed that is
    # NOT in ``ALLOWED_ACTION_TYPES``. ``_decide_route`` uses this list
    # to convert the turn to ``fallback(unsupported_capability)`` or
    # ``fallback(invalid_router_output)`` instead of silently dropping
    # the action.
    unsupported_router_types: list[str] = []
    if isinstance(plan, dict):
        for i, a in enumerate(plan.get("actions") or []):
            if isinstance(a, dict):
                proposed_type = str(a.get("type") or "").strip()
                if proposed_type and proposed_type not in ALLOWED_ACTION_TYPES:
                    unsupported_router_types.append(proposed_type)
            adapted = _adapt_planner_action(a, fallback_order=i + 1)
            if adapted is not None:
                plan_actions.append(adapted)

    # The planner's _single_action_fallback returns one
    # ``voice.answer`` action spanning the full text with confidence 0.5.
    # We track this so the chooser knows to defer to ``classify_info_tool``
    # when its route is more specific than ``voice.answer``.
    planner_is_fallback_only = (
        len(plan_actions) == 1
        and plan_actions[0]["type"] == "voice.answer"
        and abs(plan_actions[0]["confidence"] - 0.5) < 1e-6
        and plan_actions[0]["span"].strip().lower() == raw.lower()
    )

    # ---- 2) info-tool classifier ------------------------------------------
    info_fn = classify_info_tool or _default_classify_info_tool()
    info_classification: dict | None = None
    info_action: dict | None = None
    if info_fn is not None:
        try:
            info_classification = info_fn(
                raw,
                recent_news_context=recent_news_context,
                recent_sports_context=recent_sports_context,
                session_id=(session_id or ""),
                location_available=False,
            )
            info_action = _build_info_tool_action(raw, info_classification)
        except Exception as exc:
            print(f"[normalizer_info_tool_error] {exc!r}", flush=True)
            info_classification = None
            info_action = None

    # ---- 3) sports enricher (only when something thinks it's sports) ------
    needs_sports_enrich = (
        any(a.get("type") == "info.sports" for a in plan_actions)
        or (info_action is not None and info_action.get("type") == "info.sports")
    )
    sports_intent: dict | None = None
    if needs_sports_enrich:
        sports_fn = classify_sports_intent or _default_classify_sports_intent()
        if sports_fn is not None:
            try:
                sports_intent = sports_fn(
                    raw,
                    recent_sports_context=recent_sports_context,
                )
            except Exception as exc:
                print(f"[normalizer_sports_error] {exc!r}", flush=True)
                sports_intent = None

    # ---- 4) Choose primary source ----------------------------------------
    primary_actions: list[dict] = []
    chosen_source: str
    if plan_actions and not planner_is_fallback_only:
        primary_actions = plan_actions
        chosen_source = "multi_action_planner"
    elif info_action is not None:
        primary_actions = [info_action]
        chosen_source = "classify_info_tool"
    elif plan_actions:
        # Only the planner's voice.answer fallback exists.
        primary_actions = plan_actions
        chosen_source = "multi_action_planner_fallback"
    else:
        chosen_source = "no_action_detected"

    if sports_intent is not None:
        for a in primary_actions:
            _enrich_sports_payload(a, sports_intent, raw)

    # ---- 5) Stage A.5 route decision -------------------------------------
    # Late binding so callers can inject a stub ``validate_plan`` if they
    # really want to (default: the planner's own one).
    try:
        from actions.multi_action_planner import validate_plan as _validate_plan
    except Exception:
        _validate_plan = None

    decision = _decide_route(
        primary_actions=primary_actions,
        plan=plan,
        info_classification=info_classification,
        sports_intent=sports_intent,
        unsupported_router_types=unsupported_router_types,
        validate_plan_fn=_validate_plan,
    )

    route_type = decision["route_type"]
    # Stage A.5 invariant: clarification and fallback turns never carry
    # executable actions. ``shadow_deterministic_actions`` still holds
    # everything for observability.
    if route_type == "action":
        emitted_actions = primary_actions
    else:
        emitted_actions = []

    clarification_needed = (route_type == "clarification")
    clarification_question = decision["message"] if clarification_needed else None

    # If the sports classifier marked needs_clarification AND we still
    # ended up as ``action`` (because the planner anchored info.sports),
    # we leave it alone — the executor handles the partial info. The
    # signal is preserved via shadow_deterministic_actions for ops.

    # ---- 6) context resolution -------------------------------------------
    cr = _empty_context_resolution()
    if isinstance(sports_intent, dict) and sports_intent.get("followup_used"):
        cr["used_previous_turn"] = True
        cr["pronouns_resolved"] = True
        cr["inherited_from"].append("recent_sports_context")
        if sports_intent.get("entity"):
            cr["resolved_entities"]["sports_entity"] = str(sports_intent["entity"])
        if sports_intent.get("tournament_or_league"):
            cr["resolved_entities"]["sports_tournament_or_league"] = str(
                sports_intent["tournament_or_league"]
            )
    if isinstance(info_classification, dict) and info_classification.get("context_used"):
        cr["used_previous_turn"] = True
        if "recent_news_context" not in cr["inherited_from"]:
            cr["inherited_from"].append("recent_news_context")
    cr["inherited_from"] = sorted(set(cr["inherited_from"]))

    # ---- 7) build NormalizedTurn -----------------------------------------
    # Compound status: only meaningful when the route is "action" AND we
    # kept ≥2 emitted actions. Clarification/fallback are never compound.
    is_compound = (
        route_type == "action" and _classify_compound(plan, emitted_actions)
    )
    route_reason_parts: list[str] = [chosen_source, f"route_type={route_type}"]
    if decision.get("fallback_type"):
        route_reason_parts.append("fallback_type=" + str(decision["fallback_type"]))
    if decision.get("why"):
        route_reason_parts.append("decision=" + str(decision["why"]))
    if isinstance(plan, dict) and plan.get("reason"):
        route_reason_parts.append("planner_reason=" + str(plan["reason"]))
    if isinstance(info_classification, dict) and info_classification.get("reason"):
        route_reason_parts.append("info_reason=" + str(info_classification["reason"]))
    if isinstance(sports_intent, dict) and sports_intent.get("reason"):
        route_reason_parts.append("sports_reason=" + str(sports_intent["reason"]))
    route_reason = "|".join(route_reason_parts)

    shadow: list[dict] = []
    for a in plan_actions:
        shadow.append({**a, "_shadow_source": "planner"})
    if info_action is not None:
        shadow.append({**info_action, "_shadow_source": "info_tool"})

    turn = {
        "is_compound": is_compound,
        "actions": emitted_actions,
        # Stage A.5 route contract:
        "route_type": route_type,
        "intent": decision["intent"],
        "fallback_type": decision["fallback_type"],
        "missing_slots": list(decision.get("missing_slots") or []),
        "message": decision["message"],
        "observed_type": decision["observed_type"],
        # Stage A backward-compat:
        "clarification_needed": clarification_needed,
        "clarification_question": clarification_question,
        "context_resolution": cr,
        "route_reason": route_reason,
        "shadow_deterministic_actions": shadow,
        "shadow_llm_actions": [],
    }

    # ---- 8) detect disagreement + log ------------------------------------
    disagreement = _detect_router_mismatch(
        plan_actions=plan_actions,
        info_action=info_action,
        sports_intent=sports_intent,
    )
    validation_errors = _validate_turn(turn)

    if emit_logs:
        log_normalizer_trace(
            text=raw,
            turn=turn,
            session_id=session_id,
            validation_errors=validation_errors,
            disagreement=disagreement,
            note=note,
        )
        if disagreement.get("mismatch"):
            log_router_mismatch(
                text=raw, disagreement=disagreement, session_id=session_id
            )

    return turn
