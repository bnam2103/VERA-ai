"""Smoke for the 2026-06-02 panel-targeted reasoning patch.

The spec: when a user pairs an explanation/reasoning request with an
explicit panel target, the planner must produce a
``reasoning.request`` action with that panel as the target — never a
plain ``voice.answer``. Single explanations without a panel target keep
the legacy voice route.

Covers:
  * All 5 acceptance utterances.
  * The 7 bonus panel-targeted examples from the spec.
  * The new "work/walk/go/think/talk/reason/run through" verb anchors.
  * The panel-suffix → reasoning fallback for command-intent phrasings
    that don't match any reasoning verb anchor.
  * ``should_trigger_planner`` returns ``True`` with a sensible reason
    for every panel-targeted case (so voice input actually reaches the
    planner and the structured executor).
  * Negative cases: bare explanations stay single-action;
    factual statements like "The picture in panel 3 is broken." don't
    get force-routed to reasoning.

Run:  py -3 tests/smoke/__panel_targeted_reasoning_smoke.py
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


def _plan(text: str) -> dict:
    return P.plan_user_actions(text, vera=None)


def _actions(plan: dict) -> list[dict]:
    return list(plan.get("actions") or [])


def _types(actions: list[dict]) -> list[str]:
    return [a.get("type") or "" for a in actions]


def _reasoning_target(actions: list[dict]) -> int | None:
    for a in actions:
        if a.get("type") == "reasoning.request":
            tgt = (a.get("payload") or {}).get("target") or {}
            if isinstance(tgt, dict):
                idx = tgt.get("index")
                if isinstance(idx, int):
                    return idx
    return None


def _reasoning_text(actions: list[dict]) -> str:
    for a in actions:
        if a.get("type") == "reasoning.request":
            t = (a.get("payload") or {}).get("text") or ""
            return str(t)
    return ""


# ----------------------------------------------------------------------
# Section A — spec acceptance tests (1-5)
# ----------------------------------------------------------------------
section("spec acceptance tests")

# Test 1: "Explain tennis in panel 3." → reasoning.request targeted to panel 3.
plan = _plan("Explain tennis in panel 3.")
actions = _actions(plan)
ok(plan.get("is_multi_action") is True, "1. is_multi_action: 'Explain tennis in panel 3.'")
ok("reasoning.request" in _types(actions), "1. has reasoning.request")
ok(_reasoning_target(actions) == 3, "1. reasoning target = 3", detail=f"got={_reasoning_target(actions)}")
ok("tennis" in _reasoning_text(actions).lower(), "1. reasoning prompt mentions tennis", detail=f"got={_reasoning_text(actions)!r}")
ok("panel 3" not in _reasoning_text(actions).lower(), "1. reasoning prompt strips 'panel 3'", detail=f"got={_reasoning_text(actions)!r}")

# Test 2: "In panel 3, explain tennis." → reasoning.request targeted to panel 3.
plan = _plan("In panel 3, explain tennis.")
actions = _actions(plan)
ok("reasoning.request" in _types(actions), "2. has reasoning.request: 'In panel 3, explain tennis.'")
ok(_reasoning_target(actions) == 3, "2. reasoning target = 3", detail=f"got={_reasoning_target(actions)}")

# Test 3: "Can you explain tennis?" → single action (voice OK / reasoning OK), not multi.
plan = _plan("Can you explain tennis?")
actions = _actions(plan)
ok(plan.get("is_multi_action") is False, "3. is_multi_action False: 'Can you explain tennis?'")
ok(len(actions) == 1, "3. single action", detail=f"got {len(actions)} actions")
ok(_reasoning_target(actions) is None, "3. no panel target", detail=f"got={_reasoning_target(actions)}")

# Test 4: "Explain this in panel 2." → reasoning.request targeted to panel 2.
plan = _plan("Explain this in panel 2.")
actions = _actions(plan)
ok("reasoning.request" in _types(actions), "4. has reasoning.request: 'Explain this in panel 2.'")
ok(_reasoning_target(actions) == 2, "4. reasoning target = 2", detail=f"got={_reasoning_target(actions)}")

# Test 5: "Can you help me plan an essay in panel 2?" → reasoning.request targeted to panel 2.
plan = _plan("Can you help me plan an essay in panel 2?")
actions = _actions(plan)
ok("reasoning.request" in _types(actions), "5. has reasoning.request: 'Can you help me plan an essay in panel 2?'")
ok(_reasoning_target(actions) == 2, "5. reasoning target = 2", detail=f"got={_reasoning_target(actions)}")
ok("essay" in _reasoning_text(actions).lower(), "5. reasoning prompt mentions essay", detail=f"got={_reasoning_text(actions)!r}")

# ----------------------------------------------------------------------
# Section B — bonus panel-targeted reasoning examples from the spec.
# ----------------------------------------------------------------------
section("bonus panel-targeted reasoning examples")

BONUS_CASES: list[tuple[str, int]] = [
    ("Explain tennis in panel 3.", 3),
    ("Can you explain tennis in panel 3?", 3),
    ("In panel 3, explain tennis.", 3),
    ("Use panel 3 to explain tennis.", 3),
    ("Explain this in panel 2.", 2),
    ("Can you work through this in panel 1?", 1),  # patched verb
    ("Put the explanation in panel 3.", 3),
]
for text, want_idx in BONUS_CASES:
    plan = _plan(text)
    actions = _actions(plan)
    ok(
        "reasoning.request" in _types(actions),
        f"reasoning.request present: {text!r}",
        detail=f"families={_types(actions)}",
    )
    ok(
        _reasoning_target(actions) == want_idx,
        f"reasoning target = {want_idx}: {text!r}",
        detail=f"got={_reasoning_target(actions)}",
    )
    ok(
        "voice.answer" not in _types(actions),
        f"NO voice.answer fallback: {text!r}",
        detail=f"families={_types(actions)}",
    )

# ----------------------------------------------------------------------
# Section C — new "X through" reasoning verb anchors.
# ----------------------------------------------------------------------
section("new reasoning verb anchors (work/walk/go/think/talk/reason/run through)")

NEW_VERB_CASES: list[tuple[str, int]] = [
    ("Can you work through this in panel 1?", 1),
    ("Walk through this in panel 2.", 2),
    ("Go through this in panel 3.", 3),
    ("Think through this in panel 4.", 4),
    ("Talk through this in panel 1.", 1),
    ("Reason through this in panel 2.", 2),
    ("Run through this in panel 3.", 3),
]
for text, want_idx in NEW_VERB_CASES:
    plan = _plan(text)
    actions = _actions(plan)
    ok(
        "reasoning.request" in _types(actions),
        f"anchors as reasoning: {text!r}",
        detail=f"families={_types(actions)}",
    )
    ok(
        _reasoning_target(actions) == want_idx,
        f"target = {want_idx}: {text!r}",
        detail=f"got={_reasoning_target(actions)}",
    )

# ----------------------------------------------------------------------
# Section D — panel-suffix → reasoning fallback (defense-in-depth)
# ----------------------------------------------------------------------
section("panel-suffix → reasoning fallback")

FALLBACK_CASES: list[tuple[str, int]] = [
    ("Do this in panel 3.", 3),
    ("Can you make a plan in panel 2?", 2),
    ("Help me build a study schedule in panel 1.", 1),
    ("Could you draft something in panel 4?", 4),
]
for text, want_idx in FALLBACK_CASES:
    plan = _plan(text)
    actions = _actions(plan)
    ok(
        "reasoning.request" in _types(actions),
        f"fallback emits reasoning: {text!r}",
        detail=f"families={_types(actions)}",
    )
    ok(
        _reasoning_target(actions) == want_idx,
        f"target = {want_idx}: {text!r}",
        detail=f"got={_reasoning_target(actions)}",
    )

# ----------------------------------------------------------------------
# Section E — should_trigger_planner fires for every panel-targeted
# reasoning utterance so voice input actually reaches the planner.
# ----------------------------------------------------------------------
section("should_trigger_planner fires for panel-targeted reasoning")

TRIGGER_TRUE_CASES = [
    "Explain tennis in panel 3.",
    "Can you explain tennis in panel 3?",
    "In panel 3, explain tennis.",
    "Use panel 3 to explain tennis.",
    "Explain this in panel 2.",
    "Can you work through this in panel 1?",
    "Can you help me plan an essay in panel 2?",
    "Do this in panel 3.",
    "Can you make a plan in panel 2?",
    "Help me build a study schedule in panel 1.",
]
ALLOWED_TRIGGER_REASONS = {
    "in_panel_suffix_with_action",
    "panel_navigate_with_reasoning",
    "panel_suffix_with_command_intent",
    "connector_and_multi_family",
    "connector_with_action_verb_rhs",
}
for text in TRIGGER_TRUE_CASES:
    triggered, reason = P.should_trigger_planner(text)
    ok(triggered, f"trigger=True: {text!r}", detail=f"reason={reason}")
    ok(
        reason in ALLOWED_TRIGGER_REASONS,
        f"reason is recognized: {text!r}",
        detail=f"got={reason}",
    )

# ----------------------------------------------------------------------
# Section F — Negative regressions: do NOT force reasoning when there
# isn't both explanation intent AND a panel target.
# ----------------------------------------------------------------------
section("negative regressions — bare explanations / statements / single panel ops")

# Single explanation without panel: keep single action, no panel target.
for text in (
    "Explain tennis.",
    "Can you explain tennis?",
    "What is tennis?",
    "Tell me about quantum entanglement.",
):
    plan = _plan(text)
    actions = _actions(plan)
    ok(
        plan.get("is_multi_action") is False,
        f"single action (no panel target): {text!r}",
        detail=f"types={_types(actions)}",
    )
    ok(
        _reasoning_target(actions) is None,
        f"no panel target: {text!r}",
        detail=f"got={_reasoning_target(actions)}",
    )

# Statements with "in panel N" but no command intent must NOT be force-routed
# to reasoning.
for text in (
    "The picture in panel 3 is broken.",
    "I left my notes in panel 2.",
):
    plan = _plan(text)
    actions = _actions(plan)
    ok(
        "reasoning.request" not in _types(actions),
        f"no reasoning.request forced: {text!r}",
        detail=f"types={_types(actions)}",
    )

# Single-action panel commands stay single (not multi).
for text in ("Open panel 3.", "Close panel 2.", "Go to panel 4."):
    plan = _plan(text)
    ok(
        plan.get("is_multi_action") is False,
        f"single panel op stays single: {text!r}",
        detail=f"types={_types(_actions(plan))}",
    )

# ----------------------------------------------------------------------
# Section G — prompt cleanliness: the reasoning prompt MUST NOT contain
# the "in panel N" routing tokens. That phrase contaminates the LLM
# prompt (the dispatcher logs this as
# [reasoning_prompt_contaminated_by_app_action] when it slips through).
# ----------------------------------------------------------------------
section("reasoning prompt is clean of panel-routing tokens")

CLEAN_PROMPT_CASES = [
    "Explain tennis in panel 3.",
    "Can you explain tennis in panel 3?",
    "Explain this in panel 2.",
    "Can you help me plan an essay in panel 2?",
    "Can you work through this in panel 1?",
    "Use panel 3 to explain tennis.",
    "Do this in panel 3.",
]
for text in CLEAN_PROMPT_CASES:
    plan = _plan(text)
    prompt = _reasoning_text(_actions(plan)).lower()
    ok(
        "panel" not in prompt or "panel " not in prompt,
        f"prompt doesn't mention panel: {text!r}",
        detail=f"prompt={prompt!r}",
    )
    for needle in ("in panel 1", "in panel 2", "in panel 3", "in panel 4"):
        ok(
            needle not in prompt,
            f"prompt strips {needle!r}: {text!r}",
            detail=f"prompt={prompt!r}",
        )

# ----------------------------------------------------------------------
# Section H — compound combinations still work.
# ----------------------------------------------------------------------
section("compound combinations still work end-to-end")

# Panel + reasoning + music
plan = _plan("Explain tennis in panel 3 and play lo-fi.")
families = set(_types(_actions(plan)))
ok(
    {"reasoning.request", "music.play"} <= families,
    "panel+reasoning+music compound has both reasoning AND music",
    detail=f"families={sorted(families)}",
)
ok(
    _reasoning_target(_actions(plan)) == 3,
    "compound reasoning target = 3",
    detail=f"got={_reasoning_target(_actions(plan))}",
)

# Panel.open + reasoning
plan = _plan("Open a new panel and explain tennis in panel 3.")
fams = _types(_actions(plan))
ok(
    "reasoning.request" in fams,
    "panel.open + reasoning compound has reasoning.request",
    detail=f"types={fams}",
)
ok(
    _reasoning_target(_actions(plan)) == 3,
    "compound panel.open + reasoning target = 3",
    detail=f"got={_reasoning_target(_actions(plan))}",
)

# ----------------------------------------------------------------------
print()
print(f"PASS {PASS}  FAIL {FAIL}")
if FAILED:
    print("Failed tests:")
    for name in FAILED:
        print(f"  - {name}")
sys.exit(0 if FAIL == 0 else 1)
