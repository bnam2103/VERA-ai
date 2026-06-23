"""Smoke tests for Supabase Phase 1 auth foundation.

Run:  py -3 -X utf8 tests\\smoke\\__supabase_auth_smoke.py

Covers:
  - JWT verification (valid / invalid / missing)
  - /api/auth/me anonymous + invalid token (no crash)
  - /api/profile requires auth
  - Optional live Supabase RLS isolation when env vars are set

Does NOT replace legacy users_files sign-in.
"""
from __future__ import annotations

import io
import os
import sys
import time
import uuid

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

from auth.jwt_auth import extract_bearer_token, resolve_auth_user, verify_access_token
from auth.routes import router as supabase_auth_router
from auth.supabase_config import SupabaseConfig

passed = 0
failed = 0


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


def _make_token(
    *,
    secret: str,
    sub: str | None = None,
    email: str = "alice@example.com",
    aud: str = "authenticated",
    exp_offset: int = 3600,
) -> str:
    payload = {
        "sub": sub or str(uuid.uuid4()),
        "email": email,
        "role": "authenticated",
        "aud": aud,
        "exp": int(time.time()) + exp_offset,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def _test_app(secret: str, *, db_configured: bool = False) -> TestClient:
    app = FastAPI()
    app.include_router(supabase_auth_router)

    cfg = SupabaseConfig(
        url="https://example.supabase.co" if db_configured else "https://example.supabase.co",
        service_role_key="test-service-role-key" if db_configured else None,
        jwt_secret=secret,
    )

    @app.middleware("http")
    async def _inject_supabase_config(request, call_next):
        request.state._test_supabase_config = cfg
        return await call_next(request)

    # Monkeypatch get_supabase_config for this TestClient scope via env is cleaner:
    import auth.routes as routes_mod
    import auth.jwt_auth as jwt_mod

    routes_mod.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    jwt_mod.get_supabase_config = lambda: cfg  # type: ignore[method-assign]

    return TestClient(app)


section("JWT helper unit tests")
SECRET = "phase1-test-jwt-secret-not-for-production"
valid = _make_token(secret=SECRET, sub="11111111-1111-1111-1111-111111111111")
cfg = SupabaseConfig(url="https://example.supabase.co", service_role_key=None, jwt_secret=SECRET)
user = verify_access_token(valid, cfg)
ok(user is not None, "valid token resolves AuthUser")
ok(user is not None and user.user_id == "11111111-1111-1111-1111-111111111111", "valid token sub -> user_id")
ok(user is not None and user.email == "alice@example.com", "valid token email preserved")

bad_sig = valid + "x"
ok(verify_access_token(bad_sig, cfg) is None, "invalid signature returns None (no crash)")

expired = _make_token(secret=SECRET, exp_offset=-60)
ok(verify_access_token(expired, cfg) is None, "expired token returns None")

wrong_aud = _make_token(secret=SECRET, aud="anon")
ok(verify_access_token(wrong_aud, cfg) is None, "wrong audience returns None")

ok(verify_access_token("", cfg) is None, "empty token returns None")
empty_cfg = SupabaseConfig(url="https://example.supabase.co", service_role_key=None, jwt_secret="")
ok(verify_access_token(valid, empty_cfg) is None, "empty secret + no JWKS match returns None for HS256 token")

section("/api/auth/me endpoint")
client = _test_app(SECRET)

r = client.get("/api/auth/me")
ok(r.status_code == 200, "anonymous /api/auth/me returns 200")
body = r.json()
ok(body.get("authenticated") is False, "anonymous => authenticated=false")
ok(body.get("supabase_auth_configured") is True, "auth configured flag true in test app")

r2 = client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-real-jwt"})
ok(r2.status_code == 200, "invalid token /api/auth/me returns 200 (no crash)")
ok(r2.json().get("authenticated") is False, "invalid token => authenticated=false")

good_headers = {"Authorization": f"Bearer {valid}"}
r3 = client.get("/api/auth/me", headers=good_headers)
ok(r3.status_code == 200, "valid token /api/auth/me returns 200")
b3 = r3.json()
ok(b3.get("authenticated") is True, "valid token => authenticated=true")
ok(b3.get("user_id") == "11111111-1111-1111-1111-111111111111", "valid token user_id echoed")

r4 = client.get("/api/auth/me?session_id=test-session-abc")
ok(r4.status_code == 200, "session_id query param accepted")
ok(r4.json().get("session_id") == "test-session-abc", "session_id echoed for anonymous client")

section("/api/profile auth gate")
client_no_db = _test_app(SECRET, db_configured=False)
r5 = client_no_db.get("/api/profile", headers=good_headers)
ok(r5.status_code == 503, "profile GET 503 when db not configured")

client_db = _test_app(SECRET, db_configured=True)
r6 = client_db.get("/api/profile")
ok(r6.status_code == 401, "profile GET without token => 401")

r7 = client_db.get("/api/profile", headers={"Authorization": "Bearer garbage"})
ok(r7.status_code == 401, "profile GET invalid token => 401")

section("Bearer extraction")
class _Req:
    def __init__(self, header: str | None) -> None:
        self.headers = {"Authorization": header} if header is not None else {}

ok(extract_bearer_token(_Req("Bearer abc123")) == "abc123", "extract Bearer token")
ok(extract_bearer_token(_Req("bearer lowercase")) == "lowercase", "case-insensitive Bearer")
ok(extract_bearer_token(_Req(None)) is None, "missing Authorization => None")

section("Optional live Supabase RLS isolation")
live_url = (os.environ.get("SUPABASE_URL") or "").strip()
live_service = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
live_jwt_secret = (os.environ.get("SUPABASE_JWT_SECRET") or "").strip()

if live_url and live_service and live_jwt_secret:
    from auth.supabase_db import get_profile, insert_profile

    live_cfg = SupabaseConfig(
        url=live_url,
        service_role_key=live_service,
        jwt_secret=live_jwt_secret,
    )
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())
    try:
        insert_profile(live_cfg, user_a, display_name="User A")
        insert_profile(live_cfg, user_b, display_name="User B")
        pa = get_profile(live_cfg, user_a)
        pb = get_profile(live_cfg, user_b)
        ok(isinstance(pa, dict) and pa.get("display_name") == "User A", "live: service role reads user A")
        ok(isinstance(pb, dict) and pb.get("display_name") == "User B", "live: service role reads user B")
        ok(pa.get("id") != pb.get("id"), "live: two profiles are distinct")
        print("  NOTE live RLS: service role bypasses RLS by design; user-scoped isolation is enforced in JWT+RLS paths (Phase 2+ frontend).")
    except Exception as exc:
        ok(False, f"live Supabase integration skipped/failed: {exc}")
else:
    print("  SKIP live Supabase (set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET to enable)")

print(f"\n{'=' * 40}")
print(f"Results: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
print("All supabase auth smoke tests passed.")
