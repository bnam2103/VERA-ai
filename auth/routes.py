"""Minimal Supabase auth bootstrap endpoints (Phase 1)."""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from auth.jwt_auth import require_auth_user, resolve_auth_user
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError, ensure_profile, get_profile, update_profile

router = APIRouter(tags=["supabase-auth"])


class ProfilePatchBody(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    avatar_url: str | None = Field(default=None, max_length=2048)


def _public_profile_row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    return {
        "id": row.get("id"),
        "display_name": row.get("display_name"),
        "avatar_url": row.get("avatar_url"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


@router.get("/api/auth/config")
def api_auth_config() -> dict[str, Any]:
    """Public Supabase client config for the browser (anon key only)."""
    config = get_supabase_config()
    anon_key = (os.environ.get("SUPABASE_ANON_KEY") or "").strip() or None
    api_base = (os.environ.get("VERA_API_BASE_URL") or "").strip().rstrip("/") or None
    configured = bool(config.url and anon_key)
    return {
        "configured": configured,
        "supabase_url": config.url if configured else None,
        "anon_key": anon_key if configured else None,
        "api_base_url": api_base,
    }


@router.get("/api/auth/me")
def api_auth_me(
    request: Request,
    session_id: str | None = Query(default=None),
) -> dict[str, Any]:
    """Return Supabase auth state. Missing/invalid token => authenticated=false."""
    config = get_supabase_config()
    user = resolve_auth_user(request, config)

    base: dict[str, Any] = {
        "authenticated": False,
        "supabase_auth_configured": config.auth_configured,
        "supabase_db_configured": config.db_configured,
    }
    if session_id:
        base["session_id"] = session_id

    if user is None:
        return base

    profile = None
    if config.db_configured:
        try:
            profile = _public_profile_row(
                ensure_profile(config, user.user_id, email=user.email)
            )
        except SupabaseDbError:
            profile = None

    return {
        **base,
        "authenticated": True,
        "user_id": user.user_id,
        "email": user.email,
        "profile": profile,
    }


@router.get("/api/profile")
def api_profile_get(request: Request) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")

    user = require_auth_user(request, config)
    try:
        row = ensure_profile(config, user.user_id, email=user.email)
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {"ok": True, "profile": _public_profile_row(row)}


@router.patch("/api/profile")
def api_profile_patch(request: Request, body: ProfilePatchBody) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")

    user = require_auth_user(request, config)
    if body.display_name is None and body.avatar_url is None:
        raise HTTPException(status_code=400, detail="No profile fields to update.")

    try:
        row = update_profile(
            config,
            user.user_id,
            display_name=body.display_name,
            avatar_url=body.avatar_url,
        )
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc

    return {"ok": True, "profile": _public_profile_row(row)}
