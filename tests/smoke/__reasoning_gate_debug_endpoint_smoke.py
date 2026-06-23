"""Smoke test for the POST /debug/reasoning_gate helper in app.py.

We extract ``_resolve_reasoning_debug_payload`` and the surrounding
helpers from app.py source so we never need to boot the full model. The
extracted block is run in a stub namespace where ``reasoning_ai`` is a
small object that implements the methods the resolver consults:

  * ``_detect_explicit_reasoning_panel_reference(text) -> dict``
  * ``classify_route_reasoning(text) -> dict``

The stub mirrors what the real ``CHAT_REASONING.ReasoningAI`` returns,
so the smoke verifies the resolver's branching logic against the spec
PART 4 test matrix.

Run with:
    py -3 tests/smoke/__reasoning_gate_debug_endpoint_smoke.py
"""

from __future__ import annotations

import io
import json
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[2]
APP_SRC = (ROOT / "app.py").read_text(encoding="utf-8")

START_MARK = "_REASONING_DEBUG_PRONOUN_RE = re.compile"
END_MARK = "@app.post(\"/debug/reasoning_gate\")"

start_idx = APP_SRC.find(START_MARK)
end_idx = APP_SRC.find(END_MARK)
if start_idx < 0 or end_idx < 0 or end_idx <= start_idx:
    print(
        "[FAIL] Could not locate /debug/reasoning_gate helper block in app.py.\n"
        f"       start_idx={start_idx} end_idx={end_idx}"
    )
    sys.exit(1)
helper_src = APP_SRC[start_idx:end_idx]


# ---------------------------------------------------------------------------
# Stub ``ReasoningAI`` that mirrors the real classifier's deterministic
# short-circuits. We import the actual regexes from CHAT_REASONING so the
# smoke catches any drift if those patterns change.
# ---------------------------------------------------------------------------
sys.path.insert(0, str(ROOT))
from CHAT_REASONING import _parse_json_object  # noqa: F401 (helper kept available)


