"""Checklist action parsing and mutation helpers."""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher
from typing import Any


def _log_checklist_debug(tag: str, payload: dict[str, Any]) -> None:
    """Best-effort structured log. Never raises — checklist mutations
    must not fail because of logging."""
    try:
        print(f"[CHECKLIST_{tag}]", json.dumps(payload, ensure_ascii=False, default=str))
    except Exception:
        try:
            print(f"[CHECKLIST_{tag}] <unserializable payload>")
        except Exception:
            pass


_COUNT_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}

_ORDINAL_WORDS = {
    "first": 1,
    "second": 2,
    "third": 3,
    "fourth": 4,
    "fifth": 5,
    "sixth": 6,
    "seventh": 7,
    "eighth": 8,
    "ninth": 9,
    "tenth": 10,
}


# 2026-06-01 — relative-ordinal targeting: "the last item" / "the final
# task" / "the very last bullet" must resolve to the actual last
# TOP-LEVEL row, not the last flattened row. Same for "second to last"
# / "next to last" / "penultimate". Sub-item noun synonyms are
# intentionally not in this group — the helpers below resolve
# relatives against the top-level list, not the flatten.
_LAST_ITEM_NOUNS = (
    r"(?:item|task|bullet|row|step|entry|to-?do|one|thing)"
)
_LAST_ITEM_RE = re.compile(
    rf"(?ix)\b(?:the\s+)?(?:very\s+)?(?:last|final)\s+{_LAST_ITEM_NOUNS}s?\b"
)
_SECOND_TO_LAST_ITEM_RE = re.compile(
    rf"(?ix)\b(?:the\s+)?"
    rf"(?:second[\s\-]+to[\s\-]+last|next[\s\-]+to[\s\-]+last|penultimate)"
    rf"\s+{_LAST_ITEM_NOUNS}s?\b"
)


def _extract_relative_ordinals(text: str) -> list[str]:
    """Return canonical relative-ordinal tokens detected in ``text``.

    The tokens are resolved against the live TOP-LEVEL list later in
    :func:`apply_checklist_action`, because "the last item" can only be
    expanded once we know how many top-level rows exist.

    Returns: a deduped, order-preserving list of tokens drawn from
    ``{"last", "second_to_last"}``. Empty list if nothing matches.
    """
    q = str(text or "").strip().lower()
    if not q:
        return []
    out: list[str] = []
    # Check second-to-last FIRST so the "last" subword inside "second to
    # last" doesn't also fire the plain "last" regex twice.
    if _SECOND_TO_LAST_ITEM_RE.search(q):
        out.append("second_to_last")
        # Strip the second-to-last span so the plain "last" regex
        # below doesn't double-count the same phrase.
        scrubbed = _SECOND_TO_LAST_ITEM_RE.sub("", q)
    else:
        scrubbed = q
    if _LAST_ITEM_RE.search(scrubbed):
        out.append("last")
    seen: set[str] = set()
    dedup: list[str] = []
    for tok in out:
        if tok in seen:
            continue
        seen.add(tok)
        dedup.append(tok)
    return dedup


def _word_or_number_to_int(value: str | None) -> int | None:
    s = str(value or "").strip().lower()
    if not s:
        return None
    if re.fullmatch(r"\d{1,3}", s):
        n = int(s)
        return n if n > 0 else None
    return _COUNT_WORDS.get(s) or _ORDINAL_WORDS.get(s)


_NUM_WORD_PAT = r"one|two|three|four|five|six|seven|eight|nine|ten"
_ORDINAL_WORD_PAT = (
    r"first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth"
)
# 1st, 2nd, 3rd, 4th ... 99th — used alongside the ordinal-word forms so
# users can say "remove the 1st, 3rd and 5th items" too.
_ORDINAL_DIGIT_PAT = r"\d{1,3}(?:st|nd|rd|th)"

# Phrases where a trailing number is the item's NAME, not a count.
# e.g. "remove the item called four", "the item named two".
_ITEM_NAME_REF_RE = re.compile(
    r"\b(?:item|task)\s+(?:called|named|labeled|titled|that\s+says|that\s+reads)\b",
    re.IGNORECASE,
)


def _normalize_ordinal_token(raw: str) -> int | None:
    """Accept "first", "1st", "1", "third", "3rd", "3" → 1-based int."""
    s = str(raw or "").strip().lower()
    if not s:
        return None
    m = re.fullmatch(r"(\d{1,3})(?:st|nd|rd|th)?", s)
    if m:
        try:
            n = int(m.group(1))
        except Exception:
            return None
        return n if n > 0 else None
    return _ORDINAL_WORDS.get(s) or _COUNT_WORDS.get(s)


# Any single ordinal token a user may speak: "first", "1st", "1", "3rd"...
_ORDINAL_TOKEN_PAT = rf"(?:{_ORDINAL_DIGIT_PAT}|{_ORDINAL_WORD_PAT}|\d{{1,3}})"


def _split_ordinal_phrase_chunks(body: str) -> list[str]:
    """Split a phrase like ``first, third, and fifth`` into ``['first',
    'third', 'fifth']``. The separator accepts mixes of comma + 'and' /
    'or' / '&' / '+' so ``, and`` and ``and`` both work.
    """
    if not body:
        return []
    parts = re.split(
        r"(?:\s*,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+|\s*;\s*|\s*&\s*|\s*\+\s*)",
        body,
    )
    return [p.strip(" .,:;") for p in parts if p and p.strip(" .,:;")]


def _chunk_is_ordinal_or_item_n(chunk: str) -> int | None:
    """Match one chunk like ``first``, ``1st``, ``3``, ``first item``,
    ``item 3``, ``task fifth`` and return the parsed 1-based ordinal."""
    s = chunk.strip().lower()
    if not s:
        return None
    m = re.fullmatch(rf"(?:the\s+)?({_ORDINAL_TOKEN_PAT})(?:\s+(?:item|task)s?)?", s)
    if m:
        return _normalize_ordinal_token(m.group(1))
    m = re.fullmatch(rf"(?:item|task)\s+({_ORDINAL_TOKEN_PAT})", s)
    if m:
        return _normalize_ordinal_token(m.group(1))
    return None


def _extract_multi_ordinals(text: str) -> list[int]:
    """Return ordered, de-duped 1-based ordinals for multi-target commands.

    Recognises forms like:
        - "first item, third item, and fifth item"
        - "first, third, and fifth items"
        - "1st, 3rd, and 5th items"
        - "items 1, 3, and 5"
        - "items 1 3 5"
        - "remove the first and fourth tasks"

    Designed to ignore counts ("remove 4 items") — only ordinal
    sequences qualify. Single ordinals are also surfaced so the caller
    can prefer multi-target resolution over the legacy ``target_count``
    path.
    """
    q = str(text or "").strip().lower()
    if not q:
        return []

    candidates: list[int] = []

    # 1) "items N, N, N" / "items N N N" — pull every ordinal token that
    # appears after the plural "items"/"tasks" lead-in (used a lot for
    # bare digits like "1, 3, and 5").
    for m in re.finditer(r"\b(?:items?|tasks?)\b\s*(.+?)(?:$|\.|\?|!)", q):
        sub = m.group(1)
        for chunk in _split_ordinal_phrase_chunks(sub):
            n = _chunk_is_ordinal_or_item_n(chunk)
            if n is not None:
                candidates.append(n)

    # 2) "<ord>(, <ord>)+ items" — bare ordinal sequence ending with
    # "items" / "tasks". Captures both "first, third, and fifth items"
    # and "1st, 3rd and 5th tasks".
    for m in re.finditer(
        rf"((?:{_ORDINAL_TOKEN_PAT})(?:\s+(?:item|task)s?)?"
        rf"(?:\s*(?:,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+|\s*;\s*|\s*&\s*|\s*\+\s*)"
        rf"(?:{_ORDINAL_TOKEN_PAT})(?:\s+(?:item|task)s?)?){{1,}}"
        rf"\s*(?:item|task)s?)\b",
        q,
    ):
        for chunk in _split_ordinal_phrase_chunks(m.group(1)):
            n = _chunk_is_ordinal_or_item_n(chunk)
            if n is not None:
                candidates.append(n)

    # 3) "item N" / "task N" mentions: "first item, third item, fifth item".
    for tok in re.findall(rf"\b(?:item|task)\s+({_ORDINAL_TOKEN_PAT})\b", q):
        # Exclude "item called X" / "item named X" — those use a number
        # as the literal item name, not an ordinal reference.
        n = _normalize_ordinal_token(tok)
        if n is not None:
            candidates.append(n)

    # 4) Single "<ord> item" form ("the third item") — but skip "first 4
    # items" which is a count phrase. Also accepts the user-visible
    # synonyms a person tends to say when they're pointing at a parent
    # bullet ("first section", "third bullet", "second sub-item",
    # "second group", "fifth task block") so the scope router gets a
    # clean ordinal regardless of which noun the speaker preferred.
    if not re.search(rf"\bfirst\s+(?:\d{{1,3}}|{_NUM_WORD_PAT})\s+items?\b", q):
        for m in re.finditer(
            rf"\b({_ORDINAL_WORD_PAT}|{_ORDINAL_DIGIT_PAT})\s+"
            r"(?:item|task|section|group|bullet|block|thing|"
            r"sub-?item|sub-?bullet|sub-?point|nested\s+item|nested\s+bullet|"
            r"child\s+(?:item|bullet))s?\b",
            q,
        ):
            n = _normalize_ordinal_token(m.group(1))
            if n is not None:
                candidates.append(n)

    # 5) Bare ordinal lists with no trailing noun — "the second and fourth",
    # "first, third, and fifth". We only count tokens joined by pure
    # separators (",", " and ", " or ", "&", "+"), so a sentence like
    # "remove the first paragraph and the third sentence" never matches
    # here because the separator window contains nouns.
    for m in re.finditer(
        rf"\b(?:the\s+)?({_ORDINAL_TOKEN_PAT})"
        rf"((?:\s*(?:,|;|&|\+)\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+)"
        rf"(?:the\s+)?{_ORDINAL_TOKEN_PAT})+",
        q,
    ):
        seg = m.group(0)
        # Make sure the separator window does NOT include other words —
        # i.e. confirm the segment is purely an ordinal list. Strip ordinals
        # and 'the' prefixes; whatever remains must be only separator chars.
        stripped = re.sub(
            rf"\b(?:the\s+)?{_ORDINAL_TOKEN_PAT}\b", "", seg
        )
        stripped = re.sub(r"\s+", " ", stripped).strip(" ,;&+")
        residual = re.sub(r"(?:,|;|&|\+|\band\b|\bor\b|\s)+", "", stripped)
        if residual:
            continue
        for tok in re.findall(_ORDINAL_TOKEN_PAT, seg):
            n = _normalize_ordinal_token(tok)
            if n is not None:
                candidates.append(n)

    # Dedup preserving order so "first, third, first" → [1, 3].
    seen: set[int] = set()
    out: list[int] = []
    for n in candidates:
        if n <= 0 or n in seen:
            continue
        seen.add(n)
        out.append(n)
    return out


def _extract_count_phrase(text: str) -> tuple[int | None, str | None]:
    """Detect count phrases on a checklist edit.

    Returns (count, reason) where reason is one of:
      - "first_item"        e.g. "the first item"
      - "first_n_items"     e.g. "the first four items"
      - "n_items"           e.g. "4 items" / "four tasks" / "remove 4 item"
    Returns (None, None) if no clear count phrase is present, or if the user
    explicitly referenced an item by name (e.g. "the item called four").

    A multi-ordinal command like "first, third, and fifth items" is NOT
    a count — the caller should resolve those through
    ``_extract_multi_ordinals`` instead, so we early-return here.
    """
    q = str(text or "").strip().lower()
    if not q:
        return None, None
    if _ITEM_NAME_REF_RE.search(q):
        return None, None
    if len(_extract_multi_ordinals(q)) >= 2:
        return None, None
    if re.search(r"\b(?:the\s+)?first\s+item\b", q):
        return 1, "first_item"
    m = re.search(
        rf"\b(?:the\s+)?first\s+(\d{{1,3}}|{_NUM_WORD_PAT})\s+items?\b",
        q,
    )
    if m:
        return _word_or_number_to_int(m.group(1)), "first_n_items"
    # Bare "N items/tasks" — no "first" required.
    # "remove 4 items", "mark three tasks complete", "remove 4 item in the checklist".
    m = re.search(
        rf"\b(\d{{1,3}}|{_NUM_WORD_PAT})\s+(?:items?|tasks?)\b",
        q,
    )
    if m:
        return _word_or_number_to_int(m.group(1)), "n_items"
    return None, None


