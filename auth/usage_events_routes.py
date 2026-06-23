"""Usage events REST API (behavioral analytics MVP — metadata only)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth.jwt_auth import extract_bearer_token, verify_access_token
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError
from auth.usage_events_db import MVP_EVENT_TYPES, create_usage_event, sanitize_event_props

router = APIRouter(tags=["supabase-usage-events"])
_log = logging.getLogger(__name__)


class UsageEventCreateBody(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=256)
    event_type: str = Field(..., min_length=1, max_length=64)
    request_id: str | None = Field(default=None, max_length=128)
    event_props: dict[str, Any] | None = None


@router.post("/api/usage/events")
def api_usage_event_create(request: Request, body: UsageEventCreateBody) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    token = extract_bearer_token(request)
    user = None
    if token:
        user = verify_access_token(token, config)
        if user is None:
            raise HTTPException(status_code=401, detail="Invalid or expired token.")
    user_id = user.user_id if user else None
    auth_mode = "authenticated" if user else "anonymous"
    etype = (body.event_type or "").strip().lower()
    if etype not in MVP_EVENT_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"event_type must be one of: {', '.join(sorted(MVP_EVENT_TYPES))}.",
        )
    try:
        props = sanitize_event_props(body.event_props)
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    try:
        row = create_usage_event(
            config,
            user_id,
            session_id=body.session_id.strip(),
            event_type=etype,
            request_id=body.request_id,
            event_props=props,
        )
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    sid = body.session_id.strip()
    rid = (body.request_id or "")[:64]
    _log.info(
        "[usage_event] auth_mode=%s event_type=%s session_id_prefix=%s request_id_prefix=%s id=%s",
        auth_mode,
        etype,
        sid[:8] if sid else "",
        rid[:64] if rid else "",
        row.get("id"),
    )
    return {"ok": True, "id": row.get("id")}
