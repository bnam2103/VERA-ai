"""Smoke: UI voice / main chat credit cap enforcement on streaming paths.

Run:  py -3 -X utf8 tests\\smoke\\__credit_ui_voice_enforcement_smoke.py
"""
from __future__ import annotations

import asyncio
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

from cost_logging import classify_credit_action
from cost_logging import credit_enforcement as ce
from fastapi import HTTPException

import app as app_mod

passed = 0
failed = 0

ANON_SESSION = "anon-ui-voice-cap"
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


def _fill_anon_voice_credits(count: int) -> None:
    for i in range(count):
        ce.record_credit_usage(None, ANON_SESSION, f"seed-{i}", "voice_assistant", 3)


section("classifier: normal /infer chat is voice_assistant not local_action")
action, reason = classify_credit_action(
    mode="nonwork_mode",
    request_type="voice",
    extras={"http_path": "/infer"},
    events=[{"provider": "openai", "output_tokens": 80}],
    success=True,
)
ok(action == "voice_assistant", "openai /infer => voice_assistant")
ok("local_action" not in reason, "not classified as local_action")

section("preflight blocks anonymous at 100/100")
_reset()
_fill_anon_voice_credits(34)
blocked = False
try:
    with patch("app.try_prepare_streaming_action_messages", return_value=None):
        with patch("app.resolve_reply_if_not_general_llm", return_value=None):
            app_mod._preflight_general_llm_credit_cap(ANON_SESSION, "hello", [])
except HTTPException as exc:
    blocked = exc.status_code == 429
ok(blocked, "anonymous at 100/100 blocked for general LLM")

section("preflight blocks anonymous at 99/100 for 3-credit chat")
_reset()
_fill_anon_voice_credits(33)
blocked_99 = False
try:
    with patch("app.try_prepare_streaming_action_messages", return_value=None):
        with patch("app.resolve_reply_if_not_general_llm", return_value=None):
            app_mod._preflight_general_llm_credit_cap(ANON_SESSION, "hello", [])
except HTTPException:
    blocked_99 = True
ok(blocked_99, "anonymous at 99/100 blocked for 3-credit chat")

section("preflight allows anonymous at 97/100 for 3-credit chat")
_reset()
_fill_anon_voice_credits(32)
allowed = True
try:
    with patch("app.try_prepare_streaming_action_messages", return_value=None):
        with patch("app.resolve_reply_if_not_general_llm", return_value=None):
            app_mod._preflight_general_llm_credit_cap(ANON_SESSION, "hello", [])
except HTTPException:
    allowed = False
ok(allowed, "anonymous at 97/100 allowed for 3-credit chat")
ok(
    ce.get_daily_credit_usage(None, ANON_SESSION)["credits_used"] == 96,
    "usage remains 96 before request",
)

section("signed-in blocked at 200/200")
_reset()
for i in range(66):
    ce.record_credit_usage(USER_ID, "signed-sess", f"s-{i}", "voice_assistant", 3)
signed_blocked = False
mock_user = type("U", (), {"user_id": USER_ID})()
try:
    with patch("auth.request_auth.get_bound_auth_user", return_value=mock_user):
        with patch("app.try_prepare_streaming_action_messages", return_value=None):
            with patch("app.resolve_reply_if_not_general_llm", return_value=None):
                app_mod._preflight_general_llm_credit_cap("signed-sess", "hello", [])
except HTTPException as exc:
    signed_blocked = exc.status_code == 429
ok(signed_blocked, "signed-in at 198/200 blocked for 3-credit chat")

section("streaming infer LLM path enforces cap")
_reset()
_fill_anon_voice_credits(34)


async def _drain_infer_stream() -> None:
    gen = app_mod.iter_infer_tts_ndjson_stream_llm_stream(
        infer_t0=0.0,
        session_id=ANON_SESSION,
        transcript="hello there",
        client="vera",
        t_pre_asr=0.0,
        t_asr_lock=0.0,
        t_asr_transcribe=0.0,
        t_asr_lock_end=0.0,
        t_llm_start=0.0,
        t_bridge=0.0,
        history=[],
    )
    async for _ in gen:
        pass


stream_blocked = False
try:
    asyncio.run(_drain_infer_stream())
except HTTPException as exc:
    stream_blocked = exc.status_code == 429
ok(stream_blocked, "iter_infer_tts_ndjson_stream_llm_stream returns 429 when over cap")

section("streaming text LLM path enforces cap")
_reset()
_fill_anon_voice_credits(34)


async def _drain_text_stream() -> None:
    gen = app_mod.iter_text_tts_ndjson_stream_llm_stream(
        t_start=0.0,
        t_llm_start=0.0,
        session_id=ANON_SESSION,
        user_text="hello there",
        client="vera",
        history=[],
    )
    async for _ in gen:
        pass


text_blocked = False
try:
    asyncio.run(_drain_text_stream())
except HTTPException as exc:
    text_blocked = exc.status_code == 429
ok(text_blocked, "iter_text_tts_ndjson_stream_llm_stream returns 429 when over cap")

section("local timer sync path still allowed over cap")
_reset()
_fill_anon_voice_credits(34)
timer_ok = True
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="local_action",
    )
except HTTPException:
    timer_ok = False
ok(timer_ok, "local_action allowed when over daily cap")

section("frontend handles infer 429")
with open(os.path.join(_ROOT, "app.js"), encoding="utf-8") as f:
    app_js = f.read()
ok("!res.ok" in app_js and "infer_main" in app_js, "infer main checks !res.ok")
ok("veraSurfaceLlmFetchFailure" in app_js, "infer uses veraSurfaceLlmFetchFailure")
ok("text_endpoint_http" in app_js or "text_endpoint" in app_js, "text endpoint checks failures")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
