"""
Work-mode reasoning LLM: markdown-style planning + short voice digest for VERA.
Stack mirrors CHAT2.py (profiles + OpenAI) with different system prompts.
"""

import asyncio
import base64
import io
import json
import os
import re
from openai import OpenAI

from CHAT2 import admin_info_path, build_profile_context, load_profile_info
from CHAT2 import active_user_info_path as chat2_active_user_info_path


def _parse_json_bool(text: str, key: str, default: bool) -> bool:
    if not text:
        return default
    try:
        obj = json.loads(text)
        if isinstance(obj, dict) and key in obj:
            return bool(obj[key])
    except Exception:
        pass
    m = re.search(r"\{[^}]+\}", text, flags=re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict) and key in obj:
                return bool(obj[key])
        except Exception:
            pass
    return default


def _parse_json_object(text: str, fallback: dict) -> dict:
    if not text:
        return fallback
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return fallback


# Shared instructions for markdown reasoning (fast + deep models).
REASONING_MARKDOWN_GROUNDING_BLOCK = (
    "\n\nEvidence, grounding, and corrections (obey strictly):\n"
    "- Treat the user's latest message and any attachment excerpt as primary evidence. "
    "Do not treat uploads or pasted blocks as optional background.\n"
    "- When the user labels material as an answer key, solution, official result, or correction, "
    "you must reconcile your work to it step by step: extract its numbers and conclusions, "
    "compare them to yours, and explain any mismatch before giving a final answer.\n"
    "- If the user says you were wrong or supplies a reference answer, do not stop at an apology. "
    "Identify the specific error, state which given values you should have used, fix the method or arithmetic, "
    "and present a fully corrected solution that explicitly uses those values.\n"
    "- For quantitative problems (math, finance, physics, accounting), use only parameters stated in the "
    "problem or attachment (e.g. initial spot, rates, counts). Never replace them with convenient round numbers "
    "or textbook examples unless the user asked for a hypothetical with different inputs.\n"
    "- Show intermediate calculations where helpful: substitute into formulas with the actual inputs, "
    "carry units, and sanity-check orders of magnitude. Prefer explicit arithmetic over hand-waved numbers.\n"
    "- When prior turns in this thread conflict with new user evidence, follow the new evidence and say what changed.\n"
)

# How the browser renders reasoning output (custom Markdown + optional KaTeX).
REASONING_MARKDOWN_FORMAT_AND_MATH_BLOCK = (
    "\n\nMarkdown, code fences, and math (how the UI renders your reply):\n"
    "- Use clean Markdown: `#` headings, numbered steps, bullets, and tables when they organize the answer.\n"
    "- For pipe tables, put each row on its own line (header row, a `|---|---|` separator row, then body rows); "
    "the UI parser relies on line breaks between rows.\n"
    "- For emphasis use Markdown only (`**bold**`, `*italic*`); do not emit HTML tags like `<strong>` or `<b>` — the panel renderer expects Markdown, not mixed HTML.\n"
    "- Fenced code blocks (triple backticks) are ONLY for real programming source code, terminal commands, "
    "JSON or YAML, logs, stack traces, or literal copied file contents. Pick an accurate language tag "
    "(e.g. python, bash, json); do not use ```text or plain ``` to wrap math or prose. Always close every fence you open.\n"
    "- Do NOT put math formulas, symbolic equations, or final numeric answers inside code fences. "
    "Never use a fenced \"text\" block (or any fence) for equations or conclusions — the UI will show them as "
    "misleading code boxes.\n"
    "- Simple math and substitutions: write them in ordinary Markdown prose or bullets, e.g. "
    "`Delta_call = N(d1) = 0.2815` as plain text (optionally **bold** key results), not inside fences.\n"
    "- Complex formulas only when plain text is unclear: use LaTeX delimiters sparingly — inline `$...$` or "
    "display `$$...$$` / `\\[...\\]` — not code fences. Avoid `\\boxed{...}` for final answers; state conclusions "
    "in readable Markdown instead, e.g. **Investment required:** 1,128.23 USD (prefer words or ISO currency codes "
    "so dollar signs in prose are not confused with math delimiters).\n"
    "- Do not wrap large sections in dollar signs. Fewer, shorter LaTeX fragments render more reliably than walls of TeX.\n"
)


