"""Smoke test for the 2026-05-29 reasoning-gate (CHAT_REASONING.classify_route_reasoning).

Covers the 13 spec test cases plus same-shape regression cases. Tests run
against the deterministic backbone only — we monkeypatch the LLM call to
make the suite reproducible without an OpenAI key.

Run:  py -3 tests/smoke/__reasoning_gate_smoke.py
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import CHAT_REASONING as CR  # noqa: E402

# ---- ANSI test harness ----------------------------------------------------
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


# ---- Build a ReasoningAI stub that never calls OpenAI ---------------------
class _LLMShouldNotFire(Exception):
    pass


class _FakeChatCompletions:
    def __init__(self, deliver):
        self._deliver = deliver

    def create(self, **kwargs):
        return self._deliver(kwargs)


class _FakeClient:
    def __init__(self, deliver):
        self.chat = type("C", (), {})()
        self.chat.completions = _FakeChatCompletions(deliver)


def make_ai(llm_response: str | None = None, *, llm_should_not_fire: bool = False):
    """Return a ReasoningAI instance whose OpenAI client is mocked.

    - When ``llm_should_not_fire`` is True, hitting the LLM raises so the
      test fails loudly (used to assert deterministic short-circuits).
    - When ``llm_response`` is provided, the mock returns that string as
      the choice content (lets us steer the LLM-fallback branches).
    """
    ai = CR.ReasoningAI.__new__(CR.ReasoningAI)
    ai.classifier_model = "stub"
    ai.model_name = "stub"

    def deliver(kwargs):
        if llm_should_not_fire:
            raise _LLMShouldNotFire("LLM was called when it should not be")
        content = llm_response if llm_response is not None else (
            '{"route":"voice_ui","reason":"none","prompt_reasoning":false,'
            '"category":"none","confidence":0.4,"resolved_topic":null,"target_panel":null}'
        )

        class _Msg:
            def __init__(self, c): self.message = type("M", (), {"content": c})()
        class _Resp:
            def __init__(self, c): self.choices = [_Msg(c)]
        return _Resp(content)

    ai.client = _FakeClient(deliver)
    return ai


# ---- 13 SPEC TEST CASES (deterministic-only — LLM should not fire) -------
section("Spec test cases (deterministic short-circuits)")

CASES: list[tuple[str, str, str, dict]] = [
    # (utterance, expected_route, expected_reason, extras)
    ("can you tell me what tennis is?",                  "voice_ui",        "simple_definition",    {}),
    ("what is tennis?",                                  "voice_ui",        "simple_definition",    {}),
    ("explain tennis",                                   "voice_ui",        "",                     {"allow_llm": True, "llm_expected": "voice_ui"}),
    ("can you explain tennis in the reasoning panel?",   "reasoning_panel", "explicit_panel_reference", {}),
    ("put an explanation of tennis in panel 2",          "reasoning_panel", "explicit_panel_reference", {"target_panel": 2}),
    ("explain the Vietnam War",                          "reasoning_panel", "broad_complex_topic",  {}),
    ("briefly explain the Vietnam War",                  "voice_ui",        "brief_explanation",    {}),
    ("what was the Vietnam War?",                        "voice_ui",        "simple_definition",    {}),
    ("give me a detailed explanation of the Vietnam War","reasoning_panel", "complex_task",         {}),
    ("solve this probability problem",                   "reasoning_panel", "complex_task",         {}),
    ("explain this step by step",                        "reasoning_panel", "complex_task",         {}),
    ("can you briefly explain inflation?",               "voice_ui",        "brief_explanation",    {}),
    # Extra spec sanity:
    ("who is Serena Williams?",                          "voice_ui",        "simple_definition",    {}),
]

for utt, expected_route, expected_reason, extras in CASES:
    allow_llm = extras.get("allow_llm", False)
    llm_expected = extras.get("llm_expected")
    ai = make_ai(
        llm_should_not_fire=not allow_llm,
        llm_response=(
            '{"route":"' + (llm_expected or "voice_ui") + '","reason":"none",'
            '"prompt_reasoning":' + ("true" if llm_expected == "reasoning_panel" else "false") + ','
            '"category":"none","confidence":0.4,"resolved_topic":null,"target_panel":null}'
        ),
    )
    try:
        res = ai.classify_route_reasoning(utt)
        route = res.get("route")
        reason = res.get("reason")
        ok(route == expected_route,
           f"{utt!r} → route={expected_route}",
           detail=f"got route={route!r} reason={reason!r} source={res.get('source')!r}")
        if expected_reason:
            ok(reason == expected_reason,
               f"{utt!r} → reason={expected_reason}",
               detail=f"got reason={reason!r} source={res.get('source')!r}")
        if "target_panel" in extras:
            ok(res.get("target_panel") == extras["target_panel"],
               f"{utt!r} → target_panel={extras['target_panel']}",
               detail=f"got target_panel={res.get('target_panel')!r}")
    except _LLMShouldNotFire as e:
        ok(False, f"{utt!r} → no LLM call", detail=str(e))


# ---- Backwards-compat assertions ------------------------------------------
section("Legacy artifact short-circuits still route to reasoning_panel")
LEGACY = (
    ("show me an example",                                          "reasoning_panel"),
    ("make a plan for my homework due in 2 hours",                  "reasoning_panel"),
    ("guide me on my essay",                                        "reasoning_panel"),
    ("plan my homework and assignment",                             "reasoning_panel"),
    ("can you help me debug this python code?",                     "reasoning_panel"),
    ("help me write a complaint about this traffic ticket",         "reasoning_panel"),  # via explain_with_complexity
)
for utt, expected_route in LEGACY:
    ai = make_ai(llm_should_not_fire=True)
    try:
        res = ai.classify_route_reasoning(utt)
        ok(res.get("route") == expected_route,
           f"{utt!r} → route={expected_route}",
           detail=f"got route={res.get('route')!r} reason={res.get('reason')!r} source={res.get('source')!r}")
    except _LLMShouldNotFire as e:
        ok(False, f"{utt!r} → deterministic short-circuit", detail=str(e))


# ---- Explicit-panel overrides win over simplicity --------------------------
section("Explicit panel reference overrides simplicity")
for utt in (
    "answer that in the panel",
    "put this in the reasoning space",
    "use the panel for this",
    "use work mode for this",
    "open a new panel and explain tennis",
    "write this in panel 3",
):
    ai = make_ai(llm_should_not_fire=True)
    try:
        res = ai.classify_route_reasoning(utt)
        ok(res.get("route") == "reasoning_panel" and res.get("reason") == "explicit_panel_reference",
           f"{utt!r} → reasoning_panel/explicit_panel_reference",
           detail=f"got route={res.get('route')!r} reason={res.get('reason')!r}")
    except _LLMShouldNotFire as e:
        ok(False, f"{utt!r} → deterministic short-circuit", detail=str(e))


# ---- Bare-explain branch is now tight (without LLM) -----------------------
section("Bare 'explain X' with no complexity signal falls through to LLM")
for utt in ("explain tennis", "explain lasagna", "explain bicycles"):
    ai = make_ai(
        llm_response='{"route":"voice_ui","reason":"none","prompt_reasoning":false,"category":"none","confidence":0.4,"resolved_topic":null,"target_panel":null}',
    )
    res = ai.classify_route_reasoning(utt)
    ok(res.get("route") == "voice_ui",
       f"{utt!r} → voice_ui (no complexity signal)",
       detail=f"got route={res.get('route')!r} reason={res.get('reason')!r} source={res.get('source')!r}")
    ok(res.get("source") == "backend_llm_classifier",
       f"{utt!r} → fell through to LLM (not deterministic)",
       detail=f"got source={res.get('source')!r}")


# ---- Diagnostics block exists ----------------------------------------------
section("Diagnostics block populated")
ai = make_ai(llm_should_not_fire=True)
res = ai.classify_route_reasoning("explain the Vietnam War")
diag = res.get("diagnostics") or {}
for field in (
    "reasoning_gate_called", "reasoning_gate_result", "reasoning_gate_reason",
    "explicit_panel_reference", "simple_definition_detected",
    "brief_explanation_detected", "broad_complex_topic_detected",
    "complex_task_detected", "bare_explain_present",
    "complexity_signal_present", "route_source",
):
    ok(field in diag, f"diagnostics contains {field!r}", detail=str(diag))


# ---- Final tally -----------------------------------------------------------
print(f"\n{'=' * 60}")
print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
if FAILED:
    print("\nFailing tests:")
    for n in FAILED:
        print(f"  - {n}")
    sys.exit(1)
print("All reasoning-gate smoke tests passed.")
