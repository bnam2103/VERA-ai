"""Merge local + remote Vera work checklists (dedupe by normalized text)."""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

CHECKLIST_META_KEY = "checklist_meta_v1"
CHECKLIST_PLACEHOLDER_LABEL = "list item"


def is_checklist_placeholder_item(row: dict[str, Any]) -> bool:
    text = normalize_checklist_text(str(row.get("text") or ""))
    if not text:
        return True
    if not bool(row.get("done")) and text == CHECKLIST_PLACEHOLDER_LABEL:
        return True
    return False


def normalize_checklist_text(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _created_at_ms(item: dict[str, Any]) -> float | None:
    raw = item.get("created_at")
    if isinstance(raw, (int, float)):
        return float(raw)
    return None


def _normalize_row(row: object) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    rid = str(row.get("id", "")).strip()[:80]
    text = str(row.get("text", "")).replace("\r", " ").replace("\n", " ").strip()[:200]
    done = bool(row.get("done"))
    if is_checklist_placeholder_item({"text": text, "done": done}):
        return None
    if not rid:
        rid = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:6]}"
    parent_id = row.get("parent_id")
    parent_norm = str(parent_id).strip()[:80] if parent_id is not None else None
    if parent_norm == rid:
        parent_norm = None
    out: dict[str, Any] = {
        "id": rid,
        "text": text,
        "done": done,
        "parent_id": parent_norm,
    }
    created = _created_at_ms(row)
    if created is not None:
        out["created_at"] = created
    return out


def _merge_key(item: dict[str, Any]) -> str:
    text = str(item.get("text") or "")
    if not text.strip():
        return f"__empty__:{item.get('id')}"
    return normalize_checklist_text(text)


def _merge_pair(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = dict(existing)
    if bool(incoming.get("done")):
        merged["done"] = True
    incoming_created = _created_at_ms(incoming)
    existing_created = _created_at_ms(merged)
    if incoming_created is not None and (
        existing_created is None or incoming_created < existing_created
    ):
        merged["created_at"] = incoming_created
        if incoming.get("id"):
            merged["id"] = incoming["id"]
    if str(incoming.get("text") or "").strip() and not str(merged.get("text") or "").strip():
        merged["text"] = incoming["text"]
    if incoming.get("parent_id") and not merged.get("parent_id"):
        merged["parent_id"] = incoming["parent_id"]
    return merged


def strip_checklist_placeholder_items(
    items: list[dict[str, Any]] | None,
) -> tuple[list[dict[str, Any]], int]:
    """Drop placeholder/empty ongoing rows; return (clean_items, removed_count)."""
    if not items:
        return [], 0
    clean: list[dict[str, Any]] = []
    removed = 0
    for row in items:
        if not isinstance(row, dict):
            removed += 1
            continue
        normalized = _normalize_row(row)
        if normalized is None:
            removed += 1
            continue
        clean.append(normalized)
    return clean[:300], removed


def merge_checklist_items(
    local: list[dict[str, Any]] | None,
    remote: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Merge two checklist arrays. Local order is preserved; remote-only rows append."""
    merged: dict[str, dict[str, Any]] = {}
    local_keys: list[str] = []
    remote_only_keys: list[str] = []

    for row in local or []:
        item = _normalize_row(row)
        if not item:
            continue
        key = _merge_key(item)
        if key not in merged:
            merged[key] = item
            local_keys.append(key)
        else:
            merged[key] = _merge_pair(merged[key], item)

    for row in remote or []:
        item = _normalize_row(row)
        if not item:
            continue
        key = _merge_key(item)
        if key not in merged:
            merged[key] = item
            remote_only_keys.append(key)
        else:
            merged[key] = _merge_pair(merged[key], item)

    out: list[dict[str, Any]] = []
    for key in local_keys:
        if key in merged:
            out.append(merged[key])
    for key in remote_only_keys:
        if key in merged:
            out.append(merged[key])
    return out[:300]


def merge_completed_collapsed(local: bool | None, remote: bool | None) -> bool:
    if remote is not None:
        return bool(remote)
    return bool(local)
