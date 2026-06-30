"""Smoke tests for checklist undo routing after clear/erase.

Run:
    py -3 -X utf8 tests\\smoke\\__checklist_undo_routing_smoke.py
"""

from __future__ import annotations

import io
import os
import sys
import types
from time import time

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

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

import app  # noqa: E402
from actions.checklist import (  # noqa: E402
    is_checklist_undo_clarification_answer,
    is_checklist_undo_followup,
    is_checklist_undo_request,
)

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


def work_snapshot(items: list[dict], *, undo_snapshot: dict | None = None) -> dict:
    snap = {
        "mode": "work",
        "checklist": {"items": items, "completed_collapsed": False},
    }
    if undo_snapshot:
        snap["checklist_undo_snapshot"] = undo_snapshot
    return snap


def sample_items() -> list[dict]:
    return [
        {"id": "a", "text": "buy milk", "done": False, "parent_id": None},
        {"id": "b", "text": "finish essay", "done": True, "parent_id": None},
    ]


def nested_items() -> list[dict]:
    return [
        {"id": "g", "text": "gaming", "done": False, "parent_id": None},
        {
            "id": "gf",
            "text": "talking to friends",
            "done": False,
            "parent_id": "g",
        },
        {"id": "h", "text": "homework", "done": False, "parent_id": None},
    ]


def reset_session(sid: str) -> None:
    app.checklist_undo_snapshots.pop(sid, None)
    app.pending_checklist_undo_context.pop(sid, None)
    app.recent_action_context.pop(sid, None)


def arm_snapshot(sid: str, items: list[dict], *, created_at: float | None = None) -> None:
    app.checklist_undo_snapshots[sid] = {
        "snapshot_id": "test-snap",
        "items": [dict(r) for r in items],
        "completed_collapsed": False,
        "created_at": created_at if created_at is not None else time(),
        "source": "checklist.clear",
        "valid": True,
    }
    app.pending_checklist_undo_context[sid] = {
        "domain": "checklist",
        "action": "undo_clear",
        "snapshot_id": "test-snap",
        "snapshot_item_count": len(items),
        "expires_at_ms": int((time() + app.CHECKLIST_UNDO_TTL_SEC) * 1000),
    }


def client_undo_snapshot(items: list[dict]) -> dict:
    created_ms = int(time() * 1000)
    return {
        "snapshot_id": "client-snap",
        "items": [dict(r) for r in items],
        "completed_collapsed": False,
        "created_at_ms": created_ms,
        "source": "checklist.clear",
        "valid": True,
        "expires_at_ms": created_ms + app.CHECKLIST_UNDO_TTL_SEC * 1000,
    }


