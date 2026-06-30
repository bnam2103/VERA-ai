"""
Centralized safety limits + fallback message strings for Vera.

These are measurement / guard values used to:
  * block oversized typed input before it reaches the LLM
  * estimate input tokens with a rough chars/4 heuristic
  * give partial-degradation bubbles when a specific capability fails

The values intentionally live here (not scattered across handlers) so they
can be tuned without code edits across the app. They are NOT user-credit
caps, system budgets, or rate limits — those are explicitly deferred.

Char/token limits are upper bounds. Normal short prompts are unaffected.
"""

from __future__ import annotations

from typing import Final

# --------------------------------------------------------------------------- #
# Character limits per request mode (typed input).
# These cap the raw user-supplied text BEFORE it reaches the LLM.
# --------------------------------------------------------------------------- #
CHAR_LIMIT_NORMAL_CHAT: Final[int] = 4_000
CHAR_LIMIT_WORK_MODE_REASONING: Final[int] = 12_000
CHAR_LIMIT_CHECKLIST_OR_COMMAND: Final[int] = 2_000

# --------------------------------------------------------------------------- #
# Estimated-token limits (input only). Estimation uses chars/4. These are
# defensive: real model context windows are larger, but huge pastes should
# be uploaded as files, not chatted in.
# --------------------------------------------------------------------------- #
TOKEN_LIMIT_VOICE_COMMAND: Final[int] = 1_000
TOKEN_LIMIT_NORMAL_TYPED: Final[int] = 2_000
TOKEN_LIMIT_CHECKLIST_OR_COMMAND: Final[int] = 500
TOKEN_LIMIT_WORK_MODE_REASONING: Final[int] = 10_000

# --------------------------------------------------------------------------- #
# Voice recording duration cap (seconds). Starts only AFTER speech-start
# is detected (first valid partial transcript or VAD speech-frame). Pre-
# speech silence is governed by the existing no-speech / idle timeout.
# --------------------------------------------------------------------------- #
VOICE_MAX_DURATION_AFTER_SPEECH_SEC: Final[int] = 60


# --------------------------------------------------------------------------- #
# Fallback / partial-degradation bubble messages. These are user-facing.
# Only show when the relevant capability ACTUALLY fails (not as part of
# any normal successful flow).
# --------------------------------------------------------------------------- #
class FallbackMessages:
    INPUT_TOO_LONG_KEYBOARD: Final[str] = (
        "This message is too long for one request. "
        "Please shorten it or upload it as a file."
    )
    INPUT_TOO_LARGE_TOKENS: Final[str] = (
        "This request is too large to process safely in one message. "
        "Please shorten it or upload it as a file."
    )
    VOICE_DURATION_LIMIT: Final[str] = (
        "I stopped recording to keep the request manageable. "
        "Use a shorter voice command or type longer details."
    )

    ASR_FAILURE: Final[str] = (
        "Listening is not available right now. Please use the keyboard."
    )
    TTS_FAILURE: Final[str] = (
        "Speaking is not available right now. Please read the text response."
    )
    LLM_FAILURE: Final[str] = (
        "Reasoning is temporarily unavailable. Please try again later."
    )
    MUSIC_FAILURE: Final[str] = (
        "Music playback is not available right now."
    )
    WEATHER_FAILURE: Final[str] = (
        "Weather information is not available right now."
    )
    SEARCH_NEWS_FAILURE: Final[str] = (
        "Search/news information is not available right now."
    )
    FINANCE_FAILURE: Final[str] = (
        "Finance information is not available right now."
    )
    BMO_STATE_FAILURE: Final[str] = (
        "BMO's emotion display is temporarily unavailable."
    )


# --------------------------------------------------------------------------- #
# Helpers.
# --------------------------------------------------------------------------- #
def estimate_input_tokens(text: str | None) -> int:
    """Rough heuristic: ~4 characters per token. Whitespace counts."""
    if not text:
        return 0
    n_chars = len(text)
    return (n_chars + 3) // 4  # ceil(chars / 4)


def char_limit_for_mode(*, work_mode: bool, request_type: str | None) -> int:
    """Pick a char limit for typed input given mode + request_type tag.

    request_type values mirror the cost-logger taxonomy (``command``,
    ``checklist``, ``reasoning``, ``voice``...). Unknown types fall back
    to the normal chat limit, which is the safe baseline.
    """
    rt = (request_type or "").strip().lower()
    if rt == "checklist":
        return CHAR_LIMIT_CHECKLIST_OR_COMMAND
    if work_mode and rt in ("reasoning", "work_mode_reasoning", "work_reasoning"):
        return CHAR_LIMIT_WORK_MODE_REASONING
    if work_mode:
        # Other typed work-mode commands (timer set, music ask, etc.) reuse
        # the normal chat cap. Reasoning gets its own larger budget above.
        return CHAR_LIMIT_NORMAL_CHAT
    return CHAR_LIMIT_NORMAL_CHAT