class ReasoningAI:
    """Separate model + prompts from main VERA (CHAT3)."""

    def __init__(self) -> None:
        self.client = OpenAI()
        self.model_name = os.environ.get(
            "VERA_REASONING_SUMMARY_MODEL",
            os.environ.get("VERA_REASONING_MODEL", "gpt-5.4-mini"),
        )
        self.classifier_model = os.environ.get("VERA_REASONING_CLASSIFIER_MODEL", "gpt-5.4-mini")
        self.admin_info = load_profile_info(admin_info_path)
        self.active_user_info_path = chat2_active_user_info_path
        self.active_user_info = load_profile_info(chat2_active_user_info_path)

    # 2026-06-01 sentinel for session-scoped active-user override. Mirrors
    # the equivalent sentinel in CHAT3.VeraAI.build_messages.
    _NO_SESSION_PROFILE = object()

    def _profile_block(self, session_active_user_info=_NO_SESSION_PROFILE) -> str:
        """Build the active-user profile block injected into Work Mode
        reasoning system prompts.

        2026-06-01 identity-leak patch:
          * The "Persistent admin profile" block is REMOVED. The admin
            profile (``users_files/Nam.json``) is creator metadata, not
            current-user identity, and Work Mode used to inject it as a
            system block that the model treated as the speaker's
            identity. Same rule as main chat (CHAT3): only a session-
            scoped signed-in active-user profile may be injected.
          * When ``session_active_user_info`` is supplied (dict OR None)
            we use it EXACTLY and ignore the process-global
            ``self.active_user_info``. Legacy callers that don't supply
            the kwarg keep the old fallback to ``self.active_user_info``;
            in practice that field is None for fresh signed-out sessions
            because Work Mode never wired the runtime signin path here.
        """
        if session_active_user_info is ReasoningAI._NO_SESSION_PROFILE:
            profile_to_inject = self.active_user_info
        else:
            profile_to_inject = session_active_user_info
        active_ctx = build_profile_context(
            profile_to_inject, "Current active user profile:"
        )
        return active_ctx or ""

    def _session_history_messages(self, history: list[dict] | None, max_messages: int = 12) -> list[dict]:
        if not history:
            return []
        cleaned: list[dict] = []
        for m in history[-max_messages:]:
            role = str(m.get("role", "")).strip().lower()
            if role not in {"user", "assistant"}:
                continue
            content = str(m.get("content", "")).strip()
            if not content:
                continue
            cleaned.append({"role": role, "content": content[:2500]})
        return cleaned

    def classify_route_reasoning(self, user_text: str) -> dict:
        """Decide whether a Work Mode utterance should open the reasoning panel.

        Returns the legacy boolean/category/confidence shape PLUS the richer
        2026-05-29 reasoning-gate shape:

            {
              # Legacy keys (kept for frontend backwards compatibility):
              "prompt_reasoning": bool,
              "category": "dense_concept"|"math_heavy"|"history_heavy"|
                          "complex_request"|"none",
              "confidence": float,
              # New gate keys (added 2026-05-29):
              "route": "voice_ui" | "reasoning_panel",
              "reason": "simple_definition" | "brief_explanation"
                        | "explicit_panel_reference" | "broad_complex_topic"
                        | "complex_task" | "example_request" | "planning"
                        | "guide_writing" | "plan_assignments" | "code_problem"
                        | "explain_with_complexity" | "llm_positive"
                        | "llm_negative" | "default_voice",
              "resolved_topic": str | None,
              "target_panel": int | None,
              "source": str,         # which branch decided
              "diagnostics": dict,   # boolean signals for the gate log
            }

        The deterministic short-circuits run BEFORE the LLM in this priority:

          1. Explicit reasoning-panel / work-mode wording  → reasoning_panel
          2. Brief / quick / short / tl;dr modifier        → voice_ui
          3. Simple definition / who-is / what-is shape    → voice_ui
          4. Legacy artifact branches (example/plan/code…) → reasoning_panel
          5. Tightened bare-`explain` branch (only with complexity signal)
          6. LLM classifier fallback for everything else.

        See [reasoning_gate] log lines for per-turn provenance.
        """
        raw_text = (user_text or "").strip()
        text_l = raw_text.lower()
        diagnostics: dict = {
            "reasoning_gate_called": True,
            "explicit_panel_reference": False,
            "conversational_check_detected": False,
            "simple_definition_detected": False,
            "brief_explanation_detected": False,
            "broad_complex_topic_detected": False,
            "complex_task_detected": False,
            "bare_explain_present": False,
            "complexity_signal_present": False,
        }

        # ------------------------------------------------------------------
        # 1) Explicit panel/reasoning-space wording wins over everything.
        # ------------------------------------------------------------------
        panel_ref = self._detect_explicit_reasoning_panel_reference(raw_text)
        if panel_ref["matched"]:
            diagnostics["explicit_panel_reference"] = True
            return self._gate_result(
                route="reasoning_panel",
                reason="explicit_panel_reference",
                source="backend_deterministic_explicit_panel",
                category="complex_request",
                confidence=0.99,
                resolved_topic=panel_ref["topic"],
                target_panel=panel_ref["target_panel"],
                diagnostics=diagnostics,
            )

        # ------------------------------------------------------------------
        # 1b) Narrow conversational / check-in guard (2026-06-13). Obvious
        #     greetings, acknowledgments, and presence/hearing checks ("hello",
        #     "can you hear me?", "thank you", "got it") must answer in the
        #     Voice UI and never open a reasoning panel. Runs AFTER the explicit
        #     panel branch above so explicit Work Mode requests always win.
        # ------------------------------------------------------------------
        if self._detect_conversational_check(raw_text):
            diagnostics["conversational_check_detected"] = True
            try:
                print(
                    "[workmode_conversational_short_circuit] " + json.dumps(
                        {
                            "original_text": raw_text[:240],
                            "normalized_text": self._normalize_conversational(raw_text)[:240],
                            "route": "voice_ui",
                            "reason": "conversational_check",
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception:
                pass
            return self._gate_result(
                route="voice_ui",
                reason="conversational_check",
                source="backend_deterministic_conversational",
                category="none",
                confidence=0.97,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )

        # ------------------------------------------------------------------
        # 2) "briefly explain X" / "quickly explain X" / "in short, explain X"
        #    / "tl;dr" / "one-liner" — always Voice UI, regardless of topic
        #    breadth. The user opted out of the panel.
        # ------------------------------------------------------------------
        if self._detect_brief_modifier(text_l):
            diagnostics["brief_explanation_detected"] = True
            return self._gate_result(
                route="voice_ui",
                reason="brief_explanation",
                source="backend_deterministic_brief",
                category="none",
                confidence=0.95,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )

        # ------------------------------------------------------------------
        # 3) Simple definitional questions — "what is X?", "who is X?",
        #    "what does X mean?", "tell me what X is", "can you tell me what
        #    X is?". Always Voice UI unless explicit panel wording (handled
        #    above) was present.
        # ------------------------------------------------------------------
        if self._detect_simple_definition_question(raw_text):
            diagnostics["simple_definition_detected"] = True
            return self._gate_result(
                route="voice_ui",
                reason="simple_definition",
                source="backend_deterministic_simple_definition",
                category="none",
                confidence=0.95,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )

        # ------------------------------------------------------------------
        # 4) Legacy artifact short-circuits. These were already reasoning_panel
        #    in the pre-2026-05-29 gate and continue to be.
        # ------------------------------------------------------------------
        example_request_patterns = (
            "show an example",
            "show me an example",
            "give an example",
            "give me an example",
            "can you give an example",
            "can you give me an example",
            "could you give an example",
            "could you give me an example",
            "for example",
            "with an example",
            "example please",
        )
        if any(p in text_l for p in example_request_patterns):
            diagnostics["complex_task_detected"] = True
            return self._gate_result(
                route="reasoning_panel",
                reason="example_request",
                source="backend_deterministic_example",
                category="complex_request",
                confidence=0.99,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )

        planning_phrases = (
            "help me plan",
            "can you help me plan",
            "need a plan",
            "make a plan",
            "create a plan",
            "study plan",
            "plan my week",
            "plan my day",
            "weekly plan",
        )
        if any(p in text_l for p in planning_phrases):
            diagnostics["complex_task_detected"] = True
            return self._gate_result(
                route="reasoning_panel",
                reason="planning",
                source="backend_deterministic_planning",
                category="complex_request",
                confidence=0.97,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )
        if re.search(
            r"\b(guide|guidance|walk\s+me\s+through|coach\s+me(?:\s+on)?)\b",
            text_l,
        ) and re.search(
            r"\b(writ(?:e|ing|es|er|ten)?|essay|paper|draft|paragraph|piece|composition|story|article|"
            r"blog|email|script|thesis|outline|proofread|edit)\b",
            text_l,
        ):
            diagnostics["complex_task_detected"] = True
            return self._gate_result(
                route="reasoning_panel",
                reason="guide_writing",
                source="backend_deterministic_guide_writing",
                category="complex_request",
                confidence=0.94,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )
        if re.search(
            r"\b(plan|planning|roadmap|schedule|priorit|organize|organise)\b",
            text_l,
        ) and re.search(
            r"\b(essay|homework|assignment|exam|problem|project|class|course|and|plus|also)\b",
            text_l,
        ):
            diagnostics["complex_task_detected"] = True
            return self._gate_result(
                route="reasoning_panel",
                reason="plan_assignments",
                source="backend_deterministic_plan_assignments",
                category="complex_request",
                confidence=0.92,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )
        if re.search(
            r"\b(code|coding|program|debug|bug|error|exception|stack trace|traceback|"
            r"refactor|compile|build|runtime|failing test|unit test|integration test|"
            r"typescript|javascript|python|java|c\+\+|sql|api endpoint|null pointer|undefined)\b",
            text_l,
        ):
            diagnostics["complex_task_detected"] = True
            return self._gate_result(
                route="reasoning_panel",
                reason="code_problem",
                source="backend_deterministic_code",
                category="complex_request",
                confidence=0.96,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )

        # ------------------------------------------------------------------
        # 5a) Complex-task verb short-circuit. Verbs that strongly imply
        #     long-form output (solve, prove, derive, write, draft, etc.)
        #     route to the panel even without "explain". This fires when
        #     the user named a real artifact target ("solve this problem",
        #     "write a complaint about the ticket"). Greeting/standalone
        #     verbs without an object fall through to the LLM.
        # ------------------------------------------------------------------
        complex_task_verb = bool(
            re.search(
                r"\b(solve|prove|derive|simulate|debug|refactor|compute|"
                r"calculate|evaluate|analy[sz]e|outline|summari[sz]e|"
                r"compare|review|draft|compose|polish|rewrite|"
                r"write\s+(?:a|an|the|me|us|my|some|this|that|that\s+)|"
                r"help\s+me\s+(?:write|draft|solve|plan|organize|analy[sz]e|"
                r"prove|derive|debug|refactor|fix|build|make|prepare|"
                r"figure\s+out|work\s+(?:through|on)|put\s+together))\b",
                text_l,
            )
        )
        if complex_task_verb:
            diagnostics["complex_task_detected"] = True
            diagnostics["complexity_signal_present"] = True
            return self._gate_result(
                route="reasoning_panel",
                reason="complex_task",
                source="backend_deterministic_complex_task_verb",
                category="complex_request",
                confidence=0.94,
                resolved_topic=None,
                target_panel=None,
                diagnostics=diagnostics,
            )

        # ------------------------------------------------------------------
        # 5b) Tightened bare-`explain` branch. The 2026-05-29 spec is explicit
        #     that "explain" alone is NOT enough — we need at least one of:
        #       (a) broad / complex topic signal, OR
        #       (b) detailed / step-by-step / deep-dive wording, OR
        #       (c) explicit panel/work-mode wording (handled in step 1), OR
        #       (d) artifact verb (caught above in 5a).
        #     We also accept the nominal form ("explanation") so the user
        #     phrasing "give me a detailed explanation of …" reaches this
        #     branch. Bare "explain X" with no complexity signal falls
        #     through to the LLM with a Voice UI bias.
        # ------------------------------------------------------------------
        # English drops the trailing "i" in the nominal form ("explanation"
        # not "explaination"), so we list the verb and noun stems explicitly.
        bare_explain = bool(
            re.search(
                r"\b(?:explain(?:s|ed|ing)?|explanation(?:s)?|explanatory)\b",
                text_l,
            )
        )
        diagnostics["bare_explain_present"] = bare_explain
        if bare_explain and not re.match(r"^\s*explain\s+(?:yourself|vera|this\s+app)\b", text_l):
            broad_topic = self._detect_broad_complex_topic(text_l)
            detailed_wording = bool(
                re.search(
                    r"\b(in\s+detail|detailed(?:ly)?|step[-\s]*by[-\s]*step|"
                    r"deep[-\s]*dive|deep\s+dive|thorough(?:ly)?|long[-\s]*form|"
                    r"long\s+form|full\s+breakdown|breakdown|exhaustive(?:ly)?|"
                    r"comprehensive(?:ly)?|from\s+scratch)\b",
                    text_l,
                )
            )
            diagnostics["broad_complex_topic_detected"] = bool(broad_topic)
            diagnostics["complexity_signal_present"] = bool(broad_topic or detailed_wording)
            if broad_topic or detailed_wording:
                return self._gate_result(
                    route="reasoning_panel",
                    reason=(
                        "broad_complex_topic"
                        if broad_topic and not detailed_wording
                        else "complex_task"
                    ),
                    source="backend_deterministic_explain_with_complexity",
                    category=(
                        "history_heavy" if broad_topic == "history" else
                        "math_heavy" if broad_topic == "quant" else
                        "dense_concept"
                    ),
                    confidence=0.93,
                    resolved_topic=None,
                    target_panel=None,
                    diagnostics=diagnostics,
                )
            # Bare "explain X" with no complexity signal — fall through to
            # the LLM with the new Voice UI bias.

        # ------------------------------------------------------------------
        # 6) LLM fallback (rewritten 2026-05-29 to match the new taxonomy).
        # ------------------------------------------------------------------
        sys = (
            "Classify whether a user utterance in WORK MODE should be routed into the "
            "markdown REASONING PANEL or answered briefly via the VOICE UI.\n"
            "Default to VOICE UI unless there is a clear reason to open the panel.\n"
            "\n"
            "Return JSON only with this schema:\n"
            "{\"route\":\"voice_ui|reasoning_panel\","
            "\"reason\":\"simple_definition|brief_explanation|explicit_panel_reference|"
            "broad_complex_topic|complex_task|panel_followup|reasoning_continuation|none\","
            "\"prompt_reasoning\":true|false,"
            "\"category\":\"dense_concept|math_heavy|history_heavy|complex_request|none\","
            "\"confidence\":0.0,"
            "\"resolved_topic\":null|\"<topic>\",\"target_panel\":null|<int>}\n"
            "Set prompt_reasoning equal to (route == reasoning_panel).\n"
            "\n"
            "VOICE UI — short, conversational answers. Choose when the user:\n"
            "- asks a simple definition or factual question (\"what is X?\", \"who is X?\", "
            "\"what does X mean?\", \"can you tell me what X is?\")\n"
            "- asks for a brief / quick / short answer (\"briefly explain X\", \"in short …\", "
            "\"tl;dr\", \"one-liner\")\n"
            "- says \"explain X\" where X is a simple concept (tennis, lasagna, a bicycle, etc.) "
            "and there's no panel/detail/step-by-step wording\n"
            "- is venting, asking advice, or making small talk\n"
            "- asks a quick utility question (time, weather, current price, news headline)\n"
            "\n"
            "REASONING PANEL — open the panel only when the user:\n"
            "- explicitly names the panel / reasoning space / work mode (\"in the reasoning "
            "panel\", \"in panel 2\", \"use work mode\", \"put this in the panel\")\n"
            "- asks for a complex task — solve, prove, derive, simulate, debug, refactor, "
            "write an essay/letter/email/report, draft an outline, build a table or "
            "spreadsheet, analyze a file/image/PDF, plan a multi-item workload\n"
            "- asks for a detailed / step-by-step / deep-dive / thorough explanation\n"
            "- asks about a BROAD topic that requires structure (multi-section history, "
            "war, revolution, economic system, climate, biology system, framework, "
            "algorithm, theorem, derivation, finance pricing model)\n"
            "- asks to continue or refine work already in an open reasoning panel\n"
            "\n"
            "Important: the word \"explain\" alone is NOT enough. Pair it with a broad/complex "
            "topic, a detail-modifier, an artifact verb, or panel wording before opening the "
            "panel.\n"
            "\n"
            "Same topic, different intent — examples:\n"
            "- \"explain tennis\" → voice_ui / none (simple topic, no complexity signal)\n"
            "- \"explain tennis in the reasoning panel\" → reasoning_panel / explicit_panel_reference\n"
            "- \"explain the Vietnam War\" → reasoning_panel / broad_complex_topic\n"
            "- \"briefly explain the Vietnam War\" → voice_ui / brief_explanation\n"
            "- \"what was the Vietnam War?\" → voice_ui / simple_definition\n"
            "- \"give me a detailed explanation of the Vietnam War\" → reasoning_panel / complex_task\n"
            "- \"solve this probability problem\" → reasoning_panel / complex_task\n"
            "- \"explain this step by step\" → reasoning_panel / complex_task\n"
            "- \"can you briefly explain inflation?\" → voice_ui / brief_explanation\n"
            "- \"what is tennis?\" → voice_ui / simple_definition\n"
            "- \"can you tell me what tennis is?\" → voice_ui / simple_definition\n"
            "- \"who is Serena Williams?\" → voice_ui / simple_definition\n"
            "- \"what does inflation mean?\" → voice_ui / simple_definition\n"
            "- \"help me write a complaint about this traffic ticket\" → reasoning_panel / complex_task\n"
            "- \"draft an email to contest this ticket\" → reasoning_panel / complex_task\n"
            "- \"organize my evidence for a complaint\" → reasoning_panel / complex_task\n"
            "- \"make a plan for my homework due in 2 hours\" → reasoning_panel / complex_task\n"
            "\n"
            "If you cannot tell, prefer route=voice_ui / reason=none. When voice_ui, "
            "resolved_topic and target_panel must be null."
        )
        payload = f"User message:\n{raw_text[:4000]}"
        try:
            r = self.client.chat.completions.create(
                model=self.classifier_model,
                messages=[
                    {"role": "developer", "content": sys},
                    {"role": "user", "content": payload},
                ],
                temperature=0.1,
                max_completion_tokens=140,
            )
            raw = (r.choices[0].message.content or "").strip()
        except Exception:
            raw = ""
        parsed = _parse_json_object(
            raw,
            {
                "route": "voice_ui",
                "reason": "default_voice",
                "prompt_reasoning": False,
                "category": "none",
                "confidence": 0.0,
                "resolved_topic": None,
                "target_panel": None,
            },
        )

        # Validate/normalize the LLM output before trusting it.
        route_l = str(parsed.get("route", "voice_ui")).strip().lower()
        if route_l not in {"voice_ui", "reasoning_panel"}:
            # Back-compat: if the LLM ignored "route" and only set prompt_reasoning,
            # mirror it.
            route_l = "reasoning_panel" if bool(parsed.get("prompt_reasoning")) else "voice_ui"
        reason_l = str(parsed.get("reason", "")).strip().lower()
        if reason_l not in {
            "simple_definition", "brief_explanation", "explicit_panel_reference",
            "broad_complex_topic", "complex_task", "panel_followup",
            "reasoning_continuation", "none", "",
        }:
            reason_l = "none"
        if not reason_l:
            reason_l = "llm_positive" if route_l == "reasoning_panel" else "llm_negative"
        category = str(parsed.get("category", "none")).strip().lower()
        if category not in {
            "dense_concept",
            "math_heavy",
            "history_heavy",
            "complex_request",
            "none",
        }:
            category = "none"
        confidence = parsed.get("confidence", 0.0)
        try:
            confidence = float(confidence)
        except Exception:
            confidence = 0.0
        resolved_topic = parsed.get("resolved_topic")
        if not isinstance(resolved_topic, str) or not resolved_topic.strip():
            resolved_topic = None
        else:
            resolved_topic = resolved_topic.strip()[:120]
        target_panel = parsed.get("target_panel")
        try:
            target_panel = int(target_panel) if target_panel is not None else None
        except Exception:
            target_panel = None
        if route_l == "voice_ui":
            # Voice UI never carries a panel target.
            resolved_topic = resolved_topic if reason_l == "explicit_panel_reference" else None
            target_panel = None

        return self._gate_result(
            route=route_l,
            reason=reason_l,
            source="backend_llm_classifier",
            category=category,
            confidence=max(0.0, min(1.0, confidence)),
            resolved_topic=resolved_topic,
            target_panel=target_panel,
            diagnostics=diagnostics,
        )

    # ----------------------------------------------------------------------
    # Reasoning gate helpers (2026-05-29)
    # ----------------------------------------------------------------------
    # Compiled regexes are module-level constants on the instance — they're
    # used per request so we want JIT-free matching.

    # 2026-06-13 — narrow Work Mode false-positive guard. Obvious short
    # greetings / acknowledgments / presence-or-hearing checks must answer in
    # the Voice UI, never open a reasoning panel. The detector is deliberately
    # conservative: it only fires when the ENTIRE normalized utterance is made
    # of whitelisted conversational chunks, there is no explicit panel/work-mode
    # wording, and the phrase is short. This keeps real "can you …" requests
    # ("can you solve this?", "can you start a 10 minute timer?") out of the
    # shortcut because their non-conversational tail never fully consumes.
    _CONVERSATIONAL_EXPLICIT_TRIGGER_RE = re.compile(
        r"\b(?:reasoning\s+(?:panel|space|tab|page)|work\s*mode|workmode|"
        r"panel\s*#?\s*\d+|new\s+panel|in\s+(?:the\s+)?panel|"
        r"in\s+(?:the\s+)?reasoning|think\s+through|plan\s+in\s+the\s+panel|"
        r"use\s+work\s+mode)\b",
        re.IGNORECASE,
    )

    _CONVERSATIONAL_MAX_WORDS = 8

    # Ordered longest-first so multi-word phrases consume before single tokens.
    _CONVERSATIONAL_PHRASES = (
        "can you hear me now",
        "can you hear me",
        "could you hear me",
        "do you hear me",
        "can you read me",
        "could you read me",
        "are you still there",
        "are you there",
        "are you here",
        "you still there",
        "you there",
        "still there",
        "you with me",
        "thank you so much",
        "thank you",
        "thank u",
        "hello there",
        "hi there",
        "hey there",
        "mic check",
        "sound check",
        "check check",
        "sounds good",
        "got it",
        "all good",
        "whats up",
        "what up",
        "sup",
        "hello",
        "hullo",
        "hi",
        "hey",
        "hiya",
        "heya",
        "yo",
        "testing",
        "test",
        "thanks",
        "thx",
        "ty",
        "okay",
        "ok",
        "cool",
        "alright",
        "gotcha",
    )

    _BRIEF_MODIFIER_RE = re.compile(
        r"\b(?:brief(?:ly)?|short(?:ly)?|quick(?:ly)?|in\s+short|in\s+a\s+sentence|"
        r"in\s+one\s+sentence|one[-\s]*liner|one\s*sentence|tl;?dr|tldr|"
        r"give\s+me\s+the\s+(?:short|brief|quick)\s+(?:version|answer)|"
        r"summari[sz]e\s+(?:briefly|in\s+one\s+sentence)|"
        r"in\s+a\s+(?:few|couple\s+of)\s+(?:words|sentences))\b",
        re.IGNORECASE,
    )

    _SIMPLE_DEFINITION_RES = (
        # what is X / what's X / whats X — captures non-greedy X for topic seeding.
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"(?:tell\s+me\s+)?"
                   r"what(?:'s|s|\s+is|\s+are|\s+was|\s+were)\s+(?P<topic>.+?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
        # who is X / who was X
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"(?:tell\s+me\s+)?"
                   r"who(?:'s|s|\s+is|\s+are|\s+was|\s+were)\s+(?P<topic>.+?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
        # what does X mean / what's the meaning of X
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"what\s+does\s+(?P<topic>.+?)\s+mean\s*[?.!]*\s*$",
                   re.IGNORECASE),
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"what(?:'s|s|\s+is)\s+the\s+meaning\s+of\s+(?P<topic>.+?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
        # tell me what X is / can you tell me what X is
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"tell\s+me\s+what\s+(?P<topic>.+?)\s+(?:is|are|was|were|means?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
        # tell me who X is
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"tell\s+me\s+who\s+(?P<topic>.+?)\s+(?:is|are|was|were)\s*[?.!]*\s*$",
                   re.IGNORECASE),
        # define X / define the term X
        re.compile(r"^\s*(?:can\s+you\s+|could\s+you\s+|please\s+)?"
                   r"define\s+(?:the\s+(?:term|word)\s+)?(?P<topic>.+?)\s*[?.!]*\s*$",
                   re.IGNORECASE),
    )

    _EXPLICIT_PANEL_REFERENCE_RE = re.compile(
        # in / into / using / on / via the reasoning space|panel|tab — also
        # accepts "in panel 2", "in tab 3", "in the second panel", and the
        # imperative forms "put/write/answer/explain ... in (the) panel".
        r"\b(?:in|into|using|on|via|inside)\s+(?:the\s+)?"
        r"(?:reasoning\s+(?:panel|space|tab|page)|panel|tab|space|page|work\s*mode|workmode)"
        r"(?:\s*#?\s*(?P<panel_num>\d+)|\s+(?P<panel_ord>first|second|third|fourth|fifth|sixth|seventh|eighth))?\b",
        re.IGNORECASE,
    )

    _EXPLICIT_PANEL_IMPERATIVE_RE = re.compile(
        # "use the panel", "use work mode", "use the reasoning space",
        # "open a new panel and explain", "write this in panel N", and the
        # stacked-determiner variants ("open a new panel", "open another new
        # reasoning panel"). The determiner + adjective layers are both
        # optional so a bare "open panel" matches too.
        r"\b(?:use|open|launch|spin\s*up|fire\s*up)\s+(?:up\s+)?"
        r"(?:(?:a|another|the|one\s+more|some)\s+)?"
        r"(?:(?:new|extra|additional|empty|fresh|another)\s+)?"
        r"(?:reasoning\s+(?:panel|space|tab|page)|panel|tab|work\s*mode|workmode)\b",
        re.IGNORECASE,
    )

    _EXPLICIT_PANEL_PUT_RE = re.compile(
        # "put/place/write/answer/show this|that|it in (the) panel/reasoning"
        r"\b(?:put|place|write|answer|show|drop|paste)\s+"
        r"(?:this|that|it|them|the\s+answer|the\s+explanation|an?\s+explanation\s+of\s+(?P<topic>.+?))"
        r"\s+(?:in|into|onto|on)\s+(?:the\s+)?"
        r"(?:reasoning\s+(?:panel|space|tab|page)|panel|tab|space|page|work\s*mode|workmode)"
        r"(?:\s*#?\s*(?P<panel_num>\d+)|\s+(?P<panel_ord>first|second|third|fourth|fifth|sixth|seventh|eighth))?",
        re.IGNORECASE,
    )

    # Broad / complex topic noun catalog. Returns the topic FAMILY when matched
    # so the gate can stamp `category=history_heavy|math_heavy|dense_concept`.
    _BROAD_TOPIC_FAMILIES: tuple[tuple[str, "re.Pattern[str]"], ...] = (
        ("history", re.compile(
            r"\b(?:vietnam\s+war|world\s+war(?:\s+(?:i|ii|1|2|one|two))?|wwi+|"
            r"cold\s+war|civil\s+war|french\s+revolution|american\s+revolution|"
            r"industrial\s+revolution|russian\s+revolution|cuban\s+(?:missile\s+)?crisis|"
            r"holocaust|crusades|reformation|renaissance|enlightenment|"
            r"colonialism|imperialism|treaty\s+of\s+\w+|fall\s+of\s+\w+|"
            r"rise\s+of\s+\w+|war\s+of\s+\w+)\b", re.IGNORECASE)),
        ("quant", re.compile(
            r"\b(?:black[-\s]*scholes|binomial(?:\s+(?:lattice|tree|model))?|"
            r"monte[-\s]*carlo|calculus|linear\s+algebra|differential\s+equation|"
            r"partial\s+differential\s+equation|ode|pde|fourier|laplace|"
            r"bayes(?:ian|'?s)\s+(?:theorem|rule)?|"
            r"central\s+limit\s+theorem|hypothesis\s+test|regression|"
            r"probability\s+(?:problem|distribution|theory)|"
            r"theorem|proof|derivation|algorithm(?:s|ic)?|complexity\s+class|"
            r"dynamic\s+programming|graph\s+theory|"
            r"capital\s+asset\s+pricing\s+model|capm|"
            r"portfolio\s+optimization|efficient\s+frontier)\b", re.IGNORECASE)),
        ("science", re.compile(
            r"\b(?:climate\s+change|global\s+warming|greenhouse\s+effect|"
            r"theory\s+of\s+relativity|general\s+relativity|special\s+relativity|"
            r"quantum\s+(?:mechanics|computing|field\s+theory|entanglement)|"
            r"string\s+theory|big\s+bang|evolution(?:ary\s+theory)?|"
            r"natural\s+selection|dna\s+replication|protein\s+folding|"
            r"krebs\s+cycle|cellular\s+respiration|photosynthesis|mitosis|meiosis|"
            r"nervous\s+system|immune\s+system|cardiovascular\s+system|"
            r"plate\s+tectonics|ecosystem)\b", re.IGNORECASE)),
        ("economics", re.compile(
            r"\b(?:economic\s+(?:recession|depression|crisis|cycle|policy)|"
            r"great\s+depression|2008\s+financial\s+crisis|stagflation|"
            r"inflation\s+(?:dynamics|mechanism|causes)|monetary\s+policy|"
            r"fiscal\s+policy|supply[-\s]*side|keynesian\s+economics|"
            r"comparative\s+advantage|game\s+theory|nash\s+equilibrium|"
            r"market\s+failure|externalit(?:y|ies))\b", re.IGNORECASE)),
    )

    def _detect_brief_modifier(self, text_l: str) -> bool:
        if not text_l:
            return False
        return bool(self._BRIEF_MODIFIER_RE.search(text_l))

    def _detect_simple_definition_question(self, raw_text: str) -> bool:
        s = (raw_text or "").strip()
        if not s:
            return False
        # Only treat it as a "simple definition" when the whole utterance fits
        # the shape AND no panel wording is present (that's gated upstream).
        # Conservative length cap so a paragraph dressed as "what is …" still
        # falls through to the LLM/explain branch.
        if len(s) > 160:
            return False
        for pat in self._SIMPLE_DEFINITION_RES:
            if pat.match(s):
                return True
        return False

    def _normalize_conversational(self, raw_text: str) -> str:
        """Lowercase, drop apostrophes/punctuation, collapse whitespace."""
        s = (raw_text or "").lower()
        s = s.replace("'", "").replace("\u2019", "")
        s = re.sub(r"[^a-z0-9\s]", " ", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s

    def _detect_conversational_check(self, raw_text: str) -> bool:
        """True only for obvious short greeting / ack / presence-check phrases.

        The whole normalized utterance must be composed exclusively of
        whitelisted conversational chunks, contain no explicit panel/work-mode
        wording, and be short. Real requests ("can you solve this?") fail
        because their non-conversational remainder never fully consumes.
        """
        s = self._normalize_conversational(raw_text)
        if not s:
            return False
        if self._CONVERSATIONAL_EXPLICIT_TRIGGER_RE.search(s):
            return False
        if len(s.split()) > self._CONVERSATIONAL_MAX_WORDS:
            return False
        remaining = s
        consumed_any = False
        while remaining:
            matched = False
            for phrase in self._CONVERSATIONAL_PHRASES:
                if remaining == phrase or remaining.startswith(phrase + " "):
                    remaining = remaining[len(phrase):].strip()
                    matched = True
                    consumed_any = True
                    break
            if not matched:
                return False
        return consumed_any

    def _detect_explicit_reasoning_panel_reference(self, raw_text: str) -> dict:
        """Return ``{matched, topic, target_panel}`` for explicit panel wording.

        topic is None unless the matching regex captured one. target_panel is
        an integer when "panel 2" / "second panel" / "panel #3" / etc. was
        named, else None.
        """
        s = (raw_text or "").strip()
        empty = {"matched": False, "topic": None, "target_panel": None}
        if not s:
            return empty
        ord_map = {
            "first": 1, "second": 2, "third": 3, "fourth": 4,
            "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
        }
        # "put|place|write|answer X in (the) panel N" — topic + panel.
        m_put = self._EXPLICIT_PANEL_PUT_RE.search(s)
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
                target = ord_map.get(ordn)
            return {"matched": True, "topic": topic, "target_panel": target}
        # "in (the) (reasoning) panel/space/tab N"
        m_in = self._EXPLICIT_PANEL_REFERENCE_RE.search(s)
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
                target = ord_map.get(ordn)
            return {"matched": True, "topic": None, "target_panel": target}
        # "use the panel", "open a new panel and explain"
        if self._EXPLICIT_PANEL_IMPERATIVE_RE.search(s):
            return {"matched": True, "topic": None, "target_panel": None}
        return empty

    def _detect_broad_complex_topic(self, text_l: str) -> str | bool:
        """Return the topic family name when a broad topic is referenced, else False."""
        if not text_l:
            return False
        for family, pat in self._BROAD_TOPIC_FAMILIES:
            if pat.search(text_l):
                return family
        return False

    def _gate_result(
        self,
        *,
        route: str,
        reason: str,
        source: str,
        category: str,
        confidence: float,
        resolved_topic: str | None,
        target_panel: int | None,
        diagnostics: dict,
    ) -> dict:
        diagnostics = dict(diagnostics or {})
        diagnostics["reasoning_gate_result"] = route
        diagnostics["reasoning_gate_reason"] = reason
        diagnostics["route_source"] = source
        try:
            print(
                "[reasoning_gate] " + json.dumps(
                    {
                        "route": route,
                        "reason": reason,
                        "source": source,
                        "category": category,
                        "confidence": confidence,
                        "resolved_topic": resolved_topic,
                        "target_panel": target_panel,
                        "diagnostics": diagnostics,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        return {
            "prompt_reasoning": route == "reasoning_panel",
            "category": category,
            "confidence": max(0.0, min(1.0, float(confidence or 0.0))),
            "route": route,
            "reason": reason,
            "resolved_topic": resolved_topic,
            "target_panel": target_panel,
            "source": source,
            "diagnostics": diagnostics,
        }

    # ----------------------------------------------------------------------
    # Math / finance / stats problem-mode classifier (code-first vs prose).
    # ----------------------------------------------------------------------
    # Routes a reasoning turn into one of:
    #   computational_numeric    -> use Python sandbox first, then explain
    #   conceptual_explanation   -> normal Markdown reasoning (no code)
    #   symbolic_derivation_or_proof -> normal Markdown reasoning (no code)
    #   mixed                    -> Python for the numeric piece, prose around it
    # `final_route` maps that decision to the server-side action:
    #   code_first_reasoning | normal_reasoning | chat | clarification
    _CONCEPT_VERBS_RE = re.compile(
        r"\b(explain|describe|define|what\s+is|what\s+are|intuition|overview|"
        r"introduce|introduction\s+to|why\s+does|why\s+do|how\s+does|how\s+do)\b",
        re.IGNORECASE,
    )
    _PROOF_VERBS_RE = re.compile(
        r"\b(prove|proof|derive|derivation|show\s+that|verify\s+that|"
        r"why\s+(?:does|do)\s+.*\s+hold|algebraic\s+steps|symbolic(?:ally)?)\b",
        re.IGNORECASE,
    )
    _COMPUTE_VERBS_RE = re.compile(
        r"\b(calculate|compute|evaluate|find\s+(?:the\s+)?(?:value|price|premium|"
        r"probability|expected\s+value|mean|variance|standard\s+deviation|maximum|"
        r"minimum|max|min|drawdown|delta|gamma|theta|vega|rho|var|cvar|sharpe|"
        r"yield|return|payoff|npv|irr|present\s+value|future\s+value)|"
        r"price\s+(?:this|the|an?)\s+(?:option|call|put|bond|swap|derivative)|"
        r"solve\s+(?:this|the|a|for)|"
        r"work\s+out|crunch|run\s+the\s+numbers|"
        r"how\s+much\s+(?:is|would|will)|what\s+(?:is|will|would)\s+the\s+value|"
        r"plot|simulate|monte\s*carlo)\b",
        re.IGNORECASE,
    )
    _NUMERIC_INPUTS_RE = re.compile(
        r"(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*[-+]?\d|"  # `S=100`, `K = 105`
        r"[\$£€]\s*\d|"                              # `$100`
        r"\b\d+(?:\.\d+)?\s*%|"                      # `0.5%` or `20%`
        r"\b\d{2,}\b)"                                # bare 2+ digit number
    )
    _NUMERIC_DOMAIN_RE = re.compile(
        r"\b(black[-\s]?scholes|binomial(?:\s+(?:tree|lattice|model))?|trinomial|"
        r"monte\s*carlo|delta\s+hedg(?:e|ing)|gamma\s+hedg(?:e|ing)|"
        r"option\s+price|call\s+price|put\s+price|premium|payoff|var\b|cvar|"
        r"value[-\s]?at[-\s]?risk|sharpe|sortino|treynor|drawdown|"
        r"npv|irr|present\s+value|future\s+value|amortiz|annuity|bond\s+price|"
        r"yield\s+to\s+maturity|ytm|duration|convexity|"
        r"poisson|binomial\s+distribution|normal\s+distribution|"
        r"expected\s+value|variance|covariance|correlation|regression|"
        r"hypothesis\s+test|p[-\s]?value|chi[-\s]?square|t[-\s]?test|z[-\s]?test|"
        r"confidence\s+interval|standard\s+deviation|standard\s+error|"
        r"derivative|integral|integrate|differentiate|matrix\s+(?:multiply|inverse)|"
        r"eigen(?:value|vector)|determinant|solve\s+(?:the\s+)?(?:equation|system))\b",
        re.IGNORECASE,
    )

    def _math_classify_deterministic(self, text: str, has_attachment: bool) -> dict | None:
        """Cheap rule-based shortcuts that bypass the LLM classifier when obvious."""
        raw = (text or "").strip()
        if not raw:
            return None
        low = raw.lower()
        trigger: list[str] = []
        has_proof = bool(self._PROOF_VERBS_RE.search(low))
        has_concept = bool(self._CONCEPT_VERBS_RE.search(low))
        has_compute = bool(self._COMPUTE_VERBS_RE.search(low))
        has_numbers = bool(self._NUMERIC_INPUTS_RE.search(raw))
        has_numeric_domain = bool(self._NUMERIC_DOMAIN_RE.search(low))

        if has_proof:
            trigger.append("proof_verb")
        if has_concept:
            trigger.append("concept_verb")
        if has_compute:
            trigger.append("compute_verb")
        if has_numbers:
            trigger.append("numeric_inputs")
        if has_numeric_domain:
            trigger.append("numeric_domain")

        # Pure proof / derivation request → no code.
        if has_proof and not has_compute and not has_numbers:
            return {
                "domain": "math",
                "problem_mode": "symbolic_derivation_or_proof",
                "calculation_required": False,
                "code_required": False,
                "reason": "Proof / derivation request — symbolic, no numeric output expected.",
                "numeric_targets": [],
                "variables_detected": {},
                "missing_variables": [],
                "trigger_terms": trigger,
                "_deterministic": True,
            }

        # Pure conceptual ask ("explain X", "what is delta hedging") without
        # any compute verb or numeric inputs → no code.
        if has_concept and not has_compute and not has_numbers:
            domain = "finance" if has_numeric_domain and re.search(
                r"\b(option|hedg|premium|black[-\s]?scholes|binomial|delta|gamma|vega|theta|rho|"
                r"npv|irr|bond|yield|portfolio|stock|equity)\b",
                low,
            ) else "general"
            return {
                "domain": domain,
                "problem_mode": "conceptual_explanation",
                "calculation_required": False,
                "code_required": False,
                "reason": "Conceptual explanation request — no numeric answer required.",
                "numeric_targets": [],
                "variables_detected": {},
                "missing_variables": [],
                "trigger_terms": trigger,
                "_deterministic": True,
            }

        # Mixed: explain AND compute in the same turn.
        if has_concept and has_compute:
            return {
                "domain": "finance" if has_numeric_domain else "math",
                "problem_mode": "mixed",
                "calculation_required": True,
                "code_required": True,
                "reason": "Mixed explanation + numeric request — code only for the numeric part.",
                "numeric_targets": [],
                "variables_detected": {},
                "missing_variables": [],
                "trigger_terms": trigger,
                "_deterministic": True,
            }

        # Strong computational signal: compute verb with numeric inputs OR a
        # well-known numeric finance/stats model in the prompt.
        if has_compute and (has_numbers or has_numeric_domain or has_attachment):
            return {
                "domain": "finance" if has_numeric_domain else "math",
                "problem_mode": "computational_numeric",
                "calculation_required": True,
                "code_required": True,
                "reason": "Compute/solve verb with numeric inputs or named numeric model.",
                "numeric_targets": [],
                "variables_detected": {},
                "missing_variables": [],
                "trigger_terms": trigger,
                "_deterministic": True,
            }

        return None  # Fall through to LLM classifier.

    def classify_math_problem_mode(
        self,
        user_text: str,
        attachment_context: str | None = None,
    ) -> dict:
        """Return problem-mode classification used by the reasoning_stream router."""
        raw = (user_text or "").strip()
        has_attachment = bool((attachment_context or "").strip())
        empty_default = {
            "domain": "general",
            "problem_mode": "conceptual_explanation",
            "calculation_required": False,
            "code_required": False,
            "reason": "Empty input.",
            "numeric_targets": [],
            "variables_detected": {},
            "missing_variables": [],
            "trigger_terms": [],
            "final_route": "normal_reasoning",
        }
        if not raw and not has_attachment:
            return empty_default

        # 1) Deterministic shortcuts first.
        det = self._math_classify_deterministic(raw, has_attachment)
        if det is not None:
            det["final_route"] = self._resolve_math_final_route(det)
            return det

        # 2) LLM classifier with strict JSON schema.
        sys = (
            "You classify a single Work-Mode reasoning request to decide whether to use a "
            "Python sandbox for the answer.\n"
            "Return JSON ONLY with this exact shape (no markdown, no prose):\n"
            "{\n"
            '  "domain": "math|finance|statistics|probability|general",\n'
            '  "problem_mode": "computational_numeric|conceptual_explanation|symbolic_derivation_or_proof|mixed",\n'
            '  "calculation_required": true|false,\n'
            '  "code_required": true|false,\n'
            '  "reason": "...",\n'
            '  "numeric_targets": [],\n'
            '  "variables_detected": {},\n'
            '  "missing_variables": [],\n'
            '  "trigger_terms": []\n'
            "}\n\n"
            "Rules:\n"
            "- computational_numeric: a concrete numeric/computational answer is required "
            "(prices, probabilities, expected values, Greeks, payoff tables, drawdowns, etc.). "
            "Set code_required = true.\n"
            "- conceptual_explanation: explain a concept, model, or intuition. "
            "Set code_required = false.\n"
            "- symbolic_derivation_or_proof: prove / derive / show algebraic steps. "
            "Set code_required = false UNLESS the user also asks for a numeric check.\n"
            "- mixed: explanation + numeric calculation in the same request. "
            "Set code_required = true (code only for the numeric part).\n"
            "- variables_detected: stated quantitative inputs (e.g. {\"S\":100,\"K\":105,\"r\":0.05}). "
            "Use the user's wording; do not invent values.\n"
            "- missing_variables: inputs the numeric method would need but were not provided.\n"
            "- numeric_targets: short labels for the requested numeric outputs "
            "(e.g. [\"call_price\", \"delta\"]).\n"
            "- trigger_terms: which words/phrases in the user request drove the decision.\n"
            "- Do NOT set code_required = true for emotional support, general advice, history, "
            "writing/essay planning, simple definitions, or purely conceptual math/finance asks.\n"
            "- When the user uploads a numeric problem image/file and asks for the answer, prefer "
            "computational_numeric or mixed.\n"
            "- Never include extra keys, comments, or trailing commas."
        )
        attach_hint = ""
        if has_attachment:
            ac = str(attachment_context).strip()
            attach_hint = (
                "\n\nAttachment excerpt (for context only; do not copy verbatim into the JSON):\n"
                + ac[:6000]
            )
        payload = f"User request:\n{raw[:4000]}{attach_hint}"
        try:
            r = self.client.chat.completions.create(
                model=self.classifier_model,
                messages=[
                    {"role": "developer", "content": sys},
                    {"role": "user", "content": payload},
                ],
                temperature=0.0,
                max_completion_tokens=400,
            )
            raw_json = (r.choices[0].message.content or "").strip()
        except Exception as e:
            print(f"[MATH_PROBLEM_CLASSIFY_DEBUG][classifier_error] {type(e).__name__}: {e}")
            fallback = dict(empty_default)
            fallback["reason"] = f"Classifier error: {type(e).__name__}; defaulting to normal reasoning."
            return fallback

        parsed = _parse_json_object(raw_json, {})
        out = self._normalize_math_classifier_output(parsed)
        out["final_route"] = self._resolve_math_final_route(out)
        return out

    def _normalize_math_classifier_output(self, parsed: dict) -> dict:
        """Coerce LLM output to the strict schema (defaults + enum clamps)."""
        domain = str(parsed.get("domain", "general")).strip().lower()
        if domain not in {"math", "finance", "statistics", "probability", "general"}:
            domain = "general"
        mode = str(parsed.get("problem_mode", "conceptual_explanation")).strip().lower()
        if mode not in {
            "computational_numeric",
            "conceptual_explanation",
            "symbolic_derivation_or_proof",
            "mixed",
        }:
            mode = "conceptual_explanation"
        calc_required = bool(parsed.get("calculation_required", mode in {"computational_numeric", "mixed"}))
        code_required = bool(parsed.get("code_required", mode in {"computational_numeric", "mixed"}))
        # Safety net: a `conceptual_explanation` or `symbolic_derivation_or_proof`
        # bucket should not flip on code unless the LLM explicitly insisted.
        if mode == "conceptual_explanation" and not parsed.get("code_required"):
            code_required = False
            calc_required = False
        if mode == "symbolic_derivation_or_proof" and not parsed.get("code_required"):
            code_required = False

        def _as_str_list(val) -> list[str]:
            if not isinstance(val, list):
                return []
            out: list[str] = []
            for item in val[:24]:
                try:
                    s = str(item).strip()
                except Exception:
                    continue
                if s:
                    out.append(s[:120])
            return out

        def _as_dict(val) -> dict:
            if not isinstance(val, dict):
                return {}
            out: dict = {}
            for k, v in list(val.items())[:32]:
                key = str(k).strip()[:48]
                if not key:
                    continue
                try:
                    out[key] = v if isinstance(v, (int, float, bool)) else str(v)[:200]
                except Exception:
                    continue
            return out

        return {
            "domain": domain,
            "problem_mode": mode,
            "calculation_required": calc_required,
            "code_required": code_required,
            "reason": str(parsed.get("reason", "")).strip()[:500],
            "numeric_targets": _as_str_list(parsed.get("numeric_targets")),
            "variables_detected": _as_dict(parsed.get("variables_detected")),
            "missing_variables": _as_str_list(parsed.get("missing_variables")),
            "trigger_terms": _as_str_list(parsed.get("trigger_terms")),
        }

    def _resolve_math_final_route(self, out: dict) -> str:
        """Map a classifier result to the server-side route used by reasoning_stream."""
        if not out.get("code_required"):
            return "normal_reasoning"
        # If we KNOW code is required but the user did not supply the inputs
        # the numeric method needs, prefer asking for them before running code.
        # (`mixed` is allowed to proceed with stated assumptions; `computational_numeric`
        # with no variables AT ALL and no attachment is the strictest case.)
        if (
            out.get("problem_mode") == "computational_numeric"
            and out.get("missing_variables")
            and not out.get("variables_detected")
        ):
            return "clarification"
        return "code_first_reasoning"

    def generate_voice_digest_code_first(
        self,
        user_text: str,
        computed_result: dict | None = None,
        success: bool = True,
    ) -> str:
        """Spoken Stage-2 digest for the code-first path. Never reads code aloud."""
        if not success:
            return (
                "I worked through the calculation in the reasoning panel but didn't get to a final number; "
                "the setup is there so you can check the inputs and tell me what to adjust."
            )
        label = ""
        value_str = ""
        if isinstance(computed_result, dict):
            label = str(
                computed_result.get("label")
                or computed_result.get("name")
                or computed_result.get("target")
                or ""
            ).strip()
            val = (
                computed_result.get("final_answer")
                if "final_answer" in computed_result
                else computed_result.get("value")
            )
            if val is not None:
                try:
                    if isinstance(val, (int, float)):
                        value_str = f"{val:.4f}".rstrip("0").rstrip(".")
                    else:
                        value_str = str(val)[:80]
                except Exception:
                    value_str = str(val)[:80]
        if label and value_str:
            return (
                f"Done — I worked out {label} and the value is in the reasoning panel."
            )
        if value_str:
            return (
                f"Done — I worked it out and the value is in the reasoning panel."
            )
        return "Done — I worked it out and put the final value in the reasoning panel."

    def classify_thread_continuation(self, anchor_user_text: str, new_user_text: str) -> dict:
        """Small router: should NEW stay on the same reasoning panel as ANCHOR (same user thread)?"""
        anchor = (anchor_user_text or "").strip()
        new_t = (new_user_text or "").strip()
        if not anchor or not new_t:
            return {"continue_prior_lane": False}
        if new_t.lower() == anchor.lower():
            return {"continue_prior_lane": False}
        sys = (
            "Decide if NEW continues the SAME topic/thread as ANCHOR (same reasoning panel).\n"
            'Return JSON only: {"continue_prior_lane":true|false}\n'
            "True: follow-ups that presuppose ANCHOR (clarify, elaborate, who/why/how/when, "
            "'the north/the south/the communists/the allies', 'what happened next', "
            "'why did they lose', comparisons inside the SAME conflict or lesson).\n"
            "Also TRUE when ANCHOR is homework, writing, planning, study, or explanation work and NEW asks for "
            "next steps, more detail, revisions, critiques, structure, timing, or short reactive follow-ups "
            "(e.g. 'why', 'how', 'what about section 2', 'can you expand on that').\n"
            "Critical: ambiguous geography ('north won', 'how did the north win') MUST "
            "follow ANCHOR when ANCHOR names a specific war or country conflict — "
            "e.g. ANCHOR Vietnam War → north means North Vietnam / DRV / NLF side, NOT U.S. Civil War.\n"
            "False: NEW names a different subject (another war, another math model, unrelated definition), "
            "explicitly switches (e.g. 'actually explain the Civil War'), or clearly starts a new lesson "
            "(different named theorem or pricing method).\n"
            "Examples: ANCHOR about Vietnam War; NEW 'how did the north win?' → true.\n"
            "ANCHOR Vietnam War; NEW 'what is the squeeze theorem?' → false.\n"
            "When unsure about same-thread writing/homework follow-ups, prefer true."
        )
        payload = (
            "ANCHOR (previous user request):\n"
            f"{anchor[:3500]}\n\nNEW (current user message):\n{new_t[:1800]}"
        )
        r = self.client.chat.completions.create(
            model=self.classifier_model,
            messages=[
                {"role": "developer", "content": sys},
                {"role": "user", "content": payload},
            ],
            temperature=0,
            max_completion_tokens=48,
        )
        raw = (r.choices[0].message.content or "").strip()
        parsed = _parse_json_object(raw, {"continue_prior_lane": False})
        return {"continue_prior_lane": bool(parsed.get("continue_prior_lane", False))}

    def generate_voice_digest(
        self,
        user_text: str,
        history: list[dict] | None = None,
        attachment_context: str | None = None,
    ) -> str:
        """Short spoken summary for VERA (no markdown)."""
        sys = (
            "You produce a concise spoken digest (2–4 short sentences) of how you would help, "
            "without markdown, bullets, or meta commentary. "
            "Do not mention models, panels, or 'reasoning space'.\n"
            "Do not waste sentences on greetings or 'yes I can help' — jump straight to the substance "
            "(what the work is about and how you'll approach it)."
        )
        profile = self._profile_block()
        if profile:
            sys += "\n\n" + profile
        if attachment_context and str(attachment_context).strip():
            ac = str(attachment_context).strip()
            sys += (
                "\n\nA file was uploaded this turn. Excerpt from that file (ground your digest ONLY in this "
                "material plus the user's words; ignore unrelated topics from earlier chat):\n"
                + ac[:120000]
            )
            if "KNOWN_VARIABLES_AFTER_MERGE" in ac:
                sys += (
                    "\n\nIf KNOWN_VARIABLES_AFTER_MERGE appears in that excerpt, treat those lines as merged "
                    "inputs from multiple uploads — do not imply the user must still supply strike, expiry, "
                    "option type, or spot when those fields already have concrete values."
                )
            if "ACTIVE_LANE_PRIOR_CONTEXT" in ac or "FOLLOW_UP_RULES" in ac:
                sys += (
                    "\n\nThe reasoning lane already has a completed on-screen solution. Summarize follow-up work "
                    "(e.g. code in the panel) without asking the user to re-paste the full problem."
                )
        messages = [{"role": "developer", "content": sys}]
        messages.extend(self._session_history_messages(history, max_messages=10))
        messages.append({"role": "user", "content": user_text.strip()[:12000]})
        r = self.client.chat.completions.create(
            model=self.model_name,
            messages=messages,
            temperature=0.35,
            max_completion_tokens=320,
        )
        return (r.choices[0].message.content or "").strip() or (
            "I'll walk through that with you in more detail on screen."
        )

    def generate_stream_markdown(
        self,
        user_text: str,
        attachment_context: str | None = None,
        history: list[dict] | None = None,
    ):
        sys = (
            "You are a careful reasoning assistant (work mode).\n"
            "Respond in clean Markdown: headings, numbered steps, bullet lists, and tables when they help structure the answer. "
            "Use fenced code blocks only for real source code, shell commands, JSON, logs, or pasted file excerpts — "
            "never for math or final answers (see formatting rules below).\n"
            "Be thorough like ChatGPT long-form answers. No spoken-voice filler.\n"
            "Do not mention that you are a second model or internal routing.\n"
            "Never use the first `#` heading as a generic assistant reply like "
            "'Yes', 'Sure', 'I can help', or 'I can help you work through it'. "
            "The first `#` line must name the actual topic or task (e.g. the homework section, theorem, "
            "dataset, or document subject). Put any brief reassurance after that title or omit it.\n"
            "If you include a short orientation sentence before the first `#`, keep it to one line without `#`."
            + REASONING_MARKDOWN_GROUNDING_BLOCK
            + REASONING_MARKDOWN_FORMAT_AND_MATH_BLOCK
        )
        profile = self._profile_block()
        if profile:
            sys += "\n\n" + profile
        if attachment_context:
            ac = str(attachment_context)
            sys += (
                "\n\nAttachment context (already extracted):\n"
                + ac[:120000]
                + "\n\nYou MUST ground every part of your answer in this attachment and the user's question. "
                "Quote or reuse specific figures, labels, and conclusions from the attachment when answering. "
                "Do not drift into unrelated topics from earlier conversation unless the user explicitly asks."
            )
            if "ACTIVE_LANE_PRIOR_CONTEXT" in ac or "FOLLOW_UP_RULES" in ac:
                sys += (
                    "\n\nWhen ACTIVE_LANE_PRIOR_CONTEXT or FOLLOW_UP_RULES is present, the panel already has a "
                    "completed solution — treat the user message as a follow-up; do not ask for the full problem again."
                )
        messages = [{"role": "developer", "content": sys}]
        messages.extend(self._session_history_messages(history, max_messages=12))
        messages.append({"role": "user", "content": user_text.strip()[:12000]})
        stream = self.client.chat.completions.create(
            model=self.model_name,
            messages=messages,
            temperature=0.45,
            max_completion_tokens=4096,
            stream=True,
        )
        for chunk in stream:
            choice = chunk.choices[0] if chunk.choices else None
            if not choice:
                continue
            delta = choice.delta.content or ""
            if delta:
                yield delta

    async def async_generate_stream_markdown(
        self,
        user_text: str,
        attachment_context: str | None = None,
        history: list[dict] | None = None,
    ):
        _exhausted = object()
        it = iter(
            self.generate_stream_markdown(
                user_text,
                attachment_context=attachment_context,
                history=history,
            )
        )
        while True:
            delta = await asyncio.to_thread(next, it, _exhausted)
            if delta is _exhausted:
                break
            yield delta

    def extract_attachment_context(self, filename: str, mime: str, file_bytes: bytes) -> str:
        name = (filename or "upload").strip()
        mime_l = (mime or "").lower()

        if name.lower().endswith(".pdf") or "pdf" in mime_l:
            try:
                from pypdf import PdfReader
            except Exception as e:
                raise RuntimeError(
                    "PDF support requires pypdf. Install with: py -m pip install pypdf"
                ) from e
            reader = PdfReader(io.BytesIO(file_bytes))
            chunks = []
            for i, page in enumerate(reader.pages[:40], start=1):
                txt = (page.extract_text() or "").strip()
                if txt:
                    chunks.append(f"\n--- Page {i} ---\n{txt}")
            text = "\n".join(chunks).strip()
            if not text:
                raise RuntimeError("Could not extract text from PDF (possibly scanned/image-only).")
            return f"[Attachment: {name}]\n{text[:180000]}"

        if mime_l.startswith("image/") or re.search(r"\.(png|jpe?g|webp)$", name.lower()):
            b64 = base64.b64encode(file_bytes).decode("ascii")
            data_url = f"data:{mime or 'image/png'};base64,{b64}"
            prompt = (
                "Extract all useful visible text and key visual facts from this image for reasoning.\n"
                "Return plain text only. Preserve equations/symbols when possible."
            )
            r = self.client.chat.completions.create(
                model=self.model_name,
                messages=[
                    {"role": "developer", "content": "You extract high-quality context from images."},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    },
                ],
                temperature=0.1,
                max_completion_tokens=1200,
            )
            txt = (r.choices[0].message.content or "").strip()
            if not txt:
                raise RuntimeError("Could not extract text/context from image.")
            return f"[Attachment: {name}]\n{txt[:80000]}"

        raise RuntimeError("Unsupported file type. Use one PDF or image file.")

    def extract_finance_math_known_variables(self, combined_material: str, user_query: str) -> str:
        """Second pass after merging uploads + lane context: list quantitative fields so the model does not re-ask."""
        mat = (combined_material or "").strip()
        q = (user_query or "").strip()
        if not mat:
            return ""
        sys = (
            "You read COMBINED_MATERIAL that may include multiple homework images (as extracted text), "
            "prior uploads in the same lane, and optional client-provided anchors.\n"
            "Extract every quantitative or contractual input that is clearly stated or strongly implied "
            "for options/derivatives, probability, or finance homework.\n"
            "Return PLAIN TEXT only, using exactly these lines (one per line). Use 'missing' when not stated. "
            "Use concise numeric forms (e.g. 0.30 for 30%, 91/365 years for 91 days unless T is given in years). "
            "If both spot S and strike K appear, include both.\n"
            "S: ...\n"
            "K: ...\n"
            "sigma: ...\n"
            "r: ...\n"
            "q_or_div_yield: ...\n"
            "option_type: call|put|missing\n"
            "position: long|short|missing\n"
            "contracts_or_shares: ...\n"
            "T: ...\n"
            "scenario_prices: ...\n"
            "other_constraints: ...\n"
        )
        user_block = f"USER_QUERY:\n{q[:6000]}\n\nCOMBINED_MATERIAL:\n{mat[:95000]}"
        r = self.client.chat.completions.create(
            model=self.classifier_model,
            messages=[
                {"role": "developer", "content": sys},
                {"role": "user", "content": user_block},
            ],
            temperature=0.05,
            max_completion_tokens=900,
        )
        return (r.choices[0].message.content or "").strip()

    def generate_reasoning_panel_title(
        self,
        user_prompt: str,
        markdown_excerpt: str = "",
        voice_summary_excerpt: str = "",
    ) -> str:
        """Short tab label for a reasoning panel after the first completed turn (UI chrome)."""
        up = (user_prompt or "").strip()[:8000]
        md = (markdown_excerpt or "").strip()[:12000]
        vs = (voice_summary_excerpt or "").strip()[:2500]
        if not up and not md and not vs:
            return ""
        sys = (
            "Name a short UI tab label for a multi-panel reasoning workspace.\n"
            "Return JSON only with this exact shape:\n"
            '{"title":"<short label>"}\n'
            "Rules for title: 2–6 words, Title Case, name the homework/task/topic naturally "
            "(e.g. 'Black Scholes Homework', 'Civil War Essay Plan'). "
            "No emoji, no markdown, no file extensions, no quotation marks inside the title value.\n"
            "Prefer concrete subject plus task type when obvious (homework, essay, exam prep, debugging).\n"
            "If the request is vague, infer the best label from USER plus ASSISTANT material.\n"
            "Hard limit: 42 characters for the title string."
        )
        user_block = (
            f"USER_REQUEST:\n{up}\n\n"
            f"VOICE_SUMMARY_OR_DIGEST:\n{vs}\n\n"
            f"ASSISTANT_MARKDOWN_BEGIN (may be partial):\n{md}"
        )
        r = self.client.chat.completions.create(
            model=self.classifier_model,
            messages=[
                {"role": "developer", "content": sys},
                {"role": "user", "content": user_block},
            ],
            temperature=0.25,
            max_completion_tokens=96,
        )
        raw = (r.choices[0].message.content or "").strip()
        parsed = _parse_json_object(raw, {})
        title = str(parsed.get("title", "")).strip()
        title = re.sub(r"[\r\n\t]+", " ", title).strip()
        title = title.strip("\"'“”‘’")
        if not title:
            return ""
        if len(title) > 42:
            cut = title[:42].rsplit(" ", 1)[0].strip()
            title = cut or title[:42].strip()
        return title
