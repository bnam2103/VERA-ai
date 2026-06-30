"""Acceptance smoke for the 2026-06-01 multi-panel / multi-action patch.

Covers the seven acceptance tests from the patch spec:

    1. "Can you help me plan an English essay that is due in two hours in panel 2?"
       → reasoning.request targeted to panel 2.
    2. "Open panel 2 and help me plan my essay there."
       → panel.navigate/open panel 2, then reasoning.request targeted to panel 2.
    3. "In panel 2, help me plan an English essay due in two hours."
       → reasoning.request targeted to panel 2.
    4. "Can you close panel 2 and open a new panel?"
       → panel.close(2), then panel.open, executed in order.
    5. "Close the second panel and make a new one."
       → panel.close(second), then panel.open.
    6. "Close panel 2, then open a new reasoning panel."
       → panel.close(2), then panel.open.
    7. "Explain problem 1 in panel 1 and problem 2 in panel 2."
       → Either two targeted reasoning actions or clarification. Do not
         silently merge both into one wrong panel.

Plus regressions:

    * "Bake a cake. Make a new one tomorrow." (no panel context)
       → NOT panel.open.
    * "Plan an English essay." (single action)
       → reasoning.request, not voice.answer.
    * "follow the plan" (noun usage of "plan")
       → NOT reasoning.request.

Run:  py -3 tests/smoke/__multi_panel_targeting_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from actions import multi_action_planner as P  # noqa: E402

# --------------------------------------------------------------------------
# Tiny ANSI test harness
# --------------------------------------------------------------------------
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


def types_of(plan):
    return [a["type"] for a in (plan.get("actions") or [])]


def payload_of(plan, family):
    for a in plan.get("actions") or []:
        if a["type"] == family:
            return a.get("payload") or {}
    return {}


def target_index_of(plan, family):
    pay = payload_of(plan, family)
    tgt = pay.get("target") or {}
    if isinstance(tgt, dict):
        return tgt.get("index")
    return None


# ============================================================================
# Acceptance Test 1 — help-me-plan + in-panel-N
# ============================================================================
section("AT-1 — 'Can you help me plan ... in panel 2?'")
t1 = "Can you help me plan an English essay that is due in two hours in panel 2?"
p1 = P.plan_user_actions(t1)
trig1, reason1 = P.should_trigger_planner(t1)
ok(trig1, "should_trigger_planner=True", detail=f"reason={reason1}")
ok("reasoning.request" in types_of(p1), "plan contains reasoning.request",
   detail=str(types_of(p1)))
ok(target_index_of(p1, "reasoning.request") == 2,
   "reasoning.request target.index == 2",
   detail=str(payload_of(p1, "reasoning.request")))
# Prompt should NOT carry the "in panel 2" routing token after strip.
_rprompt = (payload_of(p1, "reasoning.request").get("text") or "").lower()
ok("in panel 2" not in _rprompt,
   "reasoning prompt stripped of 'in panel 2' suffix",
   detail=f"text={_rprompt!r}")

# ============================================================================
# Acceptance Test 2 — "Open panel 2 and help me plan my essay there."
# ============================================================================
section("AT-2 — 'Open panel 2 and help me plan my essay there.'")
t2 = "Open panel 2 and help me plan my essay there."
p2 = P.plan_user_actions(t2)
trig2, reason2 = P.should_trigger_planner(t2)
ok(trig2, "should_trigger_planner=True", detail=f"reason={reason2}")
ok(p2["is_multi_action"], "is_multi_action=True", detail=str(types_of(p2)))
families2 = types_of(p2)
ok(("panel.navigate" in families2 or "panel.open" in families2),
   "plan contains panel.navigate or panel.open",
   detail=str(families2))
ok("reasoning.request" in families2,
   "plan contains reasoning.request",
   detail=str(families2))
ok(target_index_of(p2, "reasoning.request") == 2,
   "reasoning.request inherits target.index == 2 from sibling panel.navigate",
   detail=str(payload_of(p2, "reasoning.request")))
# Order: panel action before reasoning.request.
ok(families2.index("reasoning.request") > families2.index(
       "panel.navigate" if "panel.navigate" in families2 else "panel.open"),
   "panel action precedes reasoning.request",
   detail=str(families2))

# ============================================================================
# Acceptance Test 3 — "In panel 2, help me plan an English essay ..."
# ============================================================================
section("AT-3 — 'In panel 2, help me plan an English essay due in two hours.'")
t3 = "In panel 2, help me plan an English essay due in two hours."
p3 = P.plan_user_actions(t3)
trig3, reason3 = P.should_trigger_planner(t3)
ok(trig3, "should_trigger_planner=True", detail=f"reason={reason3}")
ok("reasoning.request" in types_of(p3), "plan contains reasoning.request",
   detail=str(types_of(p3)))
ok(target_index_of(p3, "reasoning.request") == 2,
   "reasoning.request target.index == 2",
   detail=str(payload_of(p3, "reasoning.request")))

# ============================================================================
# Acceptance Test 4 — "Can you close panel 2 and open a new panel?"
# ============================================================================
section("AT-4 — 'Can you close panel 2 and open a new panel?'")
t4 = "Can you close panel 2 and open a new panel?"
p4 = P.plan_user_actions(t4)
ok(p4["is_multi_action"], "is_multi_action=True", detail=str(types_of(p4)))
ok(types_of(p4) == ["panel.close", "panel.open"],
   "actions == [panel.close, panel.open] (in order)",
   detail=str(types_of(p4)))
ok(payload_of(p4, "panel.close").get("targets") == [{"index": 2}],
   "panel.close targets == [{index: 2}]",
   detail=str(payload_of(p4, "panel.close")))

# ============================================================================
# Acceptance Test 5 — "Close the second panel and make a new one."
# ============================================================================
section("AT-5 — 'Close the second panel and make a new one.'")
t5 = "Close the second panel and make a new one."
p5 = P.plan_user_actions(t5)
ok(p5["is_multi_action"], "is_multi_action=True", detail=str(types_of(p5)))
ok(types_of(p5) == ["panel.close", "panel.open"],
   "actions == [panel.close, panel.open] (in order)",
   detail=str(types_of(p5)))
_pc_targets = payload_of(p5, "panel.close").get("targets") or []
ok(_pc_targets and isinstance(_pc_targets[0], dict)
   and _pc_targets[0].get("ordinal") == "second",
   "panel.close targets[0].ordinal == 'second'",
   detail=str(_pc_targets))

# ============================================================================
# Acceptance Test 6 — "Close panel 2, then open a new reasoning panel."
# ============================================================================
section("AT-6 — 'Close panel 2, then open a new reasoning panel.'")
t6 = "Close panel 2, then open a new reasoning panel."
p6 = P.plan_user_actions(t6)
ok(p6["is_multi_action"], "is_multi_action=True", detail=str(types_of(p6)))
ok(types_of(p6) == ["panel.close", "panel.open"],
   "actions == [panel.close, panel.open] (in order)",
   detail=str(types_of(p6)))
ok(payload_of(p6, "panel.close").get("targets") == [{"index": 2}],
   "panel.close targets == [{index: 2}]",
   detail=str(payload_of(p6, "panel.close")))

# ============================================================================
# Acceptance Test 7 — multi-target reasoning → clarification (not silent merge)
# ============================================================================
section("AT-7 — 'Explain problem 1 in panel 1 and problem 2 in panel 2.'")
t7 = "Explain problem 1 in panel 1 and problem 2 in panel 2."
p7 = P.plan_user_actions(t7)
ok(p7.get("clarification_needed") is True,
   "clarification_needed=True (planner refuses to silently merge)",
   detail=str(p7))
ok(not p7.get("actions"),
   "no planned actions when clarification needed",
   detail=str(types_of(p7)))
ok((p7.get("clarification_question") or "").strip(),
   "clarification_question is non-empty",
   detail=str(p7.get("clarification_question")))
ok((p7.get("reason") or "") == "multi_panel_reasoning_target_ambiguous",
   "reason='multi_panel_reasoning_target_ambiguous'",
   detail=str(p7.get("reason")))

# ============================================================================
# Anaphoric panel.open variants — must require preceding panel context
# ============================================================================
section("Anaphor — 'open a new one' only counts after panel close/open")
for text, expected_kinds in [
    # Positive: a preceding panel clause makes "make/open a new one" panel.open.
    ("Close panel 2 and open a new one.",     ["panel.close", "panel.open"]),
    ("Close panel 2 and make another one.",   ["panel.close", "panel.open"]),
    ("Close the second panel and make a new one.", ["panel.close", "panel.open"]),
]:
    plan = P.plan_user_actions(text)
    ok(types_of(plan) == expected_kinds,
       f"{text!r} → {expected_kinds}",
       detail=str(types_of(plan)))

# Negative: no panel context, "make a new one" must NOT anchor as panel.open.
neg_text = "Bake a cake. Make a new one tomorrow."
neg_plan = P.plan_user_actions(neg_text)
ok("panel.open" not in types_of(neg_plan),
   "'Bake a cake. Make a new one tomorrow.' does NOT anchor panel.open",
   detail=str(types_of(neg_plan)))

# ============================================================================
# "reasoning panel" panel.open variant
# ============================================================================
section("panel.open — 'open a new reasoning panel' anchors panel.open")
for text in [
    "open a new reasoning panel",
    "create another reasoning panel",
    "make a new reasoning panel please",
    "open a reasoning panel",
]:
    plan = P.plan_user_actions(text)
    ok("panel.open" in types_of(plan),
       f"{text!r} contains panel.open",
       detail=str(types_of(plan)))

# ============================================================================
# Plan-verb anchoring — guarded by determiner/possessive so noun usages stay out
# ============================================================================
section("reasoning.request — 'plan' verb is anchored only when followed by a noun object")
positive_plan_cases = [
    "help me plan an English essay",
    "help me draft a response to my professor",
    "help me outline a paper about AI ethics",
    "plan out my study schedule for tomorrow",
    "plan my essay about climate change",
]
for text in positive_plan_cases:
    plan = P.plan_user_actions(text)
    ok("reasoning.request" in types_of(plan),
       f"{text!r} → reasoning.request",
       detail=str(types_of(plan)))

# Noun "plan" must NOT anchor.
negative_plan_cases = [
    "follow the plan",
    "execute the plan",
    "review my plan",   # "review" is the verb, but "plan" stays a noun
    "I love this plan",
    "ok let's check the plan",
]
for text in negative_plan_cases:
    plan = P.plan_user_actions(text)
    # "review my plan" intentionally still anchors via "review" reasoning verb.
    if text.startswith("review"):
        ok("reasoning.request" in types_of(plan),
           f"{text!r} anchors via 'review' verb",
           detail=str(types_of(plan)))
        continue
    ok("reasoning.request" not in types_of(plan),
       f"{text!r} does NOT anchor reasoning.request",
       detail=str(types_of(plan)))

# ============================================================================
# Existing planner regressions — make sure earlier behavior didn't break.
# ============================================================================
section("Regression — existing planner spec still passes")
reg_cases = [
    ("explain the Vietnam War in panel 2",
     ["reasoning.request"]),
    ("close panel 1 and panel 3",
     ["panel.close"]),   # multi-panel-close stays one action with two targets
    ("play lo-fi and turn down the volume",
     ["music.play", "music.volume"]),
    ("add hello to the checklist and play lo-fi",
     ["checklist.add", "music.play"]),
]
for text, expected in reg_cases:
    plan = P.plan_user_actions(text)
    ok(types_of(plan) == expected,
       f"{text!r} → {expected}",
       detail=str(types_of(plan)))

# ============================================================================
# 2026-06-21 — multi-action panel compound regressions (A–F)
# ============================================================================
section("Compound panel actions A–F (2026-06-21 patch)")

def _targets_index(plan, family):
    pay = payload_of(plan, family)
    tgts = pay.get("targets") or []
    if not tgts:
        return None
    t0 = tgts[0]
    if isinstance(t0, dict):
        return t0.get("index") or t0.get("ordinal")
    return t0

# A — open + close
section("A — open new panel + close panel 2")
t_a = "Open a new panel and close panel 2."
p_a = P.plan_user_actions(t_a)
ok(types_of(p_a) == ["panel.open", "panel.close"],
   "A: [panel.open, panel.close]",
   detail=str(types_of(p_a)))
ok(_targets_index(p_a, "panel.close") == 2,
   "A: panel.close target index == 2",
   detail=str(payload_of(p_a, "panel.close")))

# B — open + close second + switch by title
section("B — open + close second + switch Vietnam War panel")
t_b = "Open a new panel, close second panel and switch to Vietnam War panel."
p_b = P.plan_user_actions(t_b)
ok(types_of(p_b) == ["panel.open", "panel.close", "panel.navigate"],
   "B: [panel.open, panel.close, panel.navigate]",
   detail=str(types_of(p_b)))
_pc_b = payload_of(p_b, "panel.close").get("targets") or []
ok(_pc_b and _pc_b[0].get("ordinal") == "second",
   "B: panel.close ordinal == second",
   detail=str(_pc_b))
ok((payload_of(p_b, "panel.navigate").get("target") or {}).get("title") == "Vietnam War",
   "B: panel.navigate title == Vietnam War",
   detail=str(payload_of(p_b, "panel.navigate")))

# C — music pause + reasoning in panel 3 (no redundant panel.navigate)
section("C — pause music + explain Vietnam War in panel 3")
t_c = "Pause the music and explain the Vietnam War in panel 3."
p_c = P.plan_user_actions(t_c)
ok(types_of(p_c) == ["music.pause", "reasoning.request"],
   "C: [music.pause, reasoning.request] — no redundant panel.navigate",
   detail=str(types_of(p_c)))
ok(target_index_of(p_c, "reasoning.request") == 3,
   "C: reasoning.request target.index == 3",
   detail=str(payload_of(p_c, "reasoning.request")))
ok("panel.navigate" not in types_of(p_c),
   "C: no panel.navigate",
   detail=str(types_of(p_c)))

# D — target panel 4 once
section("D — explain tennis in panel 4")
t_d = "Can you explain tennis in panel 4?"
p_d = P.plan_user_actions(t_d)
ok(types_of(p_d) == ["reasoning.request"],
   "D: [reasoning.request] only",
   detail=str(types_of(p_d)))
ok(target_index_of(p_d, "reasoning.request") == 4,
   "D: reasoning.request target.index == 4",
   detail=str(payload_of(p_d, "reasoning.request")))
ok(payload_of(p_d, "reasoning.request").get("explicit_panel_destination") is True,
   "D: explicit_panel_destination == True",
   detail=str(payload_of(p_d, "reasoning.request")))

# E — existing panel 2, no extra open
section("E — explain tennis in panel 2")
t_e = "Explain tennis in panel 2."
p_e = P.plan_user_actions(t_e)
ok(types_of(p_e) == ["reasoning.request"],
   "E: [reasoning.request] only — no panel.open/navigate",
   detail=str(types_of(p_e)))
ok(target_index_of(p_e, "reasoning.request") == 2,
   "E: reasoning.request target.index == 2",
   detail=str(payload_of(p_e, "reasoning.request")))

# F — close panel 2 then explain in panel 3 (close before reasoning, no navigate inject)
section("F — close panel 2 + explain tennis in panel 3")
t_f = "Close panel 2 and explain tennis in panel 3."
p_f = P.plan_user_actions(t_f)
ok(types_of(p_f) == ["panel.close", "reasoning.request"],
   "F: [panel.close, reasoning.request] in stable order",
   detail=str(types_of(p_f)))
ok(_targets_index(p_f, "panel.close") == 2,
   "F: panel.close target == 2",
   detail=str(payload_of(p_f, "panel.close")))
ok(target_index_of(p_f, "reasoning.request") == 3,
   "F: reasoning.request target == 3 (resolved before close mutates UI)",
   detail=str(payload_of(p_f, "reasoning.request")))

# G — explicit panel routing regression (2026-06-21)
section("G — single explicit panel targets (numeric + ordinal)")
for phrase, want_panel, want_task_fragment in [
    ("Can you explain tennis in panel 4?", 4, "explain tennis"),
    ("can you explain tennis in the fourth panel?", 4, "explain tennis"),
    ("Can you explain photosynthesis in panel 1?", 1, "explain photosynthesis"),
    ("Write about the Vietnam War in panel 2.", 2, "vietnam war"),
]:
    p_g = P.plan_user_actions(phrase)
    ok(P.should_trigger_planner(phrase)[0], f"G trigger: {phrase[:48]}")
    rr = payload_of(p_g, "reasoning.request")
    ok(target_index_of(p_g, "reasoning.request") == want_panel,
       f"G panel {want_panel}: {phrase[:48]}",
       detail=str(rr))
    task = str((rr or {}).get("content_task") or (rr or {}).get("text") or "").lower()
    ok(want_task_fragment in task,
       f"G task contains {want_task_fragment!r}: {phrase[:48]}",
       detail=task)
    ok(bool((rr or {}).get("explicit_panel_destination")),
       f"G explicit_panel_destination: {phrase[:48]}")

section("H — compound explicit panel (music + reasoning)")
t_h = "Pause music and explain the Vietnam War in panel 3."
p_h = P.plan_user_actions(t_h)
ok(p_h.get("is_multi_action"), "H: is multi-action")
ok(types_of(p_h) == ["music.pause", "reasoning.request"],
   "H: music.pause + reasoning.request",
   detail=str(types_of(p_h)))
ok(target_index_of(p_h, "reasoning.request") == 3,
   "H: reasoning.request target == 3",
   detail=str(payload_of(p_h, "reasoning.request")))

# ============================================================================
# Summary
# ============================================================================
print()
print("=" * 60)
if FAIL == 0:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    print(f"{GREEN}All multi-panel targeting smoke tests passed.{RESET}")
    sys.exit(0)
else:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    print(f"{RED}Failures:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
