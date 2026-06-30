"""Smoke tests for the reasoning-panel close pipeline (PART 17 of the spec).

What this covers (auto):
  * `_is_reasoning_close_panel_request` — top-of-pipeline detector
  * `_classify_reasoning_close_panel_scope` — scope/indices/title parser
  * `heuristic_route_action` — top-guard dispatch to
    work_mode.reasoning_close_panel
  * `handle_work_mode_reasoning_close_panel` — action handler output shape
  * Non-reasoning-close phrases (news / music / checklist / settings) must
    NOT be eaten by the new heuristic.

What is NOT covered here (requires a browser):
  * Test 1 — UI close inactive tab (X button click)
  * Test 2 — UI close active tab (X button click)
  * Test 16 — Streaming cancel on close (DOM streaming required)

Those three are listed as manual at the bottom of this script.

The script forces UTF-8 stdout/stderr and stubs the heavy `TTS` / `STT`
modules before importing `app.py`, mirroring the pattern from prior
smoke tests in this codebase so it runs in <2s on Windows.
"""

from __future__ import annotations

# --- bootstrap (auto-added on move to tests/smoke/) ----------------------
# This file was moved from the repo root into tests/smoke/. Add the repo
# root to sys.path so `import app` (and sibling modules) still resolves.
# Bootstrap must come AFTER `from __future__` to satisfy the Python rule
# that __future__ imports be the first statement (fixed 2026-05-28).
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', '..')))
# -----------------------------------------------------------------------

import io
import json
import os
import sys
import types

# --- environment hardening ------------------------------------------------
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# --- stub heavy modules so importing app.py doesn't load TTS/Whisper ------
_TTS_STUB_NAMES = (
    "synthesize_reply_audio",
    "synthesize_audio",
    "tts_init",
    "transcribe",
    "transcribe_long",
    "load_model",
    "warmup",
    "speak_to_file",
    "split_sentences_for_tts",
    "pop_first_complete_segment",
    "stream_tts_chunks",
    "tts_chunks",
    "warmup_tts",
    "warmup_asr",
    "init_tts",
    "init_asr",
    "preload",
)
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _TTS_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

# Now safe to import the app and the action module.
import app  # type: ignore  # noqa: E402
from actions import work_mode_reasoning as wmr  # type: ignore  # noqa: E402


GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"


PASS = 0
FAIL = 0
FAILED_CASES: list[str] = []


