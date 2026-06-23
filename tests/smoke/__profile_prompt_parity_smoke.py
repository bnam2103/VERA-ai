"""Smoke: Supabase account context in streaming/sync LLM prompts (parity fix).

Run:  py -3 -X utf8 tests\\smoke\\__profile_prompt_parity_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
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

from auth.jwt_auth import AuthUser
from auth.memory_context import (
    build_supabase_account_context_block,
    inject_explicit_user_memory,
    prepend_explicit_memory_to_attachment_context,
)
from auth.request_auth import bind_request_auth_user, clear_bound_auth_user
from auth.supabase_config import SupabaseConfig

passed = 0
failed = 0

USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SECRET = "profile-prompt-parity-secret"
FAKE_LEGACY_PROFILE = {
    "status": "user",
    "user_profile": {
        "name": "LegacyNam",
        "habits": ["napping"],
    },
}


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


def _bind(user_id: str = USER_ID, email: str = "ned@example.com") -> None:
    import jwt
    import time
    from fastapi import Request

    token = jwt.encode(
        {
            "sub": user_id,
            "email": email,
            "role": "authenticated",
            "aud": "authenticated",
            "exp": int(time.time()) + 3600,
        },
        SECRET,
        algorithm="HS256",
    )
    scope = {
        "type": "http",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
        "method": "GET",
        "path": "/",
    }

    async def _receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    bind_request_auth_user(Request(scope, _receive))


section("build_supabase_account_context_block")
clear_bound_auth_user()
_cfg = SupabaseConfig(
    url="https://example.supabase.co",
    service_role_key="test-service-role",
    jwt_secret=SECRET,
)
with patch("auth.memory_context.get_supabase_config", return_value=_cfg), patch(
    "auth.memory_context.list_memories",
    return_value=[{"content": "User prefers concise answers."}],
), patch(
    "auth.memory_context.get_supabase_profile_display_name",
    return_value="Ned",
):
    block = build_supabase_account_context_block(USER_ID)
ok("Account display name: Ned" in block, "display_name in account block")
ok("EXPLICIT_USER_MEMORY:" in block, "memories in account block")
ok("* User prefers concise answers." in block, "memory bullet present")
ok("password" not in block.lower(), "no password field in block")

with patch("auth.memory_context.get_supabase_config", return_value=_cfg), patch(
    "auth.memory_context.list_memories",
    return_value=[],
), patch(
    "auth.memory_context.get_supabase_profile_display_name",
    return_value=None,
):
    mem_only_empty = build_supabase_account_context_block(USER_ID)
ok(mem_only_empty == "", "no block when no display_name and no memories")

section("legacy profile suppressed when JWT bound")
import app as app_mod

clear_bound_auth_user()
_auth_user = AuthUser(user_id=USER_ID, email="ned@example.com")
with patch("auth.request_auth.get_bound_auth_user", return_value=_auth_user):
    app_mod._session_active_user["sess-parity"] = "Nam"
    with patch.object(
        app_mod,
        "_session_scoped_active_user_info",
        return_value=FAKE_LEGACY_PROFILE,
    ) as legacy_mock:
        resolved = app_mod._session_active_user_info_for_prompt("sess-parity")
    ok(resolved is None, "JWT bound => legacy profile suppressed for build_messages")
    legacy_mock.assert_not_called()

clear_bound_auth_user()
with patch("auth.request_auth.get_bound_auth_user", return_value=None):
    with patch.object(
        app_mod,
        "_session_scoped_active_user_info",
        return_value=FAKE_LEGACY_PROFILE,
    ) as legacy_mock2:
        resolved_anon = app_mod._session_active_user_info_for_prompt("sess-parity")
    ok(resolved_anon is FAKE_LEGACY_PROFILE, "logged-out => legacy profile still used")
    legacy_mock2.assert_called_once()

section("streaming infer message assembly includes account context")
clear_bound_auth_user()

built: dict = {}

def _fake_build_messages(chat_history, user_text, *, session_active_user_info=object()):
    built["session_active_user_info"] = session_active_user_info
    return [{"role": "developer", "content": "BASE_PROMPT"}]

async def _run_infer_stream_messages():
    import asyncio

    fake_vera = MagicMock()
    fake_vera.build_messages.side_effect = _fake_build_messages

    orig_vera = app_mod.vera
    app_mod.vera = fake_vera
    try:
        gen = app_mod.iter_infer_tts_ndjson_stream_llm_stream(
            infer_t0=0.0,
            session_id="sess-parity",
            transcript="hello",
            client="vera",
            t_pre_asr=0.0,
            t_asr_lock=0.0,
            t_asr_transcribe=0.0,
            t_asr_lock_end=0.0,
            t_llm_start=0.0,
            t_bridge=0.0,
            history=[],
        )
        first = await gen.__anext__()
        return first, built
    finally:
        app_mod.vera = orig_vera


with patch("auth.request_auth.get_bound_auth_user", return_value=_auth_user), patch(
    "auth.memory_context.get_bound_auth_user",
    return_value=_auth_user,
), patch(
    "auth.memory_context.get_supabase_config",
    return_value=_cfg,
), patch(
    "auth.memory_context.list_memories",
    return_value=[{"content": "Likes jazz."}],
), patch(
    "auth.memory_context.get_supabase_profile_display_name",
    return_value="Ned",
), patch.object(
    app_mod, "_pump_llm_segments_to_queue", side_effect=lambda *a, **k: None
):
    import asyncio

    meta_line, built_info = asyncio.run(_run_infer_stream_messages())
    ok(built_info.get("session_active_user_info") is None, "infer stream passes None legacy profile when JWT bound")
    msgs = app_mod._inject_supabase_account_context([{"role": "developer", "content": "BASE_PROMPT"}])
    ok("EXPLICIT_USER_MEMORY:" in str(msgs[0].get("content")), "infer path inject adds EXPLICIT_USER_MEMORY")
    ok("Account display name: Ned" in str(msgs[0].get("content")), "infer path inject adds display name")

section("text streaming message assembly includes account context")
clear_bound_auth_user()
built_text: dict = {}

def _fake_build_messages_text(chat_history, user_text, *, session_active_user_info=object()):
    built_text["session_active_user_info"] = session_active_user_info
    return [{"role": "developer", "content": "BASE_PROMPT"}]

async def _run_text_stream_messages():
    fake_vera = MagicMock()
    fake_vera.build_messages.side_effect = _fake_build_messages_text
    orig_vera = app_mod.vera
    app_mod.vera = fake_vera
    try:
        gen = app_mod.iter_text_tts_ndjson_stream_llm_stream(
            t_start=0.0,
            t_llm_start=0.0,
            session_id="sess-parity",
            user_text="hello",
            client="vera",
            history=[],
        )
        first = await gen.__anext__()
        return first, built_text
    finally:
        app_mod.vera = orig_vera

with patch("auth.request_auth.get_bound_auth_user", return_value=_auth_user), patch(
    "auth.memory_context.get_bound_auth_user",
    return_value=_auth_user,
), patch(
    "auth.memory_context.get_supabase_config",
    return_value=_cfg,
), patch(
    "auth.memory_context.list_memories",
    return_value=[{"content": "Likes jazz."}],
), patch(
    "auth.memory_context.get_supabase_profile_display_name",
    return_value="Ned",
), patch.object(
    app_mod, "_pump_llm_segments_to_queue", side_effect=lambda *a, **k: None
):
    import asyncio

    asyncio.run(_run_text_stream_messages())
    ok(built_text.get("session_active_user_info") is None, "text stream passes None legacy profile when JWT bound")
    text_msgs = app_mod._inject_supabase_account_context([{"role": "developer", "content": "BASE_PROMPT"}])
    ok("EXPLICIT_USER_MEMORY:" in str(text_msgs[0].get("content")), "text path inject adds EXPLICIT_USER_MEMORY")

section("reasoning attachment prepend includes display name")
with patch("auth.memory_context.get_bound_auth_user", return_value=_auth_user), patch(
    "auth.memory_context.get_supabase_config", return_value=_cfg
), patch(
    "auth.memory_context.list_memories",
    return_value=[{"content": "Builds VERA."}],
), patch(
    "auth.memory_context.get_supabase_profile_display_name",
    return_value="Ned",
):
    prep = prepend_explicit_memory_to_attachment_context("lane ctx")
ok(prep and "Account display name: Ned" in prep, "reasoning attachment has display name")
ok(prep and "EXPLICIT_USER_MEMORY:" in prep, "reasoning attachment has memories")
ok(prep and "lane ctx" in prep, "reasoning lane context preserved")

section("run_general_llm uses same inject helper")
clear_bound_auth_user()
msgs_holder: list = []

def _capture_inject(messages):
    msgs_holder.append(list(messages))
    return messages

with patch.object(app_mod, "_inject_supabase_account_context", side_effect=_capture_inject), patch.object(
    app_mod, "vera", MagicMock()
), patch.object(app_mod, "_inject_client_context_snapshot", side_effect=lambda m, *a, **k: (m, {})), patch.object(
    app_mod, "_inject_thread_follow_up_anchor", side_effect=lambda m, *a, **k: m
), patch.object(
    app_mod, "_inject_reasoning_voice_coach", side_effect=lambda m, *a, **k: m
), patch.object(
    app_mod, "_inject_reasoning_attachment_context", side_effect=lambda m, *a, **k: m
), patch.object(
    app_mod, "_inject_work_mode_reasoning_handoff", side_effect=lambda m, *a, **k: m
), patch.object(
    app_mod, "_inject_work_mode_voice_brief_completion_rules", side_effect=lambda m, *a, **k: m
), patch.object(
    app_mod, "inject_recent_action_context", side_effect=lambda m, *a, **k: m
), patch.object(
    app_mod.vera, "build_messages", return_value=[{"role": "developer", "content": "x"}]
), patch.object(
    app_mod.vera, "generate", return_value=("ok", 1.0)
):
    app_mod.run_general_llm([], "hi", "sess-parity")

ok(len(msgs_holder) == 1, "run_general_llm invokes account context inject")

clear_bound_auth_user()
app_mod._session_active_user.pop("sess-parity", None)

print(f"\n{'=' * 40}")
print(f"Results: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
print("All profile prompt parity smoke tests passed.")