def main() -> int:
    sid = "undo-routing-smoke"

    section("A. undo phrase detection")
    for phrase in (
        "Can you undo that?",
        "you undo that?",
        "undo",
        "restore it",
        "bring it back",
        "restore the checklist",
    ):
        ok(is_checklist_undo_request(phrase), f"detects undo phrase: {phrase!r}")
    ok(is_checklist_undo_followup("The checklist."), "clarification answer is followup")
    ok(
        is_checklist_undo_clarification_answer("the checklist"),
        "the checklist matches clarification answer",
    )

    section("B. clear -> undo restores checklist")
    reset_session(sid)
    items = sample_items()
    arm_snapshot(sid, items)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_checklist_undo_shortcut(
        sid, "Can you undo that?", work_snapshot([])
    )
    ok(resolved is not None, "undo shortcut resolves")
    reply, _t, ar = resolved or ("", 0.0, {})
    ok("Restored" in (reply or ""), "restore reply", reply or "")
    ok((ar.get("data") or {}).get("undo") is True, "undo flag set")
    restored = (ar.get("ui_payload") or {}).get("items") or []
    ok(len(restored) == 2, "restored item count", str(len(restored)))

    section("C. clear -> you undo that?")
    reset_session(sid)
    arm_snapshot(sid, items)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_checklist_undo_shortcut(
        sid, "you undo that?", work_snapshot([])
    )
    reply = (resolved or ("", 0.0, {}))[0]
    ok("Restored" in (reply or ""), "you undo that restores", reply or "")

    section("D. clear -> restore it")
    reset_session(sid)
    arm_snapshot(sid, items)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_checklist_undo_shortcut(
        sid, "restore it", work_snapshot([])
    )
    reply = (resolved or ("", 0.0, {}))[0]
    ok("Restored" in (reply or ""), "restore it works", reply or "")

    section("E. nested subitems restore")
    reset_session(sid)
    nested = nested_items()
    arm_snapshot(sid, nested)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_checklist_undo_shortcut(
        sid, "undo that", work_snapshot([])
    )
    restored = ((resolved or ("", 0.0, {}))[2].get("ui_payload") or {}).get("items") or []
    ok(len(restored) == 3, "nested item count restored", str(len(restored)))
    child = [r for r in restored if str(r.get("parent_id") or "") == "g"]
    ok(len(child) == 1 and child[0].get("text") == "talking to friends", "nested child restored")

    section("F. expired TTL -> no recent change")
    reset_session(sid)
    arm_snapshot(
        sid,
        items,
        created_at=time() - app.CHECKLIST_UNDO_TTL_SEC - 5,
    )
    resolved = app.resolve_checklist_undo_shortcut(
        sid, "undo that", work_snapshot([])
    )
    reply = (resolved or ("", 0.0, {}))[0]
    ok(
        "don't have a recent checklist change" in (reply or "").lower(),
        "expired TTL message",
        reply or "",
    )

    section("G. no snapshot -> no recent change (not clarify)")
    reset_session(sid)
    resolved = app.resolve_checklist_undo_shortcut(
        sid, "undo that", work_snapshot([])
    )
    reply = (resolved or ("", 0.0, {}))[0]
    ok(
        "don't have a recent checklist change" in (reply or "").lower(),
        "missing snapshot message",
        reply or "",
    )
    ok(
        "what would you like me to undo" not in (reply or "").lower(),
        "does not ask generic clarify",
        reply or "",
    )
    route = app.heuristic_route_action("undo that")
    ok(route is None or route.get("action_name") != "music.volume_down", "heuristic skips music volume")

    section("H. clarification answer restores from client snapshot")
    reset_session(sid)
    nested = nested_items()
    resolved = app.resolve_checklist_undo_shortcut(
        sid,
        "the checklist",
        work_snapshot([], undo_snapshot=client_undo_snapshot(nested)),
    )
    reply = (resolved or ("", 0.0, {}))[0]
    ok("Restored" in (reply or ""), "clarification answer restores", reply or "")

    section("I. clear handler arms server snapshot")
    reset_session(sid)
    before = sample_items()
    app._save_checklist_state_for_session(sid, before, completed_collapsed=False)
    ar = app._handle_checklist_action(
        sid,
        "erase the checklist",
        "checklist.clear_all",
        work_snapshot(before),
    )
    ok("Cleared the checklist" in (ar.get("spoken_reply") or ""), "clear ack")
    ok(sid in app.checklist_undo_snapshots, "server snapshot armed")
    ok(
        app._checklist_undo_snapshot_item_count(app.checklist_undo_snapshots.get(sid)) == 2,
        "server snapshot item count",
    )
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_checklist_undo_shortcut(sid, "undo that", work_snapshot([]))
    reply = (resolved or ("", 0.0, {}))[0]
    ok("Restored" in (reply or ""), "clear handler snapshot restores", reply or "")

    section("J. clear empty -> undo has nothing to restore")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    ar = app._handle_checklist_action(
        sid,
        "erase the checklist",
        "checklist.clear_all",
        work_snapshot([]),
    )
    ok("already empty" in (ar.get("spoken_reply") or "").lower(), "empty clear message")
    resolved = app.resolve_checklist_undo_shortcut(sid, "undo that", work_snapshot([]))
    reply = (resolved or ("", 0.0, {}))[0]
    ok(
        "don't have a recent checklist change" in (reply or "").lower(),
        "empty clear undo message",
        reply or "",
    )

    section("K. client snapshot hydrates after server save (sync-after-clear)")
    reset_session(sid)
    nested = nested_items()
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_checklist_undo_shortcut(
        sid,
        "undo that",
        work_snapshot([], undo_snapshot=client_undo_snapshot(nested)),
    )
    reply = (resolved or ("", 0.0, {}))[0]
    ok("Restored" in (reply or ""), "client snapshot survives empty server state", reply or "")

    section("L. play music -> checklist undo wins")
    reset_session(sid)
    app.set_recent_action_context(
        sid,
        "music.play_track",
        {"query": "lofi"},
        {"action_type": "music", "data": {}, "ui_payload": {"op": "play_track"}},
    )
    arm_snapshot(sid, items)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_checklist_undo_shortcut(
        sid, "undo that", work_snapshot([])
    )
    reply = (resolved or ("", 0.0, {}))[0]
    ok("Restored" in (reply or ""), "checklist restore beats music context", reply or "")

    section("M. resolve_reply_if_not_general_llm integration")
    reset_session(sid)
    arm_snapshot(sid, items)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    resolved = app.resolve_reply_if_not_general_llm(
        sid,
        "Can you undo that?",
        [],
        client_context_snapshot=work_snapshot([]),
    )
    ok(resolved is not None, "sync resolver returns early")
    reply = (resolved or ("", 0.0, None))[0]
    ok("Restored" in (reply or ""), "sync resolver restores checklist", reply or "")

    section("N. volume down recent -> undo blocked at execute")
    reset_session(sid)
    app.set_recent_action_context(
        sid,
        "music.volume_up",
        {},
        {"action_type": "music", "data": {}, "ui_payload": None},
    )
    ar, _ = app.execute_structured_action(
        sid,
        "undo that",
        {
            "is_action_request": True,
            "action_name": "music.volume_down",
            "slots": {},
            "needs_followup": False,
            "missing_slot": None,
        },
    )
    spoken = (ar or {}).get("spoken_reply") or ""
    ok(
        "turning the music down" not in spoken.lower(),
        "volume_down blocked for undo intent",
        spoken,
    )
    ok(
        "don't have a recent checklist change" in spoken.lower(),
        "volume_down returns no-recent-change",
        spoken,
    )

    print(f"\n{YELLOW}SUMMARY{RESET} PASS={PASS} FAIL={FAIL}")
    if FAILED:
        print(f"{RED}Failed:{RESET} " + ", ".join(FAILED))
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
