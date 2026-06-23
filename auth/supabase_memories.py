"""Supabase public.memories access (service role, scoped by verified user_id)."""

from __future__ import annotations

import re
import urllib.parse
from typing import Any

from auth.supabase_config import SupabaseConfig
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers
from auth.memory_normalize import (
    forget_query_variants,
    format_memory_for_display,
    infer_memory_kind,
    normalize_memory_for_storage,
)

MAX_USER_MEMORIES = 50
MAX_MEMORY_CONTENT_LEN = 500
MAX_INJECTED_MEMORIES = 8


def _public_memory_row(row: dict[str, Any]) -> dict[str, Any]:
    content = row.get("content")
    return {
        "id": row.get("id"),
        "content": content,
        "display_content": format_memory_for_display(str(content or "")),
        "kind": row.get("kind") or "general",
        "source": row.get("source") or "explicit",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def list_memories(
    config: SupabaseConfig,
    user_id: str,
    *,
    limit: int = MAX_USER_MEMORIES,
) -> list[dict[str, Any]]:
    if not config.db_configured:
        return []
    lim = max(1, min(int(limit), MAX_USER_MEMORIES))
    q = urllib.parse.urlencode(
        {
            "user_id": f"eq.{user_id}",
            "select": "id,content,kind,source,created_at,updated_at",
            "order": "created_at.desc",
            "limit": str(lim),
        }
    )
    url = f"{_rest_base(config.url or '')}/memories?{q}"
    rows = _request_json("GET", url, _service_headers(config.service_role_key or ""))
    if not isinstance(rows, list):
        return []
    return [_public_memory_row(r) for r in rows if isinstance(r, dict)]


def count_memories(config: SupabaseConfig, user_id: str) -> int:
    return len(list_memories(config, user_id, limit=MAX_USER_MEMORIES))


def create_memory(
    config: SupabaseConfig,
    user_id: str,
    content: str,
    *,
    kind: str = "general",
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    text = (content or "").strip()
    if not text:
        raise SupabaseDbError("Memory content is required.", 400)
    text = normalize_memory_for_storage(text)
    if kind == "general":
        kind = infer_memory_kind(text)
    if len(text) > MAX_MEMORY_CONTENT_LEN:
        raise SupabaseDbError(f"Memory content exceeds {MAX_MEMORY_CONTENT_LEN} characters.", 400)
    if count_memories(config, user_id) >= MAX_USER_MEMORIES:
        raise SupabaseDbError(
            f"You can save at most {MAX_USER_MEMORIES} explicit memories. Delete one before adding more.",
            409,
        )
    url = f"{_rest_base(config.url or '')}/memories"
    payload = {
        "user_id": user_id,
        "content": text,
        "kind": kind,
        "source": "explicit",
    }
    rows = _request_json(
        "POST",
        url,
        _service_headers(config.service_role_key or "", prefer="return=representation"),
        payload,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return _public_memory_row(rows[0])
    return payload


def delete_memory(config: SupabaseConfig, user_id: str, memory_id: str) -> bool:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    mid = (memory_id or "").strip()
    if not mid:
        raise SupabaseDbError("Memory id is required.", 400)
    q = urllib.parse.urlencode({"id": f"eq.{mid}", "user_id": f"eq.{user_id}"})
    url = f"{_rest_base(config.url or '')}/memories?{q}"
    _request_json("DELETE", url, _service_headers(config.service_role_key or ""))
    return True


def _forget_text_match(query: str, content: str) -> bool:
    q_variants = forget_query_variants(query)
    c = (content or "").strip().lower()
    if not q_variants or not c:
        return False
    for q_raw in q_variants:
        q = (q_raw or "").strip().lower()
        if not q:
            continue
        if q in c or c in q:
            return True
        q_words = {w for w in re.findall(r"[a-z0-9']+", q) if len(w) > 2}
        c_words = {w for w in re.findall(r"[a-z0-9']+", c) if len(w) > 2}
        if len(q_words) < 2:
            if q == c:
                return True
            continue
        shared = q_words & c_words
        if len(shared) >= max(2, int(0.5 * len(q_words))):
            return True
    return False


def forget_memories_matching(
    config: SupabaseConfig,
    user_id: str,
    query_text: str,
) -> list[dict[str, Any]]:
    query = (query_text or "").strip()
    if not query:
        return []
    rows = list_memories(config, user_id, limit=MAX_USER_MEMORIES)
    deleted: list[dict[str, Any]] = []
    for row in rows:
        content = str(row.get("content") or "")
        if _forget_text_match(query, content):
            delete_memory(config, user_id, str(row.get("id") or ""))
            deleted.append(row)
    return deleted
