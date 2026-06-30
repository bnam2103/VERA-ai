"""Supabase public.feedback access (service role, scoped by verified user_id)."""

from __future__ import annotations

from typing import Any

from auth.supabase_config import SupabaseConfig
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers

MAX_NOTE_LEN = 500
MAX_EXCERPT_LEN = 1000
VALID_RATINGS = frozenset({"up", "down"})
VALID_SOURCES = frozenset({"main_chat", "reasoning_panel"})


def _truncate(text: str | None, limit: int) -> str | None:
    if text is None:
        return None
    t = str(text).strip()
    if not t:
        return None
    if len(t) > limit:
        return t[:limit]
    return t


def _public_feedback_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "user_id": row.get("user_id"),
        "session_id": row.get("session_id"),
        "request_id": row.get("request_id"),
        "turn_id": row.get("turn_id"),
        "rating": row.get("rating"),
        "note": row.get("note"),
        "source": row.get("source") or "main_chat",
        "created_at": row.get("created_at"),
    }


def create_feedback(
    config: SupabaseConfig,
    user_id: str | None,
    *,
    session_id: str,
    rating: str,
    request_id: str | None = None,
    turn_id: str | None = None,
    note: str | None = None,
    user_input_excerpt: str | None = None,
    assistant_response_excerpt: str | None = None,
    source: str = "main_chat",
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    sid = (session_id or "").strip()
    if not sid:
        raise SupabaseDbError("session_id is required.", 400)
    rate = (rating or "").strip().lower()
    if rate not in VALID_RATINGS:
        raise SupabaseDbError("rating must be 'up' or 'down'.", 422)
    src = (source or "main_chat").strip().lower() or "main_chat"
    if src not in VALID_SOURCES:
        src = "main_chat"
    note_clean = _truncate(note, MAX_NOTE_LEN) if rate == "down" else None
    payload: dict[str, Any] = {
        "user_id": user_id,
        "session_id": sid[:256],
        "rating": rate,
        "source": src,
        "request_id": _truncate(request_id, 128),
        "turn_id": _truncate(turn_id, 64),
        "note": note_clean,
        "user_input_excerpt": _truncate(user_input_excerpt, MAX_EXCERPT_LEN),
        "assistant_response_excerpt": _truncate(assistant_response_excerpt, MAX_EXCERPT_LEN),
    }
    url = f"{_rest_base(config.url or '')}/feedback"
    rows = _request_json(
        "POST",
        url,
        _service_headers(config.service_role_key or "", prefer="return=representation"),
        payload,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return _public_feedback_row(rows[0])
    if isinstance(rows, dict):
        return _public_feedback_row(rows)
    return _public_feedback_row(payload)