def _extract_first_count_command(text: str) -> int | None:
    """Back-compat wrapper for callers that only need the count value."""
    count, _ = _extract_count_phrase(text)
    return count


def _has_checklist_ordinal_phrase(text: str) -> bool:
    """Generalized ordinal recognizer for checklist commands.

    Recognises everything `_extract_multi_ordinals` does ("first and third",
    "first, third, and fifth", "items 1, 3 and 5", "1 and 3", bare digit
    sequences when paired with item/task/bullet/row/step) PLUS the simpler
    legacy forms ("first item", "item 3", "first three items"). The detector
    does NOT require the literal word "checklist" — by design, so spoken
    commands like "remove first and third item" route to the checklist
    handler whenever a checklist context exists.
    """
    q = str(text or "").strip().lower()
    if not q:
        return False
    if _extract_count_phrase(q)[0] is not None:
        return True
    # 2026-06-01 — relative-ordinal phrases ("the last item", "the
    # second to last task") count as ordinal references too. Without
    # this, "remove the last item" wouldn't pass the gate and would
    # never route to the checklist handler.
    if _extract_relative_ordinals(q):
        return True
    # Generalized multi-ordinal parser already handles
    # "first, third, and fifth (items)", "1st and 3rd item", "items 1 and 3",
    # bare digit sequences when paired with item/task etc.
    if len(_extract_multi_ordinals(q)) >= 1:
        return True
    # Pre-noun ordinal: "first item", "third task", "second bullet"...
    if re.search(
        rf"\b({_ORDINAL_WORD_PAT}|{_ORDINAL_DIGIT_PAT}|\d{{1,3}})\s+"
        r"(?:checklist\s+)?(?:item|items|task|tasks|bullet|bullets|row|rows|step|steps|to-?do|sub-?item|sub-?items|sub-?bullet|sub-?bullets)\b",
        q,
    ):
        return True
    # Post-noun ordinal: "item 3", "item first" (legacy form).
    if re.search(
        r"\b(?:checklist\s+)?(?:item|task|bullet|row|step|to-?do)s?\s+"
        rf"(?:\d{{1,3}}|{_ORDINAL_WORD_PAT})\b",
        q,
    ):
        return True
    return False


# Object nouns that, when explicitly named, mean the user is NOT talking
# about the checklist — even if the verb / ordinals look checklist-y.
# "remove the first paragraph from the essay" must NOT route to checklist
# removal. Conservative on purpose: when both a checklist noun (item /
# task / bullet / checklist) AND one of these nouns are present, the
# checklist noun wins (e.g. "remove the second item from the email").
_NON_CHECKLIST_OBJECT_NOUN_RE = re.compile(
    r"\b("
    r"paragraph|paragraphs|"
    r"sentence|sentences|"
    r"line\s+of\s+code|code\s+line|line\s+of\s+the\s+code|"
    r"argument|arguments|"
    r"example|examples|"
    r"section\s+of\s+the\s+(?:essay|article|draft|paper|story|email|letter|response|reply|chapter|message|piece|post)|"
    r"chapter|verse|footnote|slide|page|word\s+count|"
    r"photo|photos|image|images|attachment|attachments|"
    r"file|files|document|documents|note|notes"
    r")\b",
    re.IGNORECASE,
)


_CHECKLIST_OBJECT_NOUN_RE = re.compile(
    r"\b("
    r"checklist|check\s+list|to-?do(?:\s+list)?|task\s*list|"
    r"item|items|task|tasks|bullet|bullets|row|rows|step|steps|"
    r"sub-?item|sub-?items|sub-?bullet|sub-?bullets"
    r")\b",
    re.IGNORECASE,
)


def _detect_non_checklist_object_collision(text: str) -> str | None:
    """Return the matched non-checklist noun (e.g. "paragraph") when the
    user is clearly talking about a different object AND has not mentioned
    any checklist-flavored noun. Otherwise return None."""
    q = str(text or "")
    if not q.strip():
        return None
    competing = _NON_CHECKLIST_OBJECT_NOUN_RE.search(q)
    if not competing:
        return None
    if _CHECKLIST_OBJECT_NOUN_RE.search(q):
        # Both nouns present — assume checklist wins (e.g. "remove the
        # second item from the email"). The non-checklist noun is just
        # scoping context.
        return None
    return competing.group(1).lower()


def _log_checklist_intent_debug(payload: dict[str, Any]) -> None:
    """Structured debug log for checklist intent classification —
    mirrors the [CHECKLIST_INTENT_DEBUG] fields the frontend emits."""
    try:
        print(
            "[CHECKLIST_INTENT_DEBUG]",
            json.dumps(payload, ensure_ascii=False, default=str),
        )
    except Exception:
        pass


def is_checklist_clear_all_request(text: str) -> bool:
    q = (text or "").strip().lower()
    if not q:
        return False
    if re.search(r"\b(?:clear|erase|reset|wipe|empty)\s+(?:out\s+)?(?:the\s+|my\s+|all\s+)?checklist\b", q):
        return True
    if re.search(r"\b(?:clear|delete|remove|erase|wipe)\s+(?:all|every|everything)\b.*\b(?:checklist|tasks?|items?|list)\b", q):
        return True
    if re.search(r"\b(?:clear|reset|erase)\s+(?:all|every)\s+(?:tasks?|items?)\b", q):
        return True
    if re.search(r"\b(?:delete|remove|erase)\s+everything\s+from\s+(?:the\s+|my\s+)?(?:checklist|list)\b", q):
        return True
    return False


def is_checklist_undo_request(text: str) -> bool:
    """Match short "undo" follow-ups that may restore a recently cleared checklist.

    The caller is responsible for ignoring this if there is no recent
    undo snapshot — we only do the cheap phrase match here.
    """
    q = (text or "").strip().lower()
    if not q:
        return False
    if re.search(
        r"\b(?:undo|restore|revert"
        r"|bring\s+(?:it|them|that|those|back)"
        r"|put\s+(?:it|them|that|those)\s+back"
        r"|get\s+(?:it|them|that|those)\s+back)\b",
        q,
    ):
        return True
    return False


def is_checklist_action_request(text: str) -> str | None:
    """Return the routed action name for checklist commands, else None.

    Generalized in the v63 update: no longer requires the literal word
    "checklist" for ordinal-style commands. The detector recognises
    "remove first and third item", "delete items 2 and 4", "take out the
    first, third and fifth", etc. via `_has_checklist_ordinal_phrase`.

    A `_detect_non_checklist_object_collision` guard refuses to route when
    the user clearly named a competing object (paragraph, sentence, code
    argument, example, etc.) and did NOT name any checklist noun.

    Every classification emits a `[CHECKLIST_INTENT_DEBUG]` row.
    """
    raw = text or ""
    q = raw.strip().lower()

    def _debug(action: str | None, reason: str, ordinals: list[int] | None = None,
               removal_verb: bool = False, non_checklist_noun: str | None = None,
               confidence: float = 0.0) -> str | None:
        _log_checklist_intent_debug({
            "latest_user_text": raw[:240],
            "removal_verb_detected": bool(removal_verb),
            "ordinal_indices_detected": list(ordinals or []),
            "explicit_non_checklist_object_detected": bool(non_checklist_noun),
            "detected_object_type": non_checklist_noun or (
                "checklist_item" if action and action.startswith("checklist.") else "unknown"
            ),
            "is_checklist_action": bool(action),
            "action": action,
            "confidence": float(confidence),
            "reason": reason,
        })
        return action

    if not q:
        return _debug(None, "empty_text")

    if is_checklist_clear_all_request(q):
        return _debug("checklist.clear_all", "clear_all_phrase", confidence=0.95)

    has_checklist_word = bool(_CHECKLIST_OBJECT_NOUN_RE.search(q) and "checklist" in q)
    has_checklist_noun = bool(_CHECKLIST_OBJECT_NOUN_RE.search(q))
    has_item_ordinal = _has_checklist_ordinal_phrase(q)
    ordinals = _extract_multi_ordinals(q)
    non_checklist_noun = _detect_non_checklist_object_collision(raw)
    removal_verb = bool(
        re.search(
            r"\b(?:remove|delete|erase|take\s+out|get\s+rid\s+of|clear|drop)\b",
            q,
        )
    )

    if non_checklist_noun:
        return _debug(
            None,
            f"explicit_non_checklist_object:{non_checklist_noun}",
            ordinals=ordinals,
            removal_verb=removal_verb,
            non_checklist_noun=non_checklist_noun,
        )

    add_verb = bool(re.search(r"\b(?:add|append|create|insert)\b", q))
    complete_verb = bool(re.search(
        r"\b(?:complete|completed|done|finish|finished|mark|check\s+off|tick\s+off)\b",
        q,
    ))
    update_verb = bool(re.search(r"\b(?:update|replace|rename|change)\b", q))

    if has_checklist_word and add_verb:
        return _debug("checklist.add_item", "checklist_word_plus_add_verb",
                      removal_verb=removal_verb, confidence=0.85)

    if (has_checklist_word or has_item_ordinal) and removal_verb:
        confidence = 0.9 if has_checklist_word else (0.75 if has_checklist_noun else 0.6)
        reason = "checklist_word_plus_removal_verb" if has_checklist_word else (
            "ordinal_plus_removal_verb_with_checklist_noun" if has_checklist_noun
            else "ordinal_plus_removal_verb"
        )
        return _debug("checklist.remove_item", reason,
                      ordinals=ordinals, removal_verb=True, confidence=confidence)

    if (has_checklist_word or has_item_ordinal) and complete_verb:
        confidence = 0.85 if has_checklist_word else 0.7
        reason = "checklist_word_plus_complete_verb" if has_checklist_word else "ordinal_plus_complete_verb"
        return _debug("checklist.complete_item", reason,
                      ordinals=ordinals, removal_verb=False, confidence=confidence)

    if update_verb:
        return _debug("checklist.update_item", "update_or_replace_verb",
                      ordinals=ordinals, removal_verb=False, confidence=0.6)

    return _debug(None, "no_matching_pattern", ordinals=ordinals,
                  removal_verb=removal_verb, non_checklist_noun=None)


def _parse_json_object(text: str) -> dict[str, Any]:
    if not text:
        return {}
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        return {}
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _fallback_parse(text: str, action_name: str) -> dict[str, Any]:
    q = (text or "").strip()
    out: dict[str, Any] = {"action": action_name}
    count, count_reason = _extract_count_phrase(q)
    if count is not None and count > 0:
        out["target_count"] = count
        out["target_count_mode"] = (
            "first_top_level_group" if count == 1 else "first_visible_rows"
        )
        out["target_count_reason"] = count_reason or "n_items"
    idx = re.search(
        r"\bitem\s+(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b",
        q,
        flags=re.IGNORECASE,
    )
    if idx:
        parsed_idx = _word_or_number_to_int(idx.group(1))
        if parsed_idx is not None:
            out["target_index"] = parsed_idx
    if action_name == "checklist.add_item":
        m = re.search(r"(?i)\badd\b(.+?)\b(?:in|to)\s+the?\s*checklist\b", q)
        if not m:
            m = re.search(r"(?i)\badd\b(.+?)\bchecklist\b", q)
        if m:
            out["item_text"] = m.group(1).strip(" .,:;")
    elif action_name == "checklist.remove_item":
        m = re.search(r"(?i)\bremove\b(.+?)\b(?:from\s+)?the?\s*checklist\b", q)
        if m:
            out["target_text"] = re.sub(r"(?i)^\s*item\s+\d+\s*", "", m.group(1)).strip(" .,:;")
    else:
        m = re.search(r"(?i)\b(?:update|replace)\b(.+?)\bwith\b(.+?)\b(?:in|on|to)?\s*the?\s*checklist\b", q)
        if not m:
            m = re.search(r"(?i)\b(?:update|replace)\b(.+?)\bwith\b(.+)$", q)
        if m:
            out["target_text"] = re.sub(r"(?i)^\s*item\s+\d+\s*", "", m.group(1)).strip(" .,:;")
            out["new_text"] = m.group(2).strip(" .,:;")
    return out


