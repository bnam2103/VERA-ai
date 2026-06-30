"""Normalize first-person explicit memories for storage, recall, and matching."""

from __future__ import annotations

import re

# Third-person storage verb fixes after "User …"
_USER_VERB_FIXES: tuple[tuple[str, str], ...] = (
    (r"(?i)\bUser am\b", "User is"),
    (r"(?i)\bUser are\b", "User is"),
    (r"(?i)\bUser love\b", "User loves"),
    (r"(?i)\bUser like\b", "User likes"),
    (r"(?i)\bUser prefer\b", "User prefers"),
    (r"(?i)\bUser enjoy\b", "User enjoys"),
    (r"(?i)\bUser hate\b", "User hates"),
    (r"(?i)\bUser dislike\b", "User dislikes"),
    (r"(?i)\bUser have\b", "User has"),
    (r"(?i)\bUser play\b", "User plays"),
    (r"(?i)\bUser cook\b", "User cooks"),
    (r"(?i)\bUser live\b", "User lives"),
    (r"(?i)\bUser work\b", "User works"),
    (r"(?i)\bUser need\b", "User needs"),
    (r"(?i)\bUser want\b", "User wants"),
    (r"(?i)\bUser use\b", "User uses"),
    (r"(?i)\bUser feel\b", "User feels"),
    (r"(?i)\bUser think\b", "User thinks"),
    (r"(?i)\bUser build\b", "User builds"),
    (r"(?i)\bUser do\b", "User does"),
    (r"(?i)\bUser go\b", "User goes"),
)

# Second-person verb fixes after User → you conversion.
_YOU_VERB_FIXES: tuple[tuple[str, str], ...] = (
    (r"(?i)\byou am\b", "you are"),
    (r"(?i)\byou is\b", "you are"),
    (r"(?i)\byou loves\b", "you love"),
    (r"(?i)\byou likes\b", "you like"),
    (r"(?i)\byou prefers\b", "you prefer"),
    (r"(?i)\byou enjoys\b", "you enjoy"),
    (r"(?i)\byou hates\b", "you hate"),
    (r"(?i)\byou dislikes\b", "you dislike"),
    (r"(?i)\byou has\b", "you have"),
    (r"(?i)\byou plays\b", "you play"),
    (r"(?i)\byou cooks\b", "you cook"),
    (r"(?i)\byou lives\b", "you live"),
    (r"(?i)\byou works\b", "you work"),
    (r"(?i)\byou needs\b", "you need"),
    (r"(?i)\byou wants\b", "you want"),
    (r"(?i)\byou uses\b", "you use"),
    (r"(?i)\byou feels\b", "you feel"),
    (r"(?i)\byou thinks\b", "you think"),
    (r"(?i)\byou builds\b", "you build"),
    (r"(?i)\byou does\b", "you do"),
    (r"(?i)\byou goes\b", "you go"),
)


def _apply_you_verb_fixes(text: str) -> str:
    out = text
    for pat, repl in _YOU_VERB_FIXES:
        out = re.sub(pat, repl, out)
    return out


_NAME_STORAGE_PATTERNS: tuple[re.Pattern[str], str] = (
    (re.compile(r"(?i)^User's name is\s+(.+)$"), r"\1"),
    (re.compile(r"(?i)^User prefers to be called\s+(.+)$"), r"\1"),
)


def _apply_user_verb_fixes(text: str) -> str:
    out = text
    for pat, repl in _USER_VERB_FIXES:
        out = re.sub(pat, repl, out)
    return out


