"""Smoke tests for checklist multi-action batch execution.

Run:
    py -3 -X utf8 tests\smoke\__checklist_multi_action_batch_smoke.py

Policy under test:
    In a multi-action checklist command, ordinal references are resolved
    against the original visible checklist at the start of the utterance.
    The actions then mutate one shared in-memory state sequentially and
    emit a single final full-state checklist payload.
"""

from __future__ import annotations

import io
import os
import sys
import types

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
from actions.checklist import apply_checklist_action, parse_checklist_command  # noqa: E402
from actions.multi_action_planner import plan_user_actions  # noqa: E402

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


def fixture() -> list[dict]:
    return [
        {"id": "a", "text": "fdsaf", "done": False, "parent_id": None},
        {"id": "b", "text": "fasdfdas", "done": False, "parent_id": None},
        {"id": "c", "text": "hi", "done": False, "parent_id": None},
    ]


def state(rows: list[dict]) -> list[tuple[str, bool]]:
    return [(str(r.get("text") or ""), bool(r.get("done"))) for r in rows]


def work_snapshot(items: list[dict]) -> dict:
    return {
        "mode": "work",
        "checklist": {
            "items": items,
            "ongoing_count": sum(1 for r in items if not bool(r.get("done"))),
            "completed_count": sum(1 for r in items if bool(r.get("done"))),
        },
    }


def run_batch(text: str, items: list[dict], sid: str = "__checklist_batch_smoke") -> tuple[str, dict]:
    try:
        app.anonymous_work_mode_checklists.pop(sid, None)
        app.checklist_undo_snapshots.pop(sid, None)
    except Exception:
        pass
    plan = plan_user_actions(text, vera=None)
    plan["_raw_user_text"] = text
    reply, _t, ar = app.execute_planned_actions(
        plan=plan,
        session_id=sid,
        history=[],
        client_context_snapshot=work_snapshot(items),
    )
    return reply, ar or {}


section("planner shape")

command = "can you remove the first item, mark the second item complete, and add hi to the checklist?"
plan = plan_user_actions(command, vera=None)
actions = plan.get("actions") or []
types_seen = [a.get("type") for a in actions]
ok(types_seen == ["checklist.remove", "checklist.complete", "checklist.add"], "planner action order", detail=str(types_seen))
ok((actions[0].get("payload") or {}).get("targets") == [{"ordinal": "first"}], "planner remove targets first")
ok((actions[1].get("payload") or {}).get("targets") == [{"ordinal": "second"}], "planner complete targets second")
ok((actions[2].get("payload") or {}).get("items") == ["hi"], "planner add item text hi")


section("batch exact command uses original-list indexing")

reply, ar = run_batch(command, fixture(), sid="__checklist_batch_exact")
payload = ar.get("ui_payload") or {}
final_items = payload.get("items") or []
expected = [("fasdfdas", True), ("hi", False), ("hi", False)]
ok(payload.get("payload_mode") == "full_state", "batch emits full_state payload", detail=str(payload))
ok(payload.get("op") == "checklist.batch", "batch emits checklist.batch op", detail=str(payload))
ok(state(final_items) == expected, "final state removes original #1 and completes original #2", detail=str(state(final_items)))
ok(
    reply == "Removed the first item, marked the second item complete, and added hi.",
    "confirmed response is based on execution results",
    detail=reply,
)
ok((ar.get("data") or {}).get("index_policy") == "original_visible_list", "documents original-list indexing policy")
ok((ar.get("data") or {}).get("verified_final_state") is True, "post-action readback verification succeeded")


section("single action synonyms still work")

rows = fixture()
parsed = parse_checklist_command(None, "delete the first item", "checklist.remove_item")
rows, reply_single, changed = apply_checklist_action(rows, "checklist.remove_item", parsed, vera=None, user_text="delete the first item")
ok(changed, "delete first item changed state")
ok(state(rows) == [("fasdfdas", False), ("hi", False)], "delete first item removes first row", detail=str(state(rows)))

rows = fixture()
parsed = parse_checklist_command(None, "mark the second item done", "checklist.complete_item")
rows, reply_single, changed = apply_checklist_action(rows, "checklist.complete_item", parsed, vera=None, user_text="mark the second item done")
ok(changed, "mark second item done changed state")
ok(state(rows) == [("fdsaf", False), ("fasdfdas", True), ("hi", False)], "mark second item done completes original second", detail=str(state(rows)))

rows = fixture()
parsed = parse_checklist_command(None, "add hi", "checklist.add_item")
rows, reply_single, changed = apply_checklist_action(rows, "checklist.add_item", parsed, vera=None, user_text="add hi")
ok(changed, "add hi changed state")
ok(state(rows)[-1] == ("hi", False), "add hi appends an incomplete hi item", detail=str(state(rows)))

parsed = parse_checklist_command(None, "add hi to the checklist", "checklist.add_item")
rows, reply_single, changed = apply_checklist_action(fixture(), "checklist.add_item", parsed, vera=None, user_text="add hi to the checklist")
ok(changed, "add hi to checklist changed state")
ok(state(rows)[-1] == ("hi", False), "add hi to checklist appends an incomplete hi item", detail=str(state(rows)))


section("combined remove + complete + add variants")

variant = "delete the first item, mark the second item done, and add hi to the checklist"
reply, ar = run_batch(variant, fixture(), sid="__checklist_batch_variant")
final_items = (ar.get("ui_payload") or {}).get("items") or []
ok(state(final_items) == expected, "variant final state matches exact command", detail=str(state(final_items)))
ok("Removed the first item" in reply and "marked the second item complete" in reply and "added hi" in reply, "variant response confirms all actual successes", detail=reply)


section("missing target partial success")

missing_cmd = "mark the fourth item done and add hi to the checklist"
reply, ar = run_batch(missing_cmd, fixture(), sid="__checklist_batch_missing")
final_items = (ar.get("ui_payload") or {}).get("items") or []
ok(state(final_items) == [("fdsaf", False), ("fasdfdas", False), ("hi", False), ("hi", False)], "missing complete does not mutate, add still succeeds", detail=str(state(final_items)))
ok("added hi" in reply.lower(), "partial response includes successful add", detail=reply)
ok("but" in reply.lower() and "could not find" in reply.lower(), "partial response mentions failed target", detail=reply)
results = (ar.get("data") or {}).get("results") or []
ok(any(r.get("type") == "checklist.complete" and not r.get("changed") for r in results), "result records failed complete action")
ok(any(r.get("type") == "checklist.add" and r.get("changed") for r in results), "result records successful add action")


print(f"\n{YELLOW}-- summary --{RESET}")
print(f"  passed: {PASS}")
print(f"  failed: {FAIL}")
if FAIL:
    print("  failures:")
    for name in FAILED:
        print(f"    - {name}")
sys.exit(0 if FAIL == 0 else 1)