def token_limit_for_mode(*, work_mode: bool, request_type: str | None) -> int:
    """Pick an estimated-token cap for the same mode / request_type axes."""
    rt = (request_type or "").strip().lower()
    if rt == "voice":
        return TOKEN_LIMIT_VOICE_COMMAND
    if rt == "checklist":
        return TOKEN_LIMIT_CHECKLIST_OR_COMMAND
    if work_mode and rt in ("reasoning", "work_mode_reasoning", "work_reasoning"):
        return TOKEN_LIMIT_WORK_MODE_REASONING
    return TOKEN_LIMIT_NORMAL_TYPED


def check_typed_input_within_limits(
    text: str,
    *,
    work_mode: bool,
    request_type: str | None,
) -> dict | None:
    """Return a structured block-reason dict, or None if the input is OK.

    Block reasons:
      * ``input_too_long`` — exceeded char cap for this mode
      * ``estimated_tokens_exceeded`` — exceeded chars/4 token cap

    Callers should refuse the LLM call (or whatever downstream call) and
    surface ``message`` to the user. Backend logs include ``mode``,
    ``feature``, ``reason``, ``char_count``, ``estimated_tokens``.
    """
    if text is None:
        return None
    char_count = len(text)
    char_cap = char_limit_for_mode(work_mode=work_mode, request_type=request_type)
    if char_count > char_cap:
        return {
            "ok": False,
            "reason": "input_too_long",
            "char_count": char_count,
            "char_limit": char_cap,
            "estimated_tokens": estimate_input_tokens(text),
            "message": FallbackMessages.INPUT_TOO_LONG_KEYBOARD,
        }
    tokens = estimate_input_tokens(text)
    tok_cap = token_limit_for_mode(work_mode=work_mode, request_type=request_type)
    if tokens > tok_cap:
        return {
            "ok": False,
            "reason": "estimated_tokens_exceeded",
            "char_count": char_count,
            "char_limit": char_cap,
            "estimated_tokens": tokens,
            "token_limit": tok_cap,
            "message": FallbackMessages.INPUT_TOO_LARGE_TOKENS,
        }
    return None


def log_safety_block(
    *,
    reason: str,
    mode: str,
    feature: str,
    char_count: int | None = None,
    estimated_tokens: int | None = None,
    request_id: str | None = None,
    turn_id: str | None = None,
    extra: dict | None = None,
) -> None:
    """Lightweight stdout log for blocked / degraded paths.

    Mirrors the [tag] {payload} style used elsewhere in this codebase so
    log scraping stays consistent.
    """
    payload: dict = {
        "reason": reason,
        "mode": mode,
        "feature": feature,
    }
    if char_count is not None:
        payload["char_count"] = int(char_count)
    if estimated_tokens is not None:
        payload["estimated_tokens"] = int(estimated_tokens)
    if request_id:
        payload["request_id"] = str(request_id)
    if turn_id:
        payload["turn_id"] = str(turn_id)
    if extra:
        try:
            payload.update({k: v for k, v in extra.items() if k not in payload})
        except Exception:
            pass
    try:
        import json as _json
        print(f"[safety_guard] {_json.dumps(payload, ensure_ascii=False)}")
    except Exception:
        # Logging must never break a request.
        try:
            print(f"[safety_guard] reason={reason} mode={mode} feature={feature}")
        except Exception:
            pass


__all__ = [
    "CHAR_LIMIT_NORMAL_CHAT",
    "CHAR_LIMIT_WORK_MODE_REASONING",
    "CHAR_LIMIT_CHECKLIST_OR_COMMAND",
    "TOKEN_LIMIT_VOICE_COMMAND",
    "TOKEN_LIMIT_NORMAL_TYPED",
    "TOKEN_LIMIT_CHECKLIST_OR_COMMAND",
    "TOKEN_LIMIT_WORK_MODE_REASONING",
    "VOICE_MAX_DURATION_AFTER_SPEECH_SEC",
    "FallbackMessages",
    "estimate_input_tokens",
    "char_limit_for_mode",
    "token_limit_for_mode",
    "check_typed_input_within_limits",
    "log_safety_block",
]