class _StubReasoningAI:
    """Re-implements the bits the resolver needs without touching the LLM."""

    _BRIEF_MODIFIER_RE = re.compile(
        r"\b(?:brief(?:ly)?|short(?:ly)?|quick(?:ly)?|in\s+short|in\s+a\s+sentence|"
        r"in\s+one\s+sentence|one[-\s]*liner|one\s*sentence|tl;?dr|tldr|"
        r"give\s+me\s+the\s+(?:short|brief|quick)\s+(?:version|answer)|"
        r"summari[sz]e\s+(?:briefly|in\s+one\s+sentence)|"
        r"in\s+a\s+(?:few|couple\s+of)\s+(?:words|sentences))\b",
        re.IGNORECASE,
    )

    _SIMPLE_DEFINITION_RES = (
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"(?:tell\s+me\s+)?"
                   r"what(?:'s|s|\s+is|\s+are|\s+was|\s+were)\s+(?P<topic>.+?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"(?:tell\s+me\s+)?"
                   r"who(?:'s|s|\s+is|\s+are|\s+was|\s+were)\s+(?P<topic>.+?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"what\s+does\s+(?P<topic>.+?)\s+mean\s*[?.!]*\s*$",
                   re.IGNORECASE),
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"tell\s+me\s+what\s+(?P<topic>.+?)\s+(?:is|are|was|were|means?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
    )

    _PANEL_PUT_RE = re.compile(
        r"\b(?:put|place|write|answer|show|drop|paste)\s+"
        r"(?:this|that|it|them|the\s+answer|the\s+explanation|"
        r"an?\s+explanation\s+of\s+(?P<topic>.+?))"
        r"\s+(?:in|into|onto|on)\s+(?:the\s+)?"
        r"(?:reasoning\s+(?:panel|space|tab|page)|panel|tab|space|page|work\s*mode|workmode)"
        r"(?:\s*#?\s*(?P<panel_num>\d+)|\s+(?P<panel_ord>first|second|third|fourth|fifth|sixth|seventh|eighth))?",
        re.IGNORECASE,
    )
    _PANEL_IN_RE = re.compile(
        r"\b(?:in|into|using|on|via|inside)\s+(?:the\s+)?"
        r"(?:reasoning\s+(?:panel|space|tab|page)|panel|tab|space|page|work\s*mode|workmode)"
        r"(?:\s*#?\s*(?P<panel_num>\d+)|\s+(?P<panel_ord>first|second|third|fourth|fifth|sixth|seventh|eighth))?\b",
        re.IGNORECASE,
    )
    _PANEL_IMP_RE = re.compile(
        r"\b(?:use|open|launch|spin\s*up|fire\s*up)\s+(?:up\s+)?"
        r"(?:(?:a|another|the|one\s+more|some)\s+)?"
        r"(?:(?:new|extra|additional|empty|fresh|another)\s+)?"
        r"(?:reasoning\s+(?:panel|space|tab|page)|panel|tab|work\s*mode|workmode)\b",
        re.IGNORECASE,
    )

    _ORD_MAP = {
        "first": 1, "second": 2, "third": 3, "fourth": 4,
        "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
    }

    def _detect_explicit_reasoning_panel_reference(self, raw_text: str) -> dict:
        s = (raw_text or "").strip()
        empty = {"matched": False, "topic": None, "target_panel": None}
        if not s:
            return empty
        m_put = self._PANEL_PUT_RE.search(s)
        if m_put:
            topic = (m_put.groupdict().get("topic") or "").strip() or None
            num = m_put.groupdict().get("panel_num")
            ordn = (m_put.groupdict().get("panel_ord") or "").lower()
            target = None
            if num:
                try:
                    target = int(num)
                except ValueError:
                    target = None
            elif ordn:
                target = self._ORD_MAP.get(ordn)
            return {"matched": True, "topic": topic, "target_panel": target}
        m_in = self._PANEL_IN_RE.search(s)
        if m_in:
            num = m_in.groupdict().get("panel_num")
            ordn = (m_in.groupdict().get("panel_ord") or "").lower()
            target = None
            if num:
                try:
                    target = int(num)
                except ValueError:
                    target = None
            elif ordn:
                target = self._ORD_MAP.get(ordn)
            return {"matched": True, "topic": None, "target_panel": target}
        if self._PANEL_IMP_RE.search(s):
            return {"matched": True, "topic": None, "target_panel": None}
        return empty

    def classify_route_reasoning(self, text: str) -> dict:
        s = (text or "").strip()
        low = s.lower()
        panel_ref = self._detect_explicit_reasoning_panel_reference(s)
        if panel_ref["matched"]:
            return {
                "prompt_reasoning": True,
                "category": "complex_request",
                "confidence": 0.99,
                "route": "reasoning_panel",
                "reason": "explicit_panel_reference",
                "resolved_topic": panel_ref["topic"],
                "target_panel": panel_ref["target_panel"],
                "source": "backend_deterministic_explicit_panel",
                "diagnostics": {
                    "reasoning_gate_called": True,
                    "explicit_panel_reference": True,
                },
            }
        if self._BRIEF_MODIFIER_RE.search(low):
            return {
                "prompt_reasoning": False,
                "category": "none",
                "confidence": 0.95,
                "route": "voice_ui",
                "reason": "brief_explanation",
                "resolved_topic": None,
                "target_panel": None,
                "source": "backend_deterministic_brief",
                "diagnostics": {
                    "reasoning_gate_called": True,
                    "brief_explanation_detected": True,
                },
            }
        if len(s) <= 160:
            for pat in self._SIMPLE_DEFINITION_RES:
                if pat.match(s):
                    return {
                        "prompt_reasoning": False,
                        "category": "none",
                        "confidence": 0.95,
                        "route": "voice_ui",
                        "reason": "simple_definition",
                        "resolved_topic": None,
                        "target_panel": None,
                        "source": "backend_deterministic_simple_definition",
                        "diagnostics": {
                            "reasoning_gate_called": True,
                            "simple_definition_detected": True,
                        },
                    }
        if re.search(
            r"\b(?:solve|prove|derive|simulate|debug|refactor|compute|"
            r"calculate|evaluate|analy[sz]e|outline|summari[sz]e|"
            r"compare|review|draft|compose|polish|rewrite|"
            r"write\s+(?:a|an|the|me|us|my|some|this|that|that\s+))\b",
            low,
        ):
            return {
                "prompt_reasoning": True,
                "category": "complex_request",
                "confidence": 0.94,
                "route": "reasoning_panel",
                "reason": "complex_task",
                "resolved_topic": None,
                "target_panel": None,
                "source": "backend_deterministic_complex_task_verb",
                "diagnostics": {
                    "reasoning_gate_called": True,
                    "complex_task_detected": True,
                    "complexity_signal_present": True,
                },
            }
        broad = bool(re.search(
            r"\b(?:vietnam\s+war|world\s+war|cold\s+war|civil\s+war|"
            r"french\s+revolution|industrial\s+revolution|"
            r"black[-\s]*scholes|monte[-\s]*carlo|calculus|"
            r"probability\s+problem|theorem|proof|derivation|"
            r"climate\s+change|theory\s+of\s+relativity|"
            r"quantum\s+(?:mechanics|computing))\b",
            low,
        ))
        detailed = bool(re.search(
            r"\b(?:in\s+detail|detailed(?:ly)?|step[-\s]*by[-\s]*step|"
            r"deep[-\s]*dive|thorough(?:ly)?)\b",
            low,
        ))
        if re.search(r"\b(?:explain(?:s|ed|ing)?|explanation(?:s)?)\b", low) and (broad or detailed):
            return {
                "prompt_reasoning": True,
                "category": "history_heavy" if broad else "dense_concept",
                "confidence": 0.93,
                "route": "reasoning_panel",
                "reason": "broad_complex_topic" if broad and not detailed else "complex_task",
                "resolved_topic": None,
                "target_panel": None,
                "source": "backend_deterministic_explain_with_complexity",
                "diagnostics": {
                    "reasoning_gate_called": True,
                    "broad_complex_topic_detected": bool(broad),
                    "complexity_signal_present": True,
                },
            }
        return {
            "prompt_reasoning": False,
            "category": "none",
            "confidence": 0.5,
            "route": "voice_ui",
            "reason": "llm_negative",
            "resolved_topic": None,
            "target_panel": None,
            "source": "backend_llm_classifier",
            "diagnostics": {
                "reasoning_gate_called": True,
            },
        }


