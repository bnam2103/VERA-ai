"""Smoke: Vera usage credit weights, caps, and ledger settlement.

Run:  py -3 -X utf8 tests\\smoke\\__credit_caps_smoke.py
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
from fastapi import HTTPException

passed = 0
failed = 0

USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
ANON_SESSION = "anon-credit-smoke"
SIGNED_SESSION = "signed-credit-smoke"


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


section("credit weights")
ok(compute_credits("voice_assistant") == 3, "voice_assistant = 3")
ok(compute_credits("simple_llm") == 3, "simple_llm = 3")
ok(compute_credits("weather") == 1, "weather = 1")
ok(compute_credits("search_or_news") == 6, "search_or_news = 6")
ok(compute_credits("work_mode_reasoning") == 12, "work_mode_reasoning = 12")
ok(compute_credits("work_mode_reasoning_deep") == 20, "work_mode_reasoning_deep = 20")
ok(compute_credits("image_pdf_reasoning") == 20, "image_pdf_reasoning = 20")
ok(compute_credits("local_action") == 0, "local_action = 0")
ok(compute_credits("failed_request") == 0, "failed_request = 0")
ok(compute_credits("bmo_tts") == 0, "bmo_tts = 0")

section("classifier mapping")
action, _ = classify_credit_action(
    mode="nonwork_mode",
    request_type="command",
    extras={"http_path": "/text"},
    events=[{"provider": "openai", "output_tokens": 120}],
    success=True,
)
ok(action == "voice_assistant", "openai chat => voice_assistant")
action_fail, _ = classify_credit_action(
    mode="nonwork_mode",
    request_type="command",
    extras={},
    events=[{"provider": "openai", "output_tokens": 10}],
    success=False,
)
ok(action_fail == "failed_request", "failed request => failed_request")
action_local, _ = classify_credit_action(
    mode="nonwork_mode",
    request_type="state_sync",
    extras={"http_path": "/api/work-mode/timer"},
    events=[],
    success=True,
)
ok(action_local == "local_action", "timer sync => local_action")
action_serper, _ = classify_credit_action(
    mode="nonwork_mode",
    request_type="news",
    extras={},
    events=[{"provider": "serper", "query_count": 1}],
    success=True,
)
ok(action_serper == "search_or_news", "serper => search_or_news")
action_wm, _ = classify_credit_action(
    mode="work_mode",
    request_type="reasoning",
    extras={
        "http_path": "/work_mode/reasoning_panel_title",
        "deep_reasoning_effort_active": False,
    },
    events=[{"provider": "openai", "output_tokens": 50, "reasoning_tokens": 10}],
    success=True,
)
ok(action_wm == "work_mode_reasoning", "short non-stream reasoning => work_mode_reasoning")

section("anonymous voice LLM charges 3 credits")
_reset()
ce.record_credit_usage(None, ANON_SESSION, "req-voice-anon", "voice_assistant", 3)
daily = ce.get_daily_credit_usage(None, ANON_SESSION)
ok(daily["credits_used"] == 3, "anon voice adds 3 credits")
ok(daily["voice_turns"] == 1, "anon voice increments voice_turns")

section("signed-in voice LLM charges 3 credits")
_reset()
ce.record_credit_usage(USER_ID, SIGNED_SESSION, "req-voice-signed", "voice_assistant", 3)
daily_signed = ce.get_daily_credit_usage(USER_ID, SIGNED_SESSION)
ok(daily_signed["credits_used"] == 3, "signed voice adds 3 credits")

section("local actions charge 0 credits")
_reset()
ce.record_credit_usage(None, ANON_SESSION, "req-local", "local_action", 0)
ok(ce.get_daily_credit_usage(None, ANON_SESSION)["credits_used"] == 0, "local_action adds 0")

section("weather charges 1 credit and logs weather calls")
_reset()
ce.record_credit_usage(
    None,
    ANON_SESSION,
    "req-weather",
    "weather",
    1,
    events=[{"provider": "openweather", "call_count": 2}],
)
w_daily = ce.get_daily_credit_usage(None, ANON_SESSION)
ok(w_daily["credits_used"] == 1, "weather adds 1 credit")
ok(w_daily["weather_calls"] == 2, "weather logs openweather call count")

section("search charges 6 credits and logs serper")
_reset()
ce.record_credit_usage(
    None,
    ANON_SESSION,
    "req-search",
    "search_or_news",
    6,
    events=[{"provider": "serper", "query_count": 1}],
)
s_daily = ce.get_daily_credit_usage(None, ANON_SESSION)
ok(s_daily["credits_used"] == 6, "search adds 6 credits")
ok(s_daily["search_turns"] == 1, "search increments search_turns")
ok(s_daily["serper_calls"] == 1, "search logs serper call count")

section("work mode reasoning charges 12 and increments reasoning_streams")
_reset()
ce.record_credit_usage(None, ANON_SESSION, "req-wm", "work_mode_reasoning", 12)
wm_daily = ce.get_daily_credit_usage(None, ANON_SESSION)
ok(wm_daily["credits_used"] == 12, "work mode adds 12 credits")
ok(wm_daily["reasoning_streams"] == 1, "work mode increments reasoning_streams")

section("deep work mode charges 20 credits")
_reset()
ce.record_credit_usage(None, ANON_SESSION, "req-deep", "work_mode_reasoning_deep", 20)
ok(ce.get_daily_credit_usage(None, ANON_SESSION)["credits_used"] == 20, "deep work mode adds 20")

section("anonymous image/pdf limited only by total credits")
_reset()
ce.record_credit_usage(None, ANON_SESSION, "req-img-1", "image_pdf_reasoning", 20)
blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="image_pdf_reasoning",
        feature_type="image_pdf",
    )
except HTTPException as exc:
    blocked = exc.status_code == 429
ok(not blocked, "anonymous 2nd image/pdf allowed when total credits remain")
_reset()
for i in range(5):
    ce.record_credit_usage(None, ANON_SESSION, f"req-img-{i}", "image_pdf_reasoning", 20)
img_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="image_pdf_reasoning",
        feature_type="image_pdf",
    )
except HTTPException:
    img_blocked = True
ok(img_blocked, "anonymous image/pdf blocked when total credits exhausted")

section("anonymous daily cap 100 credits")
_reset()
for i in range(33):
    ce.record_credit_usage(None, ANON_SESSION, f"req-cap-{i}", "voice_assistant", 3)
anon_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="voice_assistant",
    )
except HTTPException as exc:
    anon_blocked = exc.status_code == 429
ok(anon_blocked, "anonymous blocked after 100 daily credits")

section("signed-in daily cap 200 credits")
_reset()
for i in range(66):
    ce.record_credit_usage(USER_ID, SIGNED_SESSION, f"req-signed-{i}", "voice_assistant", 3)
signed_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=USER_ID,
        session_id=SIGNED_SESSION,
        credit_action="voice_assistant",
    )
except HTTPException as exc:
    signed_blocked = exc.status_code == 429
ok(signed_blocked, "signed-in blocked after 200 daily credits")

section("work mode blocked only by total credits")
_reset()
for i in range(6):
    ce.record_credit_usage(None, ANON_SESSION, f"wm-{i}", "work_mode_reasoning", 12)
wm_sub_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="work_mode_reasoning",
        feature_type="work_mode",
        credits_needed=12,
    )
except HTTPException:
    wm_sub_blocked = True
ok(not wm_sub_blocked, "anonymous 6th work mode allowed when total credits remain")
ok(
    ce.get_daily_credit_usage(None, ANON_SESSION)["reasoning_streams"] == 6,
    "work mode counter still tracked for analytics",
)

_reset()
for i in range(8):
    ce.record_credit_usage(None, ANON_SESSION, f"wm-cap-{i}", "work_mode_reasoning", 12)
wm_total_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="work_mode_reasoning",
        feature_type="work_mode",
        credits_needed=12,
    )
except HTTPException:
    wm_total_blocked = True
ok(wm_total_blocked, "anonymous work mode blocked when total credits exhausted")

section("search blocked only by total credits")
_reset()
for i in range(11):
    ce.record_credit_usage(None, ANON_SESSION, f"search-{i}", "search_or_news", 6)
search_sub_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="search_or_news",
        feature_type="search",
        credits_needed=6,
    )
except HTTPException:
    search_sub_blocked = True
ok(not search_sub_blocked, "anonymous 12th search allowed when total credits remain")
_reset()
for i in range(16):
    ce.record_credit_usage(None, ANON_SESSION, f"search-cap-{i}", "search_or_news", 6)
search_total_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=None,
        session_id=ANON_SESSION,
        credit_action="search_or_news",
        feature_type="search",
        credits_needed=6,
    )
except HTTPException:
    search_total_blocked = True
ok(search_total_blocked, "anonymous search blocked when total credits exhausted")

section("signed-in mixed routes up to 200 total credits")
_reset()
for i in range(15):
    ce.record_credit_usage(USER_ID, SIGNED_SESSION, f"wm-s-{i}", "work_mode_reasoning", 12)
signed_wm_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=USER_ID,
        session_id=SIGNED_SESSION,
        credit_action="work_mode_reasoning",
        feature_type="work_mode",
        credits_needed=12,
    )
except HTTPException:
    signed_wm_blocked = True
ok(not signed_wm_blocked, "signed-in 16th work mode allowed when total credits remain")
_reset()
for i in range(15):
    ce.record_credit_usage(USER_ID, SIGNED_SESSION, f"mix-wm-{i}", "work_mode_reasoning", 12)
for i in range(3):
    ce.record_credit_usage(USER_ID, SIGNED_SESSION, f"mix-search-{i}", "search_or_news", 6)
signed_mix_blocked = False
try:
    ce.enforce_credit_cap_or_raise(
        user_id=USER_ID,
        session_id=SIGNED_SESSION,
        credit_action="voice_assistant",
    )
except HTTPException:
    signed_mix_blocked = True
ok(signed_mix_blocked, "signed-in blocked only when total credits exhausted")

section("failed requests charge 0 credits")
_reset()
before = ce.get_daily_credit_usage(None, ANON_SESSION)["credits_used"]
ce.settle_request_credits(
    user_id=None,
    session_id=ANON_SESSION,
    request_id="req-fail",
    credit_action="voice_assistant",
    credits_used=3,
    success=False,
    events=[{"provider": "openai", "output_tokens": 10}],
)
after = ce.get_daily_credit_usage(None, ANON_SESSION)["credits_used"]
ok(before == after, "failed request does not increase credits_used")

section("ledger metadata via memory store counters")
_reset()
ce.record_credit_usage(
    None,
    ANON_SESSION,
    "req-ledger",
    "search_or_news",
    6,
    metadata={"request_id": "req-ledger", "route": "news.latest"},
    events=[{"provider": "serper", "query_count": 2}],
)
ledger_daily = ce.get_daily_credit_usage(None, ANON_SESSION)
ok(ledger_daily["credits_used"] == 6, "ledger settlement increments credits_used")
ok(ledger_daily["serper_calls"] == 2, "ledger settlement aggregates serper_calls")

section("estimate_credits_for_route")
ok(ce.estimate_credits_for_route("weather") == 1, "estimate weather")
ok(ce.estimate_credits_for_route("news.latest") == 6, "estimate news.latest")
ok(ce.estimate_credits_for_route("work_mode_reasoning_deep") == 20, "estimate deep reasoning")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
