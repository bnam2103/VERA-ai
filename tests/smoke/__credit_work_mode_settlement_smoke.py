"""Smoke: Work Mode reasoning credit settlement + classifier mapping.

Run:  py -3 -X utf8 tests\\smoke\\__credit_work_mode_settlement_smoke.py
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

from cost_logging import classify_credit_action, compute_credits
from cost_logging import credit_enforcement as ce

passed = 0
failed = 0

SESSION = "sess-wm-settle"
USER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc"


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


def _reset() -> None:
    ce.enable_test_memory_store()
    ce.reset_test_memory_store()


section("classifier: work mode reasoning stream defaults to deep")
action, _ = classify_credit_action(
    mode="work_mode",
    request_type="reasoning",
    extras={"http_path": "/work_mode/reasoning_stream", "route_path": "/work_mode/reasoning_stream"},
    events=[{"provider": "openai", "output_tokens": 50, "reasoning_tokens": 10}],
    success=True,
)
ok(action == "work_mode_reasoning_deep", "reasoning_stream => work_mode_reasoning_deep")
ok(compute_credits(action) == 20, "deep work mode = 20 credits")

section("classifier: work mode normal when deep effort explicitly false")
action_norm, _ = classify_credit_action(
    mode="work_mode",
    request_type="reasoning",
    extras={
        "http_path": "/work_mode/reasoning_stream",
        "deep_reasoning_effort_active": False,
    },
    events=[{"provider": "openai", "output_tokens": 40}],
    success=True,
)
ok(action_norm == "work_mode_reasoning", "explicit non-deep => work_mode_reasoning")
ok(compute_credits(action_norm) == 12, "normal work mode = 12 credits")

section("classifier: upload path => image_pdf_reasoning")
action_img, _ = classify_credit_action(
    mode="work_mode",
    request_type="reasoning",
    extras={
        "http_path": "/work_mode/reasoning_stream_upload",
        "has_file": True,
        "file_attachment_count": 1,
    },
    events=[{"provider": "openai", "output_tokens": 100}],
    success=True,
)
ok(action_img == "image_pdf_reasoning", "upload => image_pdf_reasoning")
ok(compute_credits(action_img) == 20, "image/pdf = 20 credits")

section("classifier: /work_mode path without mode=work_mode still maps")
action_path, _ = classify_credit_action(
    mode="unknown",
    request_type="reasoning",
    extras={"http_path": "/work_mode/reasoning_stream"},
    events=[],
    success=True,
)
ok(action_path == "work_mode_reasoning_deep", "path-only work_mode reasoning => deep")

section("settlement: work mode increments credits and reasoning_streams")
_reset()
ce.settle_request_credits(
    user_id=None,
    session_id=SESSION,
    request_id="wm-req-1",
    credit_action="work_mode_reasoning_deep",
    credits_used=20,
    success=True,
    events=[{"provider": "openai", "output_tokens": 200, "reasoning_tokens": 50}],
    extra={"route_path": "/work_mode/reasoning_stream"},
)
daily = ce.get_daily_credit_usage(None, SESSION)
ok(daily["credits_used"] == 20, "daily credits_used += 20")
ok(daily["reasoning_streams"] == 1, "reasoning_streams += 1")

section("settlement: image upload increments image_pdf_reasoning_turns")
_reset()
ce.settle_request_credits(
    user_id=None,
    session_id=SESSION,
    request_id="wm-upload-1",
    credit_action="image_pdf_reasoning",
    credits_used=20,
    success=True,
    events=[{"provider": "openai", "output_tokens": 300}],
)
daily_up = ce.get_daily_credit_usage(None, SESSION)
ok(daily_up["credits_used"] == 20, "upload credits_used = 20")
ok(daily_up["image_pdf_reasoning_turns"] == 1, "image_pdf_reasoning_turns += 1")

section("settlement: failed work mode charges 0")
_reset()
before = ce.get_daily_credit_usage(None, SESSION)["credits_used"]
ce.settle_request_credits(
    user_id=None,
    session_id=SESSION,
    request_id="wm-fail-1",
    credit_action="work_mode_reasoning_deep",
    credits_used=20,
    success=False,
)
after = ce.get_daily_credit_usage(None, SESSION)["credits_used"]
ok(before == after == 0, "failed stream does not increment credits")

section("usage credits API reflects work mode usage")
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth.usage_credits_routes import router as usage_credits_router

_daily = {
    "credits_used": 20,
    "reasoning_streams": 1,
    "search_turns": 0,
    "image_pdf_reasoning_turns": 0,
}
with patch("auth.usage_credits_routes.credit_db_available", return_value=True):
    with patch("auth.usage_credits_routes.get_daily_credit_usage", return_value=_daily):
        app = FastAPI()
        app.include_router(usage_credits_router)
        client = TestClient(app)
        res = client.get("/api/usage/credits/today", params={"session_id": SESSION})
        body = res.json()
        ok(res.status_code == 200, "credits today endpoint 200")
        ok(body.get("credits_used") == 20, "endpoint shows work mode credits")
        ok(body.get("features", {}).get("work_mode", {}).get("used") == 1, "endpoint work_mode used")

section("frontend refresh hook wraps reasoning panel done")
# usageCredits.js wraps veraUsageOnReasoningPanelReplyDone at load time.
hook_path = os.path.join(_ROOT, "users", "usageCredits.js")
with open(hook_path, encoding="utf-8") as f:
    hook_src = f.read()
ok("veraUsageOnReasoningPanelReplyDone" in hook_src, "usageCredits wraps reasoning panel hook")
ok("veraRefreshUsageCredits" in hook_src, "usageCredits exposes refresh helper")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
