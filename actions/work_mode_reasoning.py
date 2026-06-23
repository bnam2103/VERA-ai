"""Work-mode reasoning workspace: switch tab or open a new panel (client applies ui_payload)."""

from __future__ import annotations

import json
import re
from difflib import SequenceMatcher


def _reasoning_block(snapshot: dict | None) -> dict | None:
    if not isinstance(snapshot, dict):
        return None
    if str(snapshot.get("mode") or "").lower() != "work":
        return None
    if str(snapshot.get("app") or "").strip().lower() != "vera":
        return None
    r = snapshot.get("reasoning")
    return r if isinstance(r, dict) else None


def _ordered_panels(reasoning: dict) -> list[dict]:
    raw = reasoning.get("panels")
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        try:
            idx = int(p.get("index"))
        except (TypeError, ValueError):
            continue
        label = str(p.get("label") or "").strip()
        out.append({"index": idx, "label": label})
    return sorted(out, key=lambda x: x["index"])


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower().strip())


def _strip_panel_query_boilerplate(q: str) -> str:
    """Remove leading command phrases and trailing 'panel' so slots match tab titles."""
    s = (q or "").strip()
    s = re.sub(
        r"(?i)^(?:uh+|um+|hey[, ]+|vera[, ]+)?(?:can you|could you|please)\s+",
        "",
        s,
    )
    s = re.sub(
        r"(?i)^(?:go to|jump to|switch to|change to|show|select|use|open)\s+(?:the\s+|a\s+|my\s+)?",
        "",
        s,
    )
    s = re.sub(r"(?i)\s+(?:reasoning\s+)?(?:panel|space|tab|page)\s*[?.!]*\s*$", "", s)
    return s.strip()


def _token_overlap_ratio(query: str, label: str) -> float:
    qn = _norm(query)
    ln = _norm(label)
    if not qn or not ln:
        return 0.0
    words = [w for w in re.split(r"[^\w]+", qn) if len(w) >= 3]
    if not words:
        return 0.0
    hits = sum(1 for w in words if w in ln)
    return hits / len(words)


def _best_label_match(panels: list[dict], query: str) -> dict | None:
    qn = _norm(query)
    if not qn:
        return None
    mnum = re.search(r"\b(?:panel|space|tab)\s*#?\s*(\d+)\s*$", qn)
    if mnum:
        n = int(mnum.group(1))
        for p in panels:
            lab = _norm(p.get("label") or "")
            if re.search(rf"\bpanel\s*#?\s*{n}\b", lab):
                return p
        if 1 <= n <= len(panels):
            return panels[n - 1]
    best: dict | None = None
    best_score = 0.0
    for p in panels:
        label = str(p.get("label") or "").strip()
        ln = _norm(label)
        if not ln:
            continue
        if qn in ln or ln in qn:
            score = 0.92 if qn in ln else 0.88
        else:
            score = SequenceMatcher(None, qn, ln).ratio()
        tok = _token_overlap_ratio(qn, ln)
        score = max(score, tok * 0.95)
        if score > best_score:
            best_score = score
            best = p
    if best is not None and best_score >= 0.52:
        return best
    return None


