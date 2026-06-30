"""Supabase persistence for account-linked Work Mode reasoning workspaces."""

from __future__ import annotations

import json
import logging
import urllib.parse
from datetime import datetime, timezone
from typing import Any

from auth.supabase_config import SupabaseConfig
from auth.supabase_db import SupabaseDbError, _request_json, _rest_base, _service_headers

_log = logging.getLogger(__name__)

WORKSPACE_MAX_TABS = 8
WORKSPACE_MAX_SUMMARY_CHARS = 4000
WORKSPACE_MAX_RENDERED_HTML_CHARS = 120_000
WORKSPACE_MAX_MESSAGES = 30
WORKSPACE_MAX_MESSAGES_JSON_CHARS = 50_000
WORKSPACE_MAX_REGISTRY_JSON_CHARS = 32_000
WORKSPACE_MAX_TITLE_CHARS = 120
WORKSPACE_MAX_LANE_ID_CHARS = 80

# PostgREST bulk insert requires identical keys on every row (PGRST102).
WORKSPACE_TAB_SUPABASE_KEYS: tuple[str, ...] = (
    "user_id",
    "lane_id",
    "sort_order",
    "title",
    "lane_label",
    "is_active",
    "closed",
    "summary",
    "registry",
    "messages",
    "rendered_html",
    "last_opened_at",
)


