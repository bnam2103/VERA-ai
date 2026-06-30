"""Account-linked Work Mode reasoning workspace API."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from auth.jwt_auth import extract_bearer_token, require_auth_user
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError
from auth.workspace_db import (
    WORKSPACE_MAX_TABS,
    WorkspacePayloadError,
    delete_workspace_for_user,
    describe_workspace_put_payload_for_log,
    load_workspace_bundle,
    replace_workspace_for_user,
)

router = APIRouter(tags=["supabase-workspace"])
_log = logging.getLogger(__name__)

# Bump when workspace PUT normalization / error shape changes (deploy sanity check).
WORKSPACE_API_VERSION = 2


def _workspace_error_body(
    *,
    error: str,
    detail: str,
    field: str = "",
    tab_index: int | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "error": error,
        "detail": detail,
        "workspace_api_version": WORKSPACE_API_VERSION,
    }
    if field:
        body["field"] = field
    if tab_index is not None:
        body["tab_index"] = tab_index
    return body


def _workspace_error_response(
    status_code: int,
    *,
    error: str,
    detail: str,
    field: str = "",
    tab_index: int | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=_workspace_error_body(
            error=error,
            detail=detail,
            field=field,
            tab_index=tab_index,
        ),
    )


def _log_workspace_auth(route: str, request: Request, user_id: str | None) -> None:
    token = extract_bearer_token(request)
    _log.info(
        "[workspace_auth] route=%s has_authorization_header=%s bound_user_id=%s api_version=%s",
        route,
        bool(token),
        user_id,
        WORKSPACE_API_VERSION,
    )


@router.get("/api/work-mode/workspace")
def api_workspace_get(request: Request) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    _log_workspace_auth("GET", request, user.user_id)
    try:
        bundle = load_workspace_bundle(config, user.user_id)
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not bundle:
        return {
            "ok": True,
            "empty": True,
            "schema_version": 1,
            "active_lane_id": None,
            "max_tabs": WORKSPACE_MAX_TABS,
            "client_revision": 0,
            "workspace_api_version": WORKSPACE_API_VERSION,
            "tabs": [],
        }
    return {
        "ok": True,
        "empty": len(bundle.get("tabs") or []) == 0,
        "workspace_api_version": WORKSPACE_API_VERSION,
        **bundle,
    }


@router.put("/api/work-mode/workspace")
async def api_workspace_put(request: Request):
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    _log_workspace_auth("PUT", request, user.user_id)

    try:
        raw = await request.json()
    except Exception as exc:
        return _workspace_error_response(
            400,
            error="invalid_workspace_payload",
            detail="Request body must be valid JSON.",
            field="body",
        )

    debug_meta = describe_workspace_put_payload_for_log(raw)
    _log.info(
        "[workspace_put_debug] user_id=%s api_version=%s %s",
        user.user_id,
        WORKSPACE_API_VERSION,
        debug_meta,
    )

    try:
        result = replace_workspace_for_user(
            config,
            user.user_id,
            raw,
        )
    except WorkspacePayloadError as exc:
        _log.warning(
            "[workspace_put_rejected] user_id=%s api_version=%s field=%s detail=%s debug=%s",
            user.user_id,
            WORKSPACE_API_VERSION,
            exc.field,
            exc.message,
            debug_meta,
        )
        return _workspace_error_response(
            400,
            error="invalid_workspace_payload",
            detail=exc.message,
            field=exc.field,
        )
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        field = ""
        if "rendered_html" in str(exc).lower():
            field = "rendered_html"
        elif "summary" in str(exc).lower():
            field = "summary"
        elif "last_opened_at" in str(exc).lower() or "timestamp" in str(exc).lower():
            field = "last_opened_at"
        elif "does not exist" in str(exc).lower():
            field = "schema"
        _log.warning(
            "[workspace_put_rejected] user_id=%s api_version=%s persist_status=%s field=%s detail=%s debug=%s",
            user.user_id,
            WORKSPACE_API_VERSION,
            status,
            field or "persist",
            str(exc),
            debug_meta,
        )
        return _workspace_error_response(
            status,
            error="workspace_persist_failed",
            detail=str(exc),
            field=field or "persist",
        )
    _log.info(
        "[workspace_put] user_id=%s tab_count=%s client_revision=%s active_lane_id=%s api_version=%s",
        user.user_id,
        result.get("tab_count"),
        result.get("client_revision"),
        result.get("active_lane_id"),
        WORKSPACE_API_VERSION,
    )
    return {"ok": True, "workspace_api_version": WORKSPACE_API_VERSION, **result}


@router.delete("/api/work-mode/workspace")
def api_workspace_delete(request: Request) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    _log_workspace_auth("DELETE", request, user.user_id)
    try:
        delete_workspace_for_user(config, user.user_id)
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "deleted": True, "workspace_api_version": WORKSPACE_API_VERSION}