def should_block_reasoning_panel_activation_for_ordinal_problem(user_text: str | None) -> bool:
    """
    True when the line is about ordinals within homework/content (second problem, next question, …)
    and does *not* explicitly name reasoning UI (panel / tab / lane / space / page in a navigation sense).

    In that case, activation by panel index or fuzzy tab title must not switch tabs — the user likely
    means another exercise inside the active lane.
    """
    s = (user_text or "").strip()
    if not s:
        return False
    low = s.lower()

    # Explicit navigation toward the reasoning workspace chrome.
    if re.search(r"(?i)\b(?:reasoning\s+)?(?:panel|tab|lane)\b", low):
        return False
    if re.search(r"(?i)\breasoning\s+space\b", low):
        return False
    if re.search(
        r"(?i)\b(?:go\s+to|jump\s+to|switch\s+to|change\s+to|open|activate|show|select|use)\b[^.?!]{0,96}\b(?:reasoning\s+)?(?:panel|tab|lane|page)\b",
        low,
    ):
        return False
    if re.search(
        r"(?i)\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|next|previous|last|prior)\s+(?:reasoning\s+)?(?:panel|tab|lane|page)\b",
        low,
    ):
        return False
    if re.search(r"(?i)\b(?:panel|tab)\s*#?\s*\d{1,2}\b", low):
        return False

    # Content-ordinal phrasing (block tab switching).
    if re.search(
        r"(?i)\b(?:first|second|third|fourth|fifth|next|previous|last|prior|other|another)\s+(?:problem|question|part|exercise)\b",
        low,
    ):
        return True
    if re.search(
        r"(?i)\b(?:next|another)\s+(?:problem|question|part)\b",
        low,
    ):
        return True
    if re.search(r"(?i)\bproblem\s*(?:#|no\.?|number\s*)?\s*\d", low):
        return True
    if re.search(r"(?i)\bproblem\s*(?:#|no\.?)?\s*\d+\.\d+", low):
        return True
    if re.search(r"(?i)\b(?:ex\.?|exercise|question|q)\s*[#.]?\s*\d+", low):
        return True
    if re.search(r"(?i)\bthe\s+other\s+(?:problem|question|part)\b", low):
        return True
    if re.search(
        r"(?i)\b(?:this|that|the)\s+assignment(?:'s|s)?\s+(?:first|second|third|fourth|next|last)\s+part\b",
        low,
    ):
        return True
    if re.search(r"(?i)\bpart\s*\d+\b", low):
        return True
    return False


def _resolve_target_panel(slots: dict, reasoning: dict) -> tuple[dict | None, str | None]:
    """
    Returns (panel_dict, err).
    panel dict has keys index (int), label (str).
    """
    panels = _ordered_panels(reasoning)
    if not panels:
        return None, "no_panels"

    pq = (
        (slots.get("panel_query") or slots.get("target") or slots.get("name") or slots.get("query") or "")
        .strip()
    )
    if pq:
        core = _strip_panel_query_boilerplate(pq)
        for candidate in (core, pq):
            if not (candidate or "").strip():
                continue
            hit = _best_label_match(panels, candidate.strip())
            if hit:
                return hit, None

    pn = slots.get("panel_number")
    if pn is not None and str(pn).strip() != "":
        try:
            n = int(float(str(pn).strip()))
        except (TypeError, ValueError):
            n = None
        if n is not None and 1 <= n <= len(panels):
            return panels[n - 1], None
        if n is not None:
            return None, "range"

    if pq:
        return None, "nomatch"

    return None, "empty_slot"


