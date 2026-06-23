"""Centralized provider pricing config for cost logging.

Pricing comes from ONE place, not scattered constants. To override:

1. Edit ``cost_logging/pricing.json`` next to this file (created on first run if
   missing), OR
2. Set ``COST_PRICING_FILE=/abs/path/to/pricing.json`` and we will load from
   there instead. Missing keys fall back to the defaults in this module.

All values are USD. Keys you don't know the price for can be left as ``null``
in the JSON file — the logger will still record raw usage and set
``estimated_cost_usd`` to ``null`` for that field.

Supported sub-trees:
    openai.<model>.{input_per_1m_tokens, cached_input_per_1m_tokens,
                    output_per_1m_tokens, reasoning_per_1m_tokens}
    fish_audio.<model_name>.{billing_unit, cost_per_1m_utf8_bytes,
                              cost_per_utf8_byte, cost_per_1000_utf8_bytes}
    serper.<endpoint>.{cost_per_search_call}
    openai_image.<model>.{cost_per_image}

`<model_name>` (Fish Audio) and `<endpoint>` default to "default" if the
call site does not provide a more specific key. Fish Audio API billing is
always UTF-8 bytes of the text submitted to TTS; legacy "web credits" and
"per 1k characters" knobs are intentionally not modeled here.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

_THIS_DIR = Path(__file__).resolve().parent
_DEFAULT_PRICING_FILE = _THIS_DIR / "pricing.json"


# --------------------------------------------------------------------------- #
# Defaults (editable in pricing.json without touching code).
# Numbers here are reasonable placeholders — adjust to your actual contracts.
# --------------------------------------------------------------------------- #
DEFAULT_PRICING: dict[str, Any] = {
    "openai": {
        # OpenAI's mini / full ranges. Values below are current public list
        # prices at time of writing; EDIT in pricing.json as your tier changes.
        "gpt-4o": {
            "input_per_1m_tokens": 2.50,
            "cached_input_per_1m_tokens": 1.25,
            "output_per_1m_tokens": 10.00,
            "reasoning_per_1m_tokens": None,
        },
        "gpt-4o-mini": {
            "input_per_1m_tokens": 0.15,
            "cached_input_per_1m_tokens": 0.075,
            "output_per_1m_tokens": 0.60,
            "reasoning_per_1m_tokens": None,
        },
        "gpt-4.1": {
            "input_per_1m_tokens": 2.00,
            "cached_input_per_1m_tokens": 0.50,
            "output_per_1m_tokens": 8.00,
            "reasoning_per_1m_tokens": None,
        },
        "gpt-4.1-mini": {
            "input_per_1m_tokens": 0.40,
            "cached_input_per_1m_tokens": 0.10,
            "output_per_1m_tokens": 1.60,
            "reasoning_per_1m_tokens": None,
        },
        "gpt-5": {
            "input_per_1m_tokens": 5.00,
            "cached_input_per_1m_tokens": 1.25,
            "output_per_1m_tokens": 15.00,
            "reasoning_per_1m_tokens": 15.00,
        },
        "gpt-5-mini": {
            "input_per_1m_tokens": 0.25,
            "cached_input_per_1m_tokens": 0.10,
            "output_per_1m_tokens": 2.00,
            "reasoning_per_1m_tokens": 2.00,
        },
        "o3-mini": {
            "input_per_1m_tokens": 1.10,
            "cached_input_per_1m_tokens": 0.55,
            "output_per_1m_tokens": 4.40,
            "reasoning_per_1m_tokens": 4.40,
        },
        "default": {
            "input_per_1m_tokens": None,
            "cached_input_per_1m_tokens": None,
            "output_per_1m_tokens": None,
            "reasoning_per_1m_tokens": None,
        },
    },
    "fish_audio": {
        # Fish Audio HTTP TTS API: billed strictly per UTF-8 byte of the
        # text submitted to the TTS endpoint. Web playground "credits" and
        # free monthly credits are NOT modeled here because production
        # traffic only hits the API.
        "default": {
            "billing_unit": "utf8_byte",
            "cost_per_1m_utf8_bytes": 15.0,
            "cost_per_utf8_byte": 0.000015,
            "cost_per_1000_utf8_bytes": 0.015,
        },
        "s1": {
            "billing_unit": "utf8_byte",
            "cost_per_1m_utf8_bytes": 15.0,
            "cost_per_utf8_byte": 0.000015,
            "cost_per_1000_utf8_bytes": 0.015,
        },
        "s2-pro": {
            "billing_unit": "utf8_byte",
            "cost_per_1m_utf8_bytes": 15.0,
            "cost_per_utf8_byte": 0.000015,
            "cost_per_1000_utf8_bytes": 0.015,
        },
    },
    "serper": {
        # Same per-call price across endpoints unless you override.
        "default": {"cost_per_search_call": 0.001},
        "https://google.serper.dev/news": {"cost_per_search_call": 0.001},
        "https://google.serper.dev/images": {"cost_per_search_call": 0.001},
        "https://google.serper.dev/videos": {"cost_per_search_call": 0.001},
        "https://google.serper.dev/search": {"cost_per_search_call": 0.001},
    },
    "openai_image": {
        "gpt-image-1": {"cost_per_image": 0.04},
        "default": {"cost_per_image": None},
    },
}


_lock = threading.RLock()
_cached_pricing: dict[str, Any] | None = None
_cached_pricing_source: str | None = None


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge ``override`` into a shallow copy of ``base``."""
    out: dict[str, Any] = {}
    keys = set(base.keys()) | set(override.keys())
    for k in keys:
        b = base.get(k)
        o = override.get(k)
        if isinstance(b, dict) and isinstance(o, dict):
            out[k] = _deep_merge(b, o)
        elif k in override:
            out[k] = o
        else:
            out[k] = b
    return out


