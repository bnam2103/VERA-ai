"""Backend PostgREST access via the Supabase service role key (server-side only)."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from auth.supabase_config import SupabaseConfig


class SupabaseDbError(Exception):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def _rest_base(url: str) -> str:
    return url.rstrip("/") + "/rest/v1"


def _service_headers(service_role_key: str, *, prefer: str | None = None) -> dict[str, str]:
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def _request_json(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | list[Any] | None = None,
) -> Any:
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8")
            if not raw:
                return None
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        raise SupabaseDbError(detail or exc.reason or "Supabase request failed", exc.code) from exc
    except urllib.error.URLError as exc:
        raise SupabaseDbError(str(exc.reason or exc)) from exc


def get_profile(config: SupabaseConfig, user_id: str) -> dict[str, Any] | None:
    if not config.db_configured:
        return None
    q = urllib.parse.urlencode({"id": f"eq.{user_id}", "select": "*"})
    url = f"{_rest_base(config.url or '')}/profiles?{q}"
    rows = _request_json(
        "GET",
        url,
        _service_headers(config.service_role_key or ""),
    )
    if isinstance(rows, list) and rows:
        row = rows[0]
        return row if isinstance(row, dict) else None
    return None


def insert_profile(
    config: SupabaseConfig,
    user_id: str,
    *,
    display_name: str | None = None,
    avatar_url: str | None = None,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    url = f"{_rest_base(config.url or '')}/profiles"
    payload: dict[str, Any] = {"id": user_id}
    if display_name is not None:
        payload["display_name"] = display_name
    if avatar_url is not None:
        payload["avatar_url"] = avatar_url
    rows = _request_json(
        "POST",
        url,
        _service_headers(config.service_role_key or "", prefer="return=representation"),
        payload,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    if isinstance(rows, dict):
        return rows
    return payload


def ensure_profile(
    config: SupabaseConfig,
    user_id: str,
    *,
    email: str | None = None,
) -> dict[str, Any]:
    existing = get_profile(config, user_id)
    if existing:
        return existing
    display_name = None
    if email and "@" in email:
        display_name = email.split("@", 1)[0] or None
    return insert_profile(config, user_id, display_name=display_name)


def update_profile(
    config: SupabaseConfig,
    user_id: str,
    *,
    display_name: str | None = None,
    avatar_url: str | None = None,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")

    patch: dict[str, Any] = {}
    if display_name is not None:
        patch["display_name"] = display_name
    if avatar_url is not None:
        patch["avatar_url"] = avatar_url
    if not patch:
        existing = get_profile(config, user_id)
        if existing:
            return existing
        return ensure_profile(config, user_id)

    q = urllib.parse.urlencode({"id": f"eq.{user_id}"})
    url = f"{_rest_base(config.url or '')}/profiles?{q}"
    rows = _request_json(
        "PATCH",
        url,
        _service_headers(config.service_role_key or "", prefer="return=representation"),
        patch,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]

    # Row may not exist yet (pre-trigger user or manual auth.users insert).
    return insert_profile(
        config,
        user_id,
        display_name=display_name,
        avatar_url=avatar_url,
    )


def get_user_settings(config: SupabaseConfig, user_id: str) -> dict[str, Any] | None:
    if not config.db_configured:
        return None
    q = urllib.parse.urlencode({"user_id": f"eq.{user_id}", "select": "*"})
    url = f"{_rest_base(config.url or '')}/user_settings?{q}"
    rows = _request_json(
        "GET",
        url,
        _service_headers(config.service_role_key or ""),
    )
    if isinstance(rows, list) and rows:
        row = rows[0]
        return row if isinstance(row, dict) else None
    return None


def insert_user_settings(
    config: SupabaseConfig,
    user_id: str,
    *,
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    url = f"{_rest_base(config.url or '')}/user_settings"
    payload: dict[str, Any] = {
        "user_id": user_id,
        "settings": settings if isinstance(settings, dict) else {},
    }
    rows = _request_json(
        "POST",
        url,
        _service_headers(config.service_role_key or "", prefer="return=representation"),
        payload,
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    if isinstance(rows, dict):
        return rows
    return payload


def ensure_user_settings(
    config: SupabaseConfig,
    user_id: str,
) -> dict[str, Any]:
    existing = get_user_settings(config, user_id)
    if existing:
        return existing
    return insert_user_settings(config, user_id, settings={})


def update_user_settings(
    config: SupabaseConfig,
    user_id: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    if not config.db_configured:
        raise SupabaseDbError("Supabase database is not configured.")
    ensure_user_settings(config, user_id)
    q = urllib.parse.urlencode({"user_id": f"eq.{user_id}"})
    url = f"{_rest_base(config.url or '')}/user_settings?{q}"
    rows = _request_json(
        "PATCH",
        url,
        _service_headers(config.service_role_key or "", prefer="return=representation"),
        {"settings": settings if isinstance(settings, dict) else {}},
    )
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        return rows[0]
    existing = get_user_settings(config, user_id)
    if existing:
        return existing
    return insert_user_settings(config, user_id, settings=settings)