def _extract_index_list(text: str) -> list[int]:
    """Compatibility shim — defer to the richer multi-ordinal parser."""
    if not text:
        return []
    return _extract_multi_ordinals(text)


def _split_multi_phrases(text: str) -> list[str]:
    s = str(text or "").strip()
    if not s:
        return []
    parts = re.split(r"(?i)\s*(?:,|;|\band\b|\bas well as\b|&|\+|\bthen\b)\s*", s)
    out: list[str] = []
    for p in parts:
        item = str(p or "").strip(" .,:;")
        if not item:
            continue
        item = re.sub(r"(?i)^(?:also\s+)?(?:add|remove|mark|complete|check off)\s+", "", item).strip()
        if item:
            out.append(item)
    return out


def _strip_checklist_tail(text: str) -> str:
    s = str(text or "").strip()
    s = re.sub(
        r"(?i)(?:^|\s+)(?:to|in|on|from)\s+(?:the\s+)?checklist\s*[?.!]*\s*$",
        "",
        s,
    ).strip()
    s = re.sub(r"(?i)(?:^|\s+)(?:in|to|on)\s+(?:my\s+)?list\s*[?.!]*\s*$", "", s).strip()
    s = re.sub(r"(?i)^(?:the\s+|my\s+)?checklist\s*[?.!]*\s*$", "", s).strip()
    return s


# 2026-06-13 — hierarchy-level detection for ordinal commands. When the
# user explicitly names a level ("the second MAIN ITEM", "the first
# SUBITEM") we resolve the ordinal against that level's subset instead of
# the full visible-flat list. Plain "item"/"task" stays None (unchanged
# visible-flat behavior). Sub is checked first because "sub-item" also
# contains the substring "item".
# Noun-only forms — used ONLY to rewrite a detected level noun down to a
# plain "item" so the ordinal extractors can read it. Never applied unless
# a level was first detected adjacent to an ordinal (see below), so a
# literal item label like "Subitem A1" is left untouched.
_ORDINAL_LEVEL_SUB_RE = re.compile(
    r"(?i)\b(?:sub[\s\-]?items?|sub[\s\-]?tasks?|sub[\s\-]?bullets?|"
    r"child\s+items?|children|nested\s+(?:items?|tasks?|bullets?))\b"
)
_ORDINAL_LEVEL_MAIN_RE = re.compile(
    r"(?i)\b(?:main\s+items?|main\s+bullets?|main\s+sections?|main\s+tasks?|"
    r"top[\s\-]?level\s+(?:items?|tasks?|bullets?)|parent\s+items?|sections?)\b"
)

# An ordinal token that can precede a level noun ("the SECOND main item",
# "the FIRST subitem", "1st section"). Detection requires this prefix so a
# bare label ("mark Subitem A1 complete") is NOT treated as a level command.
_ORD_TOKEN = (
    r"(?:\d{1,3}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|"
    r"seventh|eighth|ninth|tenth|eleventh|twelfth|last|final|next)"
)
_LEVEL_SUB_DETECT_RE = re.compile(
    rf"(?i)\b{_ORD_TOKEN}\s+(?:sub[\s\-]?items?|sub[\s\-]?tasks?|"
    rf"sub[\s\-]?bullets?|child\s+items?|nested\s+(?:items?|tasks?|bullets?))\b"
)
_LEVEL_MAIN_DETECT_RE = re.compile(
    rf"(?i)\b{_ORD_TOKEN}\s+(?:main\s+items?|main\s+bullets?|main\s+sections?|"
    rf"main\s+tasks?|top[\s\-]?level\s+(?:items?|tasks?|bullets?)|"
    rf"parent\s+items?|sections?)\b"
)


def _detect_ordinal_level(text: str) -> str | None:
    """Return ``"main"`` / ``"sub"`` when the user names a hierarchy level
    *immediately after an ordinal*, else ``None``.

    Examples:
        "remove the second main item"   -> "main"
        "mark the first subitem done"   -> "sub"
        "remove the third item"         -> None  (plain noun, unchanged)
        "mark Subitem A1 complete"      -> None  (label, no ordinal prefix)
    """
    q = str(text or "")
    if _LEVEL_SUB_DETECT_RE.search(q):
        return "sub"
    if _LEVEL_MAIN_DETECT_RE.search(q):
        return "main"
    return None


def _route_checklist_multi_command(text: str, action_name: str) -> dict[str, Any]:
    q = str(text or "").strip()
    out: dict[str, Any] = {"action": action_name}
    if not q:
        return out

    if action_name == "checklist.add_item":
        body = re.sub(r"(?i)^.*?\badd\b", "", q, count=1).strip()
        body = _strip_checklist_tail(body)
        item_texts = _split_multi_phrases(body)
        if item_texts:
            out["item_texts"] = item_texts
            out["item_text"] = item_texts[0]
        return out

    # When a label-based command sneaks through ("remove proofread"), we
    # want target_mode=label so the resolve_debug entry is informative.
    if action_name in {"checklist.remove_item", "checklist.complete_item"}:
        # Removal scope: auto (default 2026-06-01), whole_section, sub_item.
        # The scope governs whether children cascade and whether ordinals
        # resolve against TOP-LEVEL rows or a named parent's children.
        scope, parent_text_for_sub = _detect_removal_scope(q)
        out["scope"] = scope
        if scope == "sub_item" and parent_text_for_sub:
            out["sub_item_parent_text"] = parent_text_for_sub

        # 2026-06-13: explicit hierarchy level ("main item" / "subitem")
        # so the resolver can address the right subset and the reply can
        # mirror the level the user named. We detect the level from the
        # ORIGINAL text, then normalize the level noun (and the "visible"
        # adjective) down to a plain "item" so the existing ordinal / count
        # extractors recognize "the second MAIN item" / "the first SUBITEM"
        # / "the third VISIBLE item" as ordinal references.
        ordinal_level = _detect_ordinal_level(q)
        if ordinal_level:
            out["target_level"] = ordinal_level
            q = _ORDINAL_LEVEL_SUB_RE.sub("item", q)
            q = _ORDINAL_LEVEL_MAIN_RE.sub("item", q)
        q = re.sub(r"(?i)\bvisible\s+(?=item|items|task|tasks|bullet|bullets)", "", q)

        ordinal_list = _extract_multi_ordinals(q)
        count, count_reason = _extract_count_phrase(q)
        # 2026-06-01: surface relative ordinals ("last", "second to last")
        # so the resolver can expand them once the live top-level count
        # is known. We do NOT pre-expand here because the multi-action
        # planner / fallback parser may consume the parsed dict before
        # the checklist state is available.
        relative_list = _extract_relative_ordinals(q)
        if relative_list:
            out["target_relative_ordinals"] = list(relative_list)
        # Multi-ordinal commands win over a single "first item" count, so
        # "first, third and fifth items" resolves to [1, 3, 5] and not
        # "first item" → count=1.
        if len(ordinal_list) >= 2:
            out["target_indices"] = ordinal_list
            out["target_index"] = ordinal_list[0]
            out["target_mode"] = "multi_ordinal"
        elif count is not None and count > 0:
            out["target_count"] = count
            out["target_count_mode"] = (
                "first_top_level_group" if count == 1 else "first_visible_rows"
            )
            out["target_count_reason"] = count_reason or "n_items"
            out["target_mode"] = (
                "single_ordinal" if count_reason == "first_item" else "count_from_start"
            )
            if ordinal_list:
                out["target_indices"] = ordinal_list
                out["target_index"] = ordinal_list[0]
        elif relative_list:
            # "the last item" / "the second to last item" — single
            # relative ordinal, no concrete number yet. We let the
            # resolver pick the index against the live top-level list.
            out["target_mode"] = (
                "single_ordinal" if len(relative_list) == 1 else "multi_ordinal"
            )
        else:
            if ordinal_list:
                out["target_indices"] = ordinal_list
                out["target_index"] = ordinal_list[0]
                out["target_mode"] = "single_ordinal"

        verb_pat = r"(?:remove|delete|mark|complete|check off|finish|done)"
        body = re.sub(rf"(?i)^.*?\b{verb_pat}\b", "", q, count=1).strip()
        body = re.sub(
            r"(?i)\b(?:item|items)\b\s*(?:\d{1,3}(?:\s*(?:,|and)\s*\d{1,3})*)",
            "",
            body,
        ).strip(" .,:;")
        # If we already parsed a numeric count phrase ("4 items", "first four
        # items"), strip it from the body so it does not get re-extracted as a
        # `target_text` like "4 items" and trigger a name lookup for it.
        if count is not None and count > 0:
            body = re.sub(
                rf"(?i)\b(?:the\s+)?first\s+(?:\d{{1,3}}|{_NUM_WORD_PAT})?\s*items?\b",
                "",
                body,
            ).strip(" .,:;")
            body = re.sub(
                rf"(?i)\b(\d{{1,3}}|{_NUM_WORD_PAT})\s+(?:items?|tasks?)\b",
                "",
                body,
            ).strip(" .,:;")
        body = re.sub(r"(?i)\b(?:as\s+)?(?:done|complete|completed|off)\b", "", body).strip(" .,:;")
        body = _strip_checklist_tail(body)
        target_texts = _split_multi_phrases(body)
        drop_tokens = {
            "checklist",
            "the checklist",
            "my checklist",
            "in the checklist",
            "on the checklist",
            "from the checklist",
            "list",
            "my list",
        }
        target_texts = [t for t in target_texts if t.strip().lower() not in drop_tokens]
        # When count was parsed, ignore any leftover bare name in the body — the
        # user said "remove 4 items", not "remove the item called 4".
        if count is not None and count > 0:
            target_texts = []
        if target_texts:
            out["target_texts"] = target_texts
            out["target_text"] = target_texts[0]
            out.setdefault("target_mode", "label")
        out.setdefault("target_mode", out.get("target_mode") or "label")
        return out

    return out


def parse_checklist_command(vera, text: str, action_name: str) -> dict[str, Any]:
    routed = _route_checklist_multi_command(text, action_name)
    if action_name in {"checklist.add_item", "checklist.remove_item", "checklist.complete_item"}:
        return routed

    prompt = (
        "Extract checklist editing arguments. Return JSON only.\n"
        "Fields:\n"
        "- action: one of checklist.add_item, checklist.remove_item, checklist.update_item\n"
        "- target_index: integer item index if user said 'item N' (1-based), else null\n"
        "- target_text: original item text target if spoken by name, else null\n"
        "- item_text: text to add for add_item, else null\n"
        "- new_text: replacement text for update_item, else null\n"
        "Rules:\n"
        "- update and replace mean the same.\n"
        "- If target_index exists, keep target_text null unless clearly provided too.\n"
        "- Never invent text.\n"
    )
    try:
        res = vera.client.chat.completions.create(
            model=getattr(vera, "model_name", "gpt-5.4-mini"),
            messages=[
                {"role": "developer", "content": prompt},
                {"role": "user", "content": f"Action={action_name}\nUser text={text}"},
            ],
            temperature=0.0,
            max_completion_tokens=180,
        )
        parsed = _parse_json_object((res.choices[0].message.content if res and res.choices else "") or "")
    except Exception:
        parsed = {}
    if not parsed:
        parsed = _fallback_parse(text, action_name)
    parsed["action"] = action_name
    return parsed


