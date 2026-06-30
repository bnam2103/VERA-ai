"""Supabase usage credit daily rollup + ledger (service role)."""

from __future__ import annotations

import json
import urllib.parse
from datetime import date, datetime, timezone
from typing import Any

from auth.supabase_config import SupabaseConfig, get_supabase_config
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers

_EMPTY_DAILY: dict[str, Any] = {
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


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _daily_key(user_id: str | None, session_id: str | None) -> tuple[str | None, str | None]:
    uid = (user_id or "").strip() or None
    sid = (session_id or "").strip() or None
    if uid:
        return uid, None
    return None, sid


def _normalize_daily_row(row: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(_EMPTY_DAILY)
    if not isinstance(row, dict):
        return out
    if row.get("id"):
        out["id"] = row["id"]
    for k in _EMPTY_DAILY:
        try:
            out[k] = int(row.get(k) or 0)
        except (TypeError, ValueError):
            out[k] = 0
    return out


def get_daily_credit_row(
    config: SupabaseConfig,
    *,
    user_id: str | None,
    session_id: str | None,
    usage_date: date | None = None,
) -> dict[str, Any]:
    if not config.db_configured:
        return dict(_EMPTY_DAILY)
    uid, sid = _daily_key(user_id, session_id)
    if not uid and not sid:
        return dict(_EMPTY_DAILY)
    day = usage_date or _today_utc()
    params: dict[str, str] = {
        "usage_date": f"eq.{day.isoformat()}",
        "select": "*",
        "limit": "1",
    }
    if uid:
        params["user_id"] = f"eq.{uid}"
    else:
        params["session_id"] = f"eq.{sid}"
        params["user_id"] = "is.null"
    q = urllib.parse.urlencode(params)
    url = f"{_rest_base(config.url or '')}/usage_credit_daily?{q}"
    rows = _request_json("GET", url, _service_headers(config.service_role_key or ""))
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return _normalize_daily_row(rows[0])
    return dict(_EMPTY_DAILY)


def upsert_daily_credit_increment(
    config: SupabaseConfig,
    *,
    user_id: str | None,
    session_id: str | None,
    usage_date: date | None = None,
    credits_delta: int = 0,
    openai_input_tokens: int = 0,
    openai_output_tokens: int = 0,
    openai_reasoning_tokens: int = 0,
    serper_calls: int = 0,
    weather_calls: int = 0,
    reasoning_streams: int = 0,
    voice_turns: int = 0,
    search_turns: int = 0,
    image_pdf_reasoning_turns: int = 0,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    uid, sid = _daily_key(user_id, session_id)
    if not uid and not sid:
        raise SupabaseDbError("user_id or session_id required.", 400)
    day = usage_date or _today_utc()
    current = get_daily_credit_row(config, user_id=uid, session_id=sid, usage_date=day)
    payload: dict[str, Any] = {
        "usage_date": day.isoformat(),
        "credits_used": int(current["credits_used"]) + int(credits_delta or 0),
        "openai_input_tokens": int(current["openai_input_tokens"]) + int(openai_input_tokens or 0),
        "openai_output_tokens": int(current["openai_output_tokens"]) + int(openai_output_tokens or 0),
        "openai_reasoning_tokens": int(current["openai_reasoning_tokens"])
        + int(openai_reasoning_tokens or 0),
        "serper_calls": int(current["serper_calls"]) + int(serper_calls or 0),
        "weather_calls": int(current["weather_calls"]) + int(weather_calls or 0),
        "reasoning_streams": int(current["reasoning_streams"]) + int(reasoning_streams or 0),
        "voice_turns": int(current["voice_turns"]) + int(voice_turns or 0),
        "search_turns": int(current["search_turns"]) + int(search_turns or 0),
        "image_pdf_reasoning_turns": int(current["image_pdf_reasoning_turns"])
        + int(image_pdf_reasoning_turns or 0),
        "bonus_credits": int(current.get("bonus_credits") or 0),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    base = _rest_base(config.url or "")
    row_id = current.get("id")
    if row_id:
        url = f"{base}/usage_credit_daily?id=eq.{row_id}"
        _request_json(
            "PATCH",
            url,
            _service_headers(
                config.service_role_key or "",
                prefer="return=representation",
            ),
            payload,
        )
        return _normalize_daily_row({**current, **payload, "id": row_id})
    if uid:
        payload["user_id"] = uid
        payload["session_id"] = None
    else:
        payload["user_id"] = None
        payload["session_id"] = sid
    url = f"{base}/usage_credit_daily"
    rows = _request_json(
        "POST",
        url,
        _service_headers(
            config.service_role_key or "",
            prefer="return=representation",
        ),
        payload,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return _normalize_daily_row(rows[0])
    return _normalize_daily_row(payload)


def grant_daily_bonus_credits(
    config: SupabaseConfig,
    *,
    user_id: str | None,
    session_id: str | None,
    bonus_delta: int = 50,
    usage_date: date | None = None,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    uid, sid = _daily_key(user_id, session_id)
    if not uid and not sid:
        raise SupabaseDbError("user_id or session_id required.", 400)
    day = usage_date or _today_utc()
    current = get_daily_credit_row(config, user_id=uid, session_id=sid, usage_date=day)
    payload: dict[str, Any] = {
        "usage_date": day.isoformat(),
        "credits_used": int(current["credits_used"]),
        "bonus_credits": int(current.get("bonus_credits") or 0) + int(bonus_delta or 0),
        "openai_input_tokens": int(current["openai_input_tokens"]),
        "openai_output_tokens": int(current["openai_output_tokens"]),
        "openai_reasoning_tokens": int(current["openai_reasoning_tokens"]),
        "serper_calls": int(current["serper_calls"]),
        "weather_calls": int(current["weather_calls"]),
        "reasoning_streams": int(current["reasoning_streams"]),
        "voice_turns": int(current["voice_turns"]),
        "search_turns": int(current["search_turns"]),
        "image_pdf_reasoning_turns": int(current["image_pdf_reasoning_turns"]),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    base = _rest_base(config.url or "")
    row_id = current.get("id")
    if row_id:
        url = f"{base}/usage_credit_daily?id=eq.{row_id}"
        _request_json(
            "PATCH",
            url,
            _service_headers(
                config.service_role_key or "",
                prefer="return=representation",
            ),
            payload,
        )
        return _normalize_daily_row({**current, **payload, "id": row_id})
    if uid:
        payload["user_id"] = uid
        payload["session_id"] = None
    else:
        payload["user_id"] = None
        payload["session_id"] = sid
    url = f"{base}/usage_credit_daily"
    rows = _request_json(
        "POST",
        url,
        _service_headers(
            config.service_role_key or "",
            prefer="return=representation",
        ),
        payload,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return _normalize_daily_row(rows[0])
    return _normalize_daily_row(payload)


def insert_credit_ledger_row(
    config: SupabaseConfig,
    *,
    user_id: str | None,
    session_id: str | None,
    request_id: str | None,
    credit_action: str,
    credits_delta: int,
    estimated_cost_usd: float | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not config.db_configured:
        return
    url = f"{_rest_base(config.url or '')}/usage_credit_ledger"
    body: dict[str, Any] = {
        "user_id": (user_id or None),
        "session_id": (session_id or None),
        "request_id": (request_id or None),
        "credit_action": str(credit_action or "unknown"),
        "credits_delta": int(credits_delta or 0),
        "estimated_cost_usd": estimated_cost_usd,
        "metadata": metadata or None,
    }
    _request_json(
        "POST",
        url,
        _service_headers(config.service_role_key or "", prefer="return=minimal"),
        body,
    )


def credit_db_available() -> bool:
    try:
        return bool(get_supabase_config().db_configured)
    except Exception:
        return False
