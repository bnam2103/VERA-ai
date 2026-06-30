"""Smoke tests: Supabase user_settings API + vera_prefs_v1 validation."""

from __future__ import annotations

import io
import os
import sys
import uuid
from unittest.mock import patch

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth.jwt_auth import AuthUser
from auth.settings_prefs import VERA_PREFS_KEY, merge_settings_patch, normalize_vera_prefs_v1
from auth.settings_routes import router as settings_router

passed = 0
failed = 0

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


def ok(cond: bool, msg: str) -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  OK  {msg}")
    else:
        failed += 1
        print(f" FAIL {msg}")


def section(title: str) -> None:
    print(f"\n== {title} ==")


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(settings_router)
    return TestClient(app)


section("normalize_vera_prefs_v1")
norm = normalize_vera_prefs_v1(
    {
        "asr_mode": "HYBRID",
        "asr_silence_ms": 1300,
        "workmode_mute": "1",
        "text_guide_rotator": False,
        "main_asr_partial_min_chars": "inf",
        "work_left_panes_layout": "split",
        "evil": "drop-me",
    }
)
ok(norm.get("asr_mode") == "hybrid", "asr_mode normalized")
ok(norm.get("workmode_mute") is True, "workmode_mute bool")
ok(norm.get("main_asr_partial_min_chars") == "inf", "partial inf preserved")
ok("evil" not in norm, "unknown keys dropped")

section("merge_settings_patch")
merged = merge_settings_patch(
    {VERA_PREFS_KEY: {"asr_mode": "streaming", "asr_silence_ms": 1000}},
    {VERA_PREFS_KEY: {"asr_mode": "whisper", "workmode_mute": True}},
)
prefs = merged.get(VERA_PREFS_KEY) or {}
ok(prefs.get("asr_mode") == "whisper", "patch overrides asr_mode")
ok(prefs.get("asr_silence_ms") == 1000, "unchanged keys preserved")
ok(prefs.get("workmode_mute") is True, "new keys merged")

section("GET /api/settings auth gate")
client = _make_client()
with patch("auth.settings_routes.get_supabase_config") as mock_cfg:
    mock_cfg.return_value.db_configured = True
    anon = client.get("/api/settings")
ok(anon.status_code == 401, "anonymous GET => 401")

section("logged-in settings roundtrip (mocked db)")
store: dict[str, dict] = {}


def _fake_ensure(config, user_id):
    row = store.get(user_id)
    if not row:
        row = {"user_id": user_id, "settings": {}}
        store[user_id] = row
    return row


def _fake_update(config, user_id, settings):
    row = _fake_ensure(config, user_id)
    row["settings"] = settings
    store[user_id] = row
    return row


with patch("auth.settings_routes.get_supabase_config") as mock_cfg, patch(
    "auth.settings_routes.require_auth_user"
) as mock_user, patch(
    "auth.settings_routes.ensure_user_settings", side_effect=_fake_ensure
), patch(
    "auth.settings_routes.update_user_settings", side_effect=_fake_update
):
    mock_cfg.return_value.db_configured = True
    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")

    seed = client.patch(
        "/api/settings",
        json={
            "vera_prefs_v1": {
                "asr_mode": "hybrid",
                "asr_silence_ms": 1600,
                "workmode_mute": True,
                "text_guide_rotator": False,
                "main_asr_partial_min_chars": 2,
                "work_left_panes_layout": "music-full",
            }
        },
    )
    ok(seed.status_code == 200, "PATCH seed => 200")
    got = client.get("/api/settings")
    ok(got.status_code == 200, "GET after seed => 200")
    body = got.json()
    prefs = body.get("vera_prefs_v1") or {}
    ok(prefs.get("asr_mode") == "hybrid", "GET returns saved asr_mode")
    ok(prefs.get("work_left_panes_layout") == "music-full", "GET returns layout")
    ok(body.get("empty") is False, "empty=false when prefs present")

section("user B isolation")
with patch("auth.settings_routes.get_supabase_config") as mock_cfg, patch(
    "auth.settings_routes.require_auth_user"
) as mock_user, patch(
    "auth.settings_routes.ensure_user_settings", side_effect=_fake_ensure
), patch(
    "auth.settings_routes.update_user_settings", side_effect=_fake_update
):
    mock_cfg.return_value.db_configured = True
    mock_user.return_value = AuthUser(user_id=USER_B, email="b@example.com")
    res_b = client.get("/api/settings")
    prefs_b = (res_b.json() or {}).get("vera_prefs_v1") or {}
    ok(prefs_b.get("asr_mode") is None, "user B does not see user A asr_mode")
    ok((store.get(USER_A) or {}).get("settings", {}).get(VERA_PREFS_KEY, {}).get("asr_mode") == "hybrid", "user A row intact")

section("invalid patch values stripped")
with patch("auth.settings_routes.get_supabase_config") as mock_cfg, patch(
    "auth.settings_routes.require_auth_user"
) as mock_user, patch(
    "auth.settings_routes.ensure_user_settings", side_effect=_fake_ensure
), patch(
    "auth.settings_routes.update_user_settings", side_effect=_fake_update
):
    mock_cfg.return_value.db_configured = True
    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    bad = client.patch(
        "/api/settings",
        json={"vera_prefs_v1": {"asr_mode": "invalid-mode", "asr_silence_ms": 9999}},
    )
    ok(bad.status_code == 200, "PATCH with junk still 200")
    prefs_after = (bad.json() or {}).get("vera_prefs_v1") or {}
    ok("asr_mode" not in prefs_after or prefs_after.get("asr_mode") != "invalid-mode", "invalid asr_mode not stored")
    ok("asr_silence_ms" not in prefs_after or prefs_after.get("asr_silence_ms") != 9999, "invalid silence not stored")

print(f"\nSupabase settings smoke: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