def normalize_items(items: object) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for idx, row in enumerate(items, start=1):
        if not isinstance(row, dict):
            continue
        rid = str(row.get("id") or "").strip()
        txt = str(row.get("text") or "").replace("\r", " ").replace("\n", " ").strip()
        done = bool(row.get("done"))
        parent_id_raw = row.get("parent_id")
        parent_id = str(parent_id_raw).strip() if parent_id_raw is not None else None
        if not rid:
            # Keep rows that were created client-side without ids so index-based commands
            # ("item 1", "item 2") match what the user sees in the checklist UI.
            seed = txt if txt else f"row-{idx}"
            rid = f"v-auto-{idx}-{abs(hash(seed)) % 1000000}"
        rid = rid[:80]
        if parent_id:
            parent_id = parent_id[:80]
            if parent_id == rid:
                parent_id = None
        out.append({"id": rid, "text": txt[:200], "done": done, "parent_id": parent_id})
    return out


def _ongoing_non_empty_indices(items: list[dict[str, Any]]) -> list[int]:
    return [i for i, x in enumerate(items) if not bool(x.get("done")) and str(x.get("text") or "").strip()]


def _all_non_empty_indices(items: list[dict[str, Any]]) -> list[int]:
    return [i for i, x in enumerate(items) if str(x.get("text") or "").strip()]


def _visible_non_empty_indices(items: list[dict[str, Any]]) -> list[int]:
    """Checklist display order: ongoing visible rows first, then completed rows."""
    ongoing = [
        i
        for i, x in enumerate(items)
        if not bool(x.get("done")) and str(x.get("text") or "").strip()
    ]
    completed = [
        i
        for i, x in enumerate(items)
        if bool(x.get("done")) and str(x.get("text") or "").strip()
    ]
    return ongoing + completed


def _effective_parent_id(
    row: dict[str, Any],
    id_set: set[str],
    by_id: dict[str, dict[str, Any]],
) -> str | None:
    """Return the row's parent id ONLY when the parent still exists, is in
    the same done bucket, and is non-empty — matches what
    ``loadWorkChecklistItems`` in app.js considers a real parent before
    drawing the depth indent. Orphaned children (parent removed by a
    previous mutation or by a manual UI delete) collapse to top-level so
    they are addressable by their visible ordinal.
    """
    raw = row.get("parent_id")
    pid = str(raw or "").strip()
    if not pid or pid not in id_set:
        return None
    parent = by_id.get(pid)
    if not parent:
        return None
    if bool(parent.get("done")) != bool(row.get("done")):
        return None
    if not str(parent.get("text") or "").strip():
        return None
    return pid


