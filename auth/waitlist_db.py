"""Supabase public.waitlist access (service role only)."""

from __future__ import annotations

from typing import Any

from auth.supabase_config import SupabaseConfig
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers

MAX_EMAIL_LEN = 320
MAX_SOURCE_LEN = 64
MAX_REFERRER_LEN = 2048
MAX_USER_AGENT_LEN = 512


def _is_duplicate_email_error(exc: SupabaseDbError) -> bool:
    if exc.status == 409:
        return True
    detail = str(exc).lower()
    return "23505" in detail or "duplicate key" in detail or "unique constraint" in detail


def insert_waitlist_signup(
    config: SupabaseConfig,
    *,
    email: str,
    source: str = "landing",
    user_agent: str | None = None,
    referrer: str | None = None,
) -> tuple[dict[str, Any], bool]:
    """Insert a waitlist row. Returns (row_or_payload, already_exists)."""
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")

    src = (source or "landing").strip().lower() or "landing"
    if len(src) > MAX_SOURCE_LEN:
        src = src[:MAX_SOURCE_LEN]

    payload: dict[str, Any] = {
        "email": email,
        "source": src,
        "status": "pending",
    }
    if user_agent:
        payload["user_agent"] = user_agent[:MAX_USER_AGENT_LEN]
    if referrer:
        payload["referrer"] = referrer[:MAX_REFERRER_LEN]

    url = f"{_rest_base(config.url or '')}/waitlist"
    try:
        rows = _request_json(
            "POST",
            url,
            _service_headers(config.service_role_key or "", prefer="return=representation"),
            payload,
        )
    except SupabaseDbError as exc:
        if _is_duplicate_email_error(exc):
            return {"email": email}, True
        raise

    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0], False
    if isinstance(rows, dict):
        return rows, False
    return payload, False
