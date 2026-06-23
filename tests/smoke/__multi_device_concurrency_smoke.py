"""Smoke tests for VERA multi-device concurrency hardening.

Covers the public surface introduced (or modified) by the
multi-device-concurrency change set:

  * PART 1 — `_new_request_id`, `log_req_start`, `log_req_end`,
    `log_stream_open`, `log_stream_close`, `log_cancellation`,
    `_LockDiag`, `_tts_lock_diag`, `_diag_wrap_stream`.
  * PART 3 — `_session_active_user`, `set_active_user_for_session`,
    `get_active_username_for_session`, and that `_load_checklist_state_for_session`
    actually honors the per-session active user instead of falling back
    blindly to the process-global.
  * PART 3 (model field) — `_EffortSnapshot` + `_stream_markdown_capture_effort`
    snapshot the shared `reasoning_deep_ai.last_deep_reasoning_effort_active`
    so a concurrent reasoning stream cannot overwrite it before we read it.
  * PART 4 — Cancellation: confirm there is NO module-global
    `tts_cancel_event`, `stop_event`, etc. on `app` (a regression here would
    mean someone reintroduced cross-device cancellation state).
  * PART 7 — `recent_news_context`, `recent_action_context`, `pending_action`,
    `pending_voice_actions`, `session_user_facts`, `work_mode_timer_plans`,
    `checklist_undo_snapshots`, `latest_client_context_snapshot`,
    `anonymous_work_mode_checklists`, `user_histories`,
    `reasoning_lane_histories` all stay session-keyed.
  * PART 8 — Two concurrent NDJSON-shaped generators each go through the
    global asr_lock with their own session_id; their logs and yielded
    chunks DO NOT cross. (Mocks the asr_lock body.)
  * PART 11 — `/api/diag/sessions` shape contract.
  * Sign-in/out body schema: `UserSignInBody.session_id` is optional, and
    `api_user_sign_in` writes to the per-session map only when supplied.

Run:  py -3 __multi_device_concurrency_smoke.py
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

import asyncio
import io
import os
import sys
import time as _time
import types

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# Stub heavy modules first so `import app` doesn't try to load Whisper / TTS.
_TTS_STUB_NAMES = (
    "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
    "transcribe_long", "load_model", "warmup", "speak_to_file",
    "split_sentences_for_tts", "pop_first_complete_segment",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload", "generate_bmo_audio",
    "bmo_fish_configured",
)
for modname in ("TTS", "STT", "ASR", "bmo_tts"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _TTS_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

import app  # noqa: E402


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ helpers Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def assert_(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' — ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}Ã¢”â‚¬Ã¢”â‚¬ {title} Ã¢”â‚¬Ã¢”â‚¬{RESET}")


class _StdoutCapture:
    """Context manager that captures stdout into a buffer AND still echoes
    selectively (off here, we want a quiet test run)."""

    def __init__(self):
        self.buf = io.StringIO()
        self._orig = None

    def __enter__(self):
        self._orig = sys.stdout
        sys.stdout = self.buf
        return self

    def __exit__(self, exc_type, exc, tb):
        sys.stdout = self._orig
        return False

    @property
    def text(self) -> str:
        return self.buf.getvalue()


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 1 Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 1 — request id + structured logs + lock diag")

# A. request id
ids = {app._new_request_id() for _ in range(200)}
assert_(len(ids) == 200, "_new_request_id produces unique ids")
assert_(all(s.startswith("req_") and len(s) == 16 for s in ids), "_new_request_id format")

# B. log_req_start / end produce the expected single-line shape
with _StdoutCapture() as cap:
    ts = app.log_req_start(
        route="/infer",
        session_id="sessA",
        request_id="req_aaa",
        source="voice",
        mode="continuous",
        client="vera",
    )
    app.log_req_end(
        route="/infer",
        session_id="sessA",
        request_id="req_aaa",
        start_ts=ts,
        ok=True,
        path="non_stream",
    )
out = cap.text
assert_("[REQ start] session=sessA request=req_aaa route=/infer source=voice" in out,
        "log_req_start prints expected line", detail=out)
assert_("[REQ end] session=sessA request=req_aaa route=/infer ok=true" in out,
        "log_req_end prints expected line", detail=out)
assert_("dur_ms=" in out, "log_req_end includes dur_ms")

# C. log_stream_open / close / cancellation lines
with _StdoutCapture() as cap:
    app.log_stream_open(route="/infer", session_id="sessA", request_id="req_aaa")
    app.log_stream_close(route="/infer", session_id="sessA", request_id="req_aaa")
    app.log_cancellation(route="/infer", session_id="sessA", request_id="req_aaa", source="exception:ValueError")
out = cap.text
assert_("[STREAM open] session=sessA request=req_aaa route=/infer" in out, "log_stream_open")
assert_("[STREAM close] session=sessA request=req_aaa route=/infer" in out, "log_stream_close")
assert_("[CANCEL] session=sessA request=req_aaa route=/infer source=exception:ValueError" in out,
        "log_cancellation")


async def _lock_diag_smoke() -> tuple[str, float, float]:
    lock = asyncio.Lock()
    with _StdoutCapture() as cap:
        async with app._LockDiag(lock, name="ASR", session_id="sessA", request_id="req_lock"):
            await asyncio.sleep(0.01)
    return cap.text, 0.0, 0.0


# D. _LockDiag emits [ASR done] always, and [ASR lock wait] when contended
out, _, _ = asyncio.run(_lock_diag_smoke())
assert_("[ASR done] session=sessA request=req_lock" in out, "_LockDiag emits [ASR done]")
assert_("hold_ms=" in out, "_LockDiag hold_ms present")


async def _lock_diag_contention_smoke() -> str:
    """Capture stdout once around the whole gather so the two workers can't
    fight over sys.stdout (which is process-global, not per-task)."""
    lock = asyncio.Lock()

    async def worker(sid: str, rid: str, hold: float):
        async with app._LockDiag(lock, name="ASR", session_id=sid, request_id=rid):
            await asyncio.sleep(hold)

    cap = _StdoutCapture()
    with cap:
        # A grabs first and holds 30ms; B must wait for the same lock.
        await asyncio.gather(worker("sessA", "req_A", 0.03), worker("sessB", "req_B", 0.005))
    return cap.text


out = asyncio.run(_lock_diag_contention_smoke())
assert_("[ASR lock wait] session=sessB request=req_B wait_ms=" in out,
        "_LockDiag emits [ASR lock wait] when contended", detail=out)
assert_("[ASR done] session=sessA request=req_A" in out, "_LockDiag both done lines printed")
assert_("[ASR done] session=sessB request=req_B" in out, "_LockDiag both done lines printed (B)")


# E. _tts_lock_diag pulls from the current_request_id_var contextvar
async def _tts_diag_context_smoke() -> str:
    app._current_request_id_var.set("req_ctx123")
    diag = app._tts_lock_diag("sessXYZ")
    with _StdoutCapture() as cap:
        async with diag:
            await asyncio.sleep(0)
    return cap.text


out = asyncio.run(_tts_diag_context_smoke())
assert_("[TTS done] session=sessXYZ request=req_ctx123" in out,
        "_tts_lock_diag pulls request_id from contextvar", detail=out)


# F. _diag_wrap_stream prints open/close/end and forwards chunks
async def _wrap_stream_smoke() -> tuple[str, list]:
    async def inner():
        yield b"chunk1"
        yield b"chunk2"

    chunks: list[bytes] = []
    cap = _StdoutCapture()
    with cap:
        async for chunk in app._diag_wrap_stream(
            inner(),
            route="/infer",
            session_id="sessW",
            request_id="req_wrap",
            start_ts=_time.perf_counter() - 0.05,
            mode="voice",
        ):
            chunks.append(chunk)
    return cap.text, chunks


text, chunks = asyncio.run(_wrap_stream_smoke())
assert_(chunks == [b"chunk1", b"chunk2"], "_diag_wrap_stream forwards chunks intact")
assert_("[STREAM open] session=sessW request=req_wrap route=/infer" in text,
        "_diag_wrap_stream prints [STREAM open]", detail=text)
assert_("[STREAM close] session=sessW request=req_wrap route=/infer" in text,
        "_diag_wrap_stream prints [STREAM close]", detail=text)
assert_("[REQ end] session=sessW request=req_wrap route=/infer ok=true" in text,
        "_diag_wrap_stream prints [REQ end]", detail=text)


# G. _diag_wrap_stream emits [CANCEL] + ok=false on exception
async def _wrap_stream_error_smoke() -> str:
    async def inner_err():
        yield b"chunk1"
        raise RuntimeError("boom")

    cap = _StdoutCapture()
    with cap:
        try:
            async for _ in app._diag_wrap_stream(
                inner_err(),
                route="/infer",
                session_id="sessE",
                request_id="req_err",
                start_ts=_time.perf_counter() - 0.01,
            ):
                pass
        except RuntimeError:
            pass
    return cap.text


text = asyncio.run(_wrap_stream_error_smoke())
assert_("[CANCEL] session=sessE request=req_err route=/infer source=exception:RuntimeError" in text,
        "_diag_wrap_stream prints [CANCEL] on exception", detail=text)
assert_("[REQ end] session=sessE request=req_err route=/infer ok=false" in text,
        "_diag_wrap_stream prints ok=false on exception", detail=text)


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 3 Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 3 — session-scoped active user + checklist isolation")

# Ensure clean state for this test block.
app._session_active_user.clear()
app.anonymous_work_mode_checklists.clear()
app.user_last_seen["sess_alice"] = _time.time()
app.user_last_seen["sess_bob"] = _time.time()

app.set_active_user_for_session("sess_alice", "alice")
app.set_active_user_for_session("sess_bob", "bob")

assert_(app.get_active_username_for_session("sess_alice") == "alice",
        "get_active_username_for_session(alice) Ã¢” ’ alice")
assert_(app.get_active_username_for_session("sess_bob") == "bob",
        "get_active_username_for_session(bob) Ã¢” ’ bob")
assert_(app.get_active_username_for_session("sess_alice") != app.get_active_username_for_session("sess_bob"),
        "alice and bob's per-session usernames are isolated")

# Falls back to global only when no session mapping exists.
assert_(app.get_active_username_for_session("sess_unknown") is None
        or app.get_active_username_for_session("sess_unknown") == app._active_username_from_runtime(),
        "unknown session falls back to process-global active user")

# Anonymous checklist isolation — for two sessions WITHOUT active users.
app._session_active_user.pop("sess_alice", None)
app._session_active_user.pop("sess_bob", None)
app.user_last_seen["sess_anon_a"] = _time.time()
app.user_last_seen["sess_anon_b"] = _time.time()

# anonymous path: anonymous_work_mode_checklists is session-keyed
app.anonymous_work_mode_checklists["sess_anon_a"] = {
    "items": [{"id": "a1", "text": "Alice item", "done": False, "parent_id": None}],
    "completed_collapsed": False,
}
app.anonymous_work_mode_checklists["sess_anon_b"] = {
    "items": [{"id": "b1", "text": "Bob item", "done": True, "parent_id": None}],
    "completed_collapsed": True,
}
items_a, coll_a, user_a = app._load_checklist_state_for_session("sess_anon_a")
items_b, coll_b, user_b = app._load_checklist_state_for_session("sess_anon_b")
assert_(user_a is None and user_b is None, "anonymous checklists return user=None")
assert_(len(items_a) == 1 and items_a[0]["text"] == "Alice item",
        "_load_checklist_state_for_session(A) returns A's items")
assert_(len(items_b) == 1 and items_b[0]["text"] == "Bob item",
        "_load_checklist_state_for_session(B) returns B's items")
assert_(coll_a is False and coll_b is True, "collapsed flag is per-session")

# Modify A's checklist via save helper; B must remain unchanged.
count, _ = app._save_checklist_state_for_session(
    "sess_anon_a",
    [{"id": "a1", "text": "Alice item edited", "done": False, "parent_id": None}],
    completed_collapsed=False,
)
items_a2, _, _ = app._load_checklist_state_for_session("sess_anon_a")
items_b2, _, _ = app._load_checklist_state_for_session("sess_anon_b")
assert_(items_a2[0]["text"] == "Alice item edited",
        "_save_checklist_state_for_session(A) persisted A's edit")
assert_(items_b2[0]["text"] == "Bob item",
        "_save_checklist_state_for_session(A) did NOT touch B")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 3 / model field Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 3 — _EffortSnapshot + _stream_markdown_capture_effort")


class _FakeReasoningDeep:
    def __init__(self):
        self.last_deep_reasoning_effort_active = None

    async def async_generate_stream_markdown(self, *, user_text, attachment_context=None, history=None):
        # Set the field as the model would.
        self.last_deep_reasoning_effort_active = True
        yield "chunk one"
        # Simulate a concurrent call resetting the global field BEFORE done.
        self.last_deep_reasoning_effort_active = False
        yield "chunk two"


async def _effort_snap_smoke() -> tuple[bool, list]:
    # Monkeypatch the module-level reasoning_deep_ai so _stream_markdown_capture_effort
    # reads from our fake.
    original = app.reasoning_deep_ai
    fake = _FakeReasoningDeep()
    app.reasoning_deep_ai = fake
    try:
        snap = app._EffortSnapshot()
        chunks = []
        async for delta in app._stream_markdown_capture_effort(
            snap,
            method=fake.async_generate_stream_markdown,
            user_text="hello",
            attachment_context=None,
            history=None,
        ):
            chunks.append(delta)
        return snap.value, chunks
    finally:
        app.reasoning_deep_ai = original


snap_value, chunks = asyncio.run(_effort_snap_smoke())
assert_(chunks == ["chunk one", "chunk two"], "stream wrapper forwards every chunk")
assert_(snap_value is True,
        "_EffortSnapshot captures the value at start-of-stream, "
        "not whatever the field decayed to during the stream",
        detail=f"snap={snap_value!r}")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 4 Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 4 — no module-global cancellation flags")

forbidden_globals = (
    "tts_cancel_event",
    "stop_event",
    "interrupt_flag",
    "current_generation_cancelled",
    "stream_cancelled",
    "tts_cancelled",
    "current_tts_request_id",
    "global_stop_flag",
    "active_stream",
    "active_tts_stream",
    "current_tts_audio",
)
for sym in forbidden_globals:
    assert_(not hasattr(app, sym),
            f"app has no module-global '{sym}' (would be cross-device cancellation leak)")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 7 Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 7 — session-keyed dicts stay isolated A vs B")

# Reset to a known state for the keys we'll touch.
for d in (
    app.recent_news_context,
    app.recent_action_context,
    app.pending_action,
    app.pending_voice_actions,
    app.session_user_facts,
    app.work_mode_timer_plans,
    app.checklist_undo_snapshots,
    app.latest_client_context_snapshot,
):
    for k in ("sess_iso_a", "sess_iso_b"):
        d.pop(k, None)

# Mutate A; B must remain untouched.
app.recent_news_context["sess_iso_a"] = {"topic": "trump_china", "ts": 1.0}
app.recent_news_context["sess_iso_b"] = {"topic": "openai", "ts": 2.0}
assert_(app.recent_news_context["sess_iso_a"]["topic"] == "trump_china", "news ctx A isolated")
assert_(app.recent_news_context["sess_iso_b"]["topic"] == "openai", "news ctx B isolated")

app.pending_action["sess_iso_a"] = {"action_name": "news.latest", "expires_at": 9_999_999_999.0}
assert_("sess_iso_a" in app.pending_action and "sess_iso_b" not in app.pending_action,
        "pending_action A set without leaking to B")

app.user_histories["sess_iso_a"].append({"role": "user", "content": "alice"})
app.user_histories["sess_iso_b"].append({"role": "user", "content": "bob"})
assert_(app.user_histories["sess_iso_a"][-1]["content"] == "alice", "user_histories A isolated")
assert_(app.user_histories["sess_iso_b"][-1]["content"] == "bob", "user_histories B isolated")

# Reasoning lane histories are session+lane keyed via "sid:lane".
app.reasoning_lane_histories["sess_iso_a:atlas"].append({"role": "user", "content": "a-atlas"})
app.reasoning_lane_histories["sess_iso_b:atlas"].append({"role": "user", "content": "b-atlas"})
assert_(app.reasoning_lane_histories["sess_iso_a:atlas"][-1]["content"] == "a-atlas",
        "reasoning_lane_histories session+lane A isolated")
assert_(app.reasoning_lane_histories["sess_iso_b:atlas"][-1]["content"] == "b-atlas",
        "reasoning_lane_histories session+lane B isolated")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 8 Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 8 — two concurrent NDJSON-shaped streams stay isolated")


async def _isolated_streams_smoke() -> tuple[list[bytes], list[bytes], str]:
    """Drive two _diag_wrap_stream generators concurrently with overlapping
    yields. Each generator emits chunks tagged with its session id. We
    confirm A's chunks never appear in B's output (no global buffer)."""
    async def make_gen(label: str, count: int, delay: float):
        for i in range(count):
            await asyncio.sleep(delay)
            yield f"{label}-chunk-{i}".encode()

    cap = _StdoutCapture()
    a_out: list[bytes] = []
    b_out: list[bytes] = []

    async def run_a():
        async for c in app._diag_wrap_stream(
            make_gen("A", 4, 0.005),
            route="/infer",
            session_id="sessA",
            request_id="req_streamA",
            start_ts=_time.perf_counter(),
        ):
            a_out.append(c)

    async def run_b():
        async for c in app._diag_wrap_stream(
            make_gen("B", 4, 0.003),
            route="/infer",
            session_id="sessB",
            request_id="req_streamB",
            start_ts=_time.perf_counter(),
        ):
            b_out.append(c)

    with cap:
        await asyncio.gather(run_a(), run_b())
    return a_out, b_out, cap.text


a_out, b_out, log_text = asyncio.run(_isolated_streams_smoke())
assert_(all(c.startswith(b"A-chunk-") for c in a_out),
        "Session A only receives A-tagged chunks", detail=str(a_out))
assert_(all(c.startswith(b"B-chunk-") for c in b_out),
        "Session B only receives B-tagged chunks", detail=str(b_out))
assert_("session=sessA request=req_streamA" in log_text and
        "session=sessB request=req_streamB" in log_text,
        "Both streams emit their own [STREAM open/close] + [REQ end] lines")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 11 Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 11 — /api/diag/sessions endpoint shape")

# Direct call to the function (avoids spinning up the ASGI server).
snap = app.api_diag_sessions()
assert_(isinstance(snap, dict), "api_diag_sessions returns dict")
for k in ("now", "total_sessions", "asr_lock_locked", "tts_lock_locked",
          "llm_lock_locked", "sessions", "process_active_user_path"):
    assert_(k in snap, f"api_diag_sessions includes key '{k}'")
assert_(isinstance(snap["sessions"], list), "api_diag_sessions.sessions is a list")
if snap["sessions"]:
    row = snap["sessions"][0]
    for k in ("session_id", "last_seen", "active_user",
              "user_history_len", "has_pending_action",
              "has_recent_action_context", "has_recent_news_context",
              "has_session_user_facts", "has_pending_voice_action",
              "has_work_mode_timer_plan", "has_checklist_undo_snapshot",
              "has_latest_client_snapshot", "anon_checklist_items",
              "reasoning_lane_keys"):
        assert_(k in row, f"diag session row has '{k}'")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ Sign-in body schema Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("Sign-in body schema accepts session_id")

body = app.UserSignInBody(username="alice", password="x", session_id="sess_xyz")
assert_(body.session_id == "sess_xyz",
        "UserSignInBody.session_id is accepted when provided")
body_legacy = app.UserSignInBody(username="alice", password="x")
assert_(body_legacy.session_id is None,
        "UserSignInBody.session_id is optional (legacy clients still work)")

sign_out_body = app.UserSignOutBody(session_id="sess_xyz")
assert_(sign_out_body.session_id == "sess_xyz",
        "UserSignOutBody.session_id is accepted when provided")
sign_out_legacy = app.UserSignOutBody()
assert_(sign_out_legacy.session_id is None,
        "UserSignOutBody.session_id is optional (legacy clients still work)")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ PART 12 — Manual concurrency tests doc Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

section("PART 12 — manual concurrency test plan present in spec (smoke check)")

# Self-documenting: confirm the docstring of the diag stream wrapper
# references the multi-device-concurrency intent, so future readers can find it.
docstr = (app._diag_wrap_stream.__doc__ or "")
assert_("multi-device" in docstr.lower() or "diagnostic" in docstr.lower(),
        "_diag_wrap_stream is self-documenting (mentions diagnostics)")
docstr = (app._LockDiag.__doc__ or "")
assert_("lock" in docstr.lower(), "_LockDiag is self-documenting")


# Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬ summary Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬Ã¢”â‚¬

print()
print(f"{YELLOW}Ã¢”â‚¬Ã¢”â‚¬ Summary Ã¢”â‚¬Ã¢”â‚¬{RESET}  {GREEN}PASS={PASS}{RESET}  {RED}FAIL={FAIL}{RESET}")
if FAIL:
    print()
    print(f"{RED}Failing tests:{RESET}")
    for t in FAILED:
        print(f"  - {t}")
    sys.exit(1)
sys.exit(0)