def _assert(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED_CASES.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' — ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}Ã¢”â‚¬Ã¢”â‚¬ {title} Ã¢”â‚¬Ã¢”â‚¬{RESET}")


# ---------------------------------------------------------------------------
# Suite A — _is_reasoning_close_panel_request: positive cases
# ---------------------------------------------------------------------------
section("A. Detector positives")
positive_phrases = [
    # Test 3 — voice close current
    "close this panel",
    "close the current panel",
    "close this reasoning panel",
    "close the reasoning panel",
    "close current reasoning tab",
    "close this tab",
    # Test 4-7 — specific & ordinal
    "close panel 2",
    "close the second panel",
    "close the 2nd panel",
    "close the first panel",
    "close the third panel",
    "close the last panel",
    # Test 5 — by title
    "close the ticket complaint panel",
    "close the english essay panel",
    "remove this panel",
    "delete this panel",
    "get rid of this reasoning panel",
    # Test 8 — multi-ordinal
    "close the first and third panel",
    "close first and second panels",
    "close panels 1 and 3",
    "close panel 1, 2, and 3",
    "close the first, second, and fourth panels",
    # Test 9, 11, 14 — ranges
    "close the first two panels",
    "close the first 2 panels",
    "close the first three panels",
    "close panels 1 through 3",
    "close panels 1 to 3",
    "close the last two panels",
    "close the first five panels",
    # Test 10 — all / others
    "close all panels",
    "close all reasoning panels",
    "clear reasoning panels",
    "close every panel",
    "close inactive panels",
    "close other panels",
    "close all other panels",
    "keep this one and close the rest",
    # Test 15 — undo / reopen
    "undo close",
    "reopen last panel",
    "restore closed panel",
    "bring back the last panel",
    "reopen the last reasoning panel",
]
for phrase in positive_phrases:
    _assert(
        app._is_reasoning_close_panel_request(phrase),
        f"detector positive: {phrase!r}",
    )

# ---------------------------------------------------------------------------
# Suite B — Detector negatives (must NOT eat these)
# ---------------------------------------------------------------------------
section("B. Detector negatives (must stay off)")
negative_phrases = [
    # Test 17 — news panel
    "close the news panel",
    "hide news",
    "dismiss the news tab",
    "close news",
    "open the news panel",
    # Other surfaces
    "close music",
    "close the music panel",
    "pause music",
    "close spotify",
    "close settings",
    "close the settings panel",
    "close the checklist panel",
    "close browser tab",
    # Test 18 — checklist mutations
    "remove first and third item",
    "remove the first item",
    "delete items 1 and 3",
    "remove item 2",
    "delete the second task",
    "cross off the first bullet",
    "uncheck the third item",
    "mark the first task as done",
    # Pure conversation
    "tell me about the news",
    "what's the weather like",
    "how do I close a futures position",  # finance, no panel/tab noun in reasoning sense
    "I want to close out my Tesla position",
    "open a new reasoning panel",  # this is OPEN, not close
    "switch to panel 2",  # this is SELECT, not close
]
for phrase in negative_phrases:
    _assert(
        not app._is_reasoning_close_panel_request(phrase),
        f"detector negative: {phrase!r}",
    )

# ---------------------------------------------------------------------------
# Suite C — _classify_reasoning_close_panel_scope
# ---------------------------------------------------------------------------
section("C. Scope classifier")


def expect_scope(phrase: str, scope: str, indices=None, title: str | None = None, range_n=None) -> None:
    result = app._classify_reasoning_close_panel_scope(phrase)
    ok = result.get("scope") == scope
    detail_parts = [f"scope={result.get('scope')!r}"]
    if indices is not None:
        idx_ok = list(result.get("indices") or []) == list(indices)
        ok = ok and idx_ok
        detail_parts.append(f"indices={result.get('indices')!r}")
    if title is not None:
        t_ok = (result.get("title_query") or "").lower() == title.lower()
        ok = ok and t_ok
        detail_parts.append(f"title_query={result.get('title_query')!r}")
    if range_n is not None:
        n_ok = result.get("range_n") == range_n
        ok = ok and n_ok
        detail_parts.append(f"range_n={result.get('range_n')!r}")
    _assert(
        ok,
        f"scope: {phrase!r} Ã¢” ’ {scope}",
        detail=", ".join(detail_parts) if not ok else "",
    )


# Spec PART 14 — parser examples
expect_scope("close the first panel", "specific_indices", indices=[1])
expect_scope("close the first and third panel", "specific_indices", indices=[1, 3])
expect_scope("close the first two panels", "range_first_n", indices=[1, 2], range_n=2)
expect_scope("close panels 1 through 3", "range", indices=[1, 2, 3])
expect_scope("close panels 1 to 3", "range", indices=[1, 2, 3])
expect_scope("close the last two panels", "range_last_n", range_n=2)
expect_scope("close all other panels", "other_panels")
expect_scope("close all panels", "all_panels")
expect_scope("close every panel", "all_panels")
expect_scope("close inactive panels", "other_panels")
expect_scope("keep this one and close the rest", "other_panels")
expect_scope("close this panel", "current_panel")
expect_scope("close panel", "current_panel")
expect_scope("close the current panel", "current_panel")
expect_scope("close current reasoning tab", "current_panel")
expect_scope("close the ticket complaint panel", "by_title", title="ticket complaint")
expect_scope("close the english essay panel", "by_title", title="english essay")
expect_scope("close panel 2", "specific_indices", indices=[2])
expect_scope("close panels 1 and 3", "specific_indices", indices=[1, 3])
expect_scope("close panel 1, 2, and 3", "specific_indices", indices=[1, 2, 3])
expect_scope("close the first, second, and fourth panels", "specific_indices", indices=[1, 2, 4])
expect_scope("close the first five panels", "range_first_n", indices=[1, 2, 3, 4, 5], range_n=5)
expect_scope("undo close", "reopen_last")
expect_scope("reopen last panel", "reopen_last")
expect_scope("bring back the last panel", "reopen_last")
expect_scope("restore closed panel", "reopen_last")
expect_scope("reopen the last reasoning panel", "reopen_last")


# ---------------------------------------------------------------------------
# Suite D — heuristic_route_action top-guard dispatch
# ---------------------------------------------------------------------------
section("D. heuristic_route_action dispatch")


def expect_action(phrase: str, expected_action: str, slot_check=None) -> None:
    result = app.heuristic_route_action(phrase)
    actual = result.get("action_name") if isinstance(result, dict) else None
    ok = actual == expected_action
    detail = f"actual={actual!r}"
    if ok and slot_check is not None and isinstance(result, dict):
        slot_ok, slot_detail = slot_check(result.get("slots") or {})
        ok = ok and slot_ok
        if not slot_ok:
            detail = f"slots={result.get('slots')!r} {slot_detail}"
    _assert(ok, f"route: {phrase!r} Ã¢” ’ {expected_action}", detail=detail if not ok else "")


# Reasoning close routes
expect_action("close this panel", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "current_panel", "expected scope=current_panel"))
expect_action("close panel", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "current_panel", "expected scope=current_panel"))
expect_action("close panel 2", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "specific_indices" and s.get("indices") == [2], "expected scope=specific_indices indices=[2]"))
expect_action("close the first two panels", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "range_first_n" and s.get("indices") == [1, 2], "expected range_first_n [1,2]"))
expect_action("close panels 1 through 3", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "range" and s.get("indices") == [1, 2, 3], "expected range [1,2,3]"))
expect_action("close the last two panels", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "range_last_n" and s.get("range_n") == 2, "expected range_last_n range_n=2"))
expect_action("close all panels", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "all_panels", "expected all_panels"))
expect_action("close all other panels", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "other_panels", "expected other_panels"))
expect_action("close the ticket complaint panel", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "by_title" and "ticket" in (s.get("title_query") or "").lower(), "expected by_title"))
expect_action("undo close", "work_mode.reasoning_close_panel",
              slot_check=lambda s: (s.get("scope") == "reopen_last", "expected reopen_last"))