class WorkspacePayloadError(Exception):
    """Structural workspace PUT payload error (not oversized field — those are truncated)."""

    def __init__(self, message: str, *, field: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.field = field


_REGISTRY_ALLOWED_KEYS = frozenset(
    {
        "lane_id",
        "active_lane_id",
        "title",
        "lane_title",
        "last_user_request",
        "prior_problem_anchor",
        "latest_reasoning_summary",
        "latest_visible_markdown",
        "latest_assistant_turn",
        "latest_substantive_excerpt",
        "latest_clarification_excerpt",
        "main_context_excerpt",
        "main_context_type",
        "latest_turn_type",
        "latest_final_answer_excerpt",
        "latest_markdown_preview",
        "code_or_math_generated",
        "updated_at",
    }
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _truncate_text(value: Any, limit: int) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit]


def _registry_json_len(value: Any) -> int:
    try:
        return len(json.dumps(value if isinstance(value, dict) else {}, ensure_ascii=False))
    except (TypeError, ValueError):
        return -1


def _messages_count(value: Any) -> int:
    return len(value) if isinstance(value, list) else 0


def _coerce_iso_timestamp(value: Any) -> str | None:
    """Return an ISO timestamp string for PostgREST timestamptz columns, or None."""
    if value is None or isinstance(value, (int, float)):
        return None
    text = str(value).strip()
    if not text or text.isdigit() or "T" not in text:
        return None
    if len(text) < 19:
        return None
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return text[:40]


def describe_workspace_put_payload_for_log(raw: Any) -> dict[str, Any]:
    """Safe metadata snapshot for server logs (no html/message text)."""
    if not isinstance(raw, dict):
        return {"body_type": type(raw).__name__}
    tabs_in = raw.get("tabs")
    tabs = tabs_in if isinstance(tabs_in, list) else []
    rev = raw.get("client_revision")
    tab_meta: list[dict[str, Any]] = []
    for idx, tab in enumerate(tabs[:WORKSPACE_MAX_TABS + 2]):
        if not isinstance(tab, dict):
            tab_meta.append({"index": idx, "invalid": True})
            continue
        lane_id = str(tab.get("lane_id") or "").strip()
        html = tab.get("rendered_html")
        tab_meta.append(
            {
                "index": idx,
                "lane_id_present": bool(lane_id),
                "lane_id_len": len(lane_id),
                "sort_order": tab.get("sort_order"),
                "title_len": len(str(tab.get("title") or "")),
                "rendered_html_len": len(str(html or "")),
                "messages_count": _messages_count(tab.get("messages")),
                "registry_json_len": _registry_json_len(tab.get("registry")),
                "closed": bool(tab.get("closed")),
            }
        )
    return {
        "raw_tab_count": len(tabs),
        "client_revision_type": type(rev).__name__,
        "client_revision": rev,
        "active_lane_id": str(raw.get("active_lane_id") or "").strip() or None,
        "tabs": tab_meta,
    }


def _sanitize_registry(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, Any] = {}
    for key in _REGISTRY_ALLOWED_KEYS:
        if key not in value:
            continue
        val = value.get(key)
        if val is None:
            continue
        if key in {"code_or_math_generated"}:
            out[key] = bool(val)
        elif key == "updated_at":
            try:
                out[key] = int(val)
            except (TypeError, ValueError):
                continue
        else:
            out[key] = _truncate_text(val, 12_000 if "excerpt" in key or "markdown" in key else 2000)
    raw = json.dumps(out, ensure_ascii=False)
    if len(raw) > WORKSPACE_MAX_REGISTRY_JSON_CHARS:
        # Drop large markdown fields first.
        for drop_key in (
            "latest_visible_markdown",
            "latest_assistant_turn",
            "main_context_excerpt",
            "latest_final_answer_excerpt",
            "latest_markdown_preview",
        ):
            out.pop(drop_key, None)
            raw = json.dumps(out, ensure_ascii=False)
            if len(raw) <= WORKSPACE_MAX_REGISTRY_JSON_CHARS:
                break
    return out


def _sanitize_messages(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    total_chars = 0
    for item in value[-WORKSPACE_MAX_MESSAGES:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in {"user", "assistant", "system"}:
            continue
        text = _truncate_text(item.get("text"), 8000)
        if not text:
            continue
        total_chars += len(text)
        if total_chars > WORKSPACE_MAX_MESSAGES_JSON_CHARS:
            break
        row: dict[str, Any] = {
            "role": role,
            "text": text,
        }
        if item.get("turn_id"):
            row["turn_id"] = _truncate_text(item.get("turn_id"), 80)
        if item.get("created_at"):
            row["created_at"] = _truncate_text(item.get("created_at"), 40)
        if item.get("kind"):
            row["kind"] = _truncate_text(item.get("kind"), 32)
        out.append(row)
    return out


def _normalize_client_tab(tab: Any, *, sort_order: int) -> dict[str, Any] | None:
    if not isinstance(tab, dict):
        return None
    lane_id = str(tab.get("lane_id") or "").strip()[:WORKSPACE_MAX_LANE_ID_CHARS]
    if not lane_id:
        return None
    title = _truncate_text(tab.get("title") or "Untitled", WORKSPACE_MAX_TITLE_CHARS) or "Untitled"
    lane_label = _truncate_text(tab.get("lane_label") or title, WORKSPACE_MAX_TITLE_CHARS) or title
    summary = _truncate_text(tab.get("summary"), WORKSPACE_MAX_SUMMARY_CHARS)
    closed = bool(tab.get("closed"))
    rendered_html = ""
    if not closed:
        rendered_html = _truncate_text(tab.get("rendered_html"), WORKSPACE_MAX_RENDERED_HTML_CHARS)
    messages = _sanitize_messages(tab.get("messages"))
    registry = _sanitize_registry(tab.get("registry"))
    opened = tab.get("last_opened_at")
    opened_iso = _coerce_iso_timestamp(opened)
    row: dict[str, Any] = {
        "lane_id": lane_id,
        "sort_order": int(sort_order),
        "title": title,
        "lane_label": lane_label,
        "is_active": bool(tab.get("is_active")),
        "closed": closed,
        "summary": summary or None,
        "registry": registry,
        "messages": messages,
        "rendered_html": rendered_html,
        "last_opened_at": opened_iso,
    }
    return row


def normalize_workspace_put_payload(raw: Any) -> dict[str, Any]:
    """Normalize + truncate client PUT body. Skips tabs without lane_id."""
    if not isinstance(raw, dict):
        raise WorkspacePayloadError("Body must be a JSON object.", field="body")

    tabs_in = raw.get("tabs")
    if tabs_in is None:
        tabs_in = []
    if not isinstance(tabs_in, list):
        raise WorkspacePayloadError("tabs must be an array.", field="tabs")
    if len(tabs_in) > WORKSPACE_MAX_TABS:
        _log.warning(
            "[workspace_normalize] truncating tabs from %s to %s",
            len(tabs_in),
            WORKSPACE_MAX_TABS,
        )
        tabs_in = tabs_in[:WORKSPACE_MAX_TABS]

    try:
        client_revision = int(raw.get("client_revision") or 0)
    except (TypeError, ValueError):
        client_revision = 0
    if client_revision < 0:
        client_revision = 0

    tabs_out: list[dict[str, Any]] = []
    for tab in tabs_in:
        norm = _normalize_client_tab(tab, sort_order=len(tabs_out))
        if norm:
            tabs_out.append(norm)

    active_lane_id = str(raw.get("active_lane_id") or "").strip()[:WORKSPACE_MAX_LANE_ID_CHARS] or None
    if active_lane_id and not any(t.get("lane_id") == active_lane_id for t in tabs_out):
        active_lane_id = None
    if not active_lane_id:
        for tab in tabs_out:
            if tab.get("is_active") and tab.get("lane_id"):
                active_lane_id = str(tab["lane_id"])
                break
    if not active_lane_id and tabs_out:
        active_lane_id = str(tabs_out[0].get("lane_id") or "") or None

    return {
        "client_revision": client_revision,
        "active_lane_id": active_lane_id,
        "tabs": tabs_out,
    }


def _finalize_supabase_tab_row(user_id: str, client: dict[str, Any], *, sort_order: int) -> dict[str, Any]:
    """Build a uniform PostgREST row — every insert object must share the same keys."""
    lane_label = client.get("lane_label")
    summary = client.get("summary")
    rendered = client.get("rendered_html")
    return {
        "user_id": user_id,
        "lane_id": client["lane_id"],
        "sort_order": int(sort_order),
        "title": client.get("title") or "Untitled",
        "lane_label": str(lane_label).strip() if lane_label else None,
        "is_active": bool(client.get("is_active")),
        "closed": bool(client.get("closed")),
        "summary": str(summary).strip() if summary else None,
        "registry": client.get("registry") if isinstance(client.get("registry"), dict) else {},
        "messages": client.get("messages") if isinstance(client.get("messages"), list) else [],
        "rendered_html": str(rendered) if rendered else "",
        "last_opened_at": client.get("last_opened_at") or None,
    }


def _assert_uniform_tab_row_keys(tab_rows: list[dict[str, Any]]) -> None:
    if not tab_rows:
        return
    key_sets = {frozenset(row.keys()) for row in tab_rows}
    if len(key_sets) == 1:
        expected = frozenset(WORKSPACE_TAB_SUPABASE_KEYS)
        if key_sets.pop() != expected:
            _log.warning(
                "[workspace_tab_row_key_mismatch] expected=%s got=%s",
                sorted(WORKSPACE_TAB_SUPABASE_KEYS),
                sorted(tab_rows[0].keys()),
            )
        return
    _log.error(
        "[workspace_tab_row_key_mismatch] key_sets=%s",
        [sorted(ks) for ks in key_sets],
    )
    raise SupabaseDbError(
        "Tab row key mismatch before bulk insert (PGRST102: All object keys must match).",
        status=400,
    )


def _tab_row_for_supabase(user_id: str, tab: dict[str, Any], *, sort_order: int) -> dict[str, Any] | None:
    """Build a PostgREST row with a uniform key set for bulk insert."""
    if isinstance(tab, dict) and tab.get("lane_id") and tab.get("user_id"):
        client = tab
    else:
        client = _normalize_client_tab(tab, sort_order=sort_order)
    if not client:
        return None
    return _finalize_supabase_tab_row(user_id, client, sort_order=sort_order)


def _sanitize_tab_row(user_id: str, tab: dict[str, Any], *, sort_order: int) -> dict[str, Any] | None:
    return _tab_row_for_supabase(user_id, tab, sort_order=sort_order)


def _client_tab_from_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "lane_id": row.get("lane_id"),
        "sort_order": row.get("sort_order"),
        "title": row.get("title"),
        "lane_label": row.get("lane_label"),
        "is_active": bool(row.get("is_active")),
        "closed": bool(row.get("closed")),
        "summary": row.get("summary") or "",
        "registry": row.get("registry") if isinstance(row.get("registry"), dict) else {},
        "messages": row.get("messages") if isinstance(row.get("messages"), list) else [],
        "rendered_html": row.get("rendered_html") or "",
        "last_opened_at": row.get("last_opened_at"),
        "updated_at": row.get("updated_at"),
    }


def load_workspace_bundle(config: SupabaseConfig, user_id: str) -> dict[str, Any] | None:
    if not config.db_configured:
        return None
    ws_q = urllib.parse.urlencode(
        {
            "user_id": f"eq.{user_id}",
            "select": "user_id,schema_version,active_lane_id,max_tabs,client_revision,updated_at",
            "limit": "1",
        }
    )
    ws_url = f"{_rest_base(config.url or '')}/work_mode_workspaces?{ws_q}"
    ws_rows = _request_json("GET", ws_url, _service_headers(config.service_role_key or ""))
    if not isinstance(ws_rows, list) or not ws_rows:
        return None
    workspace = ws_rows[0]
    tab_q = urllib.parse.urlencode(
        {
            "user_id": f"eq.{user_id}",
            "select": "lane_id,sort_order,title,lane_label,is_active,closed,summary,registry,messages,rendered_html,last_opened_at,updated_at",
            "order": "sort_order.asc",
        }
    )
    tab_url = f"{_rest_base(config.url or '')}/work_mode_workspace_tabs?{tab_q}"
    tab_rows = _request_json("GET", tab_url, _service_headers(config.service_role_key or ""))
    tabs = [_client_tab_from_row(r) for r in tab_rows if isinstance(r, dict)] if isinstance(tab_rows, list) else []
    return {
        "schema_version": int(workspace.get("schema_version") or 1),
        "active_lane_id": workspace.get("active_lane_id"),
        "max_tabs": int(workspace.get("max_tabs") or WORKSPACE_MAX_TABS),
        "client_revision": int(workspace.get("client_revision") or 0),
        "updated_at": workspace.get("updated_at"),
        "tabs": tabs,
    }


def _supabase_workspace_insert_hint(exc: SupabaseDbError, tab_rows: list[dict[str, Any]]) -> str:
    raw = str(exc)
    lowered = raw.lower()
    if "rendered_html" in lowered:
        return "field=rendered_html (check length <= 120000)"
    if "summary" in lowered:
        return "field=summary (check length <= 4000)"
    if "last_opened_at" in lowered or "updated_at" in lowered or "timestamp" in lowered:
        return "field=last_opened_at (invalid timestamptz)"
    if "pgrst102" in lowered or "all object keys must match" in lowered:
        keys_per_row = [sorted(r.keys()) for r in tab_rows[:5]]
        return f"field=persist PGRST102 key_sets={keys_per_row}"
    if "work_mode_workspace" in lowered and "does not exist" in lowered:
        return "migration 007_work_mode_workspace.sql not applied"
    if tab_rows:
        first = tab_rows[0]
        return (
            f"tab_count={len(tab_rows)} first_lane_id={first.get('lane_id')} "
            f"html_len={len(str(first.get('rendered_html') or ''))}"
        )
    return ""


def replace_workspace_for_user(
    config: SupabaseConfig,
    user_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")

    normalized = normalize_workspace_put_payload(payload)
    tabs_in = normalized.get("tabs") if isinstance(normalized.get("tabs"), list) else []
    client_revision = int(normalized.get("client_revision") or 0)
    active_lane_id = str(normalized.get("active_lane_id") or "").strip()[:WORKSPACE_MAX_LANE_ID_CHARS] or None

    delete_tabs_q = urllib.parse.urlencode({"user_id": f"eq.{user_id}"})
    delete_tabs_url = f"{_rest_base(config.url or '')}/work_mode_workspace_tabs?{delete_tabs_q}"
    _request_json("DELETE", delete_tabs_url, _service_headers(config.service_role_key or ""))

    tab_rows: list[dict[str, Any]] = []
    for idx, tab in enumerate(tabs_in[:WORKSPACE_MAX_TABS]):
        row = _sanitize_tab_row(user_id, tab, sort_order=idx)
        if row:
            tab_rows.append(row)

    if tab_rows:
        _assert_uniform_tab_row_keys(tab_rows)
        insert_url = f"{_rest_base(config.url or '')}/work_mode_workspace_tabs"
        try:
            _request_json(
                "POST",
                insert_url,
                _service_headers(config.service_role_key or "", prefer="return=minimal"),
                tab_rows,
            )
        except SupabaseDbError as exc:
            hint = _supabase_workspace_insert_hint(exc, tab_rows)
            raise SupabaseDbError(
                f"{exc}; {hint}" if hint else str(exc),
                exc.status,
            ) from exc

    ws_row = {
        "user_id": user_id,
        "schema_version": 1,
        "active_lane_id": active_lane_id,
        "max_tabs": WORKSPACE_MAX_TABS,
        "client_revision": client_revision,
        "updated_at": _utc_now_iso(),
    }
    upsert_url = f"{_rest_base(config.url or '')}/work_mode_workspaces?on_conflict=user_id"
    _request_json(
        "POST",
        upsert_url,
        _service_headers(config.service_role_key or "", prefer="resolution=merge-duplicates,return=representation"),
        ws_row,
    )

    return {
        "tab_count": len(tab_rows),
        "client_revision": client_revision,
        "active_lane_id": active_lane_id,
    }


def delete_workspace_for_user(config: SupabaseConfig, user_id: str) -> None:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    delete_tabs_q = urllib.parse.urlencode({"user_id": f"eq.{user_id}"})
    delete_tabs_url = f"{_rest_base(config.url or '')}/work_mode_workspace_tabs?{delete_tabs_q}"
    _request_json("DELETE", delete_tabs_url, _service_headers(config.service_role_key or ""))
    delete_ws_q = urllib.parse.urlencode({"user_id": f"eq.{user_id}"})
    delete_ws_url = f"{_rest_base(config.url or '')}/work_mode_workspaces?{delete_ws_q}"
    _request_json("DELETE", delete_ws_url, _service_headers(config.service_role_key or ""))
