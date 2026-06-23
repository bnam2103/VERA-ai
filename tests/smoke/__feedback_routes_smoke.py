"""Smoke: POST /api/feedback (Supabase Feedback MVP).

Run:  py -3 -X utf8 tests\\smoke\\__feedback_routes_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
import time
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

import jwt
from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth.feedback_db import MAX_EXCERPT_LEN, MAX_NOTE_LEN, create_feedback
from auth.feedback_routes import router as feedback_router
from auth.supabase_config import SupabaseConfig

passed = 0
failed = 0

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SECRET = "feedback-mvp-test-secret"


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


def _feedback_client() -> TestClient:
    app = FastAPI()
    app.include_router(feedback_router)
    cfg = SupabaseConfig(
        url="https://example.supabase.co",
        service_role_key="test-service-role",
        jwt_secret=SECRET,
    )
    import auth.feedback_routes as fb_routes
    import auth.jwt_auth as jwt_mod

    fb_routes.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    jwt_mod.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    return TestClient(app)


section("feedback_db truncation")
with patch("auth.feedback_db._request_json") as mock_req:
    mock_req.return_value = [{"id": str(uuid.uuid4()), "rating": "down"}]
    cfg = SupabaseConfig(
        url="https://example.supabase.co",
        service_role_key="test-service-role",
        jwt_secret=SECRET,
    )
    long_note = "n" * (MAX_NOTE_LEN + 50)
    long_excerpt = "x" * (MAX_EXCERPT_LEN + 50)
    create_feedback(
        cfg,
        USER_A,
        session_id="sess-trunc",
        rating="down",
        note=long_note,
        user_input_excerpt=long_excerpt,
        assistant_response_excerpt=long_excerpt,
    )
    sent = mock_req.call_args[0][3]
    ok(len(sent["note"]) == MAX_NOTE_LEN, "note truncated to MAX_NOTE_LEN")
    ok(len(sent["user_input_excerpt"]) == MAX_EXCERPT_LEN, "user excerpt truncated")
    ok(
        len(sent["assistant_response_excerpt"]) == MAX_EXCERPT_LEN,
        "assistant excerpt truncated",
    )

with patch("auth.feedback_db._request_json") as mock_req_anon:
    mock_req_anon.return_value = [{"id": str(uuid.uuid4()), "rating": "up"}]
    create_feedback(
        cfg,
        None,
        session_id="sess-anon-db",
        rating="up",
        user_input_excerpt="q",
        assistant_response_excerpt="a",
    )
    sent_anon = mock_req_anon.call_args[0][3]
    ok(sent_anon.get("user_id") is None, "db layer accepts null user_id")

section("POST /api/feedback")
client = _feedback_client()
token = _make_token(sub=USER_A)
headers = {"Authorization": f"Bearer {token}"}

with patch("auth.feedback_routes.create_feedback") as mock_create:
    fid = str(uuid.uuid4())
    mock_create.return_value = {"id": fid, "rating": "up"}
    res = client.post(
        "/api/feedback",
        headers=headers,
        json={
            "rating": "up",
            "session_id": "sess-abc",
            "request_id": "req_test_1",
            "user_input_excerpt": "hello",
            "assistant_response_excerpt": "hi there",
        },
    )
    ok(res.status_code == 200, "authenticated POST returns 200")
    body = res.json()
    ok(body.get("ok") is True and body.get("id") == fid, "response includes id")
    mock_create.assert_called_once()
    ok(mock_create.call_args[0][1] == USER_A, "authenticated POST sets user_id")
    kwargs = mock_create.call_args.kwargs
    ok(kwargs.get("rating") == "up", "rating passed to db layer")
    ok(kwargs.get("note") is None, "thumbs up clears note")

with patch("auth.feedback_routes.create_feedback") as mock_create:
    fid_anon = str(uuid.uuid4())
    mock_create.return_value = {"id": fid_anon, "rating": "up"}
    res_anon = client.post(
        "/api/feedback",
        json={
            "rating": "up",
            "session_id": "sess-anon",
            "request_id": "req_anon_1",
            "user_input_excerpt": "hello",
            "assistant_response_excerpt": "hi there",
        },
    )
    ok(res_anon.status_code == 200, "anonymous POST returns 200")
    ok(res_anon.json().get("id") == fid_anon, "anonymous response includes id")
    ok(mock_create.call_args[0][1] is None, "anonymous POST sets user_id null")

res_bad_token = client.post(
    "/api/feedback",
    headers={"Authorization": "Bearer not-a-valid-jwt"},
    json={"rating": "up", "session_id": "sess-x"},
)
ok(res_bad_token.status_code == 401, "401 for invalid Bearer token")

res_no_session = client.post(
    "/api/feedback",
    json={"rating": "up", "session_id": ""},
)
ok(res_no_session.status_code == 422, "missing session_id rejected with 422")

res_bad = client.post(
    "/api/feedback",
    headers=headers,
    json={"rating": "maybe", "session_id": "sess-x"},
)
ok(res_bad.status_code == 422, "invalid rating rejected with 422")

with patch("auth.feedback_routes.create_feedback") as mock_create:
    mock_create.return_value = {"id": str(uuid.uuid4())}
    res_down = client.post(
        "/api/feedback",
        headers=headers,
        json={
            "rating": "down",
            "session_id": "sess-down",
            "note": "wrong answer",
            "user_input_excerpt": "q",
            "assistant_response_excerpt": "a",
        },
    )
    ok(res_down.status_code == 200, "thumbs down with note accepted")
    note_arg = mock_create.call_args.kwargs.get("note")
    ok(note_arg == "wrong answer", "note forwarded for thumbs down")

section("summary")
print(f"\n{passed} passed, {failed} failed")
if failed:
    sys.exit(1)