def visible_flattened_rows(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return the rows the user actually sees, in screen order, with a
    stable 1-based ``visible_index`` and the *effective* depth (orphans
    flattened to depth 0 to mirror the UI render).

    Each entry carries: ``visible_index``, ``id``, ``text``,
    ``parent_id`` (effective — may be ``None`` for orphans), ``depth``,
    ``done``, ``row_index`` (storage index, for safe deletion). Empty
    rows are dropped because the UI does not bind ordinal commands to
    blank placeholders.
    """
    rows = items or []
    by_id: dict[str, dict[str, Any]] = {}
    id_set: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        rid = str(row.get("id") or "").strip()
        if rid:
            id_set.add(rid)
            by_id[rid] = row

    ordered: list[dict[str, Any]] = []
    for bucket_done in (False, True):
        for storage_idx, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            txt = str(row.get("text") or "").strip()
            if not txt:
                continue
            if bool(row.get("done")) != bucket_done:
                continue
            eff_parent = _effective_parent_id(row, id_set, by_id)
            depth = 1 if eff_parent else 0
            ordered.append(
                {
                    "visible_index": len(ordered) + 1,
                    "id": str(row.get("id") or ""),
                    "text": txt,
                    "parent_id": eff_parent,
                    "depth": depth,
                    "done": bucket_done,
                    "row_index": storage_idx,
                }
            )
    return ordered


def _ongoing_visible_rows(flat: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in flat if not r.get("done")]


def _top_level_visible_rows(flat: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return ONLY top-level rows (depth=0) from a visible-flattened list,
    re-numbered with their own 1-based ``top_level_index``. This is the
    correct view for ordinal commands like "remove the first item" — the
    user's "first item" means the first PARENT bullet they see, not the
    first leaf in a depth-first flatten.
    """
    out: list[dict[str, Any]] = []
    for row in flat:
        if int(row.get("depth") or 0) != 0:
            continue
        if row.get("parent_id"):
            continue
        copy = dict(row)
        copy["top_level_index"] = len(out) + 1
        out.append(copy)
    return out


def _descendants_for_parent_id(items: list[dict[str, Any]], parent_id: str) -> list[int]:
    """Storage indices of all descendants of ``parent_id`` (transitive)."""
    pid = str(parent_id or "").strip()
    if not pid:
        return []
    by_id_to_storage: dict[str, int] = {}
    by_parent: dict[str, list[str]] = {}
    for i, row in enumerate(items):
        if not isinstance(row, dict):
            continue
        rid = str(row.get("id") or "")
        if not rid:
            continue
        by_id_to_storage[rid] = i
        pp = str(row.get("parent_id") or "").strip()
        if pp:
            by_parent.setdefault(pp, []).append(rid)

    out: list[int] = []
    stack = list(by_parent.get(pid, []))
    seen: set[str] = set()
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        idx = by_id_to_storage.get(cur)
        if idx is not None and idx not in out:
            out.append(idx)
        for child_id in by_parent.get(cur, []):
            stack.append(child_id)
    return out


def _children_for_parent_id(flat: list[dict[str, Any]], parent_id: str) -> list[dict[str, Any]]:
    """Direct children of ``parent_id`` from a visible-flattened list,
    with a fresh 1-based ``child_index``. Sub-item ordinal commands
    (``the second sub-item under revise and polish``) resolve against
    this list, not the global flatten.
    """
    pid = str(parent_id or "").strip()
    if not pid:
        return []
    out: list[dict[str, Any]] = []
    for row in flat:
        if str(row.get("parent_id") or "") != pid:
            continue
        copy = dict(row)
        copy["child_index"] = len(out) + 1
        out.append(copy)
    return out


# Scope detection for removal commands -----------------------------------
# 2026-06-01 spec change:
#   Default scope is "auto" (was "parent_only"). The user's "remove the
#   first item" must now CASCADE descendants when the resolved row is a
#   top-level row, matching what the user sees: "remove the first item"
#   removes the whole first item group (parent + sub-items). For
#   sub-item targets (label-resolved into a row at depth > 0, or
#   ordinal-resolved via scope="sub_item"), only that single row is
#   touched.
#
# Two opt-ins still exist:
#   "whole_section" — explicit cascade ("the whole first section",
#                     "entire first item", "first item including sub-items",
#                     "first item and everything under it", "remove the
#                     whole group", "delete the section"). Forces cascade
#                     even if the matched row is itself a sub-item.
#   "sub_item"      — the user explicitly asked about a nested item
#                     ("second sub-item under revise and polish",
#                      "third bullet under proofread"). Resolves
#                     ordinals against a named parent's children and
#                     NEVER cascades.
_WHOLE_SECTION_RE = re.compile(
    r"\b("
    r"whole\s+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?|group|section|thing|item|bullet|task|block)"
    r"|entire\s+(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?|group|section|thing|item|bullet|task|block)"
    r"|(?:along|together)\s+with\s+(?:its|the)?\s*(?:sub-?items?|children|nested|bullets?|points?|sub-?bullets?)"
    r"|(?:and|with|plus)\s+(?:its|the)?\s*(?:sub-?items?|children|nested|sub-?bullets?|sub-?points?)"
    r"|including\s+(?:its|the)?\s*(?:sub-?items?|children|nested|bullets?|points?|sub-?bullets?)"
    r"|(?:and|with)\s+everything\s+(?:under(?:neath)?|below|inside|in)\s+(?:it|that|them|those)?"
    r"|the\s+(?:whole|entire)\s+(?:thing|group|section|block|chunk)"
    r"|wipe\s+(?:out\s+)?the\s+(?:whole|entire)"
    r")\b",
    re.IGNORECASE,
)

_SUB_ITEM_TRIGGER_RE = re.compile(
    r"\b(sub-?item|sub-?items|sub-?bullet|sub-?bullets|sub-?point|sub-?points|"
    r"nested\s+(?:item|bullet|point)s?|child\s+(?:item|bullet)s?|"
    r"bullet\s+under|item\s+under|point\s+under)\b",
    re.IGNORECASE,
)

_PARENT_UNDER_RE = re.compile(
    r"\bunder\s+(?:the\s+)?[\"']?(.+?)[\"']?\s*(?:[.,?!]|$)",
    re.IGNORECASE,
)


def _detect_removal_scope(text: str) -> tuple[str, str | None]:
    """Return ``(scope, parent_text_or_None)``.

    Scope is one of:
        - ``"auto"``           (default 2026-06-01 — cascade for top-level
                                targets, single-row for sub-item targets)
        - ``"whole_section"``  (always cascade — explicit "whole/entire")
        - ``"sub_item"``       (operate on a named parent's children;
                                never cascades)

    ``parent_text`` is only populated for ``"sub_item"`` scope when the
    user said ``... under <parent label>``.

    Cascade triggers are checked BEFORE sub-item triggers so phrases like
    ``"remove first item including sub-items"`` (cascade) are not
    misclassified as sub_item just because the substring "sub-items"
    appears — the user wants the parent and everything below it gone.
    """
    q = str(text or "").strip()
    if not q:
        return "auto", None

    # 1) Cascade wins. "including/with/and sub-items", "whole section",
    # "entire item", "everything under it" all mean: subtree delete,
    # regardless of whether the matched row is top-level or a sub-item.
    if _WHOLE_SECTION_RE.search(q):
        return "whole_section", None

    # 2) Sub-item targeting. Only fire when the user actually pointed at
    # a child UNDER a named parent ("second sub-item under <parent>",
    # "third bullet under X", "the second sub-item of the proofread one").
    # 2026-06-13: a BARE sub-item ordinal with no parent reference
    # ("remove the first subitem") is NOT sub_item scope — it resolves
    # against the global sub-item subset via target_level="sub" instead,
    # so it no longer dead-ends on "which top-level item is it under?".
    if _SUB_ITEM_TRIGGER_RE.search(q):
        parent_text: str | None = None
        m = _PARENT_UNDER_RE.search(q)
        if m:
            parent_text = m.group(1).strip(" .,:;?!").strip()
            # Strip trailing checklist boilerplate the parser regex may have grabbed.
            parent_text = re.sub(
                r"(?i)\s+(?:from|in|on)\s+(?:the\s+)?checklist\s*$",
                "",
                parent_text,
            ).strip()
            parent_text = re.sub(r"(?i)\s+items?\s*$", "", parent_text).strip()
        has_parent_link = bool(m) or bool(
            re.search(r"(?i)\b(?:of|within|inside|beneath)\s+", q)
        )
        if has_parent_link:
            return "sub_item", parent_text or None

    # 3) Default: auto. Top-level targets cascade, sub-item targets
    # stay single-row. The resolver below decides per resolved row.
    return "auto", None


def visible_flattened_summary(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compact form suitable for structured debug logs."""
    out: list[dict[str, Any]] = []
    for row in visible_flattened_rows(items):
        out.append(
            {
                "index": int(row["visible_index"]),
                "id": row["id"],
                "text": row["text"][:80],
                "parent_id": row["parent_id"],
                "depth": int(row["depth"]),
                "done": bool(row["done"]),
            }
        )
    return out


def _child_indices_for_top_level(items: list[dict[str, Any]], parent_idx: int) -> list[int]:
    if parent_idx < 0 or parent_idx >= len(items):
        return []
    parent_id = str(items[parent_idx].get("id") or "").strip()
    if not parent_id:
        return []
    out: list[int] = []
    for i, row in enumerate(items):
        if i == parent_idx:
            continue
        if str(row.get("parent_id") or "").strip() == parent_id and str(row.get("text") or "").strip():
            out.append(i)
    return out


def _resolve_first_count_indices(
    items: list[dict[str, Any]],
    count: int,
    *,
    scope: str = "auto",
) -> tuple[list[int], str | None]:
    """Resolve "first N items" against the current VISIBLE FLATTENED list.

    2026-06-02 spec change: the user's "first N items" now indexes into
    the full visible flattened list (top-level rows AND sub-items),
    matching what the user actually sees on screen. The cascade decision
    is per resolved row:

    - When the picked visible row is a top-level row (``depth == 0`` and
      no parent), include its descendants in the result. The user's
      "remove the first item" must drop the entire top-level group.
    - When the picked visible row is a sub-item (``depth > 0``), include
      only that single row. The user's "remove the second item" must
      affect only that nested row.
    - ``"whole_section"`` keeps cascading every resolved row regardless
      of depth (explicit phrasing wins).
    - Ranges like "first two items" deduplicate naturally: descendants
      pulled in by a top-level cascade are not re-processed when a
      sub-item ordinal lands on the same id.

    Pass ``scope="sub_item"`` only in the resolver's sub_item branch
    (this helper is never called there).
    """
    flat = visible_flattened_rows(items)
    if not flat:
        return [], "I could not find any visible checklist items."
    if count <= 0:
        return [], "Please tell me which checklist item to change."

    ongoing_flat = _ongoing_visible_rows(flat)
    pool_flat = ongoing_flat if ongoing_flat else flat
    if not pool_flat:
        return [], "I could not find any visible checklist items."

    target_rows = pool_flat[: min(count, len(pool_flat))]
    if not target_rows:
        return [], "I could not find those checklist items."

    selected_ids: list[str] = []
    for row in target_rows:
        rid = str(row.get("id") or "")
        if not rid:
            continue
        if rid not in selected_ids:
            selected_ids.append(rid)
        is_top_level = (
            int(row.get("depth") or 0) == 0 and not row.get("parent_id")
        )
        # Cascade rule:
        #   "auto"          -> cascade only when the resolved row is
        #                       itself top-level; sub-item ordinals stay
        #                       single-row.
        #   "whole_section" -> cascade every resolved row (explicit).
        should_cascade = scope == "whole_section" or (scope == "auto" and is_top_level)
        if should_cascade:
            for child_idx in _descendants_for_parent_id(items, rid):
                child_row = items[child_idx]
                cid = str((child_row or {}).get("id") or "")
                if cid and cid not in selected_ids:
                    selected_ids.append(cid)
    return _ids_to_row_indices(items, selected_ids), None


def _ids_to_row_indices(items: list[dict[str, Any]], ids: list[str]) -> list[int]:
    """Map a list of stable item ids to their current storage indices."""
    out: list[int] = []
    by_id: dict[str, int] = {}
    for i, row in enumerate(items):
        if not isinstance(row, dict):
            continue
        rid = str(row.get("id") or "")
        if rid and rid not in by_id:
            by_id[rid] = i
    for rid in ids:
        i = by_id.get(str(rid))
        if i is not None and i not in out:
            out.append(i)
    return out


def _resolve_target_with_light_llm(
    vera,
    user_text: str,
    target_text: str,
    candidates: list[dict[str, Any]],
) -> str | None:
    if vera is None or not candidates:
        return None
    prompt = (
        "Choose the best checklist target for a spoken request.\n"
        "Return JSON only with fields:\n"
        "- decision: apply | ask | skip\n"
        "- target_id: checklist id if decision=apply, else null\n"
        "Rules:\n"
        "- Prefer semantic closeness, slight ASR mistakes are allowed.\n"
        "- If multiple are close, choose decision=ask.\n"
        "- If none fit, choose decision=skip.\n"
        "- Never invent an id.\n"
    )
    payload = {
        "user_text": user_text,
        "target_text": target_text,
        "candidates": candidates,
    }
    try:
        res = vera.client.chat.completions.create(
            model=getattr(vera, "model_name", "gpt-5.4-mini"),
            messages=[
                {"role": "developer", "content": prompt},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            temperature=0.0,
            max_completion_tokens=120,
        )
        obj = _parse_json_object((res.choices[0].message.content if res and res.choices else "") or "")
    except Exception:
        obj = {}
    if str(obj.get("decision") or "").strip().lower() != "apply":
        return None
    target_id = str(obj.get("target_id") or "").strip()
    return target_id or None


def _target_row_idx_from_text(
    rows: list[dict[str, Any]],
    target_text: str,
    vera=None,
    user_text: str = "",
) -> tuple[int | None, str | None]:
    tt = str(target_text or "").strip().lower()
    if not tt:
        return None, "Please tell me which checklist item to change."
    ongoing_idxs = _ongoing_non_empty_indices(rows)
    candidates = []
    for ord_idx, i in enumerate(ongoing_idxs, start=1):
        txt = str(rows[i].get("text") or "").strip()
        lo = txt.lower()
        if not lo:
            continue
        contains = tt in lo or lo in tt
        token_overlap = len(set(tt.split()) & set(lo.split()))
        ratio = SequenceMatcher(None, tt, lo).ratio()
        score = (1.0 if contains else 0.0) + (token_overlap * 0.12) + ratio
        candidates.append(
            {
                "row_index": i,
                "ordinal": ord_idx,
                "id": str(rows[i].get("id") or ""),
                "text": txt,
                "score": score,
                "ratio": ratio,
                "contains": contains,
                "token_overlap": token_overlap,
            }
        )
    if not candidates:
        return None, f"I could not find {tt} in your checklist."
    candidates.sort(key=lambda x: x["score"], reverse=True)
    top = candidates[0]
    if len(candidates) == 1 and (top["contains"] or top["ratio"] >= 0.78):
        return int(top["row_index"]), None
    if len(candidates) > 1:
        second = candidates[1]
        if top["score"] >= 1.55 and (top["score"] - second["score"]) >= 0.26:
            return int(top["row_index"]), None
    llm_candidates = [
        {"id": c["id"], "ordinal": c["ordinal"], "text": c["text"]}
        for c in candidates[:8]
        if c["id"]
    ]
    chosen_id = _resolve_target_with_light_llm(vera, user_text, tt, llm_candidates)
    if chosen_id:
        for c in candidates:
            if c["id"] == chosen_id:
                return int(c["row_index"]), None
    if len(candidates) > 1 and candidates[0]["score"] >= 1.25:
        return None, f"I found multiple checklist items close to {tt}. Please say item number."
    return None, f"I could not find {tt} in your checklist."


_ORDINAL_SUFFIX = {1: "st", 2: "nd", 3: "rd"}


def _ordinal_label(n: int) -> str:
    if 10 <= (n % 100) <= 20:
        return f"{n}th"
    return f"{n}{_ORDINAL_SUFFIX.get(n % 10, 'th')}"


def _human_join_ordinals(nums: list[int]) -> str:
    """Render ``[5, 6]`` as ``"item 5 or item 6"`` (spoken naturally as
    "item five or item six"). Plain numerals — not "item 5th" — read
    cleaner in both TTS and on-screen captions.
    """
    labels = [f"item {int(n)}" for n in nums if isinstance(n, int) and n > 0]
    if not labels:
        return "those items"
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} or {labels[1]}"
    return ", ".join(labels[:-1]) + f", or {labels[-1]}"


def _log_after_mutation(action_name: str, deleted_ids: list[str], next_rows: list[dict[str, Any]]) -> None:
    _log_checklist_debug(
        "INDEX_DEBUG][after_mutation",
        {
            "action": action_name.split(".", 1)[-1],
            "deleted_ids": list(deleted_ids),
            "visible_flattened": visible_flattened_summary(next_rows),
        },
    )


def _promote_orphans_after_removal(
    rows: list[dict[str, Any]],
    removed_ids: set[str],
    pre_parent_of: dict[str, str | None],
) -> int:
    """When a parent is removed, re-parent its (surviving) children to the
    removed parent's grandparent — or promote them to top-level when the
    parent itself was top-level. This keeps the canonical model in sync
    with the UI render (which would otherwise show orphans at depth 0
    while the storage row still points at a now-missing ``parent_id``).
    Returns the number of rows whose ``parent_id`` was rewritten.
    """
    rewritten = 0
    surviving_ids = {str(r.get("id") or "") for r in rows if isinstance(r, dict)}
    for row in rows:
        if not isinstance(row, dict):
            continue
        pid = str(row.get("parent_id") or "").strip()
        if not pid:
            continue
        if pid in surviving_ids:
            continue
        # Walk upward through any chain of removed ancestors until we land
        # on a surviving parent or fall off the top of the tree.
        new_parent: str | None = None
        cur = pid
        seen: set[str] = set()
        while cur in removed_ids and cur not in seen:
            seen.add(cur)
            grand = pre_parent_of.get(cur)
            grand_s = str(grand or "").strip()
            if not grand_s or grand_s in removed_ids:
                cur = grand_s
                continue
            if grand_s in surviving_ids:
                new_parent = grand_s
            break
        row["parent_id"] = new_parent
        rewritten += 1
    return rewritten


def _human_join_top_ordinals(nums: list[int]) -> str:
    """Render ``[1, 3, 5]`` as ``"first, third, and fifth"`` — used when
    we want a natural spoken phrase for top-level ordinal removals.
    Falls back to ``_human_join_ordinals`` (``"item 1, item 3, or item 5"``)
    for numbers above the ten-word range.
    """
    name = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
            6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth"}
    labels: list[str] = []
    for n in nums:
        if not isinstance(n, int) or n <= 0:
            continue
        if n in name:
            labels.append(name[n])
        else:
            labels.append(_ordinal_label(n))
    if not labels:
        return ""
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return ", ".join(labels[:-1]) + f", and {labels[-1]}"


def _single_ordinal_word(n: int) -> str:
    """Spoken ordinal for a single position: 1 -> "first", 12 -> "12th"."""
    return _human_join_top_ordinals([n]) or _ordinal_label(int(n))


def _build_row_meta(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Map row id -> stable visible-hierarchy metadata, computed from a
    pre-mutation snapshot so the reply never depends on a post-removal
    index. Each entry carries: ``id``, ``text``, ``depth``,
    ``visible_index`` (1-based, full flatten), ``parent_id``,
    ``top_level_index`` (1-based among depth-0 rows, else ``None``) and
    ``sibling_index`` (1-based among rows sharing the same parent).
    """
    flat = visible_flattened_rows(rows)
    meta: dict[str, dict[str, Any]] = {}
    top_counter = 0
    sibling_counter: dict[str | None, int] = {}
    for r in flat:
        rid = str(r.get("id") or "")
        depth = int(r.get("depth") or 0)
        pid = r.get("parent_id")
        sibling_counter[pid] = sibling_counter.get(pid, 0) + 1
        if depth == 0 and not pid:
            top_counter += 1
            top_idx: int | None = top_counter
        else:
            top_idx = None
        meta[rid] = {
            "id": rid,
            "text": str(r.get("text") or "").strip(),
            "depth": depth,
            "visible_index": int(r.get("visible_index") or 0),
            "parent_id": pid,
            "top_level_index": top_idx,
            "sibling_index": sibling_counter[pid],
        }
    return meta


def _hierarchy_level_for_depth(depth: int) -> str:
    return "main item" if int(depth or 0) == 0 else "subitem"


def _compose_hierarchy_remove_reply(
    m: dict[str, Any], requested_ordinal: int | None, level: str
) -> str:
    """Hierarchy-aware removal confirmation for a single resolved row.

    Top-level rows read "main item"; nested rows read "subitem". The
    user-facing ordinal is preserved when the user counted at that level;
    otherwise the item text disambiguates (so we never echo a misleading
    post-removal ordinal).
    """
    depth = int(m.get("depth") or 0)
    text = str(m.get("text") or "").strip()
    if depth == 0:
        if level == "main" and requested_ordinal:
            return f"Removed the {_single_ordinal_word(requested_ordinal)} main item."
        top_idx = m.get("top_level_index")
        if top_idx and int(m.get("visible_index") or 0) == int(top_idx):
            return f"Removed the {_single_ordinal_word(int(top_idx))} main item."
        return f"Removed the main item: {text}." if text else "Removed the main item."
    if level == "sub" and requested_ordinal:
        word = _single_ordinal_word(requested_ordinal)
        return f"Removed the {word} subitem: {text}." if text else f"Removed the {word} subitem."
    return f"Removed the subitem: {text}." if text else "Removed the subitem."


def _compose_hierarchy_complete_reply(
    m: dict[str, Any], requested_ordinal: int | None, level: str
) -> str:
    """Hierarchy-aware completion confirmation for a single resolved row."""
    depth = int(m.get("depth") or 0)
    text = str(m.get("text") or "").strip()
    if depth == 0:
        if level == "main" and requested_ordinal:
            return (
                f"Marked the {_single_ordinal_word(requested_ordinal)} main item complete."
            )
        top_idx = m.get("top_level_index")
        if top_idx and int(m.get("visible_index") or 0) == int(top_idx):
            return f"Marked the {_single_ordinal_word(int(top_idx))} main item complete."
        return (
            f"Marked the main item complete: {text}."
            if text
            else "Marked the main item complete."
        )
    if level == "sub" and requested_ordinal:
        word = _single_ordinal_word(requested_ordinal)
        return (
            f"Marked the {word} subitem complete: {text}."
            if text
            else f"Marked the {word} subitem complete."
        )
    return (
        f"Marked the subitem complete: {text}."
        if text
        else "Marked the subitem complete."
    )


def _log_response_summary(
    *,
    action: str,
    user_text: str,
    primary: dict[str, Any] | None,
    meta: dict[str, Any] | None,
    final_response_text: str,
) -> None:
    """Emit the [checklist_response_summary] diagnostic (spec Part 6)."""
    try:
        payload = {
            "action": action,
            "requested_phrase": str(user_text or ""),
            "requested_ordinal": (primary or {}).get("requested_ordinal"),
            "requested_level": (primary or {}).get("level"),
            "resolved_item_id": (meta or {}).get("id"),
            "resolved_item_text": (meta or {}).get("text"),
            "resolved_depth": (meta or {}).get("depth"),
            "resolved_parent_id": (meta or {}).get("parent_id"),
            "original_visible_index": (meta or {}).get("visible_index"),
            "original_sibling_index": (meta or {}).get("sibling_index"),
            "original_top_level_index": (meta or {}).get("top_level_index"),
            "final_response_text": str(final_response_text or ""),
        }
        print("[checklist_response_summary]", json.dumps(payload, ensure_ascii=False, default=str))
    except Exception:
        pass


def _hierarchy_single_reply(
    composer,
    *,
    has_hierarchy: bool,
    primary_targets: list[dict[str, Any]],
    row_meta: dict[str, dict[str, Any]],
    reply_ordinals: list[int],
    action: str,
    user_text: str,
) -> str | None:
    """Build a hierarchy-aware confirmation when exactly ONE directly
    named target was resolved on a nested checklist. Returns ``None`` to
    let the caller fall back to its existing aggregate wording (flat
    checklists, multi-target batches, count phrases, etc.)."""
    if not has_hierarchy:
        return None
    distinct: list[str] = []
    for p in primary_targets:
        pid = str(p.get("id") or "")
        if pid and pid not in distinct:
            distinct.append(pid)
    if len(distinct) != 1:
        return None
    pid = distinct[0]
    primary = next(
        (x for x in primary_targets if str(x.get("id") or "") == pid), None
    )
    meta = row_meta.get(pid)
    if not primary or not meta:
        return None
    requested_ordinal: int | None = None
    if reply_ordinals:
        requested_ordinal = int(reply_ordinals[0])
    elif isinstance(primary.get("requested_ordinal"), int):
        requested_ordinal = int(primary["requested_ordinal"])
    reply = composer(meta, requested_ordinal, str(primary.get("level") or "flat"))
    _log_response_summary(
        action=action,
        user_text=user_text,
        primary=primary,
        meta=meta,
        final_response_text=reply,
    )
    return reply


def _compose_removal_reply(
    *,
    scope: str,
    removed_count: int,
    removed_texts: list[str],
    directly_targeted_top_ords: list[int],
    sub_item_parent_label: str | None,
    sub_item_child_ord: int | None,
) -> str:
    """Short, natural spoken confirmation per spec (Part 6).
    Examples produced:
        Removed the first item.
        Removed the first, third, and fifth items.
        Removed the whole first section.
        Removed the second sub-item under Revise and polish.
    """
    if scope == "sub_item" and sub_item_child_ord and sub_item_parent_label:
        ord_word = _human_join_top_ordinals([sub_item_child_ord]) or _ordinal_label(sub_item_child_ord)
        return f"Removed the {ord_word} sub-item under {sub_item_parent_label}."

    if scope == "whole_section" and directly_targeted_top_ords:
        joined = _human_join_top_ordinals(directly_targeted_top_ords)
        if len(directly_targeted_top_ords) == 1:
            return f"Removed the whole {joined} section."
        return f"Removed the whole {joined} sections."

    if directly_targeted_top_ords:
        joined = _human_join_top_ordinals(directly_targeted_top_ords)
        if len(directly_targeted_top_ords) == 1:
            return f"Removed the {joined} item."
        return f"Removed the {joined} items."

    # Label-based removal — name the item(s) for clarity.
    if removed_count == 1:
        return f"Removed {removed_texts[0]} from your checklist."
    return f"Removed {removed_count} items from your checklist."


def apply_checklist_action(
    items: list[dict[str, Any]],
    action_name: str,
    parsed: dict[str, Any],
    *,
    vera=None,
    user_text: str = "",
) -> tuple[list[dict[str, Any]], str, bool]:
    rows = normalize_items(items)

    _log_checklist_debug(
        "INDEX_DEBUG][before_mutation",
        {
            "action": action_name.split(".", 1)[-1],
            "visible_flattened": visible_flattened_summary(rows),
        },
    )
    _log_checklist_debug(
        "COMMAND_PARSE_DEBUG",
        {
            "raw_command": str(user_text or ""),
            "parsed_action": action_name,
            "parsed_count": parsed.get("target_count"),
            "parsed_ordinals": list(parsed.get("target_indices") or []),
            "parsed_range": None,
            "target_mode": parsed.get("target_mode")
            or (
                "multi_ordinal"
                if isinstance(parsed.get("target_indices"), list)
                and len(parsed.get("target_indices") or []) >= 2
                else (
                    "count_from_start"
                    if isinstance(parsed.get("target_count"), int)
                    and parsed.get("target_count_reason") not in {None, "first_item"}
                    else (
                        "single_ordinal"
                        if isinstance(parsed.get("target_count"), int)
                        or isinstance(parsed.get("target_index"), int)
                        else "label"
                    )
                )
            ),
        },
    )

    if action_name == "checklist.clear_all":
        non_empty_before = len(_all_non_empty_indices(rows))
        if not non_empty_before:
            _log_after_mutation(action_name, [], rows)
            return rows, "Your checklist is already empty.", False
        cleared: list[dict[str, Any]] = []
        _log_after_mutation(action_name, [str(r.get("id") or "") for r in rows], cleared)
        return cleared, "Cleared the checklist. You can say undo that to restore it.", True

    if action_name == "checklist.add_item":
        item_texts = parsed.get("item_texts")
        if not isinstance(item_texts, list):
            single = str(parsed.get("item_text") or "").strip()
            item_texts = [single] if single else []
        clean_items = [
            str(x).replace("\r", " ").replace("\n", " ").strip()[:200]
            for x in item_texts
            if str(x).strip()
        ]
        if not clean_items:
            return rows, "I could not find what to add to the checklist.", False
        for item_text in clean_items:
            insert_idx = len(rows)
            for i in range(len(rows) - 1, -1, -1):
                if not bool(rows[i].get("done")) and str(rows[i].get("text") or "").strip() == "":
                    insert_idx = i
                    break
            rows.insert(
                insert_idx,
                {
                    "id": f"v-{len(rows)+1}-{abs(hash(item_text))%1000000}",
                    "text": item_text,
                    "done": False,
                    "parent_id": None,
                },
            )
        if len(clean_items) == 1:
            return rows, f"Added {clean_items[0]} to your checklist.", True
        return rows, f"Added {len(clean_items)} items to your checklist.", True

    # 2026-06-13: directly-named targets (NOT cascade descendants) with the
    # ordinal / level the user used to reference each one. Populated by the
    # resolver so the reply can describe what was actually changed using the
    # visible hierarchy instead of a post-mutation list index.
    primary_targets: list[dict[str, Any]] = []

    def _resolve_target_row_indices() -> tuple[list[int], str | None, list[int]]:
        """Resolve user-supplied ordinals/labels to storage indices.

        Honours ``parsed["scope"]`` (auto | whole_section | sub_item).
        - Default ordinals are resolved against TOP-LEVEL rows so
          ``"remove first item"`` means the first PARENT bullet the user
          sees, never a depth-first leaf.
        - 2026-06-01 spec: when the resolved row is a TOP-LEVEL row and
          scope is ``"auto"`` (or ``"whole_section"``), include its
          descendants. When the resolved row is a sub-item (or scope is
          ``"sub_item"``), include only that single row.
        - ``sub_item`` resolves the ordinal(s) against the named parent's
          children (``"the second sub-item under revise and polish"``).
        - 2026-06-01: ``target_relative_ordinals`` (``"last"`` /
          ``"second_to_last"``) are expanded against the live top-level
          list here.

        Returns ``(row_indices, error_or_none, missing_ordinals)``. When
        some ordinals are out of range and at least one resolves, the
        caller can craft a partial-success message using
        ``missing_ordinals``. When NO ordinals resolve, an error message
        is returned so the caller can speak it as-is.
        """
        primary_targets.clear()
        missing_ordinals: list[int] = []
        scope = str(parsed.get("scope") or "auto").lower()
        target_level = str(parsed.get("target_level") or "").strip().lower()
        # Back-compat: any legacy/external caller still sending the old
        # "parent_only" sentinel collapses to the new default. The two
        # only differ in cascade behavior, and "auto" is what the new
        # spec wants.
        if scope == "parent_only":
            scope = "auto"
        if scope not in {"auto", "whole_section", "sub_item"}:
            scope = "auto"

        target_count = parsed.get("target_count")
        # When the user named a level ("the first MAIN item"), resolve via
        # the ordinal path against that level's subset rather than the
        # count shortcut (which addresses the full visible list).
        if (
            isinstance(target_count, int)
            and target_count > 0
            and scope != "sub_item"
            and not target_level
        ):
            resolved, err = _resolve_first_count_indices(rows, target_count, scope=scope)
            # Record the first N visible rows as the directly-named targets
            # (pre-cascade) so a single "first item" count still gets the
            # hierarchy-aware reply, while multi-count keeps the aggregate.
            _vf = visible_flattened_rows(rows)
            _pool = _ongoing_visible_rows(_vf) or _vf
            for _i in range(min(int(target_count), len(_pool))):
                _rid = str(_pool[_i].get("id") or "")
                if _rid:
                    primary_targets.append(
                        {
                            "id": _rid,
                            "requested_ordinal": _i + 1,
                            "level": target_level or "flat",
                        }
                    )
            return resolved, err, missing_ordinals

        target_indices = parsed.get("target_indices")
        if not isinstance(target_indices, list):
            target_indices = []
        index_list = [int(x) for x in target_indices if isinstance(x, int) and x > 0]
        if not index_list:
            target_idx = parsed.get("target_index")
            if isinstance(target_idx, int) and target_idx > 0:
                index_list = [target_idx]

        # 2026-06-01: track relative ordinals separately from concrete
        # ones so we can render reply text differently and still resolve
        # them against the live top-level list.
        relative_ordinals_raw = parsed.get("target_relative_ordinals")
        relative_ordinals = [
            str(tok).strip().lower()
            for tok in (relative_ordinals_raw or [])
            if str(tok).strip()
        ]

        target_texts = parsed.get("target_texts")
        if not isinstance(target_texts, list):
            target_texts = []
        text_list = [str(x).strip().lower() for x in target_texts if str(x).strip()]
        if not text_list:
            target_text = str(parsed.get("target_text") or "").strip().lower()
            if target_text:
                text_list = [target_text]

        # When the user gave explicit ordinals (or relative ordinals
        # which the resolver below expands to concrete indices), skip
        # the leftover label pass — the body parser sometimes emits
        # "1st"/"3rd" / "last item" as text too.
        if index_list or relative_ordinals:
            text_list = []

        flat = visible_flattened_rows(rows)
        ongoing_flat = _ongoing_visible_rows(flat)
        pool_flat = ongoing_flat if ongoing_flat else flat

        out_ids: list[str] = []

        # Batch/multi-action support: callers may pre-resolve user-facing
        # ordinals against an original checklist snapshot and pass stable row
        # ids here. That lets "remove the first item and mark the second
        # complete" mean original item #1 and original item #2, even though
        # the live list shifts after the removal. Normal single-action calls
        # never set target_ids, so existing visible-ordinal behavior is
        # unchanged.
        target_ids_raw = parsed.get("target_ids")
        if isinstance(target_ids_raw, list):
            requested_ids = [
                str(x or "").strip()
                for x in target_ids_raw
                if str(x or "").strip()
            ]
            flat_by_id: dict[str, dict[str, Any]] = {
                str(r.get("id") or ""): r for r in flat if str(r.get("id") or "")
            }
            for rid in requested_ids:
                row = flat_by_id.get(rid)
                if row is None:
                    continue
                if rid not in out_ids:
                    out_ids.append(rid)
                    primary_targets.append(
                        {"id": rid, "requested_ordinal": None, "level": "id"}
                    )
                is_top_level = (
                    int(row.get("depth") or 0) == 0 and not row.get("parent_id")
                )
                should_cascade = (
                    scope == "whole_section"
                    or (scope == "auto" and is_top_level)
                )
                if should_cascade:
                    for child_idx in _descendants_for_parent_id(rows, rid):
                        child_row = rows[child_idx]
                        cid = str((child_row or {}).get("id") or "")
                        if cid and cid not in out_ids:
                            out_ids.append(cid)
            out_idxs = _ids_to_row_indices(rows, out_ids)
            if not out_idxs:
                return [], "I could not find those checklist items.", missing_ordinals
            return out_idxs, None, missing_ordinals

        # --- sub_item branch: resolve ordinals under a named parent ---
        if scope == "sub_item":
            parent_label = str(parsed.get("sub_item_parent_text") or "").strip()
            parent_row = None
            if parent_label:
                pr_idx, _ = _target_row_idx_from_text(
                    rows, parent_label, vera=vera, user_text=user_text
                )
                if pr_idx is not None:
                    parent_row = rows[pr_idx]
            if parent_row is None and text_list:
                # User said "the second sub-item of the proofread one"
                pr_idx, _ = _target_row_idx_from_text(
                    rows, text_list[0], vera=vera, user_text=user_text
                )
                if pr_idx is not None:
                    parent_row = rows[pr_idx]
                    text_list = []
            if parent_row is None:
                return (
                    [],
                    "Please tell me which top-level item the sub-item is under.",
                    missing_ordinals,
                )
            parent_id = str(parent_row.get("id") or "")
            children = _children_for_parent_id(pool_flat, parent_id)
            if not children:
                return (
                    [],
                    f"That item has no sub-items right now.",
                    missing_ordinals,
                )
            target_ords = index_list or [1]
            for n in target_ords:
                if n <= 0 or n > len(children):
                    missing_ordinals.append(n)
                    continue
                rid = children[n - 1]["id"]
                if rid and rid not in out_ids:
                    out_ids.append(rid)
                    primary_targets.append(
                        {"id": rid, "requested_ordinal": n, "level": "sub"}
                    )
            out_idxs = _ids_to_row_indices(rows, out_ids)
            if not out_idxs and missing_ordinals:
                return (
                    [],
                    f"I could not find {_human_join_ordinals(missing_ordinals)} under that item — "
                    f"it has {len(children)} sub-item{'s' if len(children) != 1 else ''}.",
                    missing_ordinals,
                )
            return out_idxs, None, missing_ordinals

        # --- default branch: VISIBLE-FLAT ordinals (auto or whole_section) ---
        # 2026-06-02 spec change:
        # Ordinals now address the FULL visible flattened list (top-level
        # rows AND sub-items). The cascade decision is per resolved row:
        # top-level rows pull in their descendants; sub-item rows stay
        # single-row under "auto", and still cascade under
        # "whole_section". "sub_item" is handled in its own branch above.
        # 2026-06-13: when the user explicitly named a level ("the second
        # MAIN item" / "the first SUBITEM"), resolve the ordinal against
        # that level's subset rather than the full visible-flat list. Plain
        # "item"/"task" leaves target_level empty -> unchanged behavior.
        if target_level == "main":
            level_pool = [
                r for r in pool_flat
                if int(r.get("depth") or 0) == 0 and not r.get("parent_id")
            ]
        elif target_level == "sub":
            level_pool = [
                r for r in pool_flat
                if int(r.get("depth") or 0) != 0 or r.get("parent_id")
            ]
        else:
            level_pool = list(pool_flat)
        # Defensive: if the named level has no rows, fall back to the full
        # visible list so the command still resolves (or surfaces a clean
        # out-of-range error) instead of silently mis-targeting.
        visible_pool = level_pool if level_pool else list(pool_flat)
        # `top_level` is still computed below so the resolver can decide
        # whether to cascade per resolved row, and so out-of-range error
        # messages can quote the visible-row count.

        # 2026-06-02: expand relative ordinals ("last", "second to last")
        # against the live VISIBLE list. Out-of-range relatives surface
        # via ``relative_missing`` so the partial-success path can speak
        # them as "the last item" / "the second to last item".
        relative_missing: list[str] = []
        if relative_ordinals:
            for tok in relative_ordinals:
                if tok == "last":
                    if len(visible_pool) >= 1:
                        idx = len(visible_pool)
                        if idx not in index_list:
                            index_list.append(idx)
                    else:
                        relative_missing.append("last")
                elif tok == "second_to_last":
                    if len(visible_pool) >= 2:
                        idx = len(visible_pool) - 1
                        if idx not in index_list:
                            index_list.append(idx)
                    else:
                        relative_missing.append("second_to_last")

        # Pass 1: collect ordinal-resolved row ids in order, remembering
        # whether each one was itself top-level so the cascade decision
        # can be made per-row in pass 2. Sub-item ordinals stay
        # single-row under "auto".
        ordinal_resolved_ids: list[str] = []
        ordinal_top_level_ids: set[str] = set()
        if index_list:
            for n in index_list:
                if n <= 0 or n > len(visible_pool):
                    missing_ordinals.append(n)
                    continue
                row = visible_pool[n - 1]
                rid = str(row.get("id") or "")
                if not rid:
                    continue
                if rid not in ordinal_resolved_ids:
                    ordinal_resolved_ids.append(rid)
                    primary_targets.append(
                        {
                            "id": rid,
                            "requested_ordinal": n,
                            "level": target_level or "flat",
                        }
                    )
                is_top_level = (
                    int(row.get("depth") or 0) == 0 and not row.get("parent_id")
                )
                if is_top_level:
                    ordinal_top_level_ids.add(rid)

        # Pass 2: emit ordinal ids into out_ids and cascade per-row.
        # Deduplication is automatic because ``out_ids`` is checked on
        # every insert — a sub-item ordinal that points at an id already
        # pulled in by an earlier top-level cascade is a no-op.
        for rid in ordinal_resolved_ids:
            if rid not in out_ids:
                out_ids.append(rid)
            is_top_level = rid in ordinal_top_level_ids
            should_cascade = (
                scope == "whole_section"
                or (scope == "auto" and is_top_level)
            )
            if should_cascade:
                for child_idx in _descendants_for_parent_id(rows, rid):
                    child_row = rows[child_idx]
                    cid = str((child_row or {}).get("id") or "")
                    if cid and cid not in out_ids:
                        out_ids.append(cid)

        # top_level is still computed for the reply-format snapshot and
        # for the out-of-range error message below ("your checklist has
        # N top-level items").
        top_level = _top_level_visible_rows(pool_flat)
        if not top_level:
            top_level = [dict(r, top_level_index=i + 1) for i, r in enumerate(pool_flat)]

        # Label-based path still scans the full flat list (a label like
        # "proofread" may live at any depth and the user picked a name).
        # The cascade decision is per matched row: top-level rows cascade
        # under "auto", sub-item rows do NOT cascade under "auto" but DO
        # cascade under explicit "whole_section".
        flat_by_id: dict[str, dict[str, Any]] = {
            str(r.get("id") or ""): r for r in flat
        }
        for tt in text_list:
            row_idx, err = _target_row_idx_from_text(rows, tt, vera=vera, user_text=user_text)
            if row_idx is None:
                return [], err or f"I could not find {tt} in your checklist.", missing_ordinals
            rid = str(rows[row_idx].get("id") or "")
            if rid and rid not in out_ids:
                out_ids.append(rid)
                primary_targets.append(
                    {"id": rid, "requested_ordinal": None, "level": "label"}
                )
            if not rid:
                continue
            label_row_is_top_level = False
            label_flat_row = flat_by_id.get(rid)
            if label_flat_row is not None:
                label_row_is_top_level = (
                    int(label_flat_row.get("depth") or 0) == 0
                    and not label_flat_row.get("parent_id")
                )
            should_cascade = (
                scope == "whole_section"
                or (scope == "auto" and label_row_is_top_level)
            )
            if should_cascade:
                for child_idx in _descendants_for_parent_id(rows, rid):
                    child_row = rows[child_idx]
                    cid = str((child_row or {}).get("id") or "")
                    if cid and cid not in out_ids:
                        out_ids.append(cid)

        out_idxs = _ids_to_row_indices(rows, out_ids)
        if not out_idxs and not missing_ordinals and not relative_missing:
            return [], "Please tell me which checklist item to change.", missing_ordinals
        if not out_idxs and (missing_ordinals or relative_missing):
            visible_row_count = len(visible_pool)
            human_missing: list[str] = [
                f"item {n}" for n in missing_ordinals if isinstance(n, int) and n > 0
            ]
            for rel in relative_missing:
                if rel == "last":
                    human_missing.append("the last item")
                elif rel == "second_to_last":
                    human_missing.append("the second to last item")
            joined_missing = (
                ", ".join(human_missing) if human_missing else "those items"
            )
            # 2026-06-02 — quote the visible row count because ordinals
            # now address the full visible flattened list, not just the
            # top-level subset.
            return [], (
                f"I could not find {joined_missing} "
                f"— your checklist has {visible_row_count} visible "
                f"{'item' if visible_row_count == 1 else 'items'} right now."
            ), missing_ordinals
        return out_idxs, None, missing_ordinals

    def _emit_resolve_debug(resolved_ids: list[str], missing: list[int]) -> None:
        flat = visible_flattened_rows(rows)
        by_id = {r["id"]: r for r in flat}
        requested = list(parsed.get("target_indices") or [])
        if not requested and isinstance(parsed.get("target_index"), int):
            requested = [int(parsed.get("target_index") or 0)]
        if not requested and isinstance(parsed.get("target_count"), int):
            requested = list(range(1, int(parsed.get("target_count") or 0) + 1))
        resolved_targets = []
        for rid in resolved_ids:
            row = by_id.get(str(rid))
            if not row:
                continue
            resolved_targets.append(
                {
                    "ordinal": int(row.get("visible_index") or 0),
                    "id": row.get("id"),
                    "text": str(row.get("text") or "")[:80],
                }
            )
        _log_checklist_debug(
            "TARGET_RESOLVE_DEBUG",
            {
                "raw_command": str(user_text or ""),
                "visible_count": len(flat),
                "requested_ordinals": requested,
                "resolved_targets": resolved_targets,
                "missing_ordinals": list(missing),
            },
        )

    if action_name == "checklist.complete_item":
        # Snapshot top-level ordinals before mutation so the spoken reply
        # can read "Marked the first item complete." instead of echoing
        # the full text when the user used an ordinal.
        flat_before = visible_flattened_rows(rows)
        ongoing_before = _ongoing_visible_rows(flat_before)
        pool_before = ongoing_before if ongoing_before else flat_before
        top_level_before = _top_level_visible_rows(pool_before)
        top_level_ord_by_id: dict[str, int] = {
            str(r["id"]): int(r["top_level_index"]) for r in top_level_before
        }
        # 2026-06-13: pre-mutation hierarchy metadata for the response
        # summary. Only used when the checklist actually has nested rows,
        # so flat checklists keep their existing "Nth item" wording.
        has_hierarchy = any(int(r.get("depth") or 0) != 0 for r in flat_before)
        row_meta = _build_row_meta(rows)

        target_row_indices, err, missing = _resolve_target_row_indices()
        if err and not target_row_indices:
            _emit_resolve_debug([], missing)
            return rows, err, False
        targeted_ids = [str(rows[i].get("id") or "") for i in target_row_indices]
        _emit_resolve_debug(targeted_ids, missing)
        # Only honor ordinal phrasing in the reply when the user
        # actually said an ordinal (avoids "Marked the first item
        # complete." when they said "mark foo complete").
        # 2026-06-01: relative ordinals ("the last item", "second to
        # last") also count as user-supplied ordinals so the reply
        # phrasing reads "Marked the second item complete." instead of
        # echoing the row's full text.
        user_supplied_ordinal = (
            (
                isinstance(parsed.get("target_indices"), list)
                and any(
                    isinstance(x, int) and x > 0
                    for x in (parsed.get("target_indices") or [])
                )
            )
            or (
                isinstance(parsed.get("target_index"), int)
                and int(parsed.get("target_index") or 0) > 0
            )
            or (
                isinstance(parsed.get("target_count"), int)
                and int(parsed.get("target_count") or 0) > 0
            )
            or bool(parsed.get("target_relative_ordinals") or [])
            or bool(parsed.get("_reply_ordinals") or [])
        )
        changed = False
        completed_names: list[str] = []
        completed_top_ords: list[int] = []
        for i in target_row_indices:
            txt = str(rows[i].get("text") or "").strip()
            if not txt:
                continue
            completed_names.append(txt)
            rid = str(rows[i].get("id") or "")
            if user_supplied_ordinal and rid in top_level_ord_by_id:
                completed_top_ords.append(top_level_ord_by_id[rid])
            if not bool(rows[i].get("done")):
                rows[i]["done"] = True
                changed = True
        if not completed_names:
            _log_after_mutation(action_name, [], rows)
            return rows, "I could not find those checklist items.", False
        reply_ordinals = [
            int(x)
            for x in (parsed.get("_reply_ordinals") or [])
            if isinstance(x, int) and x > 0
        ]
        if user_supplied_ordinal and reply_ordinals:
            completed_top_ords = reply_ordinals
        completed_top_ords = sorted(set(completed_top_ords))

        # 2026-06-13: hierarchy-aware confirmation for a single directly
        # named target on a checklist that actually has nesting. Describes
        # the resolved item by its visible level ("main item" / "subitem")
        # and preserves the user's ordinal, instead of echoing a top-level
        # ordinal that can differ from what the user said.
        hier_reply = _hierarchy_single_reply(
            _compose_hierarchy_complete_reply,
            has_hierarchy=has_hierarchy,
            primary_targets=primary_targets,
            row_meta=row_meta,
            reply_ordinals=reply_ordinals,
            action="complete_item",
            user_text=user_text,
        )
        if hier_reply is not None:
            base_reply = hier_reply
        elif completed_top_ords:
            joined = _human_join_top_ordinals(completed_top_ords)
            if len(completed_top_ords) == 1:
                base_reply = f"Marked the {joined} item complete."
            else:
                base_reply = f"Marked the {joined} items complete."
        elif len(completed_names) == 1:
            base_reply = f"Marked {completed_names[0]} complete."
        else:
            base_reply = f"Marked {len(completed_names)} checklist items complete."
        if missing:
            base_reply += (
                f" I couldn't find {_human_join_ordinals(missing)}."
            )
        _log_after_mutation(action_name, [], rows)
        return rows, base_reply, changed

    if action_name == "checklist.remove_item":
        scope = str(parsed.get("scope") or "auto").lower()
        # Back-compat: legacy "parent_only" senders collapse to the new
        # default. See the resolver above for the same shim.
        if scope == "parent_only":
            scope = "auto"
        if scope not in {"auto", "whole_section", "sub_item"}:
            scope = "auto"

        # Snapshot the resolver's TOP-LEVEL ordinal preview BEFORE mutation
        # so the spoken reply can read e.g. "Removed the first item." even
        # though the underlying row index has shifted.
        flat_before = visible_flattened_rows(rows)
        ongoing_before = _ongoing_visible_rows(flat_before)
        pool_before = ongoing_before if ongoing_before else flat_before
        top_level_before = _top_level_visible_rows(pool_before)
        top_level_ord_by_id: dict[str, int] = {
            str(r["id"]): int(r["top_level_index"]) for r in top_level_before
        }
        # 2026-06-13: pre-mutation hierarchy metadata for the response
        # summary (used only for single-target removals on nested lists;
        # whole_section / sub_item keep their own dedicated wording).
        has_hierarchy = any(int(r.get("depth") or 0) != 0 for r in flat_before)
        row_meta = _build_row_meta(rows)

        target_row_indices, err, missing = _resolve_target_row_indices()
        if err and not target_row_indices:
            _emit_resolve_debug([], missing)
            return rows, err, False

        # Resolve IDs FIRST so the deletion never shifts an index from
        # under us. The deletion pass then runs in reverse storage order
        # to keep the underlying list operations cheap.
        targeted_ids = [str(rows[i].get("id") or "") for i in target_row_indices]
        _emit_resolve_debug(targeted_ids, missing)

        pre_parent_of: dict[str, str | None] = {
            str(r.get("id") or ""): (
                str(r.get("parent_id")).strip() if r.get("parent_id") else None
            )
            for r in rows
            if isinstance(r, dict)
        }

        # Sub-item branch: capture the parent label up front so we can
        # craft "Removed the second sub-item under <parent>." reliably.
        sub_item_parent_label: str | None = None
        sub_item_child_ord: int | None = None
        if scope == "sub_item":
            parent_label_raw = str(parsed.get("sub_item_parent_text") or "").strip()
            if parent_label_raw:
                # Resolve to canonical text using the row we matched
                pr_idx, _ = _target_row_idx_from_text(
                    rows, parent_label_raw, vera=vera, user_text=user_text
                )
                if pr_idx is not None:
                    sub_item_parent_label = str(rows[pr_idx].get("text") or "").strip()
            if sub_item_parent_label is None:
                sub_item_parent_label = parent_label_raw or None
            ords = list(parsed.get("target_indices") or [])
            if not ords and isinstance(parsed.get("target_index"), int):
                ords = [int(parsed["target_index"])]
            sub_item_child_ord = int(ords[0]) if ords else None

        # The "first/second/..." phrasing in the reply is only honest
        # when the USER spoke an ordinal/count. If they used a label
        # ("remove foo"), fall through to the name-based reply.
        # 2026-06-01: relative ordinals ("the last item") also qualify
        # so the reply reads "Removed the second item." (the resolved
        # numerical position) instead of "Removed buy groceries...".
        user_supplied_ordinal = (
            (
                isinstance(parsed.get("target_indices"), list)
                and any(
                    isinstance(x, int) and x > 0
                    for x in (parsed.get("target_indices") or [])
                )
            )
            or (
                isinstance(parsed.get("target_index"), int)
                and int(parsed.get("target_index") or 0) > 0
            )
            or (
                isinstance(parsed.get("target_count"), int)
                and int(parsed.get("target_count") or 0) > 0
            )
            or bool(parsed.get("target_relative_ordinals") or [])
            or bool(parsed.get("_reply_ordinals") or [])
        )

        removed: list[str] = []
        removed_id_set: set[str] = set()
        # Top-level ordinals that were the ones the user actually said
        # (used to build "Removed the first, third, and fifth items.").
        directly_targeted_top_ords: list[int] = []
        for i in sorted(target_row_indices, reverse=True):
            row = rows[i]
            txt = str(row.get("text") or "").strip()
            rid = str(row.get("id") or "")
            if txt:
                removed.append(txt)
            if rid:
                removed_id_set.add(rid)
            if user_supplied_ordinal and rid in top_level_ord_by_id:
                directly_targeted_top_ords.append(top_level_ord_by_id[rid])
            rows.pop(i)

        reply_ordinals = [
            int(x)
            for x in (parsed.get("_reply_ordinals") or [])
            if isinstance(x, int) and x > 0
        ]
        if user_supplied_ordinal and reply_ordinals:
            directly_targeted_top_ords = reply_ordinals
        directly_targeted_top_ords = sorted(set(directly_targeted_top_ords))

        if not removed:
            _log_after_mutation(action_name, list(removed_id_set), rows)
            return rows, "I could not find those checklist items.", False

        # Promote orphaned children to keep storage in sync with the UI
        # render. For parent_only scope this is the whole point — the
        # parent goes away but the children stay (and bubble up to
        # top-level so they're addressable by the next ordinal command).
        promoted = _promote_orphans_after_removal(rows, removed_id_set, pre_parent_of)
        if promoted:
            _log_checklist_debug(
                "INDEX_DEBUG][promote_orphans",
                {
                    "rewritten_count": promoted,
                    "removed_ids": list(removed_id_set),
                    "scope": scope,
                },
            )
        _log_checklist_debug(
            "SCOPE_DEBUG",
            {
                "raw_command": str(user_text or ""),
                "scope": scope,
                "sub_item_parent_text": parsed.get("sub_item_parent_text"),
                "removed_count": len(removed),
                "promoted_children_count": promoted,
                "directly_targeted_top_ordinals": directly_targeted_top_ords,
                "top_level_visible_before": len(top_level_before),
            },
        )

        # 2026-06-13: hierarchy-aware confirmation for a single directly
        # named "auto"-scope removal on a nested checklist. whole_section
        # and sub_item keep their dedicated section/parent wording.
        hier_reply = None
        if scope == "auto":
            hier_reply = _hierarchy_single_reply(
                _compose_hierarchy_remove_reply,
                has_hierarchy=has_hierarchy,
                primary_targets=primary_targets,
                row_meta=row_meta,
                reply_ordinals=reply_ordinals,
                action="remove_item",
                user_text=user_text,
            )
        if hier_reply is not None:
            base_reply = hier_reply
        else:
            base_reply = _compose_removal_reply(
                scope=scope,
                removed_count=len(removed),
                removed_texts=removed,
                directly_targeted_top_ords=directly_targeted_top_ords,
                sub_item_parent_label=sub_item_parent_label,
                sub_item_child_ord=sub_item_child_ord,
            )
        if missing:
            base_reply += f" I couldn't find {_human_join_ordinals(missing)}."
        _log_after_mutation(action_name, list(removed_id_set), rows)
        return rows, base_reply, True

    target_row_indices, err, missing = _resolve_target_row_indices()
    if err:
        _emit_resolve_debug([], missing)
        return rows, err, False
    target_row_idx = target_row_indices[0]
    _emit_resolve_debug([str(rows[target_row_idx].get("id") or "")], missing)

    new_text = str(parsed.get("new_text") or "").strip()
    if not new_text:
        return rows, "I could not find the replacement text for that checklist update.", False
    old_text = str(rows[target_row_idx].get("text") or "").strip()
    rows[target_row_idx]["text"] = new_text[:200]
    _log_after_mutation(action_name, [], rows)
    return rows, f"Updated checklist item from {old_text} to {new_text}.", True
