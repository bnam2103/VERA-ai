"""Explicit memory voice/text commands (remember / recall / forget)."""

from __future__ import annotations

import re

from auth.request_auth import get_bound_auth_user
from auth.supabase_config import get_supabase_config
from auth.supabase_db import SupabaseDbError
from auth.supabase_memories import (
    MAX_MEMORY_CONTENT_LEN,
    create_memory,
    forget_memories_matching,
    list_memories,
)
from auth.memory_normalize import (
    extract_name_from_stored_memory,
    format_memory_for_recall,
    name_from_supabase_memories,
)
from auth.profile_identity import get_supabase_profile_display_name

# Reuse app.py trigger gate via import at call time to avoid circular imports at module load.
_HAS_EXPLICIT_MEMORY_TRIGGER = None
_EXTRACT_SESSION_FACTS = None
_USER_SESSION_FACTS_HAS_CONTENT = None
_GET_SESSION_USER_FACTS = None
_TRANSCRIPT_ASKS_ABOUT_ME = None
_BUILD_ABOUT_ME_REPLY = None


def _app_memory_helpers():
    global _HAS_EXPLICIT_MEMORY_TRIGGER, _EXTRACT_SESSION_FACTS
    global _USER_SESSION_FACTS_HAS_CONTENT, _GET_SESSION_USER_FACTS
    global _TRANSCRIPT_ASKS_ABOUT_ME, _BUILD_ABOUT_ME_REPLY
    if _HAS_EXPLICIT_MEMORY_TRIGGER is None:
        import app as app_mod

        _HAS_EXPLICIT_MEMORY_TRIGGER = app_mod._has_explicit_memory_trigger
        _EXTRACT_SESSION_FACTS = app_mod._extract_and_store_session_user_facts
        _USER_SESSION_FACTS_HAS_CONTENT = app_mod._user_session_facts_has_content
        _GET_SESSION_USER_FACTS = app_mod._get_session_user_facts
        _TRANSCRIPT_ASKS_ABOUT_ME = app_mod._transcript_asks_about_me
        _BUILD_ABOUT_ME_REPLY = app_mod._build_about_me_reply
    return (
        _HAS_EXPLICIT_MEMORY_TRIGGER,
        _EXTRACT_SESSION_FACTS,
        _USER_SESSION_FACTS_HAS_CONTENT,
        _GET_SESSION_USER_FACTS,
        _TRANSCRIPT_ASKS_ABOUT_ME,
        _BUILD_ABOUT_ME_REPLY,
    )


_REMEMBER_CONTENT_RE = re.compile(
    r"(?is)\b(?:"
    r"remember(?:\s+that|\s+this|\s+to|\s+me\s+as)?|"
    r"save(?:\s+this|\s+that)?|"
    r"note(?:\s+that|\s+this)?|"
    r"make\s+a\s+note(?:\s+(?:that|of))?|"
    r"keep\s+in\s+mind(?:\s+that)?|"
    r"from\s+now\s+on|"
    r"going\s+forward|"
    r"for\s+future|"
    r"for\s+the\s+future|"
    r"my\s+preference\s+is|"
    r"my\s+preferences?\s+are|"
    r"call\s+me"
    r")\b\s*(?::\s*)?(?:that\s+)?(.+)$"
)

_FORGET_COMMAND_RE = re.compile(
    r"(?is)^(?:"
    r"forget(?:\s+that)?|"
    r"delete(?:\s+this)?\s+memory(?:\s+(?:that|about))?|"
    r"remove(?:\s+this)?\s+memory(?:\s+(?:that|about))?|"
    r"delete\s+that|"
    r"remove\s+that"
    r")\s+(.+)$"
)


def extract_remember_content(text: str) -> str | None:
    raw = (text or "").strip()
    if not raw:
        return None
    triggers, _, _, _, _, _ = _app_memory_helpers()
    if not triggers(raw):
        return None
    m = _REMEMBER_CONTENT_RE.search(raw)
    if m:
        content = (m.group(1) or "").strip().rstrip(".!?")
        if content:
            return content[:MAX_MEMORY_CONTENT_LEN]
    # Fallback: strip leading trigger words heuristically.
    stripped = re.sub(
        r"(?is)^\s*(?:remember|save|note|make a note|keep in mind|from now on|call me)\s*(?:that|this|to)?\s*:?\s*",
        "",
        raw,
    ).strip().rstrip(".!?")
    return stripped[:MAX_MEMORY_CONTENT_LEN] if stripped else None


