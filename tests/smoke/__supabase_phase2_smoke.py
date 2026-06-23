"""Phase 2 smoke: public auth config + Supabase JWT precedence over legacy user/active.

Run:  py -3 -X utf8 tests\\smoke\\__supabase_phase2_smoke.py
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

from auth.jwt_auth import verify_access_token
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


SECRET = "phase2-test-secret"
USER_ID = "22222222-2222-2222-2222-222222222222"


def _token() -> str:
    return jwt.encode(
        {
            "sub": USER_ID,
            "email": "phase2@example.com",
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )


section("GET /api/auth/config")
app = FastAPI()
app.include_router(supabase_auth_router)

import auth.routes as routes_mod

routes_mod.get_supabase_config = lambda: SupabaseConfig(  # type: ignore[method-assign]
    url="https://example.supabase.co",
    service_role_key="svc",
    jwt_secret=SECRET,
)

import os as _os

_os.environ["SUPABASE_ANON_KEY"] = "test-anon-public-key"
client = TestClient(app)
r = client.get("/api/auth/config")
ok(r.status_code == 200, "config returns 200")
body = r.json()
ok(body.get("configured") is True, "configured true when url+anon set")
ok(body.get("supabase_url") == "https://example.supabase.co", "supabase_url echoed")
ok(body.get("anon_key") == "test-anon-public-key", "anon_key echoed (public)")
ok("service_role" not in str(body).lower(), "response does not mention service_role")

section("JWT precedence helper")
cfg = SupabaseConfig(url="https://example.supabase.co", service_role_key=None, jwt_secret=SECRET)
user = verify_access_token(_token(), cfg)
ok(user is not None and user.user_id == USER_ID, "verify_access_token resolves user_id")

section("Anonymous /api/auth/me unchanged")
r2 = client.get("/api/auth/me")
ok(r2.status_code == 200 and r2.json().get("authenticated") is False, "anonymous me still works")

section("Authenticated /api/auth/me")
r3 = client.get("/api/auth/me", headers={"Authorization": f"Bearer {_token()}"})
ok(r3.status_code == 200 and r3.json().get("authenticated") is True, "authenticated me true")

print(f"\n{'=' * 40}")
print(f"Results: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
print("All phase 2 smoke tests passed.")