def normalize_memory_for_storage(text: str) -> str:
    """Convert first-person user statements into user-referential memory text."""
    raw = (text or "").strip()
    if not raw:
        return raw

    # Short "call me X" extractions (content may be just the name).
    m_call = re.match(
        r"(?i)^(?:call me|remember me as)\s+(.+)$",
        raw,
    )
    if m_call:
        name = m_call.group(1).strip().rstrip(".!?")
        if name:
            return f"User's name is {name}"

    if re.match(r"(?i)^[A-Z][a-zA-Z'\-]{1,30}$", raw) and " " not in raw:
        # Bare name from "call me Nam" extraction.
        return f"User's name is {raw}"

    m_name = re.match(r"(?i)^my name(?:'s| is)\s+(.+)$", raw)
    if m_name:
        return f"User's name is {m_name.group(1).strip().rstrip('.!?')}"

    m_call2 = re.match(r"(?i)^call me\s+(.+)$", raw)
    if m_call2:
        return f"User's name is {m_call2.group(1).strip().rstrip('.!?')}"

    out = raw
    out = re.sub(r"(?i)\bI'm\b", "User is", out)
    out = re.sub(r"(?i)\bI've\b", "User has", out)
    out = re.sub(r"(?i)\bI'd\b", "User would", out)
    out = re.sub(r"(?i)\bI'll\b", "User will", out)
    out = re.sub(r"(?i)\bI am\b", "User is", out)
    out = re.sub(r"(?i)\bmy\b", "user's", out)
    out = re.sub(r"(?i)\bme\b", "the user", out)
    out = re.sub(r"(?i)\bI\b", "User", out)
    out = _apply_user_verb_fixes(out)

    # Capitalize storage label.
    if out.lower().startswith("user"):
        out = "User" + out[4:]
    return out.strip()


def format_memory_for_recall(text: str) -> str:
    """Convert stored memory text into second-person speech for the user."""
    raw = (text or "").strip()
    if not raw:
        return raw

    m_name = re.match(r"(?i)^User's name is\s+(.+)$", raw)
    if m_name:
        return f"your name is {m_name.group(1).strip().rstrip('.!?')}"

    m_called = re.match(r"(?i)^User prefers to be called\s+(.+)$", raw)
    if m_called:
        return f"you prefer to be called {m_called.group(1).strip().rstrip('.!?')}"

    m_is = re.match(r"(?i)^User is\s+(.+)$", raw)
    if m_is:
        return f"you are {m_is.group(1).strip().rstrip('.!?')}"

    out = raw
    out = re.sub(r"(?i)\bUser's\b", "your", out)
    out = re.sub(r"(?i)\bthe user\b", "you", out)
    out = re.sub(r"(?i)\bUser\b", "you", out)
    out = _apply_you_verb_fixes(out)
    return out.strip()


def format_memory_for_display(text: str) -> str:
    """Account UI: prefer recall wording over storage 'User …' label."""
    recalled = format_memory_for_recall(text)
    if recalled:
        return recalled[0].upper() + recalled[1:] if len(recalled) > 1 else recalled.upper()
    return text


def infer_memory_kind(normalized_content: str) -> str:
    c = (normalized_content or "").strip()
    if re.match(r"(?i)^User's name is\s+", c):
        return "name"
    if re.match(r"(?i)^User prefers to be called\s+", c):
        return "name"
    if re.match(r"(?i)^User (?:likes|loves|enjoys|prefers)\s+", c):
        return "like"
    if re.match(r"(?i)^User (?:hates|dislikes)\s+", c):
        return "dislike"
    if re.match(r"(?i)^User is\s+", c):
        return "identity"
    return "general"


def extract_name_from_stored_memory(content: str) -> str | None:
    raw = (content or "").strip()
    if not raw:
        return None
    for rx, _ in _NAME_STORAGE_PATTERNS:
        m = rx.match(raw)
        if m:
            name = (m.group(1) or "").strip().rstrip(".!?")
            if name:
                return name
    return None


def forget_query_variants(query: str) -> list[str]:
    """Variants for fuzzy forget matching (raw + normalized storage form)."""
    q = (query or "").strip()
    if not q:
        return []
    normed = normalize_memory_for_storage(q)
    variants = [q]
    if normed and normed.lower() != q.lower():
        variants.append(normed)
    return variants


def name_from_supabase_memories(user_id: str) -> str | None:
    """Most recent explicit name memory for a logged-in user."""
    try:
        from auth.supabase_config import get_supabase_config
        from auth.supabase_memories import list_memories

        config = get_supabase_config()
        if not config.db_configured:
            return None
        for row in list_memories(config, user_id, limit=50):
            name = extract_name_from_stored_memory(str(row.get("content") or ""))
            if name:
                return name
        return None
    except Exception:
        return None
