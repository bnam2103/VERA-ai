"""Smoke for Voice UI → Reasoning Panel context handoff (Phase 1, 2026-06-15).

Tests server-side enrichment helpers and policy-shaped scenarios for Cases A–C.
Frontend policy lives in app.js (buildVoiceToPanelContextPacket / shouldInclude…).

Run:  py -3 tests/smoke/__voice_to_panel_context_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import app  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


def ok(cond: bool, name: str, *, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}")
        if detail:
            print(f"         {detail[:600]}")


def _reset_session(sid: str) -> None:
    app.user_histories[sid] = []
    app.recent_action_context.pop(sid, None)


section("server helpers — action reference detection")

ok(
    app._voice_to_panel_task_references_recent_action(
        "explain why that worked",
        {"deictic_detected": True, "inclusion_reasons": ["deictic_reference"]},
    ),
    "deictic packet triggers action/history enrichment path",
)
ok(
    not app._voice_to_panel_task_references_recent_action(
        "write a generic essay about tennis",
        {"deictic_detected": False, "inclusion_reasons": ["new_panel_from_voice"]},
    ),
    "unrelated deliverable without deictic does not force action summary",
)
ok(
    app._voice_to_panel_task_references_recent_action(
        "Open panel 1 and explain why that worked",
        None,
    ),
    "task text alone can reference recent action outcome",
)

section("Case A — RunPod deployment plan (server history fallback)")

sid_a = "smoke-vtp-case-a"
_reset_session(sid_a)
app.user_histories[sid_a] = [
    {"role": "user", "content": "I'm Dockerizing Vera for RunPod."},
    {"role": "assistant", "content": "Got it — RunPod Docker deployment."},
]
packet_a = {
    "source": "voice_ui",
    "original_user_text": "Open a reasoning panel and help me write the deployment plan",
    "cleaned_panel_task": "help me write the deployment plan",
    "topic_anchor": "I'm Dockerizing Vera for RunPod.",
    "recent_voice_turns": [],
    "inclusion_reasons": ["new_panel_from_voice"],
    "deictic_detected": False,
}
enrich_a = app._build_voice_session_context_for_panel(
    sid_a, "help me write the deployment plan", packet_a
)
ok("RunPod" in enrich_a or "Dockerizing" in enrich_a,
   "Case A server enrichment includes prior RunPod/Docker voice turn",
   detail=enrich_a)

section("Case B — debug that (server fallback when client turns sparse)")

sid_b = "smoke-vtp-case-b"
_reset_session(sid_b)
app.user_histories[sid_b] = [
    {"role": "user", "content": "Normalization might be causing routing issues."},
    {"role": "assistant", "content": "That could affect routing."},
]
packet_b = {
    "resolved_referent": "Normalization might be causing routing issues.",
    "cleaned_panel_task": "Debug that in panel 1",
    "recent_voice_turns": [],
    "inclusion_reasons": ["deictic_reference"],
    "deictic_detected": True,
}
enrich_b = app._build_voice_session_context_for_panel(sid_b, "Debug that in panel 1", packet_b)
ok(
    "normalization" in enrich_b.lower() or "routing" in enrich_b.lower(),
    "Case B server enrichment retains normalization/routing topic when client turns empty",
    detail=enrich_b,
)

section("Case C — music action context")

sid_c = "smoke-vtp-case-c"
_reset_session(sid_c)
app.set_recent_action_context(
    sid_c,
    "music.play_track",
    {"query": "Feather by Sabrina Carpenter"},
    {
        "spoken_reply": "Playing Feathered Indians by Tyler Childers.",
        "action_type": "music",
        "ui_payload": {"panel_type": "music_control", "op": "play_track"},
    },
)
packet_c = {
    "cleaned_panel_task": "explain why that worked",
    "inclusion_reasons": ["deictic_reference", "recent_action_reference"],
    "deictic_detected": True,
}
enrich_c = app._build_voice_session_context_for_panel(sid_c, "explain why that worked", packet_c)
ok("music.play_track" in enrich_c, "Case C includes action_name", detail=enrich_c)
ok("Feather" in enrich_c or "Feathered" in enrich_c,
   "Case C includes music query or spoken reply", detail=enrich_c)

section("regression — no client packet means no server enrichment")

sid_r = "smoke-vtp-regression"
_reset_session(sid_r)
app.user_histories[sid_r] = [{"role": "user", "content": "Old unrelated voice topic about cats."}]
ok(
    app._build_voice_session_context_for_panel(sid_r, "make section 2 shorter", None) == "",
    "no client packet → no server enrichment (panel-local path)",
)
ok(
    app._build_voice_session_context_for_panel(sid_r, "make section 2 shorter", {}) == "",
    "empty client packet → no server enrichment",
)

section("merge — enrichment appended to lane client context")

merged = app._merge_voice_session_context_into_attachment(
    "ACTIVE_LANE_PRIOR_CONTEXT:\nPanel markdown here.",
    "Recent action result: action=music.pause",
)
ok(
    merged is not None
    and "SERVER_VOICE_SESSION_ENRICHMENT" in merged
    and "ACTIVE_LANE_PRIOR_CONTEXT" in merged,
    "merge preserves lane context and adds server enrichment block",
    detail=str(merged)[:300],
)

section("caps — voice history tail obeys pair limit")

sid_cap = "smoke-vtp-cap"
_reset_session(sid_cap)
for i in range(10):
    app.user_histories[sid_cap].append({"role": "user", "content": f"user turn {i}"})
    app.user_histories[sid_cap].append({"role": "assistant", "content": f"assistant turn {i}"})
tail = app._voice_histories_tail_for_panel(sid_cap, max_pairs=3)
ok(len(tail) <= 6, f"history tail capped at 3 pairs (got {len(tail)} messages)")

print(f"\n{PASS} passed, {FAIL} failed")
if FAIL:
    print("Failures: " + ", ".join(FAILED))
    raise SystemExit(1)
raise SystemExit(0)