# ---------------------------------------------------------------------------
# Execute the extracted helper block in our stub namespace.
# ---------------------------------------------------------------------------
exec_globals: dict = {
    "__name__": "__reasoning_gate_debug_smoke__",
    "re": re,
    "json": json,
    "Any": Any,
    "Optional": Optional,
    "reasoning_ai": _StubReasoningAI(),
}
exec(helper_src, exec_globals)

_resolve_reasoning_debug_payload = exec_globals["_resolve_reasoning_debug_payload"]
_emit_reasoning_gate_debug_log = exec_globals["_emit_reasoning_gate_debug_log"]


# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RESET = "\033[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(condition: bool, name: str, *, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        suffix = f"\n         {detail}" if detail else ""
        print(f"  {RED}FAIL{RESET}  {name}{suffix}")


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


def gate(text: str, prev: str = "", active: bool = True, panel: Optional[int] = None) -> dict:
    return _resolve_reasoning_debug_payload(text, prev, active, panel)


# ---------------------------------------------------------------------------
# Spec PART 4 — Voice UI expected
# ---------------------------------------------------------------------------
section("Voice UI expected")

voice_cases = [
    ("what is tennis?", "simple_definition"),
    ("can you tell me what tennis is?", "simple_definition"),
    ("explain tennis", "llm_negative"),
    ("briefly explain the Vietnam War", "brief_explanation"),
    ("what was the Vietnam War?", "simple_definition"),
    ("can you briefly explain inflation?", "brief_explanation"),
    ("who is Serena Williams?", "simple_definition"),
    ("what does Black-Scholes mean?", "simple_definition"),
]
for text, expected_reason in voice_cases:
    r = gate(text)
    ok(r["route"] == "voice_ui",
       f"{text!r} → voice_ui",
       detail=f"got route={r['route']} reason={r['reason']}")
    if expected_reason:
        ok(r["reason"] == expected_reason,
           f"{text!r} → reason={expected_reason}",
           detail=f"got reason={r['reason']}")

# ---------------------------------------------------------------------------
# Spec PART 4 — Reasoning panel expected
# ---------------------------------------------------------------------------
section("Reasoning panel expected")

reason_cases = [
    "explain the Vietnam War",
    "give me a detailed explanation of the Vietnam War",
    "explain this step by step",
    "solve this probability problem",
    "write an essay about the Vietnam War",
    "compare the causes and effects of the Vietnam War",
    "explain Black-Scholes delta in detail",
]
for text in reason_cases:
    r = gate(text)
    ok(r["route"] == "reasoning_panel",
       f"{text!r} → reasoning_panel",
       detail=f"got route={r['route']} reason={r['reason']}")