def handle_work_mode_reasoning_select_panel(
    slots: dict,
    client_snapshot: dict | None,
    user_text: str | None = None,
) -> dict:
    reasoning = _reasoning_block(client_snapshot)
    if not reasoning:
        return {
            "spoken_reply": "Turn on VERA work mode to switch reasoning panels.",
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }

    panel, err = _resolve_target_panel(dict(slots or {}), reasoning)
    if err == "no_panels":
        return {
            "spoken_reply": "I do not see any reasoning panels in your workspace yet.",
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }
    if err in {"range", "empty_slot", "nomatch"}:
        plist = _ordered_panels(reasoning)
        names = ", ".join(f'"{p["label"]}"' for p in plist[:6] if p.get("label"))
        suffix = f" You have: {names}." if names else ""
        return {
            "spoken_reply": "I could not find that reasoning panel." + suffix,
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }

    if should_block_reasoning_panel_activation_for_ordinal_problem(user_text):
        try:
            print(
                "[blocked_lane_activation] "
                + json.dumps(
                    {
                        "user_text": (user_text or "")[:500],
                        "requested_panel_index": int(panel["index"]) if panel else None,
                        "reason": "ordinal_problem_not_tab_navigation",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        return {
            "spoken_reply": (
                "Do you mean another exercise in the current reasoning lane, "
                "or a different reasoning panel? Say which panel or tab if you want to switch workspaces."
            ),
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }

    label = str(panel.get("label") or f"Panel {int(panel['index']) + 1}").strip()
    return {
        "spoken_reply": f"Switching to {label}.",
        "action_type": "work_mode_reasoning",
        "data": {"panel_index": int(panel["index"]), "label": label},
        "ui_payload": {
            "panel_type": "work_mode_reasoning",
            "op": "activate",
            "panel_index": int(panel["index"]),
        },
    }


def handle_work_mode_reasoning_close_panel(
    *,
    client_snapshot: dict | None = None,
    slots: dict | None = None,
    user_text: str | None = None,
) -> dict:
    """
    Close-reasoning-panel handler. The frontend owns all panel state, index
    resolution, auto-refill, and undo, so the action's only job here is to:
      1. Confirm the user is in Work Mode.
      2. Echo the user_text + slots back via ui_payload so the frontend
         executor can re-parse and run the close in a single deterministic
         place (the JS parser + executeCloseReasoningPanelsCommand).
      3. Build a short voice confirmation matching spec PART 15.

    `slots` may carry `scope` ("current_panel" | "specific_indices" |
    "range_first_n" | "range_last_n" | "range" | "all_panels" |
    "other_panels" | "by_title" | "reopen_last"), `indices` (list of 1-based
    visual indices), and `title_query` (string for by-title closes). If the
    LLM router didn't extract slots, we leave them blank and let the
    frontend parser take over with `user_text`.
    """
    reasoning = _reasoning_block(client_snapshot)
    if not reasoning:
        return {
            "spoken_reply": "Turn on VERA work mode to close a reasoning panel.",
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }
    slots_ = dict(slots or {})
    scope_raw = str(slots_.get("scope") or "").strip().lower()
    raw_indices = slots_.get("indices") or []
    norm_indices: list[int] = []
    if isinstance(raw_indices, list):
        for v in raw_indices:
            try:
                n = int(v)
            except (TypeError, ValueError):
                continue
            if n >= 1:
                norm_indices.append(n)
    elif isinstance(raw_indices, (int, float)):
        try:
            n = int(raw_indices)
            if n >= 1:
                norm_indices.append(n)
        except (TypeError, ValueError):
            pass
    title_query = str(slots_.get("title_query") or slots_.get("title") or "").strip()

    if scope_raw == "reopen_last":
        try:
            print(
                "[reasoning_close_route] "
                + json.dumps(
                    {
                        "user_text": (user_text or "")[:200],
                        "action": "work_mode.reasoning_close_panel",
                        "scope": "reopen_last",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        return {
            "spoken_reply": "Bringing back the last closed panel.",
            "confirmation": "Bringing back the last closed panel.",
            "client_owns_confirmation": True,
            "action_type": "work_mode_reasoning",
            "data": {"scope": "reopen_last"},
            "ui_payload": {
                "panel_type": "work_mode_reasoning",
                "op": "reopen_last",
                "user_text": user_text or "",
                # Include a parsed shape so downstream code can introspect
                # the intent uniformly across close/reopen payloads without
                # special-casing the operation type.
                "parsed": {
                    "intent": "reopen_last_reasoning_panel",
                    "closeScope": "reopen_last",
                    "indices": None,
                    "titleQuery": "",
                    "refillToMinimum": True,
                },
                "confirmation": "Bringing back the last closed panel.",
                "client_owns_confirmation": True,
            },
        }

    # Build the spoken reply to match PART 15 + polish PART 2. Use word-form
    # counts (one/two/three…) so the line reads naturally and matches the
    # client-side phrasing in app.js → buildCloseReasoningPanelsVoiceReply.
    _COUNT_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight"]

    def _count_word(n: int) -> str:
        try:
            k = int(n)
        except (TypeError, ValueError):
            return str(n)
        if 0 < k < len(_COUNT_WORDS):
            return _COUNT_WORDS[k]
        return str(k)

    if scope_raw == "all_panels":
        spoken = "Closed all panels and opened fresh ones."
    elif scope_raw == "other_panels":
        spoken = "Closed the other reasoning panels."
    elif scope_raw == "current_panel":
        spoken = "Closed this panel and opened a fresh one."
    elif scope_raw == "by_title" and title_query:
        spoken = f"Closed the {title_query} panel."
    elif scope_raw == "range_first_n" and norm_indices:
        spoken = f"Closed the first {_count_word(len(norm_indices))} panels and opened fresh ones."
    elif scope_raw == "range_last_n" and norm_indices:
        spoken = f"Closed the last {_count_word(len(norm_indices))} panels and opened fresh ones."
    elif scope_raw == "range" and norm_indices:
        spoken = f"Closed panels {norm_indices[0]} through {norm_indices[-1]} and opened fresh ones."
    elif scope_raw == "specific_indices" and norm_indices:
        if len(norm_indices) == 1:
            spoken = f"Closed panel {norm_indices[0]} and opened a fresh one."
        else:
            joined = ", ".join(str(n) for n in norm_indices[:-1]) + f" and {norm_indices[-1]}"
            spoken = f"Closed panels {joined} and opened fresh ones."
    else:
        spoken = "Closing the reasoning panel."

    try:
        print(
            "[reasoning_close_route] "
            + json.dumps(
                {
                    "user_text": (user_text or "")[:200],
                    "action": "work_mode.reasoning_close_panel",
                    "scope": scope_raw or "unspecified",
                    "indices": norm_indices,
                    "title_query": title_query,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass

    parsed_payload = {
        "intent": "close_reasoning_panels",
        "closeScope": scope_raw or "current_panel",
        "indices": norm_indices or None,
        "titleQuery": title_query,
        "refillToMinimum": True,
    }

    return {
        # PART 2: the client owns the authoritative confirmation now. We
        # still ship `spoken_reply` so any code path that ignores the
        # ui_payload still gets a sensible voice line, but we flag
        # `client_owns_confirmation=True` and `confirmation=<spoken>` so the
        # chat pipeline can use a single bubble instead of double-firing.
        "spoken_reply": spoken,
        "confirmation": spoken,
        "client_owns_confirmation": True,
        "action_type": "work_mode_reasoning",
        "data": {
            "scope": scope_raw or "current_panel",
            "indices": norm_indices,
            "title_query": title_query,
        },
        "ui_payload": {
            "panel_type": "work_mode_reasoning",
            "op": "close",
            "reason": "backend_action",
            "user_text": user_text or "",
            "parsed": parsed_payload,
            "confirmation": spoken,
            "client_owns_confirmation": True,
        },
    }


def handle_work_mode_reasoning_open_panel(client_snapshot: dict | None, slots: dict | None = None) -> dict:
    reasoning = _reasoning_block(client_snapshot)
    if not reasoning:
        return {
            "spoken_reply": "Turn on VERA work mode to open a new reasoning panel.",
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }
    try:
        count = int(reasoning.get("panel_count") or len(_ordered_panels(reasoning)))
    except (TypeError, ValueError):
        count = len(_ordered_panels(reasoning))
    try:
        cap = int(reasoning.get("max_panels") or 8)
    except (TypeError, ValueError):
        cap = 8
    if count >= cap:
        return {
            "spoken_reply": f"You already have the maximum of {cap} reasoning spaces.",
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }
    requested = 1
    slots_ = dict(slots or {})
    try:
        requested = int(slots_.get("count") or 1)
    except (TypeError, ValueError):
        requested = 1
    requested = max(1, requested)
    max_per_request = 3
    allowed = min(requested, max_per_request, max(0, cap - count))
    if allowed <= 0:
        return {
            "spoken_reply": f"You already have the maximum of {cap} reasoning spaces.",
            "action_type": "work_mode_reasoning",
            "data": None,
            "ui_payload": None,
        }
    if requested > max_per_request:
        spoken = f"I can open up to {max_per_request} reasoning panels at once, so I opened {allowed}."
    elif allowed < requested:
        spoken = f"I opened {allowed} reasoning panel{'s' if allowed != 1 else ''}; that is all the room available."
    elif allowed == 1:
        spoken = "Opening a new reasoning panel."
    else:
        spoken = f"Opening {allowed} new reasoning spaces."
    try:
        print(
            "[panel_action] "
            + json.dumps(
                {
                    "ui_action": "open_new_panel",
                    "requested": requested,
                    "allowed": allowed,
                    "panel_count_before": count,
                    "panel_count_after_expected": count + allowed,
                    "content_task": slots_.get("content_task") or None,
                    "panel_open_request_id": slots_.get("new_panel_request_id") or "",
                    "action_plan_id": slots_.get("action_plan_id") or "",
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass
    return {
        "spoken_reply": spoken,
        "speak": True,
        "ui_status": spoken,
        "action_type": "work_mode_reasoning",
        "data": {"count": allowed, "requested": requested},
        "ui_payload": {
            "panel_type": "work_mode_reasoning",
            "op": "open_new",
            "count": allowed,
            "panel_open_request_id": slots_.get("new_panel_request_id") or "",
            "action_plan_id": slots_.get("action_plan_id") or "",
            "content_task": slots_.get("content_task") or "",
        },
    }
