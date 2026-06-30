"""Smoke: timer + music + web-search multi-action compounds must not collapse to Work Mode.

Run:  py -3 tests/smoke/__multi_action_timer_music_search_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions import multi_action_planner as P  # noqa: E402

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"
PASS = 0
FAIL = 0


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        print(f"  {RED}FAIL{RESET}  {name}")
        if detail:
            print(f"         {detail[:500]}")


def plan(text: str) -> dict:
    return P.plan_user_actions(text)


def types(p: dict) -> list[str]:
    return [a["type"] for a in (p.get("actions") or [])]


def payload(p: dict, t: str) -> dict:
    for a in p.get("actions") or []:
        if a.get("type") == t:
            return a.get("payload") or {}
    return {}


print(f"\n{YELLOW}-- Multi-action timer + music + search compounds --{RESET}")

# 1 — timer + rain + web search
t1 = "Start a 5-minute timer, play rain sounds, and search for best webcams for Zoom."
p1 = plan(t1)
ok(P.should_trigger_planner(t1)[0], "A triggers planner")
ok(p1.get("is_multi_action"), "A is multi-action")
ok(types(p1) == ["timer.set", "music.play", "info.search"], "A action types", str(types(p1)))
ok(payload(p1, "timer.set").get("duration_seconds") == 300, "A timer 300s")
ok("rain" in (payload(p1, "music.play").get("query") or "").lower(), "A music rain query")
ok(
    payload(p1, "info.search").get("query") == "best webcams for Zoom",
    "A search query",
    str(payload(p1, "info.search")),
)
ok("reasoning.request" not in types(p1), "A no reasoning")

# 2 — timer + search
t2 = "Set a timer for 10 minutes and search for best laptops for students."
p2 = plan(t2)
ok(P.should_trigger_planner(t2)[0], "B triggers planner")
ok(types(p2) == ["timer.set", "info.search"], "B action types", str(types(p2)))
ok(payload(p2, "timer.set").get("duration_seconds") == 600, "B timer 600s")
ok(
    payload(p2, "info.search").get("query") == "best laptops for students",
    "B search query",
)
ok("reasoning.request" not in types(p2), "B no reasoning")

# 3 — music + search
t3 = "Play lofi and search for Python tutorials."
p3 = plan(t3)
ok(P.should_trigger_planner(t3)[0], "C triggers planner")
ok(p3.get("is_multi_action"), "C is multi-action")
ok(types(p3) == ["music.play", "info.search"], "C action types", str(types(p3)))
ok("lofi" in (payload(p3, "music.play").get("query") or "").lower(), "C music lofi")
ok(payload(p3, "info.search").get("query") == "Python tutorials", "C search query")

# 4 — pause music + explicit panel reasoning (regression)
t4 = "Pause music and explain Vietnam War in panel 3."
p4 = plan(t4)
ok(types(p4) == ["music.pause", "reasoning.request"], "D action types", str(types(p4)))
ok(payload(p4, "reasoning.request").get("panel_target") == 3, "D panel 3")

# 5 — explicit reasoning panel destination (single search → product anchor ok)
t5 = "Search for best webcams for Zoom in the reasoning panel."
trig5, _ = P.should_trigger_planner(t5)
p5 = plan(t5)
ok(not p5.get("is_multi_action"), "E single action")
ok(types(p5)[0] in ("info.search", "info.product"), "E search/product anchor", str(types(p5)))

print(f"\n{YELLOW}-- Summary: {PASS} passed, {FAIL} failed --{RESET}")
if FAIL:
    sys.exit(1)
