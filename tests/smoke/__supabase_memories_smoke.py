"""Phase 3 smoke: explicit Supabase memories API, commands, and prompt injection.

Run:  py -3 -X utf8 tests\\smoke\\__supabase_memories_smoke.py
"""
from __future__ import annotations

import io
import os
import sys
import time
import uuid
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
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from auth.jwt_auth import AuthUser
from auth.memory_commands import (
    extract_forget_query,
    extract_remember_content,
    is_forget_memory_command,
    try_explicit_memory_fastpath,
)
from auth.memory_context import (
    build_explicit_memory_context_block,
    build_supabase_account_context_block,
    inject_explicit_user_memory,
    prepend_explicit_memory_to_attachment_context,
)
from auth.memory_routes import router as memory_router
from auth.request_auth import bind_request_auth_user, clear_bound_auth_user
from auth.supabase_config import SupabaseConfig
from auth.supabase_memories import MAX_INJECTED_MEMORIES, _forget_text_match

passed = 0
failed = 0

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
SECRET = "phase3-memories-test-secret"


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


def _make_token(*, sub: str, email: str = "alice@example.com") -> str:
    payload = {
        "sub": sub,
        "email": email,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


def _memory_test_client() -> TestClient:
    app = FastAPI()
    app.include_router(memory_router)
    cfg = SupabaseConfig(
        url="https://example.supabase.co",
        service_role_key="test-service-role",
        jwt_secret=SECRET,
    )
    import auth.memory_routes as mem_routes
    import auth.jwt_auth as jwt_mod

    mem_routes.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    jwt_mod.get_supabase_config = lambda: cfg  # type: ignore[method-assign]
    return TestClient(app)


def _bind_user(user_id: str, email: str = "alice@example.com") -> None:
    scope = {
        "type": "http",
        "headers": [(b"authorization", f"Bearer {_make_token(sub=user_id, email=email)}".encode())],
        "method": "GET",
        "path": "/",
    }

    async def _receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    req = Request(scope, _receive)
    bind_request_auth_user(req)


section("remember / forget parsing")
ok(
    extract_remember_content("Remember that I prefer short, direct answers.")
    == "I prefer short, direct answers",
    "remember that … extracts content",
)
ok(
    extract_remember_content("Note that I am building Vera.") == "I am building Vera",
    "note that … extracts content",
)
ok(
    extract_remember_content("Save this: use metric units.") == "use metric units",
    "save this … extracts content",
)
ok(is_forget_memory_command("Forget that I prefer short direct answers."), "forget command detected")
ok(
    extract_forget_query("Forget that I prefer short direct answers")
    == "I prefer short direct answers",
    "forget query extracted",
)
ok(_forget_text_match("short direct answers", "I prefer short, direct answers."), "forget fuzzy match")

section("prompt injection block")
clear_bound_auth_user()
_cfg = SupabaseConfig(
    url="https://example.supabase.co",
    service_role_key="test-service-role",
    jwt_secret=SECRET,
)
with patch("auth.memory_context.get_supabase_config", return_value=_cfg), patch(
    "auth.memory_context.list_memories"
) as lm:
    lm.return_value = [
        {"content": "User prefers short, direct answers."},
        {"content": "User is building Vera."},
    ]
    block = build_explicit_memory_context_block(USER_A)
ok("EXPLICIT_USER_MEMORY:" in block, "block has label")
ok("* User prefers short, direct answers." in block, "block lists memory 1")
ok("* User is building Vera." in block, "block lists memory 2")
ok("Do not infer sensitive traits" in block, "block has safety rules")

with patch("auth.memory_context.get_supabase_config", return_value=_cfg), patch(
    "auth.memory_context.list_memories"
) as lm2:
    lm2.return_value = [{"content": f"fact {i}"} for i in range(12)]

    def _list_respecting_limit(config, uid, *, limit=50):
        return lm2.return_value[:limit]

    lm2.side_effect = _list_respecting_limit
    block_cap = build_explicit_memory_context_block(USER_A)
    bullet_count = block_cap.count("\n* ")
    ok(bullet_count <= MAX_INJECTED_MEMORIES, f"injection capped at {MAX_INJECTED_MEMORIES}")

with patch("auth.memory_context.get_supabase_config", return_value=_cfg), patch(
    "auth.memory_context.list_memories", return_value=[{"content": "test memory"}]
), patch(
    "auth.memory_context.get_bound_auth_user",
    return_value=AuthUser(user_id=USER_A, email="alice@example.com"),
):
    msgs = inject_explicit_user_memory([{"role": "developer", "content": "base"}])
    ok("EXPLICIT_USER_MEMORY:" in str(msgs[0].get("content")), "inject_explicit_user_memory appends to developer")
    prepended = prepend_explicit_memory_to_attachment_context("lane context here")
    ok(prepended and prepended.startswith("EXPLICIT_USER_MEMORY:"), "prepend to reasoning attachment")
    ok("lane context here" in (prepended or ""), "attachment context preserved after prepend")

with patch("auth.memory_context.get_supabase_config", return_value=_cfg), patch(
    "auth.memory_context.list_memories", return_value=[{"content": "test memory"}]
), patch(
    "auth.memory_context.get_supabase_profile_display_name", return_value="Ned"
):
    account_block = build_supabase_account_context_block(USER_A)
    ok("Account display name: Ned" in account_block, "account block includes display_name")
    ok("EXPLICIT_USER_MEMORY:" in account_block, "account block includes memories")

section("memory API auth gates")
client = _memory_test_client()
token_a = _make_token(sub=USER_A)

r_anon = client.get("/api/memories")
ok(r_anon.status_code == 401, "GET /api/memories anonymous => 401")

r_post_anon = client.post("/api/memories", json={"content": "test"})
ok(r_post_anon.status_code == 401, "POST /api/memories anonymous => 401")

store: dict[str, list[dict]] = {USER_A: [], USER_B: []}

def _fake_list(config, user_id, *, limit=50):
    return list(store.get(user_id, []))[:limit]


def _fake_create(config, user_id, content, *, kind="general"):
    row = {
        "id": str(uuid.uuid4()),
        "content": content.strip(),
        "kind": kind,
        "source": "explicit",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }
    store.setdefault(user_id, []).append(row)
    return row


def _fake_delete(config, user_id, memory_id):
    rows = store.get(user_id, [])
    store[user_id] = [r for r in rows if r.get("id") != memory_id]
    return True


def _fake_forget(config, user_id, query_text):
    deleted = []
    for row in list(store.get(user_id, [])):
        if _forget_text_match(query_text, str(row.get("content") or "")):
            _fake_delete(config, user_id, str(row.get("id")))
            deleted.append(row)
    return deleted


with patch("auth.memory_routes.list_memories", side_effect=_fake_list), patch(
    "auth.memory_routes.create_memory", side_effect=_fake_create
), patch("auth.memory_routes.delete_memory", side_effect=_fake_delete), patch(
    "auth.memory_routes.forget_memories_matching", side_effect=_fake_forget
):
    r_create = client.post(
        "/api/memories",
        headers={"Authorization": f"Bearer {token_a}"},
        json={"content": "I prefer short, direct answers."},
    )
    ok(r_create.status_code == 200 and r_create.json().get("ok"), "logged-in POST creates memory")
    mem_id = r_create.json().get("memory", {}).get("id")
    ok(bool(mem_id), "create returns memory id")

    r_list = client.get("/api/memories", headers={"Authorization": f"Bearer {token_a}"})
    ok(r_list.status_code == 200 and r_list.json().get("count") == 1, "GET lists saved memory")

    r_forget = client.post(
        "/api/memories/forget",
        headers={"Authorization": f"Bearer {token_a}"},
        json={"query": "short direct answers"},
    )
    ok(r_forget.status_code == 200 and r_forget.json().get("deleted_count") == 1, "POST forget removes match")

    r_list2 = client.get("/api/memories", headers={"Authorization": f"Bearer {token_a}"})
    ok(r_list2.json().get("count") == 0, "memory gone after forget")

    r_create2 = client.post(
        "/api/memories",
        headers={"Authorization": f"Bearer {token_a}"},
        json={"content": "Second memory for delete test."},
    )
    del_id = r_create2.json().get("memory", {}).get("id")
    r_del = client.delete(
        f"/api/memories/{del_id}",
        headers={"Authorization": f"Bearer {token_a}"},
    )
    ok(r_del.status_code == 200, "DELETE /api/memories/{id} succeeds")

    token_b = _make_token(sub=USER_B, email="bob@example.com")
    store[USER_A] = [{"id": "only-a", "content": "A secret", "kind": "general", "source": "explicit"}]
    r_b_list = client.get("/api/memories", headers={"Authorization": f"Bearer {token_b}"})
    ok(r_b_list.json().get("count") == 0, "user B cannot see user A memories via API list")

    r_b_del = client.delete(
        "/api/memories/only-a",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    ok(r_b_del.status_code == 200, "user B delete call returns 200 (scoped server-side)")
    ok(len(store[USER_A]) == 1, "user B delete did not remove user A row (user_id scoped)")

section("voice/text fastpath")
clear_bound_auth_user()
with patch("auth.memory_commands.create_memory") as cm_anon:
    reply_anon = try_explicit_memory_fastpath(
        "Remember that I like short answers.", "sess-anon", []
    )
    ok(cm_anon.called is False, "anonymous remember does not call create_memory")
    ok(reply_anon and "session" in reply_anon.lower(), "anonymous remember mentions session persistence")

clear_bound_auth_user()
_bind_user(USER_A)
with patch("auth.memory_commands.create_memory") as cm_auth:
    cm_auth.return_value = {"id": "m1", "content": "I prefer short, direct answers."}
    reply_save = try_explicit_memory_fastpath(
        "Remember that I prefer short, direct answers.", "sess-a", []
    )
    ok(cm_auth.called, "logged-in remember calls create_memory")
    ok(reply_save and "remember" in reply_save.lower(), "logged-in remember confirms save")

with patch("auth.memory_commands.list_memories") as lm_recall:
    lm_recall.return_value = [{"content": "I prefer short, direct answers."}]
    reply_recall = try_explicit_memory_fastpath("What do you remember about me?", "sess-a", [])
    ok(reply_recall and "prefer short" in reply_recall.lower(), "recall lists saved memories")

with patch("auth.memory_commands.forget_memories_matching") as fm:
    fm.return_value = [{"content": "I prefer short, direct answers."}]
    reply_forget = try_explicit_memory_fastpath(
        "Forget that I prefer short direct answers.", "sess-a", []
    )
    ok(fm.called, "forget calls forget_memories_matching")
    ok(reply_forget and "removed" in reply_forget.lower(), "forget confirms deletion")

clear_bound_auth_user()
with patch("auth.memory_context.get_supabase_config", return_value=_cfg), patch(
    "auth.memory_context.list_memories"
) as lm_deleted:
    lm_deleted.return_value = []
    block_after = build_explicit_memory_context_block(USER_A)
    ok(block_after == "", "deleted memories not in prompt block")

clear_bound_auth_user()

section("summary")
print(f"\nPhase 3 memories smoke: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
