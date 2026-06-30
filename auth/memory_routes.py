"""Explicit memory REST API (Phase 3)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth.jwt_auth import require_auth_user
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError
from auth.supabase_memories import (
    MAX_MEMORY_CONTENT_LEN,
    MAX_USER_MEMORIES,
    create_memory,
    delete_memory,
    forget_memories_matching,
    list_memories,
)

router = APIRouter(tags=["supabase-memories"])


class MemoryCreateBody(BaseModel):
    content: str = Field(..., min_length=1, max_length=MAX_MEMORY_CONTENT_LEN)
    kind: str = Field(default="general", max_length=32)


class MemoryForgetBody(BaseModel):
    query: str = Field(..., min_length=1, max_length=MAX_MEMORY_CONTENT_LEN)


@router.get("/api/memories")
def api_memories_list(request: Request) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    try:
        rows = list_memories(config, user.user_id, limit=MAX_USER_MEMORIES)
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "memories": rows, "count": len(rows), "max": MAX_USER_MEMORIES}


@router.post("/api/memories")
def api_memories_create(request: Request, body: MemoryCreateBody) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    kind = (body.kind or "general").strip().lower() or "general"
    if kind not in ("general", "name", "like", "dislike", "identity", "preference"):
        kind = "general"
    try:
        row = create_memory(config, user.user_id, body.content.strip(), kind=kind)
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"ok": True, "memory": row}


@router.delete("/api/memories/{memory_id}")
def api_memories_delete(request: Request, memory_id: str) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    try:
        delete_memory(config, user.user_id, memory_id)
    except SupabaseDbError as exc:
        status = exc.status if exc.status and 400 <= exc.status < 600 else 502
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"ok": True, "deleted_id": memory_id}


@router.post("/api/memories/forget")
def api_memories_forget(request: Request, body: MemoryForgetBody) -> dict[str, Any]:
    config = get_supabase_config()
    if not config.db_configured:
        raise HTTPException(status_code=503, detail="Supabase database is not configured.")
    user = require_auth_user(request, config)
    try:
        deleted = forget_memories_matching(config, user.user_id, body.query.strip())
    except SupabaseDbError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {
        "ok": True,
        "deleted_count": len(deleted),
        "deleted": deleted,
    }
