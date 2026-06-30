"""Smoke: dev no-cap testing toggle (env-gated, session-scoped).

Run:  py -3 -X utf8 tests\\smoke\\__no_cap_toggle_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
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

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from auth.no_cap_routes import router as no_cap_router
from auth.usage_credits_routes import router as usage_credits_router
from cost_logging import credit_enforcement as ce
from cost_logging.no_cap_testing import reset_no_cap_state, set_no_cap_active

passed = 0
failed = 0

SESSION_A = "sess-no-cap-a"
SESSION_B = "sess-no-cap-b"


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


def _no_cap_client() -> TestClient:
    app = FastAPI()
    app.include_router(no_cap_router)
    return TestClient(app)


def _credits_client() -> TestClient:
    app = FastAPI()
    app.include_router(usage_credits_router)
    return TestClient(app)


def _reset_credits() -> None:
    ce.enable_test_memory_store()
    ce.reset_test_memory_store()
    reset_no_cap_state()


section("env disabled: API hidden, caps enforced")
os.environ.pop("VERA_ENABLE_NO_CAP_TOGGLE", None)
_reset_credits()
for i in range(34):
    ce.record_credit_usage(None, SESSION_A, f"req-{i}", "voice_assistant", 3)
blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=SESSION_A,
        credit_action="voice_assistant",
    )
except HTTPException as exc:
    blocked = exc.status_code == 429
ok(blocked, "over-cap blocked when toggle env disabled")
client_off = _no_cap_client()
ok(client_off.get("/api/dev/no-cap/status", params={"session_id": SESSION_A}).status_code == 404, "status 404 when disabled")
ok(
    client_off.post(
        "/api/dev/no-cap/set",
        json={"session_id": SESSION_A, "active": True},
    ).status_code
    == 404,
    "set rejected when disabled",
)
with patch("auth.usage_credits_routes.credit_db_available", return_value=False):
    body = _credits_client().get(
        "/api/usage/credits/today", params={"session_id": SESSION_A}
    ).json()
ok(body.get("no_cap_toggle_enabled") is False, "credits/today no_cap_toggle_enabled false")
ok(body.get("no_cap_active") is False, "credits/today no_cap_active false")

section("env enabled: toggle session, enforce skip, accounting continues")
os.environ["VERA_ENABLE_NO_CAP_TOGGLE"] = "true"
_reset_credits()
for i in range(34):
    ce.record_credit_usage(None, SESSION_A, f"req-{i}", "voice_assistant", 3)
client_on = _no_cap_client()
res_set = client_on.post(
    "/api/dev/no-cap/set",
    json={"session_id": SESSION_A, "active": True},
)
ok(res_set.status_code == 200 and res_set.json().get("active") is True, "set no-cap on for session A")
res_stat = client_on.get("/api/dev/no-cap/status", params={"session_id": SESSION_A})
ok(res_stat.json().get("enabled") is True and res_stat.json().get("active") is True, "status active for A")
allowed = True
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=SESSION_A,
        credit_action="voice_assistant",
    )
except HTTPException:
    allowed = False
ok(allowed, "no-cap active: over-cap request allowed")
before = ce.get_daily_credit_usage(None, SESSION_A)["credits_used"]
ce.record_credit_usage(None, SESSION_A, "req-after-nocap", "voice_assistant", 3)
after = ce.get_daily_credit_usage(None, SESSION_A)["credits_used"]
ok(after == before + 3, "no-cap active: usage still logged")

section("no-cap does not apply to other sessions")
for i in range(34):
    ce.record_credit_usage(None, SESSION_B, f"req-b-{i}", "voice_assistant", 3)
other_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=SESSION_B,
        credit_action="voice_assistant",
    )
except HTTPException as exc:
    other_blocked = exc.status_code == 429
ok(other_blocked, "session B still blocked when only A has no-cap")

section("toggle off restores enforcement")
client_on.post("/api/dev/no-cap/set", json={"session_id": SESSION_A, "active": False})
blocked_again = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=SESSION_A,
        credit_action="voice_assistant",
    )
except HTTPException as exc:
    blocked_again = exc.status_code == 429
ok(blocked_again, "no-cap off: over-cap blocked again")

section("usage credits endpoint includes no_cap_active")
_reset_credits()
set_no_cap_active(SESSION_A, True)
_daily = {"credits_used": 123, "bonus_credits": 0}
with patch("auth.usage_credits_routes.credit_db_available", return_value=True):
    with patch("auth.usage_credits_routes.get_daily_credit_usage", return_value=_daily):
        body = _credits_client().get(
            "/api/usage/credits/today", params={"session_id": SESSION_A}
        ).json()
ok(body.get("no_cap_toggle_enabled") is True, "credits/today toggle enabled")
ok(body.get("no_cap_active") is True, "credits/today no_cap_active true")

section("frontend button visibility + display")
html = open(os.path.join(_ROOT, "app/index.html"), encoding="utf-8").read()
js = open(os.path.join(_ROOT, "users", "usageCredits.js"), encoding="utf-8").read()
css = open(os.path.join(_ROOT, "app/styles.css"), encoding="utf-8").read()
ok('id="vera-no-cap-toggle"' in html, "no-cap button in HTML")
ok("no_cap_toggle_enabled" in js, "JS reads no_cap_toggle_enabled")
ok("btn.hidden = true" in js or "btn.hidden = true;" in js, "JS hides button when disabled")
ok("No cap: OFF" in js and "No cap: ON" in js, "toggle button labels")
ok("used · No cap" in js, "pill shows used · No cap when active")
ok(".vera-no-cap-toggle" in css, "no-cap button styled")

os.environ.pop("VERA_ENABLE_NO_CAP_TOGGLE", None)
reset_no_cap_state()

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
