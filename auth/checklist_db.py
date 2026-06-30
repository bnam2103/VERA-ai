"""Supabase persistence for account-linked work checklists."""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any

from auth.checklist_merge import CHECKLIST_META_KEY, is_checklist_placeholder_item
from auth.supabase_config import SupabaseConfig
from auth.supabase_db import (
    SupabaseDbError,
    _request_json,
    _rest_base,
    _service_headers,
    ensure_user_settings,
    get_user_settings,
    update_user_settings,
)

_log = logging.getLogger(__name__)


def _rows_to_client_items(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        item: dict[str, Any] = {
            "id": str(row.get("client_id") or "").strip()[:80],
            "text": str(row.get("text") or "").replace("\r", " ").replace("\n", " ").strip()[:200],
            "done": bool(row.get("completed")),
            "parent_id": str(row.get("parent_id")).strip()[:80]
            if row.get("parent_id") is not None
            else None,
        }
        created = row.get("created_at")
        if created:
            item["created_at"] = created
        if not item["id"]:
            continue
        if is_checklist_placeholder_item(item):
            continue
        out.append(item)
    return out


def _client_items_to_rows(user_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for idx, row in enumerate(items[:300]):
        if not isinstance(row, dict):
            continue
        if row.get("id") == "__vera_wm_checklist_placeholder__":
            continue
        client_id = str(row.get("id", "")).strip()[:80]
        if not client_id:
            continue
        text = str(row.get("text", "")).replace("\r", " ").replace("\n", " ").strip()[:200]
        done = bool(row.get("done"))
        if is_checklist_placeholder_item({"id": client_id, "text": text, "done": done}):
            continue
        parent_id = row.get("parent_id")
        parent_norm = str(parent_id).strip()[:80] if parent_id is not None else None
        if parent_norm == client_id:
            parent_norm = None
        payload: dict[str, Any] = {
            "user_id": user_id,
            "client_id": client_id,
            "text": text,
            "completed": done,
            "parent_id": parent_norm,
            "sort_order": len(rows),
        }
        created = row.get("created_at")
        if created is not None:
            payload["created_at"] = created
        rows.append(payload)
    return rows


def list_checklist_items(config: SupabaseConfig, user_id: str) -> list[dict[str, Any]]:
    if not config.db_configured:
        return []
    q = urllib.parse.urlencode(
        {
            "user_id": f"eq.{user_id}",
            "select": "client_id,text,completed,parent_id,sort_order,created_at,updated_at,source",
            "order": "sort_order.asc",
        }
    )
    url = f"{_rest_base(config.url or '')}/checklist_items?{q}"
    rows = _request_json("GET", url, _service_headers(config.service_role_key or ""))
    if not isinstance(rows, list):
        return []
    clean = _rows_to_client_items(rows)
    removed = max(0, len(rows) - len(clean))
    if removed > 0:
        _log.info(
            "[checklist_cleanup] user_id=%s removed_count=%s remote_count=%s",
            user_id,
            removed,
            len(clean),
        )
    return clean


def get_checklist_meta(config: SupabaseConfig, user_id: str) -> dict[str, Any]:
    row = get_user_settings(config, user_id)
    settings = row.get("settings") if isinstance(row, dict) else {}
    if not isinstance(settings, dict):
        return {}
    meta = settings.get(CHECKLIST_META_KEY)
    return meta if isinstance(meta, dict) else {}


def replace_checklist_for_user(
    config: SupabaseConfig,
    user_id: str,
    items: list[dict[str, Any]],
    *,
    completed_collapsed: bool | None = None,
) -> int:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")

    delete_q = urllib.parse.urlencode({"user_id": f"eq.{user_id}"})
    delete_url = f"{_rest_base(config.url or '')}/checklist_items?{delete_q}"
    _request_json(
        "DELETE",
        delete_url,
        _service_headers(config.service_role_key or ""),
    )

    rows = _client_items_to_rows(user_id, items)
    skipped = max(0, len(items) - len(rows))
    if skipped > 0:
        _log.info(
            "[checklist_cleanup] user_id=%s removed_count=%s saved_count=%s",
            user_id,
            skipped,
            len(rows),
        )
    if rows:
        insert_url = f"{_rest_base(config.url or '')}/checklist_items"
        _request_json(
            "POST",
            insert_url,
            _service_headers(config.service_role_key or "", prefer="return=minimal"),
            rows,
        )

    if completed_collapsed is not None:
        settings_row = ensure_user_settings(config, user_id)
        settings = settings_row.get("settings") if isinstance(settings_row, dict) else {}
        if not isinstance(settings, dict):
            settings = {}
        meta = settings.get(CHECKLIST_META_KEY)
        if not isinstance(meta, dict):
            meta = {}
        meta = {**meta, "completed_collapsed": bool(completed_collapsed)}
        settings = {**settings, CHECKLIST_META_KEY: meta}
        update_user_settings(config, user_id, settings)

    return len(rows)


def load_checklist_bundle(
    config: SupabaseConfig,
    user_id: str,
) -> tuple[list[dict[str, Any]], bool | None]:
    items = list_checklist_items(config, user_id)
    meta = get_checklist_meta(config, user_id)
    collapsed = meta.get("completed_collapsed")
    if collapsed is None:
        return items, None
    return items, bool(collapsed)