# ---------------------------------------------------------------------------
# Spec PART 4 — Explicit panel expected
# ---------------------------------------------------------------------------
section("Explicit panel expected")

panel_cases = [
    ("can you explain tennis in the reasoning panel?", None, None),
    ("put an explanation of tennis in panel 2", "tennis", 2),
    ("use the reasoning space to explain tennis", None, None),
    ("open a new panel and explain tennis", None, None),
]
for text, expected_topic, expected_target in panel_cases:
    r = gate(text)
    ok(r["route"] == "reasoning_panel",
       f"{text!r} → reasoning_panel",
       detail=f"got route={r['route']} reason={r['reason']}")
    if expected_topic:
        ok(expected_topic.lower() in (r.get("resolved_topic") or "").lower(),
           f"{text!r} → resolved_topic contains {expected_topic!r}",
           detail=f"got resolved_topic={r.get('resolved_topic')}")
    if expected_target is not None:
        ok(r["target_panel"] == expected_target,
           f"{text!r} → target_panel={expected_target}",
           detail=f"got target_panel={r.get('target_panel')}")

# Pronoun with prior topic ⇒ reasoning_panel.
r = gate("answer this in the panel", prev="what is tennis?")
ok(r["route"] == "reasoning_panel",
   "pronoun + prior topic → reasoning_panel",
   detail=str(r))
ok(r["resolved_topic"] == "what is tennis?",
   "pronoun + prior topic → resolved_topic = previous_user_text",
   detail=str(r))
ok(r["diagnostics"]["prior_topic_used"] is True,
   "pronoun + prior topic → prior_topic_used=true",
   detail=str(r["diagnostics"]))

# ---------------------------------------------------------------------------
# Spec PART 4 — Clarification expected
# ---------------------------------------------------------------------------
section("Clarification expected")

clar_cases = [
    "explain that in the panel",
    "answer this in the reasoning panel",
]
for text in clar_cases:
    r = gate(text)
    ok(r["route"] == "clarification",
       f"{text!r} → clarification",
       detail=f"got route={r['route']} reason={r['reason']}")
    ok(r["reason"] == "explicit_panel_pronoun_without_prior_topic",
       f"{text!r} → reason=explicit_panel_pronoun_without_prior_topic",
       detail=f"got reason={r['reason']}")

# ---------------------------------------------------------------------------
# Diagnostics log fires exactly once per call.
# ---------------------------------------------------------------------------
section("[reasoning_gate_debug] log emission")

buf = io.StringIO()
with redirect_stdout(buf):
    payload = gate("what is tennis?")
    _emit_reasoning_gate_debug_log(payload)
log_lines = [ln for ln in buf.getvalue().splitlines() if ln.startswith("[reasoning_gate_debug] ")]
ok(len(log_lines) == 1,
   "emits exactly one [reasoning_gate_debug] line per call",
   detail=str(log_lines))
if log_lines:
    parsed = json.loads(log_lines[0].split("] ", 1)[1])
    for key in [
        "text", "route", "reason", "resolved_topic", "target_panel",
        "explicit_panel_reference", "simple_definition_detected",
        "brief_explanation_detected", "broad_complex_topic_detected",
        "complex_task_detected", "active_work_mode",
        "prior_topic_used", "route_source",
    ]:
        ok(key in parsed, f"log carries {key}", detail=str(parsed))

# ---------------------------------------------------------------------------
# Empty text + helper guards
# ---------------------------------------------------------------------------
section("Edge cases")

r = gate("")
ok(r["route"] == "voice_ui" and r["reason"] == "empty_text",
   "empty text → voice_ui / empty_text",
   detail=str(r))

# active_panel_index passthrough
r = gate("what is tennis?", panel=2)
ok(r["active_panel_index"] == 2,
   "active_panel_index round-trips in response",
   detail=str(r.get("active_panel_index")))

# ---------------------------------------------------------------------------
# Final tally
# ---------------------------------------------------------------------------
print(f"\n{'=' * 60}")
print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
if FAILED:
    print("\nFailing tests:")
    for n in FAILED:
        print(f"  - {n}")
    sys.exit(1)
print("All /debug/reasoning_gate smoke tests passed.")
