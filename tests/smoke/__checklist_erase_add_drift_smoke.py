"""Smoke: UI/voice erase then add must not duplicate from stale server checklist.

Run:
    py -3 -X utf8 tests\\smoke\\__checklist_erase_add_drift_smoke.py
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
        {"id": "a", "text": "hello", "done": False, "parent_id": None},
        {"id": "b", "text": "world", "done": False, "parent_id": None},
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
    ]


def client_undo(items: list[dict]) -> dict:
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


def reset_session(sid: str) -> None:
    app.checklist_undo_snapshots.pop(sid, None)
    app.pending_checklist_undo_context.pop(sid, None)
    app.anonymous_work_mode_checklists.pop(sid, None)


def titles(items: list[dict]) -> list[str]:
    return [str((r or {}).get("text") or "") for r in items if str((r or {}).get("text") or "").strip()]


def add_hello(sid: str, snap: dict) -> list[str]:
    ar = app._handle_checklist_action(
        sid,
        "add hello to the checklist",
        "checklist.add_item",
        snap,
    )
    payload = (ar or {}).get("ui_payload") or {}
    return titles(payload.get("items") or [])


def clear_by_voice(sid: str, snap: dict) -> tuple[str, list[str]]:
    ar = app._handle_checklist_action(
        sid,
        "erase the checklist",
        "checklist.clear_all",
        snap,
    )
    payload = (ar or {}).get("ui_payload") or {}
    return str((ar or {}).get("spoken_reply") or ""), titles(payload.get("items") or [])


def main() -> int:
    sid = "erase-add-drift-smoke"

    section("1 — empty checklist → add hello")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    got = add_hello(sid, work_snapshot([]))
    ok(got == ["hello"], f"exactly one hello: {got!r}")

    section("2 — non-empty → client empty + undo → add hello (UI erase drift guard)")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, sample_items(), completed_collapsed=False)
    undo = client_undo(sample_items())
    got = add_hello(sid, work_snapshot([], undo_snapshot=undo))
    ok(got == ["hello"], f"one hello after UI-style clear: {got!r}", str(got))

    section("3 — non-empty → voice clear → add hello")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, sample_items(), completed_collapsed=False)
    clear_ar = app._handle_checklist_action(
        sid,
        "clear the checklist",
        "checklist.clear_all",
        work_snapshot(sample_items()),
    )
    ok((clear_ar.get("ui_payload") or {}).get("items") == [], "voice clear empties server")
    got = add_hello(sid, work_snapshot([]))
    ok(got == ["hello"], f"one hello after voice clear: {got!r}", str(got))

    section("4 — UI erase PUT → add hello → erase → add hello")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, sample_items(), completed_collapsed=False)
    app.api_work_mode_checklist_put(
        app.WorkChecklistSaveBody(session_id=sid, items=[], completed_collapsed=False)
    )
    got1 = add_hello(sid, work_snapshot([]))
    app.api_work_mode_checklist_put(
        app.WorkChecklistSaveBody(session_id=sid, items=[], completed_collapsed=False)
    )
    got2 = add_hello(sid, work_snapshot([]))
    ok(got1 == ["hello"], f"first add: {got1!r}")
    ok(got2 == ["hello"], f"second add after re-erase: {got2!r}", str(got2))

    section("5 — nested checklist → client empty + undo → add hello")
    reset_session(sid)
    nested = nested_items()
    app._save_checklist_state_for_session(sid, nested, completed_collapsed=False)
    got = add_hello(sid, work_snapshot([], undo_snapshot=client_undo(nested)))
    ok(got == ["hello"], f"only hello after nested clear: {got!r}", str(got))

    section("6 — UI erase → undo restores previous checklist")
    reset_session(sid)
    before = sample_items()
    app._save_checklist_state_for_session(sid, before, completed_collapsed=False)
    app.api_work_mode_checklist_put(
        app.WorkChecklistSaveBody(session_id=sid, items=[], completed_collapsed=False)
    )
    app.checklist_undo_snapshots[sid] = {
        "snapshot_id": "ui-snap",
        "items": [dict(r) for r in before],
        "completed_collapsed": False,
        "created_at": time(),
        "source": "checklist.clear",
        "valid": True,
    }
    undo_ar = app._handle_checklist_action(
        sid,
        "undo that",
        "checklist.undo_clear",
        work_snapshot([]),
    )
    restored = titles((undo_ar.get("ui_payload") or {}).get("items") or [])
    ok(len(restored) == 2, f"undo restores two items: {restored!r}")

    section("7 — UI erase → add hello → undo restores empty (clear superseded)")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, before, completed_collapsed=False)
    app.api_work_mode_checklist_put(
        app.WorkChecklistSaveBody(session_id=sid, items=[], completed_collapsed=False)
    )
    app.checklist_undo_snapshots[sid] = {
        "snapshot_id": "ui-snap-old",
        "items": [dict(r) for r in before],
        "completed_collapsed": False,
        "created_at": time(),
        "source": "checklist.clear",
        "valid": True,
    }
    got = add_hello(sid, work_snapshot([]))
    ok(got == ["hello"], f"add after clear: {got!r}")
    undo_ar2 = app._handle_checklist_action(
        sid,
        "undo that",
        "checklist.undo_clear",
        work_snapshot([{"id": "h", "text": "hello", "done": False, "parent_id": None}]),
    )
    restored2 = titles((undo_ar2.get("ui_payload") or {}).get("items") or [])
    ok(restored2 == [], f"undo after add restores empty not old checklist: {restored2!r}", str(restored2))

    section("8 — server empty, client visible items, voice erase")
    reset_session(sid)
    client_items = sample_items()
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    reply, after = clear_by_voice(sid, work_snapshot(client_items))
    ok("already empty" not in reply.lower(), f"does not say already empty: {reply!r}")
    ok("Cleared" in reply, f"clears visible client checklist: {reply!r}")
    ok(after == [], f"result empty: {after!r}")

    section("9 — server and client both have items, voice erase")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, sample_items(), completed_collapsed=False)
    reply, after = clear_by_voice(sid, work_snapshot(sample_items()))
    ok("Cleared" in reply, f"clears when server has items: {reply!r}")
    ok(after == [], f"result empty: {after!r}")

    section("10 — server has items, client empty snapshot, voice erase")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, sample_items(), completed_collapsed=False)
    reply, after = clear_by_voice(sid, work_snapshot([]))
    ok("Cleared" in reply, f"clears stale server rows: {reply!r}")
    ok(after == [], f"result empty: {after!r}")

    section("11 — server empty, client empty, voice erase")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    reply, after = clear_by_voice(sid, work_snapshot([]))
    ok("already empty" in reply.lower(), f"already empty when both empty: {reply!r}")
    ok(after == [], f"still empty: {after!r}")

    section("12 — UI erase PUT → add hello → voice erase")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, sample_items(), completed_collapsed=False)
    app.api_work_mode_checklist_put(
        app.WorkChecklistSaveBody(session_id=sid, items=[], completed_collapsed=False)
    )
    got = add_hello(sid, work_snapshot([]))
    ok(got == ["hello"], f"add after UI erase: {got!r}")
    reply, after = clear_by_voice(
        sid, work_snapshot([{"id": "h", "text": "hello", "done": False, "parent_id": None}])
    )
    ok("Cleared" in reply, f"voice erase after add: {reply!r}")
    ok(after == [], f"hello erased: {after!r}")

    section("13 — add hello → voice erase")
    reset_session(sid)
    app._save_checklist_state_for_session(sid, [], completed_collapsed=False)
    got = add_hello(sid, work_snapshot([]))
    ok(got == ["hello"], f"add hello: {got!r}")
    reply, after = clear_by_voice(
        sid, work_snapshot([{"id": "h", "text": "hello", "done": False, "parent_id": None}])
    )
    ok("Cleared" in reply, f"erase after add: {reply!r}")
    ok(after == [], f"hello erased: {after!r}")

    print(f"\n{PASS} passed, {FAIL} failed")
    if FAILED:
        print("Failed:", ", ".join(FAILED))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
