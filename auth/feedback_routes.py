"""Feedback REST API (MVP — main chat thumbs up/down)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from auth.feedback_db import MAX_EXCERPT_LEN, MAX_NOTE_LEN, create_feedback
from auth.jwt_auth import extract_bearer_token, verify_access_token
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError

router = APIRouter(tags=["supabase-feedback"])
_log = logging.getLogger(__name__)


class FeedbackCreateBody(BaseModel):
    rating: str = Field(..., min_length=2, max_length=8)
    session_id: str = Field(..., min_length=1, max_length=256)
    request_id: str | None = Field(default=None, max_length=128)
    turn_id: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=MAX_NOTE_LEN)
    user_input_excerpt: str | None = Field(default=None, max_length=MAX_EXCERPT_LEN)
    assistant_response_excerpt: str | None = Field(
        default=None, max_length=MAX_EXCERPT_LEN
    )
    source: str = Field(default="main_chat", max_length=32)

    @field_validator("rating")
    @classmethod
    def _normalize_rating(cls, v: str) -> str:
        rate = (v or "").strip().lower()
        if rate not in ("up", "down"):
            raise ValueError("rating must be 'up' or 'down'")
        return rate

    @field_validator("note")
    @classmethod
    def _strip_note(cls, v: str | None) -> str | None:
        if v is None:
            return None
        t = str(v).strip()
        return t or None


@router.post("/api/feedback")
def api_feedback_create(request: Request, body: FeedbackCreateBody) -> dict[str, Any]:
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
    if body.rating == "up":
        note = None
    else:
        note = body.note
    try:
        row = create_feedback(
            config,
            user_id,
            session_id=body.session_id.strip(),
            rating=body.rating,
            request_id=body.request_id,
            turn_id=body.turn_id,
            note=note,
            user_input_excerpt=body.user_input_excerpt,
            assistant_response_excerpt=body.assistant_response_excerpt,
            source=body.source,
        )
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    _log.info(
        "[feedback_submit] auth_mode=%s user_id=%s rating=%s request_id=%s id=%s",
        auth_mode,
        user_id,
        body.rating,
        (body.request_id or "")[:64],
        row.get("id"),
    )
    return {"ok": True, "id": row.get("id")}
