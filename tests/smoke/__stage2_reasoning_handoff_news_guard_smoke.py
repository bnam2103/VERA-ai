"""Smoke: stage-2 reasoning handoff must not leak stale news into Voice UI.

Run:  py -3 tests/smoke/__stage2_reasoning_handoff_news_guard_smoke.py
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

HANDOFF = (
    "Can you help me write that in the reasoning space? Location was on the highway CA-73."
)
NEWS_FOLLOWUP = "What else happened with that On The Border story?"
TICKET_PRIOR = (
    "I just got a ticket for speeding from a police officer. I feel like it was unfair "
    "and I'm thinking of filing a complaint."
)


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


section("reasoning handoff detection")

ok(app._is_work_mode_reasoning_handoff_request(HANDOFF), "complaint handoff detected")
ok(
    app._is_strong_new_topic_message(HANDOFF)["detected"],
    "handoff is strong new topic",
    detail=str(app._is_strong_new_topic_message(HANDOFF)),
)
ok(not app._is_work_mode_reasoning_handoff_request(TICKET_PRIOR), "ticket narrative alone is not panel handoff")
ok(not app._is_work_mode_reasoning_handoff_request("location was CA-73"), "location-only is not panel handoff")

section("route_action_request — no news.latest on handoff")

sid = "smoke-stage2-handoff"
app.recent_news_context[sid] = {
    "topic": "On The Border restaurant closures",
    "entities": ["On The Border", "California"],
    "result_titles": ["Patch reported On The Border closing locations"],
    "result_sources": ["Patch"],
}
route = app.route_action_request(sid, HANDOFF)
ok(not route.get("is_action_request"), "handoff is not an action request", detail=str(route))
ok(route.get("action_name") in ("", None), "handoff has no action_name", detail=str(route.get("action_name")))

section("real news follow-up not misclassified as reasoning handoff")

ok(not app._is_work_mode_reasoning_handoff_request(NEWS_FOLLOWUP), "news follow-up is not a panel handoff")
ok(
    app._classify_news_followup_type(
        NEWS_FOLLOWUP,
        {
            "topic": "On The Border restaurant closures",
            "entities": ["On The Border"],
            "result_titles": ["Patch reported closures"],
        },
    ).get("strategy")
    in {"answer_from_context", "search_again"},
    "news follow-up still classifies as news strategy",
)

section("resolve_reply_if_not_general_llm — handoff returns None")

sid3 = "smoke-stage2-process"
app.recent_news_context[sid3] = {
    "topic": "On The Border restaurant closures",
    "entities": ["On The Border", "California"],
}
app.user_histories[sid3] = [
    {"role": "user", "content": "news about On The Border"},
    {"role": "assistant", "content": "Patch reported closures in California."},
]
resolved = app.resolve_reply_if_not_general_llm(sid3, HANDOFF, app.user_histories[sid3])
ok(resolved is None, "resolve returns None for reasoning handoff (no news action)")

print(f"\n{YELLOW}Summary:{RESET} {PASS} passed, {FAIL} failed")
if FAILED:
    print(f"{RED}Failed:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
print(f"{GREEN}All tests passed.{RESET}")
