"""Explicit feedback rows + bonus-claim checks (service role)."""

from __future__ import annotations

import urllib.parse
from datetime import date, datetime, timezone
from typing import Any

from auth.supabase_config import SupabaseConfig
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers

FEEDBACK_BONUS_CREDITS = 50

ALLOWED_CATEGORIES: frozenset[str] = frozenset(
    {
        "work_mode",
        "voice_assistant",
        "latency",
        "response_quality",
        "search_news",
        "memory_context",
        "ui_ux",
        "bugs",
        "credit_limits",
        "other",
    }
)

MAX_REASON_LEN = 2000
MAX_ROUTE_CONTEXT_LEN = 256
MAX_USER_AGENT_LEN = 512
MAX_APP_VERSION_LEN = 64


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _principal(user_id: str | None, session_id: str | None) -> tuple[str | None, str | None]:
    uid = (user_id or "").strip() or None
    sid = (session_id or "").strip() or None
    if uid:
        return uid, None
    return None, sid


def sanitize_categories(raw: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in raw or []:
        key = str(item or "").strip().lower().replace(" ", "_").replace("/", "_")
        if key == "search/news" or key == "search_news":
            key = "search_news"
        if key == "memory/context" or key == "memory_context":
            key = "memory_context"
        if key == "ui/ux" or key == "ui_ux":
            key = "ui_ux"
        if key == "work_mode" or key == "work mode":
            key = "work_mode"
        if key not in ALLOWED_CATEGORIES:
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
        if len(out) >= 10:
            break
    return out


def has_claimed_feedback_bonus_today(
    config: SupabaseConfig,
    *,
    user_id: str | None,
    session_id: str | None,
    usage_date: date | None = None,
) -> bool:
    if not config.db_configured:
        return False
    uid, sid = _principal(user_id, session_id)
    if not uid and not sid:
        return False
    day = usage_date or _today_utc()
    params: dict[str, str] = {
        "usage_date": f"eq.{day.isoformat()}",
        "granted_bonus_credits": "gt.0",
        "select": "id",
        "limit": "1",
    }
    if uid:
        params["user_id"] = f"eq.{uid}"
    else:
        params["session_id"] = f"eq.{sid}"
        params["user_id"] = "is.null"
    q = urllib.parse.urlencode(params)
    url = f"{_rest_base(config.url or '')}/explicit_feedback?{q}"
    rows = _request_json("GET", url, _service_headers(config.service_role_key or ""))
    return isinstance(rows, list) and bool(rows)


def insert_explicit_feedback(
    config: SupabaseConfig,
    *,
    user_id: str | None,
    session_id: str | None,
    usage_date: date | None,
    rating: int,
    reason: str,
    categories: list[str],
    contact_ok: bool,
    user_agent: str | None,
    app_version: str | None,
    route_context: str | None,
    granted_bonus_credits: int,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    uid, sid = _principal(user_id, session_id)
    if not uid and not sid:
        raise SupabaseDbError("user_id or session_id required.", 400)
    day = usage_date or _today_utc()
    body: dict[str, Any] = {
        "usage_date": day.isoformat(),
        "rating": int(rating),
        "reason": str(reason or "").strip()[:MAX_REASON_LEN],
        "categories": categories,
        "contact_ok": bool(contact_ok),
        "user_agent": (user_agent or None),
        "app_version": (app_version or None),
        "route_context": (route_context or None),
        "granted_bonus_credits": int(granted_bonus_credits or 0),
    }
    if uid:
        body["user_id"] = uid
        body["session_id"] = None
    else:
        body["user_id"] = None
        body["session_id"] = sid
    url = f"{_rest_base(config.url or '')}/explicit_feedback"
    rows = _request_json(
        "POST",
        url,
        _service_headers(
            config.service_role_key or "",
            prefer="return=representation",
        ),
        body,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    return body
