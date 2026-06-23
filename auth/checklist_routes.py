"""Account-linked work checklist API (Supabase)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth.checklist_db import load_checklist_bundle, replace_checklist_for_user
from auth.checklist_merge import merge_checklist_items, merge_completed_collapsed, strip_checklist_placeholder_items
from auth.jwt_auth import extract_bearer_token, require_auth_user
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError

router = APIRouter(tags=["supabase-checklist"])
_log = logging.getLogger(__name__)


class ChecklistPutBody(BaseModel):
    items: list[dict[str, Any]] = Field(default_factory=list)
    completed_collapsed: bool | None = None


def _log_checklist_auth(route: str, request: Request, user_id: str | None) -> None:
    token = extract_bearer_token(request)
    _log.info(
        "[checklist_auth] route=%s has_authorization_header=%s bound_user_id=%s",
        route,
        bool(token),
        user_id,
    )


@router.get("/api/checklist")
def api_checklist_get(request: Request) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    _log_checklist_auth("GET", request, user.user_id)
    try:
        items, collapsed = load_checklist_bundle(config, user.user_id)
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "ok": True,
        "items": items,
        "completed_collapsed": collapsed,
        "empty": len(items) == 0,
    }


@router.put("/api/checklist")
def api_checklist_put(request: Request, body: ChecklistPutBody) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    _log_checklist_auth("PUT", request, user.user_id)
    clean_items, removed = strip_checklist_placeholder_items(body.items)
    if removed > 0:
        _log.info(
            "[checklist_cleanup] user_id=%s removed_count=%s item_count=%s",
            user.user_id,
            removed,
            len(clean_items),
        )
    try:
        count = replace_checklist_for_user(
            config,
            user.user_id,
            clean_items,
            completed_collapsed=body.completed_collapsed,
        )
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    _log.info(
        "[checklist_put] item_count=%s saved_count=%s user_id=%s cleanup_removed=%s",
        len(clean_items),
        count,
        user.user_id,
        removed,
    )
    return {"ok": True, "items_count": count}


@router.post("/api/checklist/merge")
def api_checklist_merge(request: Request, body: ChecklistPutBody) -> dict[str, Any]:
    """Merge client-local items with stored Supabase items (login hydration helper)."""
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    _log_checklist_auth("POST /merge", request, user.user_id)
    try:
        remote_items, remote_collapsed = load_checklist_bundle(config, user.user_id)
        local_clean, local_removed = strip_checklist_placeholder_items(body.items)
        if local_removed > 0:
            _log.info(
                "[checklist_cleanup] user_id=%s removed_count=%s phase=merge_local",
                user.user_id,
                local_removed,
            )
        merged_items = merge_checklist_items(local_clean, remote_items)
        merged_collapsed = merge_completed_collapsed(
            body.completed_collapsed,
            remote_collapsed,
        )
        count = replace_checklist_for_user(
            config,
            user.user_id,
            merged_items,
            completed_collapsed=merged_collapsed,
        )
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    _log.info(
        "[checklist_merge] user_id=%s local_count=%s remote_count=%s merged_count=%s saved_count=%s local_cleanup_removed=%s",
        user.user_id,
        len(body.items),
        len(remote_items),
        len(merged_items),
        count,
        local_removed,
    )
    return {
        "ok": True,
        "items": merged_items,
        "completed_collapsed": merged_collapsed,
        "items_count": count,
        "remote_count": len(remote_items),
    }
