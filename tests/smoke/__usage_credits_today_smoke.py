"""Smoke: GET /api/usage/credits/today (daily credit pill API).

Run:  py -3 -X utf8 tests\\smoke\\__usage_credits_today_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
import time
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

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth.supabase_config import SupabaseConfig
from auth.usage_credits_routes import router as usage_credits_router

passed = 0
failed = 0

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SECRET = "usage-credits-test-secret"
SESSION = "sess-credits-smoke"


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


def _make_token(*, sub: str) -> str:
    payload = {
        "sub": sub,
        "email": "alice@example.com",
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def _credits_client() -> TestClient:
    app = FastAPI()
    app.include_router(usage_credits_router)
    cfg = SupabaseConfig(
        url="https://example.supabase.co",
        service_role_key="test-service-role",
        jwt_secret=SECRET,
    )
    import auth.usage_credits_routes as uc_routes
    import auth.jwt_auth as jwt_mod

    uc_routes.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    jwt_mod.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    return TestClient(app)


section("anonymous credits today")
with patch("auth.usage_credits_routes.credit_db_available", return_value=False):
    client = _credits_client()
    res = client.get("/api/usage/credits/today", params={"session_id": SESSION})
    ok(res.status_code == 200, "anonymous GET returns 200")
    body = res.json()
    ok(body.get("ok") is True, "ok=true")
    ok(body.get("auth_mode") == "anonymous", "auth_mode anonymous")
    ok(body.get("credits_used") == 0, "credits_used 0 when db unavailable")
    ok(body.get("credits_cap") == 100, "anonymous cap 100")
    ok(body.get("base_credits_cap") == 100, "anonymous base cap 100")
    ok(body.get("bonus_credits") == 0, "anonymous bonus 0 by default")
    ok(body.get("remaining_credits") == 100, "remaining 100")
    ok(body.get("no_cap_toggle_enabled") is False, "no_cap_toggle_enabled false by default")
    ok(body.get("no_cap_active") is False, "no_cap_active false by default")
    ok("features" not in body, "no feature sub-caps in response")
    ok(bool(body.get("usage_date")), "usage_date present")
    ok(bool(body.get("reset_time")), "reset_time present")

section("authenticated credits today")
_daily = {
    "credits_used": 42,
    "bonus_credits": 0,
    "reasoning_streams": 3,
    "search_turns": 8,
    "image_pdf_reasoning_turns": 0,
}
with patch("auth.usage_credits_routes.credit_db_available", return_value=True):
    with patch("auth.usage_credits_routes.get_daily_credit_usage", return_value=_daily):
        client = _credits_client()
        token = _make_token(sub=USER_A)
        res = client.get(
            "/api/usage/credits/today",
            params={"session_id": SESSION},
            headers={"Authorization": f"Bearer {token}"},
        )
        ok(res.status_code == 200, "authenticated GET returns 200")
        body = res.json()
        ok(body.get("auth_mode") == "authenticated", "auth_mode authenticated")
        ok(body.get("credits_used") == 42, "credits_used from daily row")
        ok(body.get("credits_cap") == 200, "signed-in effective cap 200 without bonus")
        ok(body.get("base_credits_cap") == 200, "signed-in base cap 200")
        ok(body.get("remaining_credits") == 158, "remaining credits")
        ok("features" not in body, "no feature sub-caps in response")

section("frontend pill does not display feature sub-caps")
pill_src = open(os.path.join(_ROOT, "users", "usageCredits.js"), encoding="utf-8").read()
ok("Work Mode:" not in pill_src, "pill JS omits work mode limits")
ok("Search:" not in pill_src, "pill JS omits search limits")
ok("Image/PDF:" not in pill_src, "pill JS omits image/pdf limits")
ok("Give feedback to unlock +50 credits" in pill_src, "pill tooltip mentions feedback bonus")

section("optional auth fallback")
with patch("auth.usage_credits_routes.credit_db_available", return_value=False):
    client = _credits_client()
    bad = client.get(
        "/api/usage/credits/today",
        params={"session_id": SESSION},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    ok(bad.status_code == 200, "invalid bearer falls back to 200 anonymous")
    ok(bad.json().get("auth_mode") == "anonymous", "invalid bearer auth_mode anonymous")

token = _make_token(sub=USER_A)
with patch("auth.usage_credits_routes.credit_db_available", return_value=False):
    client = _credits_client()
    good = client.get(
        "/api/usage/credits/today",
        params={"session_id": SESSION},
        headers={"Authorization": f"Bearer {token}"},
    )
    ok(good.status_code == 200, "valid bearer returns 200")
    ok(good.json().get("auth_mode") == "authenticated", "valid bearer auth_mode authenticated")

section("validation errors")
client = _credits_client()
missing = client.get("/api/usage/credits/today")
ok(missing.status_code == 422, "missing session_id returns 422")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