def is_forget_memory_command(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return False
    if _FORGET_COMMAND_RE.search(raw):
        return True
    return bool(
        re.search(r"(?is)^forget\s+(?:that\s+)?", raw)
        and not re.search(r"\b(?:problem|question|topic|thread|panel)\b", raw)
    )


def is_memory_command_request(text: str) -> bool:
    """True for explicit remember / forget / about-me recall commands only."""
    raw = (text or "").strip()
    if not raw:
        return False
    if is_forget_memory_command(raw):
        return True
    (
        has_trigger,
        _,
        _,
        _,
        asks_about_me,
        _,
    ) = _app_memory_helpers()
    if has_trigger(raw):
        return True
    if asks_about_me(raw):
        return True
    return False


def extract_forget_query(text: str) -> str | None:
    raw = (text or "").strip()
    if not raw:
        return None
    m = _FORGET_COMMAND_RE.search(raw)
    if m:
        q = (m.group(1) or "").strip().rstrip(".!?")
        return q or None
    m2 = re.search(r"(?is)^forget\s+(?:that\s+)?(.+)$", raw)
    if m2:
        q = (m2.group(1) or "").strip().rstrip(".!?")
        return q or None
    return None


def _is_name_memory_row(row: dict) -> bool:
    if str(row.get("kind") or "").lower() == "name":
        return True
    content = str(row.get("content") or "").strip()
    return extract_name_from_stored_memory(content) is not None


def _join_recall_memory_bits(bits: list[str]) -> str:
    clean = [b for b in bits if b]
    if not clean:
        return ""
    if len(clean) == 1:
        return clean[0]
    if len(clean) == 2:
        return f"{clean[0]} and {clean[1]}"
    return "; ".join(clean[:-1]) + f"; and {clean[-1]}"


def _non_name_memory_bits(rows: list[dict], *, limit: int = 12) -> list[str]:
    bits: list[str] = []
    for row in rows[:limit]:
        if _is_name_memory_row(row):
            continue
        content = str(row.get("content") or "").strip()
        if not content:
            continue
        recalled = format_memory_for_recall(content)
        if recalled:
            bits.append(recalled)
    return bits


ABOUT_ME_EMPTY_LOGGED_IN = (
    "I don't know much about you yet. "
    "You can say 'remember that…' if you want me to save something."
)


def build_supabase_recall_reply(user_id: str, session_id: str | None) -> str:
    """Combined profile + explicit-memory reply for logged-in about-me questions."""
    user = get_bound_auth_user()
    email = user.email if user else None

    explicit_name = name_from_supabase_memories(user_id)
    profile_name = get_supabase_profile_display_name(user_id=user_id, email=email)
    resolved_name = explicit_name or profile_name

    config = get_supabase_config()
    rows = list_memories(config, user_id, limit=50) if config.db_configured else []
    memory_bits = _non_name_memory_bits(rows)

    if resolved_name and memory_bits:
        joined = _join_recall_memory_bits(memory_bits)
        return f"I know you as {resolved_name}, and I remember that {joined}."

    if resolved_name:
        return (
            f"I know you as {resolved_name}, but you haven't asked me to "
            "remember anything else yet."
        )

    if memory_bits:
        joined = _join_recall_memory_bits(memory_bits)
        return f"I remember that {joined}."

    _, _, has_sess, get_sess, _, build_about = _app_memory_helpers()
    blob = get_sess(session_id)
    if has_sess(blob):
        return build_about(session_id)

    return ABOUT_ME_EMPTY_LOGGED_IN


def try_explicit_memory_fastpath(
    text: str,
    session_id: str | None,
    history: list | None = None,
) -> str | None:
    """Handle remember / recall / forget. Returns spoken reply or None."""
    raw = (text or "").strip()
    if not raw:
        return None

    (
        has_trigger,
        extract_session,
        _,
        _,
        asks_about_me,
        _,
    ) = _app_memory_helpers()

    user = get_bound_auth_user()
    config = get_supabase_config()

    if is_forget_memory_command(raw):
        if not user:
            return None
        query = extract_forget_query(raw)
        if not query:
            return "What should I forget?"
        try:
            deleted = forget_memories_matching(config, user.user_id, query)
        except SupabaseDbError as exc:
            return str(exc) or "I couldn't delete that memory."
        if not deleted:
            return "I couldn't find a saved memory matching that."
        if len(deleted) == 1:
            return "Okay, I've removed that memory."
        return f"Okay, I've removed {len(deleted)} matching memories."

    if has_trigger(raw):
        content = extract_remember_content(raw)
        if not content:
            return None
        if user:
            try:
                create_memory(config, user.user_id, content)
            except SupabaseDbError as exc:
                status = exc.status or 0
                if status == 409:
                    return str(exc)
                return "I couldn't save that memory right now."
            return "Got it. I'll remember that."
        extract_session(session_id, raw)
        return (
            "I'll remember that for this session. "
            "Sign in to keep memories across devices and browsers."
        )

    if asks_about_me(raw):
        if user:
            return build_supabase_recall_reply(user.user_id, session_id)
        return None

    return None
