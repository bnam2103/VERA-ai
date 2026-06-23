"""Supabase profile display_name for identity / name questions."""

from __future__ import annotations

from auth.request_auth import get_bound_auth_user
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError, ensure_profile, get_profile


def get_supabase_profile_display_name(
    user_id: str | None = None,
    email: str | None = None,
) -> str | None:
    """Return profiles.display_name for a logged-in user, if set and usable.

    Uses the same ensure_profile fallback as /api/auth/me when the row is
    missing. Does not treat an email local-part that matches display_name
    as a real name — those are typically auto-generated on first profile
    row creation.
    """
    uid = user_id
    user_email = email
    if not uid:
        user = get_bound_auth_user()
        if not user:
            return None
        uid = user.user_id
        user_email = user.email

    config = get_supabase_config()
    if not config.db_configured or not uid:
        return None

    row: dict | None = None
    try:
        row = get_profile(config, uid)
        if not row:
            row = ensure_profile(config, uid, email=user_email)
    except SupabaseDbError as exc:
        print(f"[profile_identity] profile lookup failed: {exc}", flush=True)
        return None
    except Exception as exc:
        print(f"[profile_identity] profile lookup error: {exc}", flush=True)
        return None

    if not isinstance(row, dict):
        return None

    display_name = str(row.get("display_name") or "").strip()
    if not display_name:
        return None

    local = ""
    if user_email and "@" in user_email:
        local = user_email.split("@", 1)[0].strip()
    if local and display_name.lower() == local.lower():
        return None

    return display_name


def profile_display_name_for_bound_user() -> str | None:
    """Convenience wrapper using the current request-bound auth user."""
    user = get_bound_auth_user()
    if not user:
        return None
    name = get_supabase_profile_display_name(user.user_id, user.email)
    if name is None:
        print(
            "[profile_identity] display_name unavailable "
            + f"user_id={(user.user_id or '')[:36]} "
            + f"email={(user.email or '')[:48]}",
            flush=True,
        )
    return name
