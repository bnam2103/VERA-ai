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
    "state_sync": 0,
    "local_command": 0,
    "failed_request": 0,
    "simple_llm_command": 1,
    "normal_chat_short": 2,
    "normal_chat_long": 4,
    "checklist_generation": 3,
    "checklist_edit_local": 0,
    "checklist_edit_llm": 1,
    "work_mode_reasoning_short": 5,
    "work_mode_reasoning_long": 10,
    "serper_search_bundle": 3,
    "image_file_reasoning": 15,
    "bmo_tts": 0,
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
    try:
        return int(cfg.get(str(action or ""), 0))
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

    # Combined output + reasoning tokens across all OpenAI events.
    out_tokens = 0
    reasoning_tokens = 0
    for e in evs:
        if e.get("provider") != "openai":
            continue
        out_tokens += _safe_int(e.get("output_tokens"))
        reasoning_tokens += _safe_int(e.get("reasoning_tokens"))
    reasoning_total = out_tokens + reasoning_tokens

    # 1) Generic state-sync — explicit type tag or known no-LLM routes
    #    (timer polls, etc.). Checklist paths are handled below by the more
    #    specific checklist_* family so they never collapse into state_sync.
    if rt == "state_sync" or "/timer" in path:
        return (
            "state_sync",
            f"state_sync_route_or_type(path={path or '-'},type={rt or '-'})",
        )

    # 2) BMO TTS only — explicit request_type or a Fish-only request.
    if rt == "bmo_tts" or (has_fish and not has_openai and not has_serper):
        return "bmo_tts", "fish_tts_only_no_llm_or_search"

    # 3) Image / file reasoning — overrides everything else (including Serper)
    #    because the dominant cost is the multimodal LLM call.
    if (
        rt == "file_image"
        or ex.get("has_image")
        or ex.get("has_file")
        or _safe_int(ex.get("file_attachment_count")) > 0
    ):
        return "image_file_reasoning", "image_or_file_attachment_present"

    # 4) Checklist generation (LLM build) vs LLM-assisted edit vs local edit.
    if "/checklist" in path and (
        "/generate" in path or ex.get("checklist_generation")
    ):
        return "checklist_generation", "checklist_generation_route_or_flag"
    if "/checklist" in path:
        if has_openai:
            return "checklist_edit_llm", "checklist_route_with_openai_event"
        return "checklist_edit_local", "checklist_route_no_provider_event"

    # 5) Work-mode reasoning lanes — short vs long.
    if md == "work_mode" and ("reasoning" in path or rt == "reasoning"):
        if reasoning_total >= REASONING_LONG_TOKEN_MIN:
            return (
                "work_mode_reasoning_long",
                f"reasoning+output={reasoning_total}>={REASONING_LONG_TOKEN_MIN}",
            )
        return (
            "work_mode_reasoning_short",
            f"reasoning+output={reasoning_total}<{REASONING_LONG_TOKEN_MIN}",
        )

    # 6) Serper-touching turn (any non-reasoning request that did a search).
    if has_serper:
        return "serper_search_bundle", "serper_event_present"

    # 7) Logged route that fired no paid provider events — local command.
    if not (has_openai or has_fish or has_serper):
        return "local_command", "no_provider_events_on_logged_route"

    # 8) Simple LLM command — command-style turn with a tiny one-shot reply.
    if rt == "command" and out_tokens <= SIMPLE_LLM_OUTPUT_TOKEN_MAX:
        return (
            "simple_llm_command",
            f"command_request_with_output_tokens={out_tokens}<={SIMPLE_LLM_OUTPUT_TOKEN_MAX}",
        )

    # 9) Normal chat — short vs long based on cumulative output tokens.
    if out_tokens >= NORMAL_CHAT_LONG_OUTPUT_TOKEN_MIN:
        return (
            "normal_chat_long",
            f"output_tokens={out_tokens}>={NORMAL_CHAT_LONG_OUTPUT_TOKEN_MIN}",
        )
    return (
        "normal_chat_short",
        f"output_tokens={out_tokens}<{NORMAL_CHAT_LONG_OUTPUT_TOKEN_MIN}",
    )


def credit_action_keys() -> list[str]:
    """Return the canonical vocabulary of credit actions (for validation/UI)."""
    return list(DEFAULT_CREDIT_CONFIG.keys())
