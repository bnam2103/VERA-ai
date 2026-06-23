"""Shared explicit-memory prompt block for Voice UI and Reasoning Panels."""

from __future__ import annotations

from auth.profile_identity import get_supabase_profile_display_name
from auth.request_auth import get_bound_auth_user
from auth.supabase_config import get_supabase_config
from auth.supabase_memories import MAX_INJECTED_MEMORIES, list_memories

_MEMORY_RULES = (
    "Rules: These are explicit user-requested memories only. "
    "Do not treat them as certain if ambiguous. "
    "Do not infer sensitive traits from them. "
    "Do not mention memories the user has deleted."
)


def _resolve_bound_user(user_id: str | None = None) -> tuple[str | None, str | None]:
    if user_id:
        user = get_bound_auth_user()
        email = user.email if user and user.user_id == user_id else None
        return user_id, email
    user = get_bound_auth_user()
    if not user:
        return None, None
    return user.user_id, user.email


def _build_explicit_memory_section(user_id: str) -> str:
    config = get_supabase_config()
    if not config.db_configured:
        return ""

    rows = list_memories(config, user_id, limit=MAX_INJECTED_MEMORIES)
    lines: list[str] = []
    for row in rows:
        content = str(row.get("content") or "").strip()
        if content:
            lines.append(f"* {content}")
    if not lines:
        return ""

    return "EXPLICIT_USER_MEMORY:\n\n" + "\n".join(lines) + "\n\n" + _MEMORY_RULES


def build_explicit_memory_context_block(user_id: str | None = None) -> str:
    """Compact EXPLICIT_USER_MEMORY block for model prompts (memory bullets only)."""
    uid, _ = _resolve_bound_user(user_id)
    if not uid:
        return ""
    return _build_explicit_memory_section(uid)


def build_supabase_account_context_block(user_id: str | None = None) -> str:
    """Compact Supabase account context: display_name (if set) + explicit memories."""
    uid, email = _resolve_bound_user(user_id)
    if not uid:
        return ""

    parts: list[str] = []
    display_name = get_supabase_profile_display_name(user_id=uid, email=email)
    if display_name:
        parts.append(f"Account display name: {display_name}")

    memory_section = _build_explicit_memory_section(uid)
    if memory_section:
        parts.append(memory_section)

    if not parts:
        return ""
    return "\n\n".join(parts)


def _messages_already_have_account_context(messages: list[dict]) -> bool:
    for msg in messages:
        if msg.get("role") not in ("developer", "system"):
            continue
        content = str(msg.get("content") or "")
        if "EXPLICIT_USER_MEMORY:" in content or "Account display name:" in content:
            return True
    return False


def inject_explicit_user_memory(messages: list[dict]) -> list[dict]:
    block = build_supabase_account_context_block()
    if not block or not messages or _messages_already_have_account_context(messages):
        return messages
    out = list(messages)
    for i, msg in enumerate(out):
        if msg.get("role") in ("developer", "system"):
            out[i] = {
                **msg,
                "content": str(msg.get("content") or "") + "\n\n" + block,
            }
            return out
    out.insert(0, {"role": "developer", "content": block})
    return out


def prepend_explicit_memory_to_attachment_context(attachment: str | None) -> str | None:
    block = build_supabase_account_context_block()
    if not block:
        return attachment
    base = (attachment or "").strip()
    if "EXPLICIT_USER_MEMORY:" in base or "Account display name:" in base:
        return attachment if base else None
    if not base:
        return block
    return block + "\n\n" + base
