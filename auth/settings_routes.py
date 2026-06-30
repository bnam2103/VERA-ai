"""Account-linked user settings API (Phase 4 narrow slice)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth.jwt_auth import require_auth_user
from auth.settings_prefs import (
    VERA_PREFS_KEY,
    merge_settings_patch,
    normalize_vera_prefs_v1,
    vera_prefs_is_empty,
)
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError, ensure_user_settings, update_user_settings

router = APIRouter(tags=["supabase-settings"])


class SettingsPatchBody(BaseModel):
    vera_prefs_v1: dict[str, Any] | None = Field(default=None)


def _public_settings_row(row: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(row, dict):
        return {"settings": {}}
    settings = row.get("settings")
    if not isinstance(settings, dict):
        settings = {}
    prefs = settings.get(VERA_PREFS_KEY)
    if isinstance(prefs, dict):
        settings = {**settings, VERA_PREFS_KEY: normalize_vera_prefs_v1(prefs)}
    return {
        "user_id": row.get("user_id"),
        "settings": settings,
        "updated_at": row.get("updated_at"),
    }


@router.get("/api/settings")
def api_settings_get(request: Request) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    try:
        row = ensure_user_settings(config, user.user_id)
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    public = _public_settings_row(row)
    return {
        "ok": True,
        **public,
        "vera_prefs_v1": (public.get("settings") or {}).get(VERA_PREFS_KEY) or {},
        "empty": vera_prefs_is_empty(public.get("settings")),
    }


@router.put("/api/settings")
def api_settings_put(request: Request, body: SettingsPatchBody) -> dict[str, Any]:
    return api_settings_patch(request, body)


@router.patch("/api/settings")
def api_settings_patch(request: Request, body: SettingsPatchBody) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    if body.vera_prefs_v1 is None:
        raise HTTPException(status_code=400, detail="No settings fields to update.")

    try:
        row = ensure_user_settings(config, user.user_id)
        existing_settings = row.get("settings") if isinstance(row, dict) else {}
        merged = merge_settings_patch(
            existing_settings if isinstance(existing_settings, dict) else {},
            {VERA_PREFS_KEY: body.vera_prefs_v1},
        )
        row = update_user_settings(config, user.user_id, merged)
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc

    public = _public_settings_row(row)
    return {
        "ok": True,
        **public,
        "vera_prefs_v1": (public.get("settings") or {}).get(VERA_PREFS_KEY) or {},
        "empty": vera_prefs_is_empty(public.get("settings")),
    }
