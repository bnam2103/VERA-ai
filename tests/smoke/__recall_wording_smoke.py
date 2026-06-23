"""Smoke tests: natural profile/memory recall wording."""

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

import app as app_mod
from auth.jwt_auth import AuthUser
from auth.memory_commands import ABOUT_ME_EMPTY_LOGGED_IN, build_supabase_recall_reply

passed = 0
failed = 0
USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


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


def _identity_reply(*, memory_name=None, profile_name=None):
    with patch.object(app_mod, "_user_name_from_visible_chat", return_value=None), patch.object(
        app_mod, "_user_name_from_supabase_memories", return_value=memory_name
    ), patch.object(
        app_mod, "_user_name_from_supabase_profile", return_value=profile_name
    ), patch.object(
        app_mod, "_user_name_from_session_facts", return_value=None
    ), patch.object(
        app_mod, "_session_scoped_active_user_name", return_value=None
    ), patch.object(
        app_mod, "_identity_uses_supabase_account_priority", return_value=True
    ):
        return app_mod._identity_challenge_fastpath_reply("What's my name?", "sess-a", [])


def _about_me_reply(*, profile_name=None, explicit_name=None, rows=None):
    auth_user = AuthUser(user_id=USER_ID, email="ned@example.com")
    with patch("auth.memory_commands.get_bound_auth_user", return_value=auth_user), patch(
        "auth.memory_commands.get_supabase_profile_display_name", return_value=profile_name
    ), patch(
        "auth.memory_commands.name_from_supabase_memories", return_value=explicit_name
    ), patch(
        "auth.memory_commands.list_memories", return_value=rows or []
    ), patch(
        "auth.memory_commands.get_supabase_config"
    ) as cfg:
        cfg.return_value.db_configured = True
        return build_supabase_recall_reply(USER_ID, "sess-a")


section("what's my name? wording")
reply_profile = _identity_reply(memory_name=None, profile_name="Ned")
ok(reply_profile == "I know you as Ned.", f"profile only: {reply_profile!r}")

reply_memory = _identity_reply(memory_name="Nam", profile_name="Ned")
ok(reply_memory == "Your name is Nam.", f"explicit memory wins: {reply_memory!r}")

section("what do you know about me? — profile + memories")
tennis_row = {
    "id": "m1",
    "content": "User loves playing tennis and cooking",
    "kind": "like",
}
reply_both = _about_me_reply(
    profile_name="Ned",
    rows=[tennis_row],
)
ok(
    "know you as Ned" in reply_both and "tennis" in reply_both.lower(),
    f"profile + memory: {reply_both!r}",
)

section("profile only")
reply_profile_only = _about_me_reply(profile_name="Ned", rows=[])
ok(
    "know you as Ned" in reply_profile_only and "haven't asked me" in reply_profile_only,
    f"profile only: {reply_profile_only!r}",
)

section("memory only")
reply_mem_only = _about_me_reply(profile_name=None, rows=[tennis_row])
ok(
    reply_mem_only.startswith("I remember that") and "tennis" in reply_mem_only.lower(),
    f"memory only: {reply_mem_only!r}",
)

section("empty state")
reply_empty = _about_me_reply(profile_name=None, rows=[])
ok(reply_empty == ABOUT_ME_EMPTY_LOGGED_IN, f"empty: {reply_empty!r}")

section("explicit name memory + profile on about-me")
name_row = {"id": "n1", "content": "User's name is Nam", "kind": "name"}
reply_name_wins = _about_me_reply(
    profile_name="Ned",
    explicit_name="Nam",
    rows=[name_row, tennis_row],
)
ok(
    "know you as Nam" in reply_name_wins and "Ned" not in reply_name_wins,
    f"explicit name beats profile in about-me: {reply_name_wins!r}",
)

section("anonymous logged-out unchanged")
with patch.object(app_mod, "_user_name_from_visible_chat", return_value=None), patch(
    "auth.memory_commands.name_from_supabase_memories", return_value=None
), patch(
    "auth.profile_identity.profile_display_name_for_bound_user", return_value=None
), patch.object(app_mod, "_user_name_from_session_facts", return_value=None), patch.object(
    app_mod, "_session_scoped_active_user_name", return_value=None
):
    anon = app_mod._identity_challenge_fastpath_reply("What's my name?", "anon-sess", [])
ok(
    anon == app_mod._IDENTITY_FASTPATH_NO_GROUND,
    f"logged-out identity unchanged: {anon!r}",
)

section("forget name memory falls back to profile")
history_after_forget = [
    {"role": "user", "content": "Remember that my name is Nam."},
    {"role": "assistant", "content": "Got it. I'll remember that."},
    {"role": "user", "content": "Forget that my name is Nam."},
    {"role": "assistant", "content": "Okay, I've removed that memory."},
]
with patch.object(app_mod, "_user_name_from_visible_chat", wraps=app_mod._user_name_from_visible_chat) as hist_mock, patch.object(
    app_mod, "_user_name_from_supabase_memories", return_value=None
), patch.object(
    app_mod, "_user_name_from_supabase_profile", return_value="Ned"
), patch.object(
    app_mod, "_user_name_from_session_facts", return_value=None
), patch.object(
    app_mod, "_session_scoped_active_user_name", return_value=None
), patch.object(
    app_mod, "_identity_uses_supabase_account_priority", return_value=True
):
    # history scan must ignore remember/forget command lines
    hist_val = app_mod._user_name_from_visible_chat(history_after_forget)
    ok(hist_val is None, f"remember/forget lines not chat disclosure: {hist_val!r}")
    reply_after_forget = app_mod._identity_challenge_fastpath_reply(
        "What's my name?", "sess-a", history=history_after_forget
    )
ok(
    reply_after_forget == "I know you as Ned.",
    f"after forget name memory -> profile Ned: {reply_after_forget!r}",
)

section("name memory beats profile when present")
with patch.object(app_mod, "_user_name_from_visible_chat", return_value=None), patch.object(
    app_mod, "_user_name_from_supabase_memories", return_value="Nam"
), patch.object(
    app_mod, "_user_name_from_supabase_profile", return_value="Ned"
), patch.object(
    app_mod, "_user_name_from_session_facts", return_value=None
), patch.object(
    app_mod, "_session_scoped_active_user_name", return_value=None
), patch.object(
    app_mod, "_identity_uses_supabase_account_priority", return_value=True
):
    reply_nam_mem = app_mod._identity_challenge_fastpath_reply("What's my name?", "sess-a", [])
ok(reply_nam_mem == "Your name is Nam.", f"explicit memory over profile: {reply_nam_mem!r}")

print(f"\nRecall wording smoke: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
