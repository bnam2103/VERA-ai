"""Smoke: POST /api/usage/events (behavioral analytics Phase 0+1).

Run:  py -3 -X utf8 tests\\smoke\\__usage_events_routes_smoke.py
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

from auth.usage_events_db import (
    ALLOWED_EVENT_TYPES,
    MAX_PROP_STRING_LEN,
    create_usage_event,
    find_usage_event_by_client_id,
    sanitize_event_props,
)
from auth.usage_events_routes import router as usage_events_router
from auth.supabase_config import SupabaseConfig

passed = 0
failed = 0

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SECRET = "usage-events-mvp-test-secret"


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


def _usage_client() -> TestClient:
    app = FastAPI()
    app.include_router(usage_events_router)
    cfg = SupabaseConfig(
        url="https://example.supabase.co",
        service_role_key="test-service-role",
        jwt_secret=SECRET,
    )
    import auth.usage_events_routes as ue_routes
    import auth.jwt_auth as jwt_mod

    ue_routes.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    jwt_mod.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    return TestClient(app)


section("ALLOWED_EVENT_TYPES")
ok("mode_duration_flush" in ALLOWED_EVENT_TYPES, "mode_duration_flush allowed")
ok("work_mode_entered" in ALLOWED_EVENT_TYPES, "work_mode_entered allowed")
ok("bmo_mode_entered" in ALLOWED_EVENT_TYPES, "bmo_mode_entered allowed")
ok("action_executed" in ALLOWED_EVENT_TYPES, "action_executed in Phase 2")
ok("music_transport_used" in ALLOWED_EVENT_TYPES, "music_transport_used in Phase 2")
ok("checklist_item_added" in ALLOWED_EVENT_TYPES, "checklist_item_added in Phase 2")
ok("reasoning_panel_opened" in ALLOWED_EVENT_TYPES, "reasoning_panel_opened in Phase 2")
ok("interrupt_confirmed" in ALLOWED_EVENT_TYPES, "interrupt_confirmed in Phase 2")

PHASE2_EVENT_TYPES = (
    "action_executed",
    "action_failed",
    "multi_action_plan_executed",
    "multi_action_step_executed",
    "action_sequence_failed",
    "music_action_executed",
    "music_provider_switched",
    "music_sequence_executed",
    "music_play_started",
    "music_transport_used",
    "checklist_item_added",
    "checklist_item_completed",
    "checklist_item_deleted",
    "checklist_sync_started",
    "checklist_sync_completed",
    "checklist_sync_failed",
    "checklist_batch_action_executed",
    "reasoning_panel_opened",
    "reasoning_panel_closed",
    "reasoning_panel_focused",
    "reasoning_panel_message_sent",
    "reasoning_panel_reply_done",
    "interrupt_candidate_detected",
    "interrupt_candidate_submitted",
    "interrupt_confirmed",
    "interrupt_rejected",
    "interrupt_cleanup_done",
)
for evt in PHASE2_EVENT_TYPES:
    ok(evt in ALLOWED_EVENT_TYPES, f"{evt} allowed")

section("sanitize_event_props")
clean = sanitize_event_props(
    {
        "source": "text",
        "input_chars": 12,
        "work_mode_on": False,
        "text": "forbidden",
        "note": "secret",
        "playlist_name": "Peak",
        "uri": "spotify:track:abc",
    }
)
ok(clean is not None, "sanitizer returns props")
ok(clean.get("source") == "text", "allowed keys kept")
ok(clean.get("input_chars") == 12, "numeric props kept")
ok("text" not in clean and "note" not in clean, "forbidden keys stripped")
ok("playlist_name" not in clean and "uri" not in clean, "privacy keys stripped")
long_val = "x" * (MAX_PROP_STRING_LEN + 40)
capped = sanitize_event_props({"source": long_val})
ok(len(capped.get("source", "")) == MAX_PROP_STRING_LEN, "string props capped")
huge = {"source": "a", "n": 1}
for i in range(300):
    huge[f"k{i}"] = i
try:
    sanitize_event_props(huge)
    ok(False, "oversized event_props should raise")
except Exception:
    ok(True, "oversized event_props rejected")

section("usage_events_db insert")
cfg = SupabaseConfig(
    url="https://example.supabase.co",
    service_role_key="test-service-role",
    jwt_secret=SECRET,
)
with patch("auth.usage_events_db.find_usage_event_by_client_id", return_value=None):
    with patch("auth.usage_events_db._request_json") as mock_req:
        mock_req.return_value = [{"id": str(uuid.uuid4()), "event_type": "message_sent"}]
        create_usage_event(
            cfg,
            None,
            session_id="sess-db",
            event_type="message_sent",
            request_id="req_1",
            client_event_id="ce-db-1",
            event_props={"source": "text", "input_chars": 5},
        )
        sent = mock_req.call_args[0][3]
        ok(sent.get("user_id") is None, "db layer accepts null user_id")
        ok(sent.get("event_type") == "message_sent", "event_type stored")
        ok(sent.get("client_event_id") == "ce-db-1", "client_event_id stored")
        ok(sent.get("event_props", {}).get("input_chars") == 5, "props stored")

section("client_event_id idempotency")
existing_id = str(uuid.uuid4())
with patch("auth.usage_events_db.find_usage_event_by_client_id") as mock_find:
    mock_find.return_value = {
        "id": existing_id,
        "session_id": "sess-dedupe",
        "event_type": "mode_duration_flush",
    }
    with patch("auth.usage_events_db._request_json") as mock_req:
        row = create_usage_event(
            cfg,
            None,
            session_id="sess-dedupe",
            event_type="mode_duration_flush",
            client_event_id="ce-same",
            event_props={"mode": "work_mode", "duration_ms": 1000},
        )
        ok(row.get("id") == existing_id, "duplicate client_event_id returns existing row")
        ok(mock_req.called is False, "insert skipped when client_event_id exists")

with patch("auth.usage_events_db._request_json") as mock_req:
    mock_req.return_value = [
        {
            "id": existing_id,
            "session_id": "sess-find",
            "client_event_id": "ce-find",
            "event_type": "session_start",
        }
    ]
    found = find_usage_event_by_client_id(cfg, "sess-find", "ce-find")
    ok(found is not None and found.get("id") == existing_id, "find_usage_event_by_client_id works")

section("POST /api/usage/events")
client = _usage_client()
token = _make_token(sub=USER_A)
headers = {"Authorization": f"Bearer {token}"}

with patch("auth.usage_events_routes.create_usage_event") as mock_create:
    eid = str(uuid.uuid4())
    mock_create.return_value = {"id": eid, "event_type": "message_sent"}
    res = client.post(
        "/api/usage/events",
        headers=headers,
        json={
            "session_id": "sess-auth",
            "event_type": "message_sent",
            "request_id": "req_auth",
            "client_event_id": "ce-auth-1",
            "event_props": {"source": "text", "input_chars": 3},
        },
    )
    ok(res.status_code == 200, "authenticated POST returns 200")
    ok(res.json().get("id") == eid, "response includes id")
    ok(mock_create.call_args[0][1] == USER_A, "authenticated POST sets user_id")
    ok(mock_create.call_args.kwargs.get("client_event_id") == "ce-auth-1", "client_event_id passed")

with patch("auth.usage_events_routes.create_usage_event") as mock_create:
    eid_anon = str(uuid.uuid4())
    mock_create.return_value = {"id": eid_anon}
    res_anon = client.post(
        "/api/usage/events",
        json={
            "session_id": "sess-anon",
            "event_type": "session_start",
            "event_props": {"app_surface": "vera", "authenticated": False},
        },
    )
    ok(res_anon.status_code == 200, "anonymous POST returns 200")
    ok(mock_create.call_args[0][1] is None, "anonymous POST sets user_id null")

with patch("auth.usage_events_routes.create_usage_event") as mock_create:
    mock_create.return_value = {"id": str(uuid.uuid4())}
    res_mode = client.post(
        "/api/usage/events",
        json={
            "session_id": "sess-mode",
            "event_type": "mode_duration_flush",
            "client_event_id": "ce-mode-1",
            "event_props": {
                "mode": "work_mode",
                "duration_ms": 5000,
                "app_surface": "vera",
                "source": "heartbeat",
                "visible": True,
                "segment_id": "seg_1",
            },
        },
    )
    ok(res_mode.status_code == 200, "mode_duration_flush accepted")

res_bad_token = client.post(
    "/api/usage/events",
    headers={"Authorization": "Bearer not-a-valid-jwt"},
    json={"session_id": "sess-x", "event_type": "page_hidden"},
)
ok(res_bad_token.status_code == 401, "401 for invalid Bearer token")

res_no_session = client.post(
    "/api/usage/events",
    json={"session_id": "", "event_type": "page_hidden"},
)
ok(res_no_session.status_code == 422, "missing session_id rejected with 422")

res_bad_type = client.post(
    "/api/usage/events",
    json={"session_id": "sess-x", "event_type": "feature_dashboard_view"},
)
ok(res_bad_type.status_code == 422, "invalid event_type rejected with 422")

with patch("auth.usage_events_routes.create_usage_event") as mock_create:
    mock_create.return_value = {"id": str(uuid.uuid4())}
    res_action = client.post(
        "/api/usage/events",
        json={
            "session_id": "sess-action",
            "event_type": "action_executed",
            "client_event_id": "ce-action-1",
            "event_props": {
                "action_type": "music.skip_next",
                "action_category": "music",
                "success": True,
                "transcript": "skip",
                "title": "Song",
                "uri": "spotify:track:abc",
            },
        },
    )
    ok(res_action.status_code == 200, "action_executed accepted")
    action_props = mock_create.call_args.kwargs.get("event_props") or {}
    ok(action_props.get("action_type") == "music.skip_next", "action_type kept")
    ok("transcript" not in action_props and "title" not in action_props, "privacy keys stripped")

big_props = {f"tag{i}": "abcdefghij" for i in range(300)}
res_big = client.post(
    "/api/usage/events",
    json={"session_id": "sess-x", "event_type": "message_sent", "event_props": big_props},
)
ok(res_big.status_code == 422, "oversized event_props rejected with 422")

with patch("auth.usage_events_routes.create_usage_event") as mock_create:
    mock_create.return_value = {"id": str(uuid.uuid4())}
    res_fb = client.post(
        "/api/usage/events",
        json={
            "session_id": "sess-fb",
            "event_type": "feedback_submitted",
            "event_props": {
                "feedback_rating": "up",
                "source": "main_chat",
                "note": "should be stripped",
            },
        },
    )
    ok(res_fb.status_code == 200, "feedback_submitted accepted")
    props_arg = mock_create.call_args.kwargs.get("event_props") or {}
    ok(props_arg.get("feedback_rating") == "up", "feedback_rating kept")
    ok("note" not in props_arg, "forbidden note stripped before insert")

section("summary")
print(f"\n{passed} passed, {failed} failed")
if failed:
    sys.exit(1)
