"""Lightweight credit metering for Vera requests.

This is a **measurement-only** layer. It classifies each user-facing request
into a single ``credit_action`` (from a fixed vocabulary) and looks up an
integer ``credits_used`` value from ``credit_config.json``. The classifier
never blocks a request — if the config can't be loaded, or the action isn't
priced, credits default to 0 and a ``credit_reason`` is attached so callers
can see why.

The classifier is deterministic and side-effect free, so it can be unit-
tested without spinning up the rest of the cost system. It only looks at
already-captured request state (mode, request_type, route, provider events,
success flag) — no network calls, no extra LLM hops.

Vocabulary (must match the keys in ``credit_config.json``):

    state_sync, local_command, failed_request,
    simple_llm_command, normal_chat_short, normal_chat_long,
    checklist_generation, checklist_edit_local, checklist_edit_llm,
    work_mode_reasoning_short, work_mode_reasoning_long,
    serper_search_bundle, image_file_reasoning, bmo_tts

Thresholds (output_tokens / reasoning_tokens) are conservative starting
points — easy to tune later without touching call sites.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

# Authoritative defaults. The credit_config.json file is materialized from
# these on first run and merged on every load (file values win for keys it
# defines; defaults fill in anything missing).
DEFAULT_CREDIT_CONFIG: dict[str, int] = {
    "local_action": 0,
    "failed_request": 0,
    "weather": 1,
    "simple_llm": 3,
    "voice_assistant": 3,
    "search_or_news": 6,
    "work_mode_reasoning": 12,
    "work_mode_reasoning_deep": 20,
    "work_mode_voice_summary": 2,
    "image_pdf_reasoning": 20,
    "bmo_tts": 0,
    # Legacy aliases (older logs / classifiers)
    "state_sync": 0,
    "local_command": 0,
    "simple_llm_command": 3,
    "normal_chat_short": 3,
    "normal_chat_long": 3,
    "checklist_generation": 0,
    "checklist_edit_local": 0,
    "checklist_edit_llm": 0,
    "work_mode_reasoning_short": 12,
    "work_mode_reasoning_long": 20,
    "serper_search_bundle": 6,
    "image_file_reasoning": 20,
}

_LEGACY_CREDIT_ALIASES: dict[str, str] = {
    "state_sync": "local_action",
    "local_command": "local_action",
    "checklist_generation": "local_action",
    "checklist_edit_local": "local_action",
    "checklist_edit_llm": "local_action",
    "simple_llm_command": "simple_llm",
    "normal_chat_short": "voice_assistant",
    "normal_chat_long": "voice_assistant",
    "work_mode_reasoning_short": "work_mode_reasoning",
    "work_mode_reasoning_long": "work_mode_reasoning_deep",
    "serper_search_bundle": "search_or_news",
    "image_file_reasoning": "image_pdf_reasoning",
}

# Output-size thresholds used by the classifier (combined across all OpenAI
# events on a single request).
SIMPLE_LLM_OUTPUT_TOKEN_MAX = 80          # command + tiny reply -> "simple"
NORMAL_CHAT_LONG_OUTPUT_TOKEN_MIN = 600   # plain chat >= this -> "long"
REASONING_LONG_TOKEN_MIN = 2000           # output+reasoning >= this -> "long"

_CREDIT_CONFIG_PATH = Path(__file__).resolve().parent / "credit_config.json"

_loaded_credit_config: dict[str, int] | None = None
_credit_source: str = "<unloaded>"


def _materialize_default_credit_config() -> None:
    try:
        if not _CREDIT_CONFIG_PATH.exists():
            _CREDIT_CONFIG_PATH.write_text(
                json.dumps(DEFAULT_CREDIT_CONFIG, indent=2) + "\n",
                encoding="utf-8",
            )
    except Exception as e:  # pragma: no cover - filesystem oddities
        print(f"[cost_logger] credit_config materialize failed: {e}")


def load_credit_config(force: bool = False) -> dict[str, int]:
    """Return the current credit config dict (defaults merged with the JSON file).

    Idempotent and cached. Pass ``force=True`` to re-read from disk.
    """
    global _loaded_credit_config, _credit_source
    if _loaded_credit_config is not None and not force:
        return _loaded_credit_config
    _materialize_default_credit_config()
    cfg = dict(DEFAULT_CREDIT_CONFIG)
    source = "<defaults>"
    try:
        if _CREDIT_CONFIG_PATH.is_file():
            raw = json.loads(_CREDIT_CONFIG_PATH.read_text(encoding="utf-8") or "{}")
            if isinstance(raw, dict):
                for k, v in raw.items():
                    if k.startswith("_"):
                        continue  # skip comments / metadata keys
                    if isinstance(v, bool):
                        continue
                    if isinstance(v, (int, float)):
                        try:
                            cfg[str(k)] = int(v)
                        except Exception:
                            continue
                source = str(_CREDIT_CONFIG_PATH)
    except Exception as e:
        print(f"[cost_logger] credit_config load failed: {e}")
    _loaded_credit_config = cfg
    _credit_source = source
    return cfg


def reload_credit_config() -> dict[str, int]:
    return load_credit_config(force=True)


def credit_config_source() -> str:
    return _credit_source


def compute_credits(action: str | None) -> int:
    cfg = load_credit_config()
    key = str(action or "")
    key = _LEGACY_CREDIT_ALIASES.get(key, key)
    try:
        return int(cfg.get(key, 0))
    except Exception:
        return 0


def _safe_int(v: Any, default: int = 0) -> int:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        try:
            return int(v)
        except Exception:
            return default
    try:
        return int(str(v).strip())
    except Exception:
        return default


def classify_credit_action(
    *,
    mode: str | None,
    request_type: str | None,
    extras: dict[str, Any] | None,
    events: Iterable[dict[str, Any]] | None,
    success: bool = True,
) -> tuple[str, str]:
    """Infer a single ``credit_action`` + human-readable reason for one request.

    The returned action is guaranteed to be a key in
    :data:`DEFAULT_CREDIT_CONFIG`; unknown intents fall through to
    ``local_command`` so they get 0 credits and a reason tag.
    """
    ex = extras or {}
    evs = list(events or [])

    if not success:
        return "failed_request", "request_success=False"

    path = str(ex.get("http_path") or ex.get("route_path") or "").lower()
    rt = (request_type or "").lower()
    md = (mode or "").lower()

    has_openai = any(e.get("provider") == "openai" for e in evs)
    has_fish = any(e.get("provider") == "fish_audio" for e in evs)
    has_serper = any(e.get("provider") == "serper" for e in evs)
    has_weather = any(e.get("provider") == "openweather" for e in evs)

    # Combined output + reasoning tokens across all OpenAI events.
    out_tokens = 0
    reasoning_tokens = 0
    for e in evs:
        if e.get("provider") != "openai":
            continue
        out_tokens += _safe_int(e.get("output_tokens"))
        reasoning_tokens += _safe_int(e.get("reasoning_tokens"))
    reasoning_total = out_tokens + reasoning_tokens

    # 1) Local / state-sync — timers, checklist local edits, panel UI, etc.
    if rt == "state_sync" or "/timer" in path:
        return (
            "local_action",
            f"state_sync_route_or_type(path={path or '-'},type={rt or '-'})",
        )

    # 2) BMO TTS only — explicit request_type or a Fish-only request.
    if rt == "bmo_tts" or (has_fish and not has_openai and not has_serper):
        return "bmo_tts", "fish_tts_only_no_llm_or_search"

    # 3) Image / file reasoning — dominant cost is multimodal LLM.
    if (
        rt == "file_image"
        or ex.get("has_image")
        or ex.get("has_file")
        or _safe_int(ex.get("file_attachment_count")) > 0
    ):
        return "image_pdf_reasoning", "image_or_file_attachment_present"

    # 4) Checklist — local edits are free; generation uses LLM but not user credits.
    if "/checklist" in path:
        if has_openai and ("/generate" in path or ex.get("checklist_generation")):
            return "local_action", "checklist_generation_no_credit"
        return "local_action", "checklist_route_local"

    # 5a) Grounded Voice UI final brief after Work Mode panel (small add-on LLM).
    if "/work_mode/voice_final_brief" in path:
        return (
            "work_mode_voice_summary",
            "grounded_panel_voice_final_brief",
        )

    # 5) Work-mode reasoning lanes — normal vs deep.
    is_wm_reasoning = (md == "work_mode" or "/work_mode/" in path) and (
        "reasoning" in path or rt == "reasoning"
    )
    if is_wm_reasoning:
        deep_effort = ex.get("deep_reasoning_effort_active")
        if (
            deep_effort is True
            or reasoning_total >= REASONING_LONG_TOKEN_MIN
            or ("reasoning_stream" in path and deep_effort is not False)
        ):
            return (
                "work_mode_reasoning_deep",
                f"work_mode_deep(effort={deep_effort},tokens={reasoning_total},path={path or '-'})",
            )
        return (
            "work_mode_reasoning",
            f"work_mode_normal(effort={deep_effort},tokens={reasoning_total})",
        )

    # 6) Weather API turn (OpenWeather geocode + forecast).
    if has_weather or rt == "weather" or ex.get("action_type") == "weather":
        return "weather", "openweather_event_or_weather_route"

    # 7) Serper-touching turn (search / news / web / finance / sports).
    if has_serper:
        return "search_or_news", "serper_event_present"

    # 8) Logged route with no paid provider events — local command.
    if not (has_openai or has_fish or has_serper or has_weather):
        return "local_action", "no_provider_events_on_logged_route"

    # 9) Simple LLM command — tiny one-shot reply.
    if rt == "command" and out_tokens <= SIMPLE_LLM_OUTPUT_TOKEN_MAX:
        return (
            "simple_llm",
            f"command_request_with_output_tokens={out_tokens}<={SIMPLE_LLM_OUTPUT_TOKEN_MAX}",
        )

    # 10) Normal voice assistant chat.
    return (
        "voice_assistant",
        f"voice_assistant_output_tokens={out_tokens}",
    )


def credit_action_keys() -> list[str]:
    """Return the canonical vocabulary of credit actions (for validation/UI)."""
    return list(DEFAULT_CREDIT_CONFIG.keys())