# Non-reasoning routes must go elsewhere
expect_action("close the news panel", "news.close_panel")
expect_action("hide news", "news.close_panel")
expect_action("open the news panel", "news.open_panel")
expect_action("open music", "music.open_panel")
expect_action("show music panel", "music.open_panel")

# Checklist phrases must not route here
result = app.heuristic_route_action("remove the first item")
checklist_route = isinstance(result, dict) and result.get("action_name") == "work_mode.reasoning_close_panel"
_assert(not checklist_route, "checklist phrase 'remove the first item' does NOT route to reasoning_close_panel")

result = app.heuristic_route_action("delete items 1 and 3")
checklist_route = isinstance(result, dict) and result.get("action_name") == "work_mode.reasoning_close_panel"
_assert(not checklist_route, "checklist phrase 'delete items 1 and 3' does NOT route to reasoning_close_panel")

# Open-new must not route to close
result = app.heuristic_route_action("open a new reasoning panel")
close_route = isinstance(result, dict) and result.get("action_name") == "work_mode.reasoning_close_panel"
_assert(not close_route, "open-new phrase does NOT route to close")


# ---------------------------------------------------------------------------
# Suite E — handle_work_mode_reasoning_close_panel
# ---------------------------------------------------------------------------
section("E. Action handler output shape")


def _snapshot_with_panels(n: int, active: int = 0) -> dict:
    return {
        "app": "vera",
        "mode": "work",
        "reasoning": {
            "panel_count": n,
            "max_panels": 8,
            "panels": [
                {"index": i, "label": f"Panel {i + 1}"} for i in range(n)
            ],
            "active_panel_index": active,
        },
    }


# Work-mode off Ã¢” ’ friendly message, no ui_payload
result = wmr.handle_work_mode_reasoning_close_panel(
    client_snapshot=None,
    slots={"scope": "current_panel"},
    user_text="close this panel",
)
_assert(result.get("ui_payload") is None, "no-work-mode close returns ui_payload=None")
_assert("work mode" in (result.get("spoken_reply") or "").lower(), "no-work-mode close mentions work mode")

# current_panel — ui_payload + spoken reply
result = wmr.handle_work_mode_reasoning_close_panel(
    client_snapshot=_snapshot_with_panels(3),
    slots={"scope": "current_panel"},
    user_text="close this panel",
)
ui = result.get("ui_payload") or {}
_assert(ui.get("panel_type") == "work_mode_reasoning", "current: ui_payload.panel_type=work_mode_reasoning")
_assert(ui.get("op") == "close", "current: ui_payload.op=close")
_assert(isinstance(ui.get("parsed"), dict), "current: ui_payload.parsed is dict")
_assert(ui["parsed"].get("closeScope") == "current_panel", "current: parsed.closeScope=current_panel")
_assert("closed this panel" in (result.get("spoken_reply") or "").lower(), "current: spoken reply matches PART 15")

