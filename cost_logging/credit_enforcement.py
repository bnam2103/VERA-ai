"""Production credit cap enforcement (extends measurement-only credits.py)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from fastapi import HTTPException

from .credits import compute_credits
from .no_cap_testing import is_no_cap_active

ANON_DAILY_CAP = 100
SIGNED_IN_DAILY_CAP = 200

FEATURE_WORK_MODE = "work_mode"
FEATURE_SEARCH = "search"
FEATURE_IMAGE_PDF = "image_pdf"

ANON_CAP_MESSAGE = (
    "You've reached today's free Vera usage limit. Sign in or try again tomorrow."
)
SIGNED_IN_CAP_MESSAGE = "You've reached today's Vera usage limit. Try again tomorrow."

_ROUTE_TO_CREDIT_ACTION: dict[str, str] = {
    "weather": "weather",
    "weather.current": "weather",
    "weather.followup": "weather",
    "news": "search_or_news",
    "news.latest": "search_or_news",
    "finance": "search_or_news",
    "finance.quote": "search_or_news",
    "finance.context": "search_or_news",
    "finance.analytics": "search_or_news",
    "web_search": "search_or_news",
    "web.search": "search_or_news",
    "sports": "search_or_news",
    "voice_assistant": "voice_assistant",
    "simple_llm": "simple_llm",
    "work_mode_reasoning": "work_mode_reasoning",
    "work_mode_reasoning_deep": "work_mode_reasoning_deep",
    "work_mode_voice_summary": "work_mode_voice_summary",
    "image_pdf_reasoning": "image_pdf_reasoning",
    "local_action": "local_action",
    "failed_request": "failed_request",
}

_ACTION_FEATURE: dict[str, str] = {
    "work_mode_reasoning": FEATURE_WORK_MODE,
    "work_mode_reasoning_deep": FEATURE_WORK_MODE,
    "work_mode_voice_summary": FEATURE_WORK_MODE,
    "search_or_news": FEATURE_SEARCH,
    "image_pdf_reasoning": FEATURE_IMAGE_PDF,
}

_ACTION_COUNTERS: dict[str, dict[str, int]] = {
    "search_or_news": {"search_turns": 1},
    "work_mode_reasoning": {"reasoning_streams": 1},
    "work_mode_reasoning_deep": {"reasoning_streams": 1},
    "voice_assistant": {"voice_turns": 1},
    "simple_llm": {"voice_turns": 1},
    "image_pdf_reasoning": {"image_pdf_reasoning_turns": 1},
}

_MEMORY_STORE: dict[tuple[str | None, str | None, str], dict[str, Any]] = {}
_USE_MEMORY_STORE = False


def enable_test_memory_store() -> None:
    global _USE_MEMORY_STORE
    _USE_MEMORY_STORE = True
    _MEMORY_STORE.clear()


def reset_test_memory_store() -> None:
    _MEMORY_STORE.clear()


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _principal(user_id: str | None, session_id: str | None) -> tuple[str | None, str | None]:
    uid = (user_id or "").strip() or None
    sid = (session_id or "").strip() or None
    if uid:
        return uid, None
    return None, sid


def _store_key(user_id: str | None, session_id: str | None, usage_date: date) -> tuple:
    uid, sid = _principal(user_id, session_id)
    return (uid, sid, usage_date.isoformat())


def _empty_daily() -> dict[str, Any]:
    return {
        "credits_used": 0,
        "bonus_credits": 0,
        "openai_input_tokens": 0,
        "openai_output_tokens": 0,
        "openai_reasoning_tokens": 0,
        "serper_calls": 0,
        "weather_calls": 0,
        "reasoning_streams": 0,
        "voice_turns": 0,
        "search_turns": 0,
        "image_pdf_reasoning_turns": 0,
    }


def _credits_enabled() -> bool:
    if _USE_MEMORY_STORE:
        return True
    try:
        from auth.credit_usage_db import credit_db_available

        return credit_db_available()
    except Exception:
        return False


def get_daily_credit_usage(
    user_id: str | None,
    session_id: str | None,
    *,
    usage_date: date | None = None,
) -> dict[str, Any]:
    day = usage_date or _today_utc()
    if _USE_MEMORY_STORE:
        row = _MEMORY_STORE.get(_store_key(user_id, session_id, day))
        return dict(row) if row else _empty_daily()
    try:
        from auth.credit_usage_db import get_daily_credit_row, get_supabase_config

        return get_daily_credit_row(
            get_supabase_config(),
            user_id=user_id,
            session_id=session_id,
            usage_date=day,
        )
    except Exception as exc:
        print(f"[credit_cap] get_daily_credit_usage failed: {exc}")
        return _empty_daily()


def get_base_credit_cap(user_id: str | None, session_id: str | None) -> int:
    _ = session_id
    return SIGNED_IN_DAILY_CAP if user_id else ANON_DAILY_CAP


def get_credit_cap(user_id: str | None, session_id: str | None) -> int:
    base = get_base_credit_cap(user_id, session_id)
    daily = get_daily_credit_usage(user_id, session_id)
    bonus = int(daily.get("bonus_credits") or 0)
    return base + bonus


def estimate_credits_for_route(route_or_action: str) -> int:
    key = str(route_or_action or "").strip()
    action = _ROUTE_TO_CREDIT_ACTION.get(key, key)
    return int(compute_credits(action))


def feature_type_for_action(credit_action: str) -> str | None:
    return _ACTION_FEATURE.get(str(credit_action or ""))


def _cap_message(user_id: str | None) -> str:
    return SIGNED_IN_CAP_MESSAGE if user_id else ANON_CAP_MESSAGE


def can_spend_credits(
    user_id: str | None,
    session_id: str | None,
    credits_needed: int,
    feature_type: str | None = None,
) -> tuple[bool, str]:
    _ = feature_type
    if not _credits_enabled():
        return True, ""
    if is_no_cap_active(session_id):
        return True, ""
    needed = max(0, int(credits_needed or 0))
    daily = get_daily_credit_usage(user_id, session_id)
    cap = get_credit_cap(user_id, session_id)
    if int(daily.get("credits_used") or 0) + needed > cap:
        return False, _cap_message(user_id)
    return True, ""


def enforce_credit_cap_or_raise(
    *,
    user_id: str | None,
    session_id: str | None,
    credit_action: str,
    feature_type: str | None = None,
    credits_needed: int | None = None,
) -> None:
    if not _credits_enabled():
        return
    action = str(credit_action or "local_action")
    needed = int(credits_needed) if credits_needed is not None else estimate_credits_for_route(action)
    if needed <= 0:
        return
    ft = feature_type or feature_type_for_action(action)
    ok, msg = can_spend_credits(user_id, session_id, needed, ft)
    if not ok:
        raise HTTPException(status_code=429, detail=msg)


def _aggregate_provider_stats(events: list[dict[str, Any]] | None) -> dict[str, int]:
    stats = {
        "openai_input_tokens": 0,
        "openai_output_tokens": 0,
        "openai_reasoning_tokens": 0,
        "serper_calls": 0,
        "weather_calls": 0,
    }
    for ev in events or []:
        prov = ev.get("provider")
        if prov == "openai":
            stats["openai_input_tokens"] += int(ev.get("input_tokens") or ev.get("billable_input_tokens") or 0)
            stats["openai_output_tokens"] += int(ev.get("output_tokens") or 0)
            stats["openai_reasoning_tokens"] += int(ev.get("reasoning_tokens") or 0)
        elif prov == "serper":
            stats["serper_calls"] += max(1, int(ev.get("query_count") or 1))
        elif prov == "openweather":
            stats["weather_calls"] += max(1, int(ev.get("call_count") or 1))
    return stats


def record_credit_usage(
    user_id: str | None,
    session_id: str | None,
    request_id: str | None,
    credit_action: str,
    credits_delta: int,
    *,
    estimated_cost_usd: float | None = None,
    metadata: dict[str, Any] | None = None,
    events: list[dict[str, Any]] | None = None,
    success: bool = True,
) -> None:
    if not success:
        return
    delta = int(credits_delta or 0)
    action = str(credit_action or "local_action")
    if delta <= 0 and action not in ("failed_request", "local_action"):
        if not (metadata or events):
            return
    stats = _aggregate_provider_stats(events)
    if action == "weather" and not stats["weather_calls"]:
        stats["weather_calls"] = 1
    if action == "search_or_news" and not stats["serper_calls"]:
        stats["serper_calls"] = 1
    counters = dict(_ACTION_COUNTERS.get(action) or {})

    meta = dict(metadata or {})
    meta.setdefault("credit_action", action)
    meta.setdefault("success", success)

    if _USE_MEMORY_STORE:
        day = _today_utc()
        key = _store_key(user_id, session_id, day)
        row = dict(_MEMORY_STORE.get(key) or _empty_daily())
        row["credits_used"] = int(row.get("credits_used") or 0) + delta
        for k, v in stats.items():
            row[k] = int(row.get(k) or 0) + int(v)
        for k, v in counters.items():
            row[k] = int(row.get(k) or 0) + int(v)
        _MEMORY_STORE[key] = row
        return

    if not _credits_enabled():
        return
    try:
        from auth.credit_usage_db import (
            get_supabase_config,
            insert_credit_ledger_row,
            upsert_daily_credit_increment,
        )

        upsert_daily_credit_increment(
            get_supabase_config(),
            user_id=user_id,
            session_id=session_id,
            credits_delta=delta,
            openai_input_tokens=stats["openai_input_tokens"],
            openai_output_tokens=stats["openai_output_tokens"],
            openai_reasoning_tokens=stats["openai_reasoning_tokens"],
            serper_calls=stats["serper_calls"],
            weather_calls=stats["weather_calls"],
            reasoning_streams=counters.get("reasoning_streams", 0),
            voice_turns=counters.get("voice_turns", 0),
            search_turns=counters.get("search_turns", 0),
            image_pdf_reasoning_turns=counters.get("image_pdf_reasoning_turns", 0),
        )
        insert_credit_ledger_row(
            get_supabase_config(),
            user_id=user_id,
            session_id=session_id,
            request_id=request_id,
            credit_action=action,
            credits_delta=delta,
            estimated_cost_usd=estimated_cost_usd,
            metadata=meta,
        )
    except Exception as exc:
        print(f"[credit_cap] record_credit_usage failed: {exc}")


def settle_request_credits(
    *,
    user_id: str | None,
    session_id: str | None,
    request_id: str | None,
    credit_action: str | None,
    credits_used: int,
    success: bool,
    events: list[dict[str, Any]] | None = None,
    estimated_cost_usd: float | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    if not success:
        return
    record_credit_usage(
        user_id,
        session_id,
        request_id,
        str(credit_action or "local_action"),
        int(credits_used or 0),
        estimated_cost_usd=estimated_cost_usd,
        metadata=extra,
        events=events,
        success=True,
    )