def _pricing_file_path() -> Path:
    env_path = (os.environ.get("COST_PRICING_FILE") or "").strip()
    if env_path:
        return Path(env_path).expanduser().resolve()
    return _DEFAULT_PRICING_FILE


def _ensure_template_file(path: Path) -> None:
    """Create a starter pricing.json at ``path`` so the user can edit it."""
    try:
        if path.exists():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "_note": (
                "Edit any value to match your actual contract. "
                "Set unknown prices to null — the logger will still record "
                "raw usage and report estimated_cost_usd=null. "
                "All numbers are USD."
            ),
            **DEFAULT_PRICING,
        }
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception as e:  # pragma: no cover - first-run convenience only
        print(f"[cost_logger] could not create pricing template at {path}: {e}")


def load_pricing() -> dict[str, Any]:
    """Return the active pricing dict. Cached after first call."""
    global _cached_pricing, _cached_pricing_source
    with _lock:
        if _cached_pricing is not None:
            return _cached_pricing
        path = _pricing_file_path()
        _ensure_template_file(path)
        merged: dict[str, Any] = json.loads(json.dumps(DEFAULT_PRICING))
        try:
            if path.is_file():
                with path.open("r", encoding="utf-8") as f:
                    on_disk = json.load(f)
                if isinstance(on_disk, dict):
                    # strip the human-only "_note" marker before merge
                    on_disk.pop("_note", None)
                    merged = _deep_merge(merged, on_disk)
                _cached_pricing_source = str(path)
            else:
                _cached_pricing_source = "defaults_only"
        except Exception as e:
            print(f"[cost_logger] pricing file {path} unreadable: {e}; using defaults only.")
            _cached_pricing_source = "defaults_only"
        _cached_pricing = merged
        return _cached_pricing


def reload_pricing() -> dict[str, Any]:
    """Drop the cache and re-read from disk (useful while iterating)."""
    global _cached_pricing
    with _lock:
        _cached_pricing = None
    return load_pricing()


def pricing_source() -> str:
    load_pricing()
    return _cached_pricing_source or "defaults_only"


# --------------------------------------------------------------------------- #
# Per-provider getters. Return ``None`` rather than raising when a field is
# missing — the logger uses that to set ``estimated_cost_usd=null``.
# --------------------------------------------------------------------------- #
_DATE_SUFFIX_RX = re.compile(r"-\d+$")


def _openai_model_candidates(model: str) -> list[str]:
    """Yield progressively shorter forms of an OpenAI model slug.

    ``gpt-5.4-mini-2026-03-17`` → ``gpt-5.4-mini-2026-03`` → ``gpt-5.4-mini-2026``
    → ``gpt-5.4-mini``. Stops once no trailing ``-<digits>`` segment remains.
    Also strips a ``:fine-tune-id`` suffix as the first step.
    """
    cands: list[str] = []
    seen: set[str] = set()

    def _push(s: str) -> None:
        if s and s not in seen:
            cands.append(s)
            seen.add(s)

    base = (model or "").strip()
    _push(base)
    short = base.split(":")[0]
    _push(short)
    cur = short
    for _ in range(8):
        nxt = _DATE_SUFFIX_RX.sub("", cur)
        if nxt == cur:
            break
        _push(nxt)
        cur = nxt
    return cands


def get_openai_price(model: str | None) -> dict[str, float | None]:
    p = load_pricing().get("openai", {})
    if not isinstance(p, dict):
        return {}
    key = (model or "").strip()
    if not key:
        return p.get("default", {}) or {}
    for cand in _openai_model_candidates(key):
        if cand in p and isinstance(p[cand], dict):
            return p[cand]
    return p.get("default", {}) or {}


def get_fish_price(model_name: str | None = None) -> dict[str, float | None]:
    """Return the Fish Audio price entry for ``model_name``.

    Lookup order:
      1. Exact model match (e.g. ``"s1"``, ``"s2-pro"``).
      2. ``"default"`` entry.

    The returned dict is expected to carry ``billing_unit == "utf8_byte"``
    plus ``cost_per_utf8_byte`` / ``cost_per_1m_utf8_bytes`` /
    ``cost_per_1000_utf8_bytes``. Missing keys leave cost estimation null.
    """
    p = load_pricing().get("fish_audio", {})
    if not isinstance(p, dict):
        return {}
    key = (model_name or "").strip() or "default"
    if key in p and isinstance(p[key], dict):
        return p[key]
    return p.get("default", {}) or {}


def get_serper_price(endpoint: str | None = None) -> dict[str, float | None]:
    p = load_pricing().get("serper", {})
    if not isinstance(p, dict):
        return {}
    key = (endpoint or "").strip()
    if key and key in p and isinstance(p[key], dict):
        return p[key]
    return p.get("default", {}) or {}
