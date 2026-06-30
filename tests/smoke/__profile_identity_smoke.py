"""Smoke tests: Supabase profile.display_name in identity/name fastpath."""

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
from auth.profile_identity import get_supabase_profile_display_name

passed = 0
failed = 0


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


def _identity_reply(
    *,
    memory_name=None,
    profile_name=None,
    session_name=None,
    legacy_name=None,
    session_id="sess-test",
    history=None,
):
    with patch.object(app_mod, "_user_name_from_visible_chat", return_value=None), patch.object(
        app_mod, "_user_name_from_supabase_memories", return_value=memory_name
    ), patch.object(
        app_mod, "_user_name_from_supabase_profile", return_value=profile_name
    ), patch.object(
        app_mod, "_user_name_from_session_facts", return_value=session_name
    ), patch.object(
        app_mod, "_session_scoped_active_user_name", return_value=legacy_name
    ), patch.object(
        app_mod, "_identity_uses_supabase_account_priority", return_value=True
    ):
        return app_mod._identity_challenge_fastpath_reply(
            "What's my name?", session_id, history=history or []
        )


section("profile display_name fallback")
reply_nam = _identity_reply(memory_name=None, profile_name="NED")
ok(reply_nam and "NED" in reply_nam, f"profile NED only: {reply_nam!r}")
ok(
    reply_nam and ("know you as NED" in reply_nam or "account name" in reply_nam.lower()),
    "profile reply uses natural account-name wording",
)

reply_ned = _identity_reply(memory_name="Ned", profile_name="Nam")
ok(reply_ned and "Ned" in reply_ned and "Nam" not in reply_ned, f"memory Ned beats profile Nam: {reply_ned!r}")

reply_unknown = _identity_reply(memory_name=None, profile_name=None, session_name=None, legacy_name=None)
ok(
    reply_unknown == app_mod._IDENTITY_FASTPATH_NO_GROUND,
    f"no sources -> unknown: {reply_unknown!r}",
)

section("ASR transcript variants")
matched_whats, _ = app_mod._detect_identity_challenge("Whats my name")
ok(matched_whats, "ASR 'Whats my name' matches identity challenge")
matched_curly, _ = app_mod._detect_identity_challenge("What\u2019s my name?")
ok(matched_curly, "curly-apostrophe 'What's my name?' matches identity challenge")
reply_whats = _identity_reply(memory_name=None, profile_name="NED")
ok(reply_whats and "NED" in reply_whats and "know you as" in reply_whats.lower(), f"Whats my name + profile NED: {reply_whats!r}")

section("anonymous logged-out unchanged")
with patch.object(app_mod, "_user_name_from_visible_chat", return_value=None), patch(
    "auth.memory_normalize.name_from_supabase_memories", return_value=None
), patch(
    "auth.profile_identity.profile_display_name_for_bound_user", return_value=None
), patch.object(app_mod, "_user_name_from_session_facts", return_value=None), patch.object(
    app_mod, "_session_scoped_active_user_name", return_value=None
):
    anon = app_mod._identity_challenge_fastpath_reply("What's my name?", "anon-sess", history=[])
ok(
    anon == app_mod._IDENTITY_FASTPATH_NO_GROUND,
    f"logged-out anonymous unchanged: {anon!r}",
)

section("ensure_profile fallback when row missing")
from auth.supabase_config import SupabaseConfig

cfg = SupabaseConfig(url="https://example.supabase.co", service_role_key="k", jwt_secret="s")
with patch("auth.profile_identity.get_profile", return_value=None), patch(
    "auth.profile_identity.ensure_profile",
    return_value={"display_name": "NED"},
), patch(
    "auth.profile_identity.get_supabase_config", return_value=cfg
):
    dn = get_supabase_profile_display_name("uid-1", "nedvip2004@gmail.com")
ok(dn == "NED", f"ensure_profile fallback returns display_name: {dn!r}")

section("email local-part not treated as display name")
with patch("auth.profile_identity.get_profile", return_value={"display_name": "alice"}), patch(
    "auth.profile_identity.get_supabase_config", return_value=cfg
):
    dn_email = get_supabase_profile_display_name("uid", "alice@example.com")
ok(dn_email is None, "email local-part matching display_name is not used as name")

print(f"\nProfile identity smoke: {passed} passed, {failed} failed")
if failed:
    sys.exit(1)