# specific_indices
result = wmr.handle_work_mode_reasoning_close_panel(
    client_snapshot=_snapshot_with_panels(3),
    slots={"scope": "specific_indices", "indices": [2]},
    user_text="close panel 2",
)
ui = result.get("ui_payload") or {}
_assert(ui["parsed"].get("indices") == [2], "specific: parsed.indices=[2]")
_assert("panel 2" in (result.get("spoken_reply") or "").lower(), "specific: spoken reply names Panel 2")

# all_panels
result = wmr.handle_work_mode_reasoning_close_panel(
    client_snapshot=_snapshot_with_panels(3),
    slots={"scope": "all_panels"},
    user_text="close all panels",
)
_assert("all panels" in (result.get("spoken_reply") or "").lower(), "all_panels: spoken reply mentions 'all panels'")

# range_first_n
result = wmr.handle_work_mode_reasoning_close_panel(
    client_snapshot=_snapshot_with_panels(3),
    slots={"scope": "range_first_n", "indices": [1, 2]},
    user_text="close the first two panels",
)
_assert(
    "first two panels" in (result.get("spoken_reply") or "").lower(),
    "range_first_n: spoken reply uses word-form 'first two panels' (PART 2 polish)",
)
_assert(
    (result.get("client_owns_confirmation") is True) and (result.get("confirmation") == result.get("spoken_reply")),
    "range_first_n: action result carries client_owns_confirmation + matching confirmation string (PART 2)",
)
_assert(
    bool((result.get("ui_payload") or {}).get("client_owns_confirmation")) and (result.get("ui_payload") or {}).get("confirmation") == result.get("spoken_reply"),
    "range_first_n: ui_payload also carries client_owns_confirmation + confirmation (PART 2)",
)

# by_title
result = wmr.handle_work_mode_reasoning_close_panel(
    client_snapshot=_snapshot_with_panels(3),
    slots={"scope": "by_title", "title_query": "ticket complaint"},
    user_text="close the ticket complaint panel",
)
_assert("ticket complaint" in (result.get("spoken_reply") or "").lower(), "by_title: spoken reply includes title")

# reopen_last
result = wmr.handle_work_mode_reasoning_close_panel(
    client_snapshot=_snapshot_with_panels(3),
    slots={"scope": "reopen_last"},
    user_text="undo close",
)
_assert((result.get("ui_payload") or {}).get("op") == "reopen_last", "reopen_last: ui_payload.op=reopen_last")
_assert("bring" in (result.get("spoken_reply") or "").lower() or "reopen" in (result.get("spoken_reply") or "").lower(),
        "reopen_last: spoken reply mentions reopening")


# ---------------------------------------------------------------------------
# Suite F — Spec PART 17 scenario walkthroughs (parser + handler only)
# ---------------------------------------------------------------------------
section("F. PART 17 scenario walkthroughs (parserÃ¢” ’handler)")


def walk(name: str, phrase: str, panel_count: int, expected_scope: str, expected_indices=None) -> None:
    # 1. Heuristic route fires
    route = app.heuristic_route_action(phrase)
    routed_correctly = (
        isinstance(route, dict)
        and route.get("action_name") == "work_mode.reasoning_close_panel"
        and (route.get("slots") or {}).get("scope") == expected_scope
    )
    # 2. Handler accepts the slots and emits a usable ui_payload
    if routed_correctly:
        slots = dict(route.get("slots") or {})
        result = wmr.handle_work_mode_reasoning_close_panel(
            client_snapshot=_snapshot_with_panels(panel_count),
            slots=slots,
            user_text=phrase,
        )
        ui = result.get("ui_payload") or {}
        ok = ui.get("op") in {"close", "reopen_last"} and isinstance(ui.get("parsed"), dict)
        if expected_indices is not None:
            ok = ok and (slots.get("indices") == expected_indices)
    else:
        ok = False
    _assert(ok, name)


