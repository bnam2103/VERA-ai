"""Waitlist signup API smoke (mocked Supabase).

Run:  py -3 -X utf8 tests\\smoke\\__waitlist_smoke.py
"""
from __future__ import annotations

import io
import os
import sys

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth.supabase_config import SupabaseConfig
from auth.waitlist_routes import router as waitlist_router

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


cfg = SupabaseConfig(
    url="https://example.supabase.co",
    service_role_key="svc-test",
    jwt_secret="secret",
)

app = FastAPI()
app.include_router(waitlist_router)
client = TestClient(app)


section("validation")
with patch("auth.waitlist_routes.get_supabase_config", return_value=cfg):
    bad = client.post("/api/waitlist", json={"email": "not-an-email"})
ok(bad.status_code == 400, "invalid email returns 400")

section("new signup")
with patch("auth.waitlist_routes.get_supabase_config", return_value=cfg), patch(
    "auth.waitlist_routes.insert_waitlist_signup",
    return_value=({"id": "1", "email": "a@b.com"}, False),
), patch("auth.waitlist_routes.send_waitlist_confirmation_email", return_value=False):
    r = client.post("/api/waitlist", json={"email": "A@B.com", "source": "landing"})
body = r.json()
ok(r.status_code == 200 and body.get("ok") is True, "new signup returns ok")
ok("waitlist" in (body.get("message") or "").lower(), "success message mentions waitlist")

section("duplicate signup")
with patch("auth.waitlist_routes.get_supabase_config", return_value=cfg), patch(
    "auth.waitlist_routes.insert_waitlist_signup",
    return_value=({"email": "a@b.com"}, True),
):
    r2 = client.post("/api/waitlist", json={"email": "a@b.com"})
body2 = r2.json()
ok(r2.status_code == 200 and body2.get("ok") is True, "duplicate returns ok")
ok("already" in (body2.get("message") or "").lower(), "duplicate friendly message")

section("unconfigured db")
with patch(
    "auth.waitlist_routes.get_supabase_config",
    return_value=SupabaseConfig(url=None, service_role_key=None, jwt_secret=None),
):
    r3 = client.post("/api/waitlist", json={"email": "x@y.com"})
ok(r3.status_code == 503, "unconfigured Supabase returns 503")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
