"""Validated account preference blob stored in public.user_settings.settings."""

from __future__ import annotations

from typing import Any

VERA_PREFS_KEY = "vera_prefs_v1"

_ALLOWED_ASR_MODES = frozenset({"streaming", "whisper", "hybrid"})
_ALLOWED_SILENCE_MS = frozenset({1000, 1300, 1600})
_ALLOWED_LAYOUTS = frozenset({"split", "music-full", "checklist-full"})
_PARTIAL_MIN_OPTIONS = frozenset({0, 1, 2, 3, 4})


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("1", "true", "yes", "on"):
            return True
        if s in ("0", "false", "no", "off"):
            return False
    return None


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_vera_prefs_v1(raw: Any) -> dict[str, Any]:
    """Return a sanitized vera_prefs_v1 dict (drops unknown/invalid keys)."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}

    mode = str(raw.get("asr_mode") or "").strip().lower()
    if mode in _ALLOWED_ASR_MODES:
        out["asr_mode"] = mode

    silence = _as_int(raw.get("asr_silence_ms"))
    if silence in _ALLOWED_SILENCE_MS:
        out["asr_silence_ms"] = silence

    mute = _as_bool(raw.get("workmode_mute"))
    if mute is not None:
        out["workmode_mute"] = mute

    rotator = _as_bool(raw.get("text_guide_rotator"))
    if rotator is not None:
        out["text_guide_rotator"] = rotator

    partial_raw = raw.get("main_asr_partial_min_chars")
    if partial_raw == "inf" or str(partial_raw).strip().lower() == "inf":
        out["main_asr_partial_min_chars"] = "inf"
    else:
        partial = _as_int(partial_raw)
        if partial is not None and partial in _PARTIAL_MIN_OPTIONS:
            out["main_asr_partial_min_chars"] = partial

    layout = str(raw.get("work_left_panes_layout") or "").strip()
    if layout in _ALLOWED_LAYOUTS:
        out["work_left_panes_layout"] = layout

    return out


def merge_settings_patch(
    existing: dict[str, Any] | None,
    patch: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge a PATCH body into the full settings JSONB document."""
    base: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    if not isinstance(patch, dict) or not patch:
        return base

    if VERA_PREFS_KEY in patch:
        current = base.get(VERA_PREFS_KEY)
        current_norm = normalize_vera_prefs_v1(current if isinstance(current, dict) else {})
        incoming = normalize_vera_prefs_v1(patch.get(VERA_PREFS_KEY))
        merged = {**current_norm, **incoming}
        if merged:
            base[VERA_PREFS_KEY] = merged
        elif VERA_PREFS_KEY in base:
            base.pop(VERA_PREFS_KEY, None)

    return base


def vera_prefs_is_empty(settings: dict[str, Any] | None) -> bool:
    if not isinstance(settings, dict):
        return True
    prefs = settings.get(VERA_PREFS_KEY)
    if not isinstance(prefs, dict):
        return True
    return len(normalize_vera_prefs_v1(prefs)) == 0
