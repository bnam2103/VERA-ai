"""Smoke tests for explicit memory pronoun normalization (Phase 3)."""

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
from fastapi import Request

from auth.jwt_auth import AuthUser
from auth.memory_commands import try_explicit_memory_fastpath
from auth.memory_normalize import (
    format_memory_for_recall,
    forget_query_variants,
    normalize_memory_for_storage,
)
from auth.request_auth import bind_request_auth_user, clear_bound_auth_user
from auth.supabase_config import SupabaseConfig
from auth.supabase_memories import _forget_text_match, create_memory

passed = 0
failed = 0
USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
SECRET = "memory-normalize-test-secret"


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


def _bind_user(user_id: str) -> None:
    token = jwt.encode(
        {
            "sub": user_id,
            "email": "alice@example.com",
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


section("storage normalization")
stored = normalize_memory_for_storage("I love playing tennis and cooking")
ok(stored == "User loves playing tennis and cooking", f"storage: {stored!r}")
stored_pref = normalize_memory_for_storage("I prefer short answers")
ok(stored_pref == "User prefers short answers", f"prefer storage: {stored_pref!r}")
stored_name = normalize_memory_for_storage("my name is Nam")
ok(stored_name == "User's name is Nam", f"name storage: {stored_name!r}")

section("recall formatting")
recall = format_memory_for_recall(stored)
ok("you love playing tennis" in recall.lower(), f"recall love: {recall!r}")
recall_pref = format_memory_for_recall(stored_pref)
ok(recall_pref == "you prefer short answers", f"recall prefer: {recall_pref!r}")

section("remember + recall fastpath")
clear_bound_auth_user()
auth_user = AuthUser(user_id=USER_A, email="alice@example.com")
cfg = SupabaseConfig(
    url="https://example.supabase.co",
    service_role_key="test-key",
    jwt_secret=SECRET,
)
created: list[dict] = []


def _fake_create(config, user_id, content, *, kind="general"):
    from auth.memory_normalize import normalize_memory_for_storage

    normalized = normalize_memory_for_storage(content)
    row = {
        "id": str(uuid.uuid4()),
        "content": normalized,
        "kind": kind,
        "source": "explicit",
    }
    created.append(row)
    return row


def _fake_list(config, user_id, *, limit=50):
    return list(created)[:limit]


with patch("auth.memory_commands.get_bound_auth_user", return_value=auth_user), patch(
    "auth.memory_commands.get_supabase_config", return_value=cfg
), patch("auth.memory_commands.create_memory", side_effect=_fake_create), patch(
    "auth.memory_commands.list_memories", side_effect=_fake_list
):
    try_explicit_memory_fastpath(
        "Remember that I love playing tennis", "sess-a", []
    )
    ok(
        created and created[-1]["content"] == "User loves playing tennis",
        "remember stores normalized text",
    )
    reply = try_explicit_memory_fastpath("What do you remember about me?", "sess-a", [])
    ok(reply and "you love playing tennis" in reply.lower(), f"recall reply: {reply!r}")

    created.clear()
    try_explicit_memory_fastpath("Remember that my name is Nam", "sess-a", [])
    ok(created and created[-1]["content"] == "User's name is Nam", "name stored normalized")

clear_bound_auth_user()

section("identity fastpath uses supabase name")
# Import app after path setup — identity helpers live in app.py.
import app as app_mod

with patch.object(app_mod, "_user_name_from_visible_chat", return_value=None), patch.object(
    app_mod, "_user_name_from_session_facts", return_value=None
), patch.object(app_mod, "_session_scoped_active_user_name", return_value=None), patch(
    "auth.memory_normalize.name_from_supabase_memories", return_value="Nam"
), patch("auth.request_auth.get_bound_auth_user", return_value=AuthUser(user_id=USER_A, email="a@e.com")):
    reply = app_mod._identity_challenge_fastpath_reply("What's my name?", "sess-a", [])
    ok(reply and "Nam" in reply, f"what's my name uses supabase memory: {reply!r}")

section("forget after normalization")
stored_forget = "User loves playing tennis"
ok(
    _forget_text_match("I love playing tennis", stored_forget),
    "forget matches raw first-person query to stored memory",
)
ok(
    _forget_text_match("love playing tennis", stored_forget),
    "forget partial query still matches",
)
variants = forget_query_variants("I prefer short answers")
ok(
    any("User prefers short answers" == v for v in variants),
    "forget query variants include normalized form",
)

section("create_memory applies normalization")
store2: list[str] = []


def _mock_request_json(method, url, headers, payload=None):
    if payload and isinstance(payload, dict):
        store2.append(str(payload.get("content") or ""))
    return [{"id": "1", "content": store2[-1] if store2 else "", "kind": "like"}]


with patch("auth.supabase_memories._request_json", side_effect=_mock_request_json), patch(
    "auth.supabase_memories.count_memories", return_value=0
):
    create_memory(cfg, USER_A, "I prefer short answers")
ok(store2 and store2[0] == "User prefers short answers", "create_memory normalizes before persist")

print(f"\nMemory normalize smoke: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
