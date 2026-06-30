"""Supabase public.usage_events access (service role insert, metadata only)."""

from __future__ import annotations

import json
import urllib.parse
from typing import Any

from auth.supabase_config import SupabaseConfig
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers

MAX_EVENT_PROPS_BYTES = 2048
MAX_PROP_STRING_LEN = 128
MAX_REQUEST_ID_LEN = 128
MAX_CLIENT_EVENT_ID_LEN = 128

# Phase 0+1 foundation + Phase 2 feature interaction events.
ALLOWED_EVENT_TYPES = frozenset(
    {
        "session_start",
        "page_hidden",
        "message_sent",
        "assistant_reply_done",
        "assistant_reply_failed",
        "feedback_submitted",
        "mode_changed",
        "mode_duration_flush",
        "work_mode_entered",
        "work_mode_exited",
        "bmo_mode_entered",
        "bmo_mode_exited",
        "action_executed",
        "action_failed",
        "multi_action_plan_executed",
        "multi_action_step_executed",
        "action_sequence_failed",
        "music_action_executed",
        "music_provider_switched",
        "music_sequence_executed",
        "music_play_started",
        "music_transport_used",
        "checklist_item_added",
        "checklist_item_completed",
        "checklist_item_deleted",
        "checklist_sync_started",
        "checklist_sync_completed",
        "checklist_sync_failed",
        "checklist_batch_action_executed",
        "reasoning_panel_opened",
        "reasoning_panel_closed",
        "reasoning_panel_focused",
        "reasoning_panel_message_sent",
        "reasoning_panel_reply_done",
        "interrupt_candidate_detected",
        "interrupt_candidate_submitted",
        "interrupt_confirmed",
        "interrupt_rejected",
        "interrupt_cleanup_done",
    }
)

# Backward-compatible alias used by older imports/tests.
MVP_EVENT_TYPES = ALLOWED_EVENT_TYPES

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
        "title",
        "query",
        "playlist_name",
        "song",
        "lyrics",
        "checklist_item",
        "panel_content",
        "markdown",
        "uri",
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
        "client_event_id": row.get("client_event_id"),
        "event_type": row.get("event_type"),
        "created_at": row.get("created_at"),
    }


def find_usage_event_by_client_id(
    config: SupabaseConfig,
    session_id: str,
    client_event_id: str,
) -> dict[str, Any] | None:
    if not config.db_configured:
        return None
    sid = (session_id or "").strip()
    cid = _truncate(client_event_id, MAX_CLIENT_EVENT_ID_LEN)
    if not sid or not cid:
        return None
    params = urllib.parse.urlencode(
        {
            "session_id": f"eq.{sid}",
            "client_event_id": f"eq.{cid}",
            "select": "id,user_id,session_id,request_id,client_event_id,event_type,created_at",
            "limit": "1",
        }
    )
    url = f"{_rest_base(config.url or '')}/usage_events?{params}"
    rows = _request_json("GET", url, _service_headers(config.service_role_key or ""))
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return _public_usage_event_row(rows[0])
    return None


def create_usage_event(
    config: SupabaseConfig,
    user_id: str | None,
    *,
    session_id: str,
    event_type: str,
    request_id: str | None = None,
    client_event_id: str | None = None,
    event_props: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    sid = (session_id or "").strip()
    if not sid:
        raise SupabaseDbError("session_id is required.", 400)
    etype = (event_type or "").strip().lower()
    if etype not in ALLOWED_EVENT_TYPES:
        raise SupabaseDbError(
            f"event_type must be one of: {', '.join(sorted(ALLOWED_EVENT_TYPES))}.",
            422,
        )
    cid = _truncate(client_event_id, MAX_CLIENT_EVENT_ID_LEN)
    if cid:
        existing = find_usage_event_by_client_id(config, sid, cid)
        if existing:
            return existing
    props_clean = sanitize_event_props(event_props)
    payload: dict[str, Any] = {
        "user_id": user_id,
        "session_id": sid[:256],
        "event_type": etype,
        "request_id": _truncate(request_id, MAX_REQUEST_ID_LEN),
        "event_props": props_clean,
    }
    if cid:
        payload["client_event_id"] = cid
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
