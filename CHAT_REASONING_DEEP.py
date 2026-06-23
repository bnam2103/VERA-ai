"""
Deep work-mode reasoning model for markdown generation.
Uses separate model settings from fast summary/classifier path.
"""

from __future__ import annotations

import asyncio
import json
import os

from CHAT_REASONING import (
    REASONING_MARKDOWN_FORMAT_AND_MATH_BLOCK,
    REASONING_MARKDOWN_GROUNDING_BLOCK,
    ReasoningAI,
)
from math_code_executor import RESULT_MARKER as _MATH_RESULT_MARKER


class ReasoningDeepAI(ReasoningAI):
    """Dedicated deep-reasoning markdown path (separate model config)."""

    def __init__(self) -> None:
        super().__init__()
        self.deep_model_name = os.environ.get("VERA_REASONING_DEEP_MODEL", "gpt-5.4")
        self.deep_reasoning_effort = os.environ.get("VERA_REASONING_DEEP_REASONING_EFFORT", "high").strip().lower()
        self.deep_max_tokens = int(os.environ.get("VERA_REASONING_DEEP_MAX_TOKENS", "6144"))
        self.deep_temperature = float(os.environ.get("VERA_REASONING_DEEP_TEMPERATURE", "0.35"))
        # Set when a deep markdown stream is opened (see generate_stream_markdown).
        self.last_deep_reasoning_effort_active: bool | None = None
        self.last_deep_reasoning_effort_error: str | None = None

    def generate_stream_markdown(
        self,
        user_text: str,
        attachment_context: str | None = None,
        history: list[dict] | None = None,
    ):
        sys = (
            "You are a careful deep reasoning assistant (work mode).\n"
            "Respond in clean Markdown with headings, numbered steps, bullet lists, and tables when useful.\n"
            "Use only Markdown for emphasis and tables (e.g. **bold**, GFM `| col |` rows); never emit HTML tags such as "
            "<strong>, <b>, or <br> — the client renders Markdown to HTML in one pass.\n"
            "Use fenced code blocks only for real source code, shell commands, JSON, logs, or pasted file excerpts — never for math or final answers.\n"
            "Prioritize correctness over speed and style.\n"
            "Before solving, identify what the user is actually asking for and choose the correct method.\n"
            "For quantitative problems, do not rely on shortcuts unless the problem explicitly asks for an approximation.\n"
            "If a problem asks for a value after time passes or after a state changes, recompute the relevant quantities at the new time/state before calculating the final answer.\n"
            "For options/derivatives problems: use delta to determine hedge shares, but compute future hedge profit/loss by repricing the option at the new stock price and remaining time unless the user explicitly asks for delta approximation.\n"
            "For any answer involving calculations, show the formula, substitutions, and final numeric result. Check whether the result makes sense before finalizing.\n"
            "If the user provides an answer sheet, attachment, or expected result, treat it as the primary source of truth and reconcile your solution with it instead of ignoring it.\n"
            "Do not mention models or internal routing.\n"
            "Never use the first `#` heading as generic filler. The first `#` must be the actual task/topic name.\n"
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
                "Quote or reuse specific figures, labels, and conclusions from the attachment when answering."
            )
            if "KNOWN_VARIABLES_AFTER_MERGE" in ac:
                sys += (
                    "\n\nWhen KNOWN_VARIABLES_AFTER_MERGE is present, treat every line that is not 'missing' "
                    "as fixed inputs — solve with them; only ask the user for parameters still marked missing "
                    "or clearly contradictory."
                )
            if "ACTIVE_LANE_PRIOR_CONTEXT" in ac or "FOLLOW_UP_RULES" in ac:
                sys += (
                    "\n\nWhen ACTIVE_LANE_PRIOR_CONTEXT or FOLLOW_UP_RULES is present, the reasoning panel "
                    "already contains a completed solution for this lane. Treat the user's message as a follow-up "
                    "(e.g. code, recap, or variant). Reuse figures and variables from ACTIVE_LANE_PRIOR_CONTEXT. "
                    "Do not ask for the full problem statement again unless critical inputs are truly absent."
                )
        messages = [{"role": "developer", "content": sys}]
        messages.extend(self._session_history_messages(history, max_messages=12))
        messages.append({"role": "user", "content": user_text.strip()[:12000]})

        self.last_deep_reasoning_effort_active = None
        self.last_deep_reasoning_effort_error = None

        # Some model/runtime combos reject reasoning_effort (or specific values like xhigh).
        # Fall back to a plain streaming request so markdown still renders instead of failing the lane.
        # That fallback is NOT equivalent to the configured deep path for reliability / reasoning depth.
        try:
            stream = self.client.chat.completions.create(
                model=self.deep_model_name,
                messages=messages,
                temperature=self.deep_temperature,
                max_completion_tokens=self.deep_max_tokens,
                stream=True,
                reasoning_effort=self.deep_reasoning_effort,
            )
            self.last_deep_reasoning_effort_active = True
            self.last_deep_reasoning_effort_error = None
            print(
                "[ReasoningDeepAI] "
                + json.dumps(
                    {
                        "deep_reasoning_effort_active": True,
                        "model": self.deep_model_name,
                        "reasoning_effort": self.deep_reasoning_effort,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as e:
            err_preview = f"{type(e).__name__}: {e}"[:500]
            self.last_deep_reasoning_effort_active = False
            self.last_deep_reasoning_effort_error = err_preview
            print(
                "[ReasoningDeepAI] "
                + json.dumps(
                    {
                        "deep_reasoning_effort_active": False,
                        "model": self.deep_model_name,
                        "requested_reasoning_effort": self.deep_reasoning_effort,
                        "error": err_preview,
                        "note": (
                            "Retrying without reasoning_effort; output is plain streaming and "
                            "must not be treated as the same reliability as the configured deep lane."
                        ),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            stream = self.client.chat.completions.create(
                model=self.deep_model_name,
                messages=messages,
                temperature=self.deep_temperature,
                max_completion_tokens=self.deep_max_tokens,
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

    # ----------------------------------------------------------------------
    # Code-first path: generate Python that produces the numeric answer, then
    # write the markdown answer USING that computed result as ground truth.
    # ----------------------------------------------------------------------

    _CODE_GEN_SYSTEM = (
        "You write a single self-contained Python script to compute a numeric answer "
        "for a math/finance/statistics/probability problem.\n"
        "Output ONLY the Python source code — no markdown fences, no commentary, no headings.\n"
        "Rules:\n"
        "- Use only the standard library plus numpy and scipy (already installed). Do NOT import sympy or any other extra package.\n"
        "- Define all inputs as named variables at the top so values are easy to audit.\n"
        "- Use the exact inputs the user provided (and any KNOWN_VARIABLES_AFTER_MERGE / numeric_targets listed below). "
        "Never invent textbook values when the problem states real numbers.\n"
        "- If the problem requires Black-Scholes, use math.log/math.exp and scipy.stats.norm.cdf for N(d1)/N(d2). "
        "For binomial pricing, build the tree explicitly. For Monte Carlo, fix the seed (e.g. np.random.seed(7)) so the answer is reproducible.\n"
        "- Print intermediate values that help a human verify the calculation (formula substitutions, key Greeks if relevant).\n"
        "- At the END print exactly one line that begins with `" + _MATH_RESULT_MARKER + "` "
        "followed by a single JSON object on the same line. Use this shape "
        "(omit keys that do not apply):\n"
        "  " + _MATH_RESULT_MARKER + ' {"final_answer": <number or object>, "label": "<short label>", '
        '"units": "<units or empty>", "rounded": <number>, "extras": {<diagnostic numbers>}}\n'
        "- final_answer MUST be the single number (or small JSON object) the user actually asked for. "
        "If the user asked for multiple values, put each as a key inside an object under final_answer.\n"
        "- Keep the script short and deterministic. No interactive input(), no file I/O, no network calls, no subprocesses.\n"
        "- Do NOT wrap the code in ```python fences. Emit raw Python only.\n"
        "- If a required input is missing, do NOT guess — print a clear error to stderr (raise ValueError) "
        "and skip the result marker so the server can ask the user to clarify."
    )

    _CODE_RETRY_SYSTEM = (
        "Your previous Python attempt failed. Produce a corrected single self-contained Python script.\n"
        "Same output rules as before: raw Python only (no fences), end with one `" + _MATH_RESULT_MARKER + "` line "
        "carrying the JSON result. Fix the specific error shown in the stderr/error_kind. "
        "Do not change the inputs unless they were the cause of the failure."
    )

    _CODE_FIRST_MARKDOWN_SYSTEM = (
        "You are a careful deep reasoning assistant (work mode), writing the final Markdown answer "
        "for a problem whose numeric answer has ALREADY been computed by a trusted Python run on the server.\n"
        "\n"
        "Ground rules for this turn:\n"
        "- Treat the COMPUTED_RESULT block below as the authoritative numeric answer. "
        "Do NOT recompute it from scratch in prose; do NOT contradict it. "
        "If the computed result and your intuition disagree, trust the computed result and explain why it is correct.\n"
        "- Do not invent or substitute different numbers. Use the exact values from the user's problem and from COMPUTED_RESULT.\n"
        "- Do not narrate the code line-by-line; describe the method, not the implementation details.\n"
        "\n"
        "Structure the answer with these Markdown headings, IN THIS ORDER (skip a section only if it is "
        "genuinely irrelevant for this request):\n"
        "## Given\n"
        "- bullet each input variable with its value and units\n"
        "## Formula / Model\n"
        "- name the model and write the key equation(s) in plain Markdown or short LaTeX `$...$`\n"
        "## Computed result\n"
        "- restate the authoritative computed result(s) verbatim (with units)\n"
        "## Final answer\n"
        "- one short bold line, e.g. **Call price: 12.34 USD** (no `$` outside numbers to avoid TeX collisions)\n"
        "## Explanation\n"
        "- short prose explaining what the result means and any caveats\n"
        "## Python check\n"
        "- one fenced ```python block showing the exact script that produced the result (already supplied below)\n"
        "- one short note about how to run it / what each input means\n"
        "\n"
        "Never use `\\boxed{}`. Never put final numbers inside code fences other than `## Python check`.\n"
        "Do not say 'as an AI' or mention internal routing."
        + REASONING_MARKDOWN_GROUNDING_BLOCK
        + REASONING_MARKDOWN_FORMAT_AND_MATH_BLOCK
    )

    _CODE_FIRST_FAILED_SYSTEM = (
        "You are a careful deep reasoning assistant (work mode). The server attempted to compute the numeric "
        "answer with Python but the run did not finish successfully. Do NOT invent an exact numeric answer.\n"
        "Write Markdown that:\n"
        "1. Lists the inputs you can confirm under `## Given`.\n"
        "2. Names the model/formula under `## Formula / Model`.\n"
        "3. Under `## Setup`, shows the substitutions the user can follow by hand (no fabricated final number).\n"
        "4. Under `## Python check (not executed)`, embeds the attempted code in one ```python block.\n"
        "5. Under `## What we still need`, lists the specific missing inputs or fixes required to compute the answer.\n"
        "Tone: matter-of-fact, no apology spiral."
        + REASONING_MARKDOWN_GROUNDING_BLOCK
        + REASONING_MARKDOWN_FORMAT_AND_MATH_BLOCK
    )

    def _build_code_gen_messages(
        self,
        user_text: str,
        attachment_context: str | None,
        classifier_result: dict | None,
        history: list[dict] | None,
        *,
        retry: bool = False,
        prior_code: str | None = None,
        prior_stdout: str = "",
        prior_stderr: str = "",
        prior_error_kind: str | None = None,
    ) -> list[dict]:
        sys = self._CODE_RETRY_SYSTEM if retry else self._CODE_GEN_SYSTEM
        if classifier_result:
            sys += (
                "\n\nClassifier hint (for inputs / targets — JSON):\n"
                + json.dumps(
                    {
                        k: classifier_result.get(k)
                        for k in (
                            "domain",
                            "problem_mode",
                            "numeric_targets",
                            "variables_detected",
                            "missing_variables",
                        )
                    },
                    ensure_ascii=False,
                )
            )
        if attachment_context:
            ac = str(attachment_context).strip()
            if ac:
                sys += "\n\nAttachment context (use the figures from here, not textbook defaults):\n" + ac[:60000]
        messages = [{"role": "developer", "content": sys}]
        messages.extend(self._session_history_messages(history, max_messages=6))
        user_block = f"User request:\n{user_text.strip()[:8000]}"
        if retry and prior_code:
            user_block += (
                "\n\n---\nPrevious failed Python (do not repeat the same mistake):\n"
                f"```python\n{prior_code[:6000]}\n```\n"
                f"stderr (truncated): {prior_stderr[:2000]}\n"
                f"stdout so far (truncated): {prior_stdout[:1500]}\n"
                f"error_kind: {prior_error_kind or 'unknown'}\n"
                "Now produce a corrected script."
            )
        messages.append({"role": "user", "content": user_block})
        return messages

    def generate_python_code_for_problem(
        self,
        user_text: str,
        attachment_context: str | None = None,
        classifier_result: dict | None = None,
        history: list[dict] | None = None,
    ) -> str:
        """Single-shot Python generation for the code-first path (returns raw source)."""
        messages = self._build_code_gen_messages(
            user_text=user_text,
            attachment_context=attachment_context,
            classifier_result=classifier_result,
            history=history,
        )
        r = self.client.chat.completions.create(
            model=self.deep_model_name,
            messages=messages,
            temperature=0.1,
            max_completion_tokens=2200,
        )
        return (r.choices[0].message.content or "").strip()

    def make_python_retry_callback(
        self,
        user_text: str,
        attachment_context: str | None,
        classifier_result: dict | None,
        history: list[dict] | None,
    ):
        """Build a closure suitable for math_code_executor.run_python_with_retry."""

        def _cb(prior_code: str, stdout: str, stderr: str, error_kind: str | None) -> str:
            try:
                messages = self._build_code_gen_messages(
                    user_text=user_text,
                    attachment_context=attachment_context,
                    classifier_result=classifier_result,
                    history=history,
                    retry=True,
                    prior_code=prior_code,
                    prior_stdout=stdout,
                    prior_stderr=stderr,
                    prior_error_kind=error_kind,
                )
                r = self.client.chat.completions.create(
                    model=self.deep_model_name,
                    messages=messages,
                    temperature=0.1,
                    max_completion_tokens=2200,
                )
                return (r.choices[0].message.content or "").strip()
            except Exception as e:
                print(f"[MATH_CODE_EXECUTION_DEBUG][retry_callback_error] {type(e).__name__}: {e}")
                return ""

        return _cb

    def generate_stream_markdown_with_computed_result(
        self,
        user_text: str,
        attachment_context: str | None,
        classifier_result: dict | None,
        executor_result: dict,
        history: list[dict] | None = None,
    ):
        """Streaming Markdown synth that treats `executor_result` as the source of truth."""
        success = bool(executor_result.get("execution_success"))
        sys = self._CODE_FIRST_MARKDOWN_SYSTEM if success else self._CODE_FIRST_FAILED_SYSTEM

        profile = self._profile_block()
        if profile:
            sys += "\n\n" + profile

        # Inject classifier + computed result + code as authoritative context.
        sys += "\n\nClassifier result (JSON):\n" + json.dumps(
            {
                k: classifier_result.get(k)
                for k in (
                    "domain",
                    "problem_mode",
                    "calculation_required",
                    "code_required",
                    "numeric_targets",
                    "variables_detected",
                    "missing_variables",
                )
            } if classifier_result else {},
            ensure_ascii=False,
        )
        sys += "\n\nCOMPUTED_RESULT (authoritative — use these numbers verbatim):\n" + json.dumps(
            {
                "execution_success": success,
                "computed_result": executor_result.get("computed_result"),
                "stdout_preview": executor_result.get("stdout_preview", "")[:6000],
                "stderr_preview": executor_result.get("stderr", "")[:1500] if not success else "",
                "retry_count": executor_result.get("retry_count", 0),
                "error_kind": executor_result.get("error_kind"),
            },
            ensure_ascii=False,
        )
        final_code = str(executor_result.get("final_code") or "").strip()
        if final_code:
            sys += (
                "\n\nPython script that produced the COMPUTED_RESULT (embed verbatim under "
                "`## Python check`):\n```python\n"
                + final_code[:8000]
                + "\n```"
            )
        if attachment_context:
            ac = str(attachment_context).strip()
            if ac:
                sys += "\n\nAttachment excerpt (already used to extract inputs):\n" + ac[:60000]

        messages = [{"role": "developer", "content": sys}]
        messages.extend(self._session_history_messages(history, max_messages=8))
        messages.append({"role": "user", "content": user_text.strip()[:12000]})

        self.last_deep_reasoning_effort_active = None
        self.last_deep_reasoning_effort_error = None
        try:
            stream = self.client.chat.completions.create(
                model=self.deep_model_name,
                messages=messages,
                temperature=self.deep_temperature,
                max_completion_tokens=self.deep_max_tokens,
                stream=True,
                reasoning_effort=self.deep_reasoning_effort,
            )
            self.last_deep_reasoning_effort_active = True
        except Exception as e:
            err_preview = f"{type(e).__name__}: {e}"[:500]
            self.last_deep_reasoning_effort_active = False
            self.last_deep_reasoning_effort_error = err_preview
            print(
                "[ReasoningDeepAI] "
                + json.dumps(
                    {
                        "deep_reasoning_effort_active": False,
                        "model": self.deep_model_name,
                        "requested_reasoning_effort": self.deep_reasoning_effort,
                        "error": err_preview,
                        "path": "code_first_markdown",
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            stream = self.client.chat.completions.create(
                model=self.deep_model_name,
                messages=messages,
                temperature=self.deep_temperature,
                max_completion_tokens=self.deep_max_tokens,
                stream=True,
            )

        for chunk in stream:
            choice = chunk.choices[0] if chunk.choices else None
            if not choice:
                continue
            delta = choice.delta.content or ""
            if delta:
                yield delta

    async def async_generate_stream_markdown_with_computed_result(
        self,
        user_text: str,
        attachment_context: str | None,
        classifier_result: dict | None,
        executor_result: dict,
        history: list[dict] | None = None,
    ):
        _exhausted = object()
        it = iter(
            self.generate_stream_markdown_with_computed_result(
                user_text=user_text,
                attachment_context=attachment_context,
                classifier_result=classifier_result,
                executor_result=executor_result,
                history=history,
            )
        )
        while True:
            delta = await asyncio.to_thread(next, it, _exhausted)
            if delta is _exhausted:
                break
            yield delta
