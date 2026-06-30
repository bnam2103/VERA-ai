"""Read-only daily credit usage for the Vera UI."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from auth.credit_usage_db import credit_db_available
from auth.jwt_auth import resolve_optional_auth
from cost_logging.credit_enforcement import (
    get_base_credit_cap,
    get_credit_cap,
    get_daily_credit_usage,
)
from cost_logging.no_cap_testing import is_no_cap_active, no_cap_toggle_enabled

router = APIRouter(tags=["supabase-usage-credits"])


def _utc_usage_date_and_reset() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    usage_date = now.date()
    tomorrow = usage_date + timedelta(days=1)
    reset_dt = datetime(
        tomorrow.year,
        tomorrow.month,
        tomorrow.day,
        tzinfo=timezone.utc,
    )
    return usage_date.isoformat(), reset_dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _build_credits_today_payload(
    *,
    user_id: str | None,
    session_id: str,
    auth_mode: str,
) -> dict[str, Any]:
    usage_date, reset_time = _utc_usage_date_and_reset()
    base_cap = int(get_base_credit_cap(user_id, session_id))
    daily: dict[str, Any] = {}
    if credit_db_available():
        try:
            daily = get_daily_credit_usage(user_id, session_id)
        except Exception:
            daily = {}
    credits_used = int(daily.get("credits_used") or 0)
    bonus_credits = int(daily.get("bonus_credits") or 0)
    effective_cap = base_cap + bonus_credits
    remaining = max(0, effective_cap - credits_used)
    toggle_enabled = no_cap_toggle_enabled()
    no_cap_active = toggle_enabled and is_no_cap_active(session_id)
    return {
        "ok": True,
        "auth_mode": auth_mode,
        "usage_date": usage_date,
        "reset_time": reset_time,
        "credits_used": credits_used,
        "base_credits_cap": base_cap,
        "bonus_credits": bonus_credits,
        "credits_cap": effective_cap,
        "remaining_credits": remaining,
        "no_cap_toggle_enabled": toggle_enabled,
        "no_cap_active": no_cap_active,
    }


@router.get("/api/usage/credits/today")
def api_usage_credits_today(
    request: Request,
    session_id: str = Query(..., min_length=1, max_length=256),
) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id is required.")
    user_id, auth_mode = resolve_optional_auth(
        request,
        endpoint="/api/usage/credits/today",
        session_id_present=True,
    )
    return _build_credits_today_payload(
        user_id=user_id,
        session_id=sid,
        auth_mode=auth_mode,
    )
