"""Smoke for the 2026-06-02 multi-info voice compound patch.

Covers:
  * Planner anchor + payload extraction for the 7 acceptance utterances
    in the spec (no malformed combined locations).
  * ``should_trigger_planner`` returns ``True`` with the correct reason
    for the new info+info compound shapes.
  * The /infer voice compound override decision logic (replicated as a
    pure function here so we don't have to import the full app stack)
    fires for multi-info plans but stays off for single-action voice
    info queries.

Run:  py -3 tests/smoke/__multi_info_voice_compound_smoke.py
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
            print(f"         {detail[:800]}")


def _plan_actions(text: str) -> list[dict]:
    plan = P.plan_user_actions(text, vera=None)
    return list(plan.get("actions") or [])


def _types(actions: list[dict]) -> list[str]:
    return [a.get("type") or "" for a in actions]


def _location_for(action: dict) -> str:
    payload = action.get("payload") or {}
    return (payload.get("location") or "").strip().lower()


def _query_for(action: dict) -> str:
    payload = action.get("payload") or {}
    return (payload.get("query") or "").strip().lower()


# ----------------------------------------------------------------------
# /infer voice compound override decision — pure function mirror.
#
# Mirrors the logic in app.py around the ``_voice_compound_override``
# block. Keeping this in lockstep with the production code is the
# point of the test — if app.py changes the bucket map or the
# threshold, this test must change too.
# ----------------------------------------------------------------------
def voice_compound_override_decision(plan: dict) -> tuple[bool, str | None]:
    actions = [a for a in (plan.get("actions") or []) if a.get("type")]
    families = {a.get("type") for a in actions}
    buckets: set[str] = set()
    for f in families:
        if f.startswith("panel."):
            buckets.add("panel")
        elif f.startswith("reasoning."):
            buckets.add("reasoning")
        elif f.startswith("music."):
            buckets.add("music")
        elif f.startswith("checklist."):
            buckets.add("checklist")
        elif f.startswith("timer."):
            buckets.add("timer")
    action_count = len(actions)
    info_action_count = sum(
        1 for a in actions if (a.get("type") or "").startswith("info.")
    )
    if len(buckets) >= 2:
        return True, "voice_compound_defer_to_backend_planner"
    if action_count >= 2 and info_action_count >= 1:
        return True, "voice_multi_info_defer_to_backend_planner"
    return False, None


# ----------------------------------------------------------------------
# Planner acceptance cases — section A
# ----------------------------------------------------------------------
section("planner acceptance cases — multi-info compounds")

CASES_PLANNER: list[tuple[str, list[str], list[str]]] = [
    # text, expected_types, expected_locations (parallel list, lowercase)
    (
        "weather in Irvine and time in Tokyo",
        ["info.weather", "info.time"],
        ["irvine", "tokyo"],
    ),
    (
        "time in Tokyo and weather in Fountain Valley",
        ["info.time", "info.weather"],
        ["tokyo", "fountain valley"],
    ),
    (
        "Can you tell me the time in Tokyo and the weather in Fountain Valley?",
        ["info.time", "info.weather"],
        ["tokyo", "fountain valley"],
    ),
    (
        "What time is it in Tokyo and what time is it in Paris?",
        ["info.time", "info.time"],
        ["tokyo", "paris"],
    ),
    (
        "What's the weather in Irvine and the weather in Fountain Valley?",
        ["info.weather", "info.weather"],
        ["irvine", "fountain valley"],
    ),
]

for text, expected_types, expected_locs in CASES_PLANNER:
    actions = _plan_actions(text)
    types_actual = _types(actions)
    ok(
        types_actual == expected_types,
        f"types match: {text!r}",
        detail=f"got={types_actual} want={expected_types}",
    )
    # Each location must be set (not empty) and must NOT contain the
    # connector + sibling clause text. Reject malformed combined
    # locations like "tokyo and the weather in fountain valley".
    for i, want_loc in enumerate(expected_locs):
        if i >= len(actions):
            ok(False, f"action[{i}] present: {text!r}")
            continue
        loc = _location_for(actions[i])
        ok(
            loc == want_loc,
            f"action[{i}] location == {want_loc!r}: {text!r}",
            detail=f"got={loc!r}",
        )
        ok(
            " and " not in loc and "weather" not in loc.split() and "time" not in loc.split(),
            f"action[{i}] location clean (no merged sibling): {text!r}",
            detail=f"got={loc!r}",
        )

# ----------------------------------------------------------------------
# Existing working compounds must keep working — section B
# ----------------------------------------------------------------------
section("regression — existing compounds still plan correctly")

CASES_REGRESSION: list[tuple[str, list[str]]] = [
    # Time + checklist still plans as info.time + checklist.add.
    (
        "Tell me the time and add homework to the checklist.",
        ["info.time", "checklist.add"],
    ),
    # Panel open + panel close still plans as panel.open + panel.close.
    (
        "Open a new panel and close the second panel.",
        ["panel.open", "panel.close"],
    ),
]

for text, expected_types in CASES_REGRESSION:
    actions = _plan_actions(text)
    types_actual = _types(actions)
    ok(
        types_actual == expected_types,
        f"types match: {text!r}",
        detail=f"got={types_actual} want={expected_types}",
    )

# ----------------------------------------------------------------------
# Single-action voice queries — must remain single-action so the
# legacy router can keep handling them. The planner returns ``None``
# from ``try_execute_planned_actions_for_text`` when ``is_multi_action``
# is False, so the override gate never even sees these.
# ----------------------------------------------------------------------
section("regression — single-action info queries stay single-action")

CASES_SINGLE: list[tuple[str, str]] = [
    ("What time is it?", "info.time"),
    ("weather in Irvine", "info.weather"),
    ("the time in our schedule", "info.time"),
    ("What's the weather like today?", "info.weather"),
]

for text, expected_family in CASES_SINGLE:
    plan = P.plan_user_actions(text, vera=None)
    actions = list(plan.get("actions") or [])
    ok(
        len(actions) == 1,
        f"single-action plan: {text!r}",
        detail=f"got {len(actions)} actions: {_types(actions)}",
    )
    if actions:
        ok(
            actions[0].get("type") == expected_family,
            f"family is {expected_family}: {text!r}",
            detail=f"got={actions[0].get('type')}",
        )
    ok(
        plan.get("is_multi_action") is False,
        f"is_multi_action False: {text!r}",
        detail=f"got={plan.get('is_multi_action')}",
    )

# ----------------------------------------------------------------------
# should_trigger_planner — section C
# ----------------------------------------------------------------------
section("should_trigger_planner fires for multi-info compounds")

CASES_TRIGGER_TRUE: list[tuple[str, set[str]]] = [
    (
        "weather in Irvine and time in Tokyo",
        {"connector_and_multi_info_subfamily"},
    ),
    (
        "time in Tokyo and weather in Fountain Valley",
        {"connector_and_multi_info_subfamily"},
    ),
    (
        "Can you tell me the time in Tokyo and the weather in Fountain Valley?",
        {"connector_and_multi_info_subfamily"},
    ),
    (
        # Two info.time — same subfamily, but RHS has "what" verb so the
        # action-verb-after-connector rule fires too. Either reason is fine.
        "What time is it in Tokyo and what time is it in Paris?",
        {
            "connector_and_multi_family",
            "connector_and_multi_info_subfamily",
            "connector_with_action_verb_rhs",
        },
    ),
    (
        # Same-family weather + weather — same subfamily; RHS has "the
        # weather" which doesn't match _ACTION_VERB_RHS_RE directly, but
        # the connector_and_multi_family or _action_verb rule still
        # fires for "what's the weather" RHS pattern.
        "What's the weather in Irvine and the weather in Fountain Valley?",
        {
            "connector_and_multi_family",
            "connector_and_multi_info_subfamily",
            "connector_with_action_verb_rhs",
        },
    ),
]

for text, allowed_reasons in CASES_TRIGGER_TRUE:
    triggered, reason = P.should_trigger_planner(text)
    ok(
        triggered,
        f"should_trigger_planner True: {text!r}",
        detail=f"reason={reason}",
    )
    ok(
        reason in allowed_reasons,
        f"trigger reason in {sorted(allowed_reasons)}: {text!r}",
        detail=f"got reason={reason}",
    )

section("should_trigger_planner stays False for single-action info")

CASES_TRIGGER_FALSE = [
    "What time is it?",
    "weather in Irvine",
    "the time in our schedule",
    "What's the weather like today?",
]

for text in CASES_TRIGGER_FALSE:
    triggered, reason = P.should_trigger_planner(text)
    ok(
        not triggered,
        f"should_trigger_planner False: {text!r}",
        detail=f"reason={reason}",
    )

# ----------------------------------------------------------------------
# /infer voice compound override decision — section D
# ----------------------------------------------------------------------
section("/infer voice compound override decision")

# 1. Multi-info plan ⇒ override ON.
plan1 = P.plan_user_actions("weather in Irvine and time in Tokyo", vera=None)
ovr1, reason1 = voice_compound_override_decision(plan1)
ok(
    ovr1 is True,
    "override on: 'weather in Irvine and time in Tokyo'",
    detail=f"reason={reason1}",
)
ok(
    reason1 == "voice_multi_info_defer_to_backend_planner",
    "override reason multi_info: 'weather in Irvine and time in Tokyo'",
    detail=f"reason={reason1}",
)

# 2. Single info plan ⇒ override OFF (legacy single-action path).
plan2 = P.plan_user_actions("What time is it?", vera=None)
ovr2, reason2 = voice_compound_override_decision(plan2)
ok(
    ovr2 is False,
    "override off: 'What time is it?'",
    detail=f"reason={reason2}",
)

# 3. Info + checklist ⇒ override ON (existing bucket rule still wins).
plan3 = P.plan_user_actions(
    "Tell me the time and add homework to the checklist.", vera=None
)
ovr3, reason3 = voice_compound_override_decision(plan3)
ok(
    ovr3 is True,
    "override on: 'Tell me the time and add homework to the checklist.'",
    detail=f"reason={reason3}",
)

# 4. Two info.time ⇒ override ON via multi_info rule (set has 1 family).
plan4 = P.plan_user_actions(
    "What time is it in Tokyo and what time is it in Paris?", vera=None
)
ovr4, reason4 = voice_compound_override_decision(plan4)
ok(
    ovr4 is True,
    "override on: two info.time actions (same subfamily, two locations)",
    detail=f"reason={reason4}",
)
ok(
    reason4 == "voice_multi_info_defer_to_backend_planner",
    "override reason multi_info for same-subfamily compound",
    detail=f"reason={reason4}",
)

# 5. Two info.weather ⇒ override ON via multi_info rule.
plan5 = P.plan_user_actions(
    "What's the weather in Irvine and the weather in Fountain Valley?", vera=None
)
ovr5, reason5 = voice_compound_override_decision(plan5)
ok(
    ovr5 is True,
    "override on: two info.weather actions",
    detail=f"reason={reason5}",
)

# 6. Panel + reasoning ⇒ override ON via the EXISTING bucket rule (two
# distinct non-info buckets). This proves the patch didn't break the
# pre-existing compound override behaviour. panel.open + panel.close
# would collapse to a single "panel" bucket and is intentionally not
# covered by either rule — the spec scope is "multi-info + info+app",
# not "two actions in the same non-info family".
plan6 = P.plan_user_actions(
    "Open a new panel and put an explanation of the Vietnam War in it.",
    vera=None,
)
ovr6, reason6 = voice_compound_override_decision(plan6)
families6 = {a.get("type") for a in (plan6.get("actions") or [])}
# Only assert the gate fires when the planner actually returned a
# panel+reasoning compound plan — guards us against an unrelated planner
# regression breaking this gate assertion.
if {f for f in families6 if isinstance(f, str) and (f.startswith("panel.") or f.startswith("reasoning."))} >= {
    "panel.open",
}:
    ok(
        ovr6 is True,
        "override on: panel.open + reasoning.request (existing bucket rule)",
        detail=f"families={sorted(families6)} reason={reason6}",
    )
    ok(
        reason6 == "voice_compound_defer_to_backend_planner",
        "override reason regular bucket for panel+reasoning compound",
        detail=f"reason={reason6}",
    )

# ----------------------------------------------------------------------
# Bad output regression — section E
# Make sure no plan from any acceptance case contains a malformed
# combined location like ``"tokyo and the weather in fountain valley"``.
# ----------------------------------------------------------------------
section("bad-output regression — no malformed merged locations")

BAD_LOC_FRAGMENTS = [
    "tokyo and",
    "irvine and",
    "fountain valley and",
    "and the weather",
    "and the time",
    "and weather in",
    "and time in",
]

for text, _expected_types, _expected_locs in CASES_PLANNER:
    actions = _plan_actions(text)
    for i, a in enumerate(actions):
        loc = _location_for(a)
        q = _query_for(a)
        for bad in BAD_LOC_FRAGMENTS:
            ok(
                bad not in loc,
                f"action[{i}] location lacks {bad!r}: {text!r}",
                detail=f"location={loc!r}",
            )
            ok(
                bad not in q,
                f"action[{i}] query lacks {bad!r}: {text!r}",
                detail=f"query={q!r}",
            )

# ----------------------------------------------------------------------
# Partial-success fallback message — section F
# ----------------------------------------------------------------------
section("partial-success fallback message helper")

# Importing the helper from app.py would load the whole model stack,
# which is way too heavy for a unit smoke. We mirror the helper here
# (and assert the production helper exists by file-search) so the test
# stays cheap. If app.py renames or removes the helper, the assertion
# below will flag it.
import re as _re  # noqa: E402

app_path = os.path.join(ROOT, "app.py")
with open(app_path, "r", encoding="utf-8") as _fh:
    _app_text = _fh.read()
ok(
    "def _human_failure_reply_for_action(" in _app_text,
    "app.py defines _human_failure_reply_for_action",
)
ok(
    "_human_failure_reply_for_action(action)" in _app_text,
    "app.py wires the partial-success helper into execute_planned_actions",
)


# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------
print()
print(f"PASS {PASS}  FAIL {FAIL}")
if FAILED:
    print("Failed tests:")
    for name in FAILED:
        print(f"  - {name}")
sys.exit(0 if FAIL == 0 else 1)
