"""Explicit feedback form API (+50 bonus credits, once per day)."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from auth.credit_usage_db import credit_db_available, grant_daily_bonus_credits, insert_credit_ledger_row
from auth.explicit_feedback_db import (
    FEEDBACK_BONUS_CREDITS,
    MAX_APP_VERSION_LEN,
    MAX_REASON_LEN,
    MAX_ROUTE_CONTEXT_LEN,
    MAX_USER_AGENT_LEN,
    has_claimed_feedback_bonus_today,
    insert_explicit_feedback,
    sanitize_categories,
)
from auth.jwt_auth import resolve_optional_auth
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError

router = APIRouter(tags=["supabase-explicit-feedback"])
_log = logging.getLogger(__name__)


class ExplicitFeedbackSubmitBody(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=256)
    rating: int = Field(..., ge=1, le=5)
    reason: str = Field(..., min_length=1, max_length=MAX_REASON_LEN)
    categories: list[str] = Field(default_factory=list, max_length=10)
    contact_ok: bool = False
    route_context: str | None = Field(default=None, max_length=MAX_ROUTE_CONTEXT_LEN)
    app_version: str | None = Field(default=None, max_length=MAX_APP_VERSION_LEN)

    @field_validator("reason")
    @classmethod
    def _strip_reason(cls, v: str) -> str:
        t = str(v or "").strip()
        if not t:
            raise ValueError("reason is required.")
        return t[:MAX_REASON_LEN]


@router.get("/api/feedback/status")
def api_feedback_status(
    request: Request,
    session_id: str = Query(..., min_length=1, max_length=256),
) -> dict[str, Any]:
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id is required.")
    config = get_supabase_config()
    user_id, auth_mode = resolve_optional_auth(
        request,
        endpoint="/api/feedback/status",
        session_id_present=True,
    )
    if not credit_db_available():
        return {
            "ok": True,
            "eligible": False,
            "bonus_credits": FEEDBACK_BONUS_CREDITS,
            "already_claimed": False,
            "auth_mode": auth_mode,
            "db_configured": False,
        }
    claimed = has_claimed_feedback_bonus_today(
        config, user_id=user_id, session_id=sid
    )
    return {
        "ok": True,
        "eligible": not claimed,
        "bonus_credits": FEEDBACK_BONUS_CREDITS,
        "already_claimed": claimed,
        "auth_mode": auth_mode,
    }


@router.post("/api/feedback/submit")
def api_feedback_submit(request: Request, body: ExplicitFeedbackSubmitBody) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    sid = body.session_id.strip()
    user_id, auth_mode = resolve_optional_auth(
        request,
        endpoint="/api/feedback/submit",
        session_id_present=bool(sid),
    )
    categories = sanitize_categories(body.categories)
    ua = (request.headers.get("User-Agent") or "")[:MAX_USER_AGENT_LEN] or None
    already_claimed = has_claimed_feedback_bonus_today(
        config, user_id=user_id, session_id=sid
    )
    grant_bonus = 0 if already_claimed else FEEDBACK_BONUS_CREDITS
    if body.contact_ok and not user_id:
        contact_ok = False
    else:
        contact_ok = bool(body.contact_ok)
    try:
        row = insert_explicit_feedback(
            config,
            user_id=user_id,
            session_id=sid,
            usage_date=None,
            rating=body.rating,
            reason=body.reason,
            categories=categories,
            contact_ok=contact_ok,
            user_agent=ua,
            app_version=(body.app_version or None),
            route_context=(body.route_context or None),
            granted_bonus_credits=grant_bonus,
        )
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        if status == 409 or "duplicate" in str(exc).lower() or "23505" in str(exc):
            grant_bonus = 0
            already_claimed = True
            try:
                row = insert_explicit_feedback(
                    config,
                    user_id=user_id,
                    session_id=sid,
                    usage_date=None,
                    rating=body.rating,
                    reason=body.reason,
                    categories=categories,
                    contact_ok=contact_ok,
                    user_agent=ua,
                    app_version=(body.app_version or None),
                    route_context=(body.route_context or None),
                    granted_bonus_credits=0,
                )
            except SupabaseDbError as exc2:
                raise HTTPException(status_code=502, detail=str(exc2)) from exc2
        else:
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    feedback_id = row.get("id")
    if grant_bonus > 0:
        try:
            grant_daily_bonus_credits(
                config,
                user_id=user_id,
                session_id=sid,
                bonus_delta=grant_bonus,
            )
            insert_credit_ledger_row(
                config,
                user_id=user_id,
                session_id=sid,
                request_id=f"feedback-{uuid.uuid4().hex[:12]}",
                credit_action="feedback_bonus",
                credits_delta=grant_bonus,
                metadata={
                    "feedback_id": feedback_id,
                    "bonus_type": "daily_cap_increase",
                    "rating": body.rating,
                    "categories": categories,
                },
            )
        except Exception as exc:
            _log.warning("[explicit_feedback] bonus grant failed: %s", exc)
            grant_bonus = 0
            already_claimed = True

    _log.info(
        "[explicit_feedback] auth_mode=%s user_id=%s session_prefix=%s rating=%s granted=%s id=%s",
        auth_mode,
        user_id,
        sid[:8],
        body.rating,
        grant_bonus,
        feedback_id,
    )
    return {
        "ok": True,
        "id": feedback_id,
        "granted_bonus_credits": grant_bonus,
        "already_claimed": already_claimed or grant_bonus == 0,
        "bonus_credits": FEEDBACK_BONUS_CREDITS,
    }
