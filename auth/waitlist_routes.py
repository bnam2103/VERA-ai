"""Public waitlist signup API (no auth required)."""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError
from auth.waitlist_db import MAX_EMAIL_LEN, insert_waitlist_signup
from auth.waitlist_email import send_waitlist_confirmation_email

router = APIRouter(tags=["waitlist"])
_log = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class WaitlistSignupBody(BaseModel):
    email: str = Field(..., min_length=3, max_length=MAX_EMAIL_LEN)
    source: str = Field(default="landing", max_length=64)
    referrer: str | None = Field(default=None, max_length=2048)

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, v: str) -> str:
        return (v or "").strip().lower()


@router.post("/api/waitlist")
def api_waitlist_signup(request: Request, body: WaitlistSignupBody) -> dict[str, Any]:
    # TODO: Rate limit by IP / session to reduce abuse (no shared helper yet).
    email = body.email
    if not email or not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")

    config = get_supabase_config()
    if not config.db_configured:
        _log.error("[waitlist] Supabase database is not configured")
        raise HTTPException(
            status_code=503,
            detail="Waitlist is temporarily unavailable. Please try again later.",
        )

    user_agent = (request.headers.get("user-agent") or "").strip() or None
    referrer = (body.referrer or request.headers.get("referer") or "").strip() or None

    try:
        _row, already_exists = insert_waitlist_signup(
            config,
            email=email,
            source=body.source,
            user_agent=user_agent,
            referrer=referrer,
        )
    except SupabaseDbError as exc:
        _log.exception("[waitlist] Supabase insert failed for %s", email[:64])
        raise HTTPException(
            status_code=500,
            detail="Something went wrong. Please try again later.",
        ) from exc

    if already_exists:
        _log.info("[waitlist] duplicate signup: %s", email[:64])
        return {"ok": True, "message": "You're already on the waitlist."}

    _log.info("[waitlist] new signup: %s source=%s", email[:64], (body.source or "landing")[:32])
    try:
        send_waitlist_confirmation_email(email)
    except Exception:
        _log.exception("[waitlist] confirmation email failed for %s", email[:64])

    return {"ok": True, "message": "You're on the waitlist."}
