"""Supabase public.usage_events access (service role insert, metadata only)."""

from __future__ import annotations

import json
from typing import Any

from auth.supabase_config import SupabaseConfig
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers

MAX_EVENT_PROPS_BYTES = 2048
MAX_PROP_STRING_LEN = 128
MAX_REQUEST_ID_LEN = 128

MVP_EVENT_TYPES = frozenset(
    {
        "session_start",
        "page_hidden",
        "message_sent",
        "assistant_reply_done",
        "assistant_reply_failed",
        "feedback_submitted",
    }
)

FORBIDDEN_PROP_KEYS = frozenset(
    {
        "text",
        "transcript",
        "reply",
        "audio",
        "token",
        "note",
        "excerpt",
        "password",
        "email",
        "content",
        "message",
        "body",
        "assistant_response",
        "user_input",
        "user_input_excerpt",
        "assistant_response_excerpt",
        "raw",
        "prompt",
    }
)


def _truncate(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    t = str(text).strip()
    if not t:
        return None
    if len(t) > limit:
        return t[:limit]
    return t


def sanitize_event_props(props: Any) -> dict[str, Any] | None:
    if props is None:
        return None
    if not isinstance(props, dict):
        raise SupabaseDbError("event_props must be an object.", 422)
    clean: dict[str, Any] = {}
    for raw_key, raw_val in props.items():
        key = str(raw_key or "").strip().lower()
        if not key or key in FORBIDDEN_PROP_KEYS:
            continue
        if isinstance(raw_val, bool):
            clean[key] = raw_val
        elif isinstance(raw_val, int) and not isinstance(raw_val, bool):
            clean[key] = raw_val
        elif isinstance(raw_val, float):
            clean[key] = int(raw_val) if raw_val == int(raw_val) else round(raw_val, 3)
        elif isinstance(raw_val, str):
            val = raw_val.strip()[:MAX_PROP_STRING_LEN]
            if val:
                clean[key] = val
    if not clean:
        return None
    try:
        size = len(json.dumps(clean, separators=(",", ":"), ensure_ascii=True))
    except (TypeError, ValueError) as exc:
        raise SupabaseDbError("event_props must be JSON-serializable.", 422) from exc
    if size > MAX_EVENT_PROPS_BYTES:
        raise SupabaseDbError("event_props too large.", 422)
    return clean


def _public_usage_event_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "user_id": row.get("user_id"),
        "session_id": row.get("session_id"),
        "request_id": row.get("request_id"),
        "event_type": row.get("event_type"),
        "created_at": row.get("created_at"),
    }


def create_usage_event(
    config: SupabaseConfig,
    user_id: str | None,
    *,
    session_id: str,
    event_type: str,
    request_id: str | None = None,
    event_props: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    sid = (session_id or "").strip()
    if not sid:
        raise SupabaseDbError("session_id is required.", 400)
    etype = (event_type or "").strip().lower()
    if etype not in MVP_EVENT_TYPES:
        raise SupabaseDbError(f"event_type must be one of: {', '.join(sorted(MVP_EVENT_TYPES))}.", 422)
    props_clean = sanitize_event_props(event_props)
    payload: dict[str, Any] = {
        "user_id": user_id,
        "session_id": sid[:256],
        "event_type": etype,
        "request_id": _truncate(request_id, MAX_REQUEST_ID_LEN),
        "event_props": props_clean,
    }
    url = f"{_rest_base(config.url or '')}/usage_events"
    rows = _request_json(
        "POST",
        url,
        _service_headers(config.service_role_key or "", prefer="return=representation"),
        payload,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return _public_usage_event_row(rows[0])
    if isinstance(rows, dict):
        return _public_usage_event_row(rows)
    return _public_usage_event_row(payload)
