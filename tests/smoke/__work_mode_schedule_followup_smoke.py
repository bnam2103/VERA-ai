"""Smoke tests — Work Mode schedule/plan voice follow-ups vs venue misroute.

Run:
    py -3 tests/smoke/__work_mode_schedule_followup_smoke.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import app as app_mod

_pass = 0
_fail = 0


def ok(cond: bool, label: str, detail: str = "") -> None:
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  PASS  {label}")
    else:
        _fail += 1
        extra = f" — {detail}" if detail else ""
        print(f"  FAIL  {label}{extra}")


print("[schedule follow-up detector]")
for text, expected in [
    ("is gym at 9:20 too late?", True),
    ("what should I do next?", True),
    ("is this schedule realistic?", True),
    ("do I have enough time for dinner?", True),
    ("what is the capital of France?", False),
    ("play lofi", False),
    ("find gyms near me", False),
    ("coffee shops near me", False),
]:
    got = app_mod.looks_like_work_mode_schedule_followup(text)
    ok(got == expected, f"{text!r} -> {expected}", f"got {got}")

print("\n[classify_info_tool routing]")
c = app_mod.classify_info_tool("is gym at 9:20 too late?")
ok(c.get("route") == "llm_only", "gym+time advice -> llm_only", str(c))
ok(
    c.get("reason") == "work_mode_schedule_followup_not_venue_search",
    "reason=work_mode_schedule_followup_not_venue_search",
    str(c.get("reason")),
)

c2 = app_mod.classify_info_tool("find gyms near me")
ok(c2.get("route") != "llm_only" or "schedule" in str(c2.get("reason", "")), "find gyms near me not schedule followup", str(c2))

print("\n[unrelated question stays general]")
c3 = app_mod.classify_info_tool("what is the capital of France?")
ok(c3.get("route") in ("llm_only", "uncertain"), "France capital not venue search", str(c3.get("route")))

print(f"\nTotal: {_pass + _fail}  PASS={_pass}  FAIL={_fail}")
if _fail:
    sys.exit(1)
print("All work mode schedule follow-up smoke tests passed.")