# Test 3 — Voice close current
walk("Test 3 — close this panel", "close this panel", 3, "current_panel")
# Test 4 — Voice close by number
walk("Test 4 — close panel 2", "close panel 2", 3, "specific_indices", expected_indices=[2])
# Test 5 — Voice close by title
walk("Test 5 — close the ticket complaint panel", "close the ticket complaint panel", 3, "by_title")
# Test 6 — Close first panel
walk("Test 6 — close the first panel", "close the first panel", 3, "specific_indices", expected_indices=[1])
# Test 7 — Close third panel
walk("Test 7 — close the third panel", "close the third panel", 3, "specific_indices", expected_indices=[3])
# Test 8 — Close first and third
walk("Test 8 — close the first and third panel", "close the first and third panel", 3, "specific_indices", expected_indices=[1, 3])
# Test 9 — Close first two panels
walk("Test 9 — close the first two panels", "close the first two panels", 3, "range_first_n", expected_indices=[1, 2])
# Test 10 — Close all panels
walk("Test 10 — close all panels", "close all panels", 3, "all_panels")
# Test 11 — Close last two panels (range_last_n; frontend resolves absolute indices)
walk("Test 11 — close the last two panels", "close the last two panels", 4, "range_last_n")
# Test 12 — Close all other panels
walk("Test 12 — close all other panels", "close all other panels", 3, "other_panels")
# Test 13 — Invalid specific index (still routes; frontend refuses with "I only see N")
walk("Test 13 — close the fourth panel (3 exist)", "close the fourth panel", 3, "specific_indices", expected_indices=[4])
# Test 14 — First five when only three exist (still routes; frontend trims to [1,2,3])
walk("Test 14 — close the first five panels (3 exist)", "close the first five panels", 3, "range_first_n", expected_indices=[1, 2, 3, 4, 5])
# Test 15 — Undo close
walk("Test 15 — undo close", "undo close", 3, "reopen_last")
# Test 19 — Panel close should not affect checklist (just verifies it routes to close)
walk("Test 19 — close the first panel (panel route, not checklist)", "close the first panel", 3, "specific_indices", expected_indices=[1])

# Test 17 — Do not confuse with news panel
result = app.heuristic_route_action("close the news panel")
_assert(
    isinstance(result, dict) and result.get("action_name") == "news.close_panel",
    "Test 17 — 'close the news panel' routes to news.close_panel",
)

# Test 18 — Checklist should not be panel close
result = app.heuristic_route_action("remove first and third item")
_assert(
    not (isinstance(result, dict) and result.get("action_name") == "work_mode.reasoning_close_panel"),
    "Test 18 — 'remove first and third item' does NOT route to reasoning_close_panel",
)


# ---------------------------------------------------------------------------
# Suite G — Post-LLM redirect: LLM returns reasoning_close_panel but the
# user actually said "close the news panel" — make sure the existing
# news-panel post-LLM override now includes reasoning_close_panel.
# ---------------------------------------------------------------------------
section("G. Post-LLM redirect safety (reasoning_close_panel Ã¢” ” news.close_panel)")
import inspect  # noqa: E402
src = inspect.getsource(app)
_assert(
    'reasoning_close_panel' in src and 'news.close_panel' in src,
    "post-LLM safety: both action names present in source",
)
_assert(
    '"work_mode.reasoning_close_panel",\n        } and _is_news_panel_open_request(text)' in src
    or 'reasoning_close_panel' in src.split('_is_news_panel_open_request(text)')[0],
    "post-LLM safety: redirect block covers reasoning_close_panel",
)


# ---------------------------------------------------------------------------
section("Summary")
total = PASS + FAIL
print(f"\n  Total: {total}   {GREEN}Pass: {PASS}{RESET}   {(RED if FAIL else RESET)}Fail: {FAIL}{RESET}")
if FAIL:
    print(f"\n  {RED}Failed cases:{RESET}")
    for n in FAILED_CASES:
        print(f"    - {n}")

print(
    "\nMANUAL UI TESTS (browser-only, not auto-covered):\n"
    "  Test 1  — UI close inactive tab (X click): open work mode, click X on Panel 2,\n"
    "             confirm Panel 2 disappears, active tab unchanged, total stays at 3.\n"
    "  Test 2  — UI close active tab (X click): open work mode, click X on the active\n"
    "             panel, confirm the right-neighbor becomes active, total stays at 3.\n"
    "  Test 16 — Streaming close: start a long generation on a panel, say 'close this\n"
    "             panel'. Inspect console for '[reasoning_stream_cancelled_due_to_panel_close]'\n"
    "             and confirm no further chunks land in the new blank replacement.\n"
)

sys.exit(0 if FAIL == 0 else 1)
