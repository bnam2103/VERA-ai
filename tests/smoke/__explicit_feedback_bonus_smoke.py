"""Smoke: explicit feedback bonus credits (+50/day).

Run:  py -3 -X utf8 tests\\smoke\\__explicit_feedback_bonus_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
import time
from unittest.mock import MagicMock, patch

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

from auth.explicit_feedback_db import sanitize_categories
from auth.explicit_feedback_routes import router as explicit_feedback_router
from auth.supabase_config import SupabaseConfig
from cost_logging import credit_enforcement as ce

passed = 0
failed = 0

USER_A = "dddddddd-dddd-dddd-dddd-dddddddddddd"
SECRET = "explicit-feedback-test-secret"
SESSION = "sess-feedback-smoke"


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
        "email": "bob@example.com",
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def _feedback_client() -> TestClient:
    app = FastAPI()
    app.include_router(explicit_feedback_router)
    cfg = SupabaseConfig(
        url="https://example.supabase.co",
        service_role_key="test-service-role",
        jwt_secret=SECRET,
    )
    import auth.explicit_feedback_routes as ef_routes
    import auth.jwt_auth as jwt_mod

    ef_routes.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    jwt_mod.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    return TestClient(app)


section("sanitize categories")
cats = sanitize_categories(["Work Mode", "Latency", "bogus", "Search/news", "UI/UX"])
ok("work_mode" in cats, "work_mode accepted")
ok("search_news" in cats, "search_news accepted")
ok("ui_ux" in cats, "ui_ux accepted")
ok("bogus" not in cats, "unknown category dropped")
ok(len(cats) <= 10, "category count capped")

section("anonymous status eligible")
_claimed = {"v": False}
with patch("auth.explicit_feedback_routes.credit_db_available", return_value=True):
    with patch(
        "auth.explicit_feedback_routes.has_claimed_feedback_bonus_today",
        side_effect=lambda *a, **k: _claimed["v"],
    ):
        client = _feedback_client()
        res = client.get("/api/feedback/status", params={"session_id": SESSION})
        body = res.json()
        ok(res.status_code == 200, "status 200")
        ok(body.get("eligible") is True, "eligible true")
        ok(body.get("already_claimed") is False, "not claimed")
        ok(body.get("bonus_credits") == 50, "bonus amount 50")

section("invalid token falls back to anonymous status")
with patch("auth.explicit_feedback_routes.credit_db_available", return_value=True):
    with patch(
        "auth.explicit_feedback_routes.has_claimed_feedback_bonus_today",
        return_value=False,
    ):
        client = _feedback_client()
        res = client.get(
            "/api/feedback/status",
            params={"session_id": SESSION},
            headers={"Authorization": "Bearer not-a-real-token"},
        )
        ok(res.status_code == 200, "invalid bearer status returns 200")
        ok(res.json().get("auth_mode") == "anonymous", "invalid bearer status anonymous")
        ok(res.json().get("eligible") is True, "invalid bearer still eligible")

section("anonymous submit grants +50 once")
_grant_calls: list[int] = []
_ledger_calls: list[dict] = []
_insert_count = {"n": 0}

def _insert_side_effect(*args, **kwargs):
    _insert_count["n"] += 1
    granted = kwargs.get("granted_bonus_credits", 0)
    if _insert_count["n"] == 1:
        _claimed["v"] = granted > 0
    return {"id": f"fb-{_insert_count['n']}", "granted_bonus_credits": granted}

with patch("auth.explicit_feedback_routes.credit_db_available", return_value=True):
    with patch(
        "auth.explicit_feedback_routes.has_claimed_feedback_bonus_today",
        side_effect=lambda *a, **k: _claimed["v"],
    ):
        with patch(
            "auth.explicit_feedback_routes.insert_explicit_feedback",
            side_effect=_insert_side_effect,
        ):
            with patch(
                "auth.explicit_feedback_routes.grant_daily_bonus_credits",
                side_effect=lambda *a, **kw: (
                    _grant_calls.append(kw.get("bonus_delta", 0)),
                    {"bonus_credits": 50},
                )[1],
            ):
                with patch(
                    "auth.explicit_feedback_routes.insert_credit_ledger_row",
                    side_effect=lambda *a, **k: _ledger_calls.append(k),
                ):
                    client = _feedback_client()
                    first = client.post(
                        "/api/feedback/submit",
                        json={
                            "session_id": SESSION,
                            "rating": 5,
                            "reason": "Work Mode is great.",
                            "categories": ["Work Mode", "Latency"],
                        },
                    )
                    ok(first.status_code == 200, "first submit 200")
                    b1 = first.json()
                    ok(b1.get("granted_bonus_credits") == 50, "first grant 50")
                    ok(_grant_calls == [50], "grant_daily_bonus_credits called once")
                    ok(any(c.get("credit_action") == "feedback_bonus" for c in _ledger_calls), "ledger feedback_bonus")

                    second = client.post(
                        "/api/feedback/submit",
                        json={
                            "session_id": SESSION,
                            "rating": 4,
                            "reason": "Still good.",
                            "categories": ["Other"],
                        },
                    )
                    ok(second.status_code == 200, "second submit 200")
                    b2 = second.json()
                    ok(b2.get("granted_bonus_credits") == 0, "second grant 0")
                    ok(b2.get("already_claimed") is True, "second already_claimed")

section("stale token submit falls back to anonymous")
_claimed3 = {"v": False}
with patch("auth.explicit_feedback_routes.credit_db_available", return_value=True):
    with patch(
        "auth.explicit_feedback_routes.has_claimed_feedback_bonus_today",
        side_effect=lambda *a, **k: _claimed3["v"],
    ):
        with patch(
            "auth.explicit_feedback_routes.insert_explicit_feedback",
            side_effect=lambda *a, **kw: (
                _claimed3.update({"v": kw.get("granted_bonus_credits", 0) > 0}),
                {"id": "fb-stale", "granted_bonus_credits": kw.get("granted_bonus_credits", 0)},
            )[1],
        ):
            with patch("auth.explicit_feedback_routes.grant_daily_bonus_credits"):
                with patch("auth.explicit_feedback_routes.insert_credit_ledger_row"):
                    client = _feedback_client()
                    res = client.post(
                        "/api/feedback/submit",
                        headers={"Authorization": "Bearer expired-or-invalid"},
                        json={
                            "session_id": SESSION,
                            "rating": 3,
                            "reason": "Stale token should not block.",
                            "categories": [],
                        },
                    )
                    ok(res.status_code == 200, "stale token submit returns 200")
                    ok(res.json().get("granted_bonus_credits") == 50, "stale token submit still grants bonus")

section("signed-in submit grants +50 once")
_claimed2 = {"v": False}
_grant2: list[int] = []
with patch("auth.explicit_feedback_routes.credit_db_available", return_value=True):
    with patch(
        "auth.explicit_feedback_routes.has_claimed_feedback_bonus_today",
        side_effect=lambda *a, **k: _claimed2["v"],
    ):
        with patch(
            "auth.explicit_feedback_routes.insert_explicit_feedback",
            side_effect=lambda *a, **kw: (
                _claimed2.update({"v": kw.get("granted_bonus_credits", 0) > 0}),
                {"id": "fb-signed", "granted_bonus_credits": kw.get("granted_bonus_credits", 0)},
            )[1],
        ):
            with patch(
                "auth.explicit_feedback_routes.grant_daily_bonus_credits",
                side_effect=lambda *a, **kw: (
                    _grant2.append(kw.get("bonus_delta", 0)),
                    {"bonus_credits": 50},
                )[1],
            ):
                with patch("auth.explicit_feedback_routes.insert_credit_ledger_row"):
                    client = _feedback_client()
                    token = _make_token(sub=USER_A)
                    r1 = client.post(
                        "/api/feedback/submit",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "session_id": SESSION,
                            "rating": 3,
                            "reason": "Okay overall.",
                            "categories": ["Voice assistant"],
                        },
                    )
                    ok(r1.json().get("granted_bonus_credits") == 50, "signed-in first grant 50")
                    r2 = client.post(
                        "/api/feedback/submit",
                        headers={"Authorization": f"Bearer {token}"},
                        json={
                            "session_id": SESSION,
                            "rating": 2,
                            "reason": "More notes.",
                            "categories": [],
                        },
                    )
                    ok(r2.json().get("granted_bonus_credits") == 0, "signed-in second grant 0")

section("validation rejects bad input")
with patch("auth.explicit_feedback_routes.credit_db_available", return_value=True):
    client = _feedback_client()
    bad_rating = client.post(
        "/api/feedback/submit",
        json={"session_id": SESSION, "rating": 0, "reason": "x"},
    )
    ok(bad_rating.status_code == 422, "invalid rating rejected")
    bad_reason = client.post(
        "/api/feedback/submit",
        json={"session_id": SESSION, "rating": 4, "reason": "   "},
    )
    ok(bad_reason.status_code == 422, "empty reason rejected")

section("usage credits endpoint reflects increased cap")
from auth.usage_credits_routes import router as usage_credits_router

_daily = {"credits_used": 3, "bonus_credits": 50, "reasoning_streams": 0, "search_turns": 0, "image_pdf_reasoning_turns": 0}
with patch("auth.usage_credits_routes.credit_db_available", return_value=True):
    with patch("auth.usage_credits_routes.get_daily_credit_usage", return_value=_daily):
        app = FastAPI()
        app.include_router(usage_credits_router)
        client = TestClient(app)
        res = client.get("/api/usage/credits/today", params={"session_id": SESSION})
        body = res.json()
        ok(body.get("base_credits_cap") == 100, "anon base cap 100")
        ok(body.get("bonus_credits") == 50, "bonus 50")
        ok(body.get("credits_cap") == 150, "effective cap 150")

section("credit cap enforcement uses base + bonus")
ce.enable_test_memory_store()
ce.reset_test_memory_store()
ce._MEMORY_STORE[(None, SESSION, ce._today_utc().isoformat())] = {
    **ce._empty_daily(),
    "credits_used": 95,
    "bonus_credits": 50,
}
ok(ce.get_credit_cap(None, SESSION) == 150, "effective cap includes bonus")
ok(ce.can_spend_credits(None, SESSION, 50)[0] is True, "95+50 within 150 cap")
ok(ce.can_spend_credits(None, SESSION, 60)[0] is False, "95+60 exceeds 150 cap")

section("frontend hook files present")
ok(os.path.isfile(os.path.join(_ROOT, "users", "explicitFeedback.js")), "explicitFeedback.js exists")
with open(os.path.join(_ROOT, "users", "explicitFeedback.js"), encoding="utf-8") as f:
    src = f.read()
ok("veraRefreshUsageCredits" in src, "explicitFeedback refreshes usage pill")
ok("[explicitFeedback] loaded" in src or "LOG_PREFIX" in src, "explicitFeedback debug log present")
ok("ensureFeedbackButtonDom" in src, "explicitFeedback creates button if missing")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
