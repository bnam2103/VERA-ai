"""Checklist help-plan intent detection (voice/typed/planner)."""

from __future__ import annotations

import json
import re

__all__ = [
    "CHECKLIST_PLAN_INTENT_RE",
    "checklist_plan_intent_matches",
    "checklist_plan_context_from_snapshot",
    "CHECKLIST_PLAN_MAIN_ITEM_LIMIT",
]

CHECKLIST_PLAN_MAIN_ITEM_LIMIT = 5

CHECKLIST_PLAN_INTENT_RE = re.compile(
    r"(?:"
    r"(?:help\s+me\s+)?(?:can\s+you\s+|could\s+you\s+|will\s+you\s+|please\s+)?"
    r"(?:plan|planning|roadmap|prioriti[sz]e|break\s*(?:it\s*)?down|organi[sz]e)\b"
    r".{0,80}?\b(?:check\s*list|checklist|to-?do|todo|task\s*list|tasks?)\b"
    r"|"
    r"\bplan\s+(?:using|with|from)\s+(?:the\s+|my\s+)?(?:check\s*list|checklist|to-?do|todo|task\s*list)\b"
    r"|"
    r"\b(?:help\s+me\s+)?plan\s+my\s+(?:check\s*list|checklist|to-?do|todo|tasks?)\b"
    r")",
    re.IGNORECASE,
)

_CHECKLIST_PLAN_SYNC_RE = re.compile(
    r"\bsync\s+(?:the\s+)?(?:plan|checklist|list|reasoning(?:\s+plan)?)\b",
    re.IGNORECASE,
)


def checklist_plan_intent_matches(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return False
    if _CHECKLIST_PLAN_SYNC_RE.search(raw):
        return False
    return bool(CHECKLIST_PLAN_INTENT_RE.search(raw))


def checklist_plan_context_from_snapshot(snapshot: dict | None) -> dict:
    checklist = {}
    if isinstance(snapshot, dict) and isinstance(snapshot.get("checklist"), dict):
        checklist = snapshot["checklist"]
    main_count = int(checklist.get("main_count") or 0)
    subitem_count = int(checklist.get("subitem_count") or 0)
    if not main_count and isinstance(checklist.get("main_items"), list):
        main_count = len(checklist["main_items"])
    return {
        "main_count": main_count,
        "subitem_count": subitem_count,
        "ongoing_count": int(checklist.get("ongoing_count") or 0),
    }


def log_checklist_plan_detected(raw_text: str, *, source: str = "voice") -> None:
    try:
        print(
            "[checklist_plan_action_detected] "
            + json.dumps(
                {"raw_text": (raw_text or "")[:240], "source": source},
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass
