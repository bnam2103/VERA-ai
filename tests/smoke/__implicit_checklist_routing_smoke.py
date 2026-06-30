"""Implicit checklist routing smoke tests."""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions.checklist import is_checklist_action_request  # noqa: E402
from actions.multi_action_planner import plan_user_actions, should_trigger_planner  # noqa: E402


def _types(plan: dict) -> list[str]:
    return [a.get("type") or "" for a in plan.get("actions") or []]


def main() -> int:
    fail = 0

    text = "can you add stat homework and mark milk and eggs complete?"
    triggered, reason = should_trigger_planner(text)
    plan = plan_user_actions(text)
    types = _types(plan)
    if not triggered:
        print("FAIL should_trigger_planner")
        fail += 1
    else:
        print(f"PASS should_trigger_planner reason={reason}")
    if types != ["checklist.add", "checklist.complete"]:
        print(f"FAIL plan types={types}")
        fail += 1
    else:
        print("PASS plan types checklist.add + checklist.complete")
    if is_checklist_action_request(text) is None:
        print("FAIL is_checklist_action_request")
        fail += 1
    else:
        print("PASS is_checklist_action_request")

    explicit = text + " in the checklist"
    if _types(plan_user_actions(explicit)) != ["checklist.add", "checklist.complete"]:
        print("FAIL explicit checklist plan")
        fail += 1
    else:
        print("PASS explicit checklist plan")

    negatives = [
        "add 3 minutes to the timer",
        "remove panel 4",
        "add more detail to the explanation",
        "add evidence to my essay in panel 3",
        "complete this explanation",
    ]
    for neg in negatives:
        if is_checklist_action_request(neg) is not None:
            print(f"FAIL negative routed to checklist: {neg!r}")
            fail += 1
        else:
            print(f"PASS negative blocked: {neg!r}")

    print(f"\nFAIL={fail}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
