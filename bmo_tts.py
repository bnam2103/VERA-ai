"""
BMO TTS using the official Fish Audio Python SDK.

Used by app.py when the client sends ``client=bmo`` and Fish env is set.

Install (PyPI package is ``fish-audio-sdk``, not plain ``fishaudio``):

  py -m pip uninstall fishaudio -y
  py -m pip install "fish-audio-sdk[utils]"

Environment:
  FISH_API_KEY or FISH_AUDIO_API_KEY — API key
  REFERENCE_ID, FISH_REFERENCE_ID, or BMO_REFERENCE_ID — voice model id

  Optional API latency / quality (hosted ``tts.convert``, not self-hosted S2):
  FISH_TTS_MODEL — speech-1.5 | speech-1.6 | s1 | s2-pro (default: SDK default s2-pro).
    Lighter models are often faster; quality may differ.
  FISH_TTS_LATENCY — normal | balanced (SDK default is balanced = lower latency vs normal).
  FISH_TTS_SPEED — float, e.g. 1.1 for slightly faster speech (see Fish docs).
  FISH_MP3_BITRATE — 64 | 128 | 192 (smaller = slightly less data; default 128 via SDK).

  Docs: https://docs.fish.audio/api-reference/sdk/python/overview
"""

from __future__ import annotations

import os
from pathlib import Path


def _strip_env_value(v: str) -> str:
    """Trim whitespace, newlines, and a single pair of surrounding quotes from .env mistakes."""
    s = (v or "").strip().strip("\ufeff")
    s = s.replace("\r", "").replace("\n", "")
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        s = s[1:-1].strip()
    return s


def api_key_source() -> str:
    for name in ("FISH_AUDIO_API_KEY", "FISH_API_KEY"):
        v = _strip_env_value(os.environ.get(name) or "")
        if v:
            return v
    return ""


def reference_id_source() -> str:
    for name in ("REFERENCE_ID", "FISH_REFERENCE_ID", "BMO_REFERENCE_ID"):
        v = _strip_env_value(os.environ.get(name) or "")
        if v:
            return v
    return ""


def bmo_fish_configured() -> bool:
    """True if Fish credentials are set (no SDK import required)."""
    return bool(reference_id_source() and api_key_source())


_FISH_TTS_MODELS = frozenset({"speech-1.5", "speech-1.6", "s1", "s2-pro"})
_FISH_TTS_LATENCIES = frozenset({"normal", "balanced"})
_FISH_MP3_BITRATES = frozenset({64, 128, 192})

# Defensive cap so a long reasoning answer can never get accidentally
# routed to Fish Audio. Product target for BMO/persona voice is 300 chars;
# this hard cap is the safety net (Fish bills per UTF-8 byte at $15/1M B).
BMO_TTS_HARD_MAX_CHARS = 1000


def _fish_tts_options_from_env() -> tuple[str | None, str | None, float | None, int | None]:
    """Returns (model, latency, speed, mp3_bitrate) with unset entries as None."""
    model = _strip_env_value(os.environ.get("FISH_TTS_MODEL", ""))
    if model not in _FISH_TTS_MODELS:
        model = None
    latency = _strip_env_value(os.environ.get("FISH_TTS_LATENCY", ""))
    if latency not in _FISH_TTS_LATENCIES:
        latency = None
    speed: float | None = None
    sp = _strip_env_value(os.environ.get("FISH_TTS_SPEED", ""))
    if sp:
        try:
            speed = float(sp)
        except ValueError:
            pass
    mp3_bitrate: int | None = None
    br = _strip_env_value(os.environ.get("FISH_MP3_BITRATE", ""))
    if br.isdigit():
        v = int(br)
        if v in _FISH_MP3_BITRATES:
            mp3_bitrate = v
    return model, latency, speed, mp3_bitrate


def _load_fish_sdk():
    try:
        from fishaudio import FishAudio
        from fishaudio.utils import save
    except ImportError as e:
        raise ImportError(
            "Could not import FishAudio. Install the official SDK:\n\n"
            "  py -m pip uninstall fishaudio -y\n"
            '  py -m pip install "fish-audio-sdk[utils]"'
        ) from e
    return FishAudio, save


def fish_client(api_key: str | None = None):
    FishAudio, _ = _load_fish_sdk()
    key = (api_key or api_key_source()).strip()
    if not key:
        raise ValueError("Set FISH_API_KEY (or FISH_AUDIO_API_KEY) or pass api_key=")
    return FishAudio(api_key=key)


def generate_bmo_audio(
    text: str,
    output_path: str | Path,
    *,
    reference_id: str | None = None,
    api_key: str | None = None,
) -> Path:
    """
    Generate speech with your Fish voice and save to disk (extension sets format, e.g. .mp3).
    """
    _, save = _load_fish_sdk()
    ref = (reference_id or reference_id_source()).strip()
    if not ref:
        raise ValueError(
            "Set REFERENCE_ID (or FISH_REFERENCE_ID / BMO_REFERENCE_ID) or pass reference_id="
        )

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    client = fish_client(api_key=api_key)
    model, latency, speed, mp3_bitrate = _fish_tts_options_from_env()
    # Fish Audio HTTP API bills strictly per UTF-8 byte of the text submitted.
    # Pre-compute it so we can log cost regardless of whether the TTS call
    # succeeds or fails.
    safe_text = text or ""
    if len(safe_text) > BMO_TTS_HARD_MAX_CHARS:
        truncated_from = len(safe_text)
        safe_text = safe_text[:BMO_TTS_HARD_MAX_CHARS]
        print(
            f"[FISH_AUDIO_COST_DEBUG] bmo_text_truncated "
            f"from={truncated_from} to={BMO_TTS_HARD_MAX_CHARS}"
        )
        text = safe_text
    try:
        utf8_bytes_count = len(safe_text.encode("utf-8"))
    except Exception:
        utf8_bytes_count = None
    # Cost logging is best-effort and must never break TTS. ``model_name``
    # falls back to "default" so the pricing lookup still resolves.
    effective_model_name = (model or "default").strip() or "default"
    log_extra: dict = {
        "reference_id": ref,
        "latency": latency,
        "speed": speed,
        "mp3_bitrate": mp3_bitrate,
        "output_path": str(out),
    }

    try:
        if mp3_bitrate is not None:
            from fishaudio.types import TTSConfig

            cfg = TTSConfig(
                reference_id=ref,
                latency=latency or "balanced",
                mp3_bitrate=mp3_bitrate,
            )
            audio = client.tts.convert(
                text=text,
                config=cfg,
                **({"model": model} if model else {}),
                **({"speed": speed} if speed is not None else {}),
            )
        else:
            audio = client.tts.convert(
                text=text,
                reference_id=ref,
                **({"latency": latency} if latency else {}),
                **({"model": model} if model else {}),
                **({"speed": speed} if speed is not None else {}),
            )
    except Exception as e:
        # Always log the failed attempt so cost dashboards still see the
        # request (with success=False, estimated_cost_usd may still be set
        # because Fish bills on submitted bytes regardless of success).
        try:
            from cost_logging import log_fish_event as _log_fish_event

            _log_fish_event(
                text=safe_text,
                utf8_bytes=utf8_bytes_count,
                text_characters=len(safe_text),
                model_name=effective_model_name,
                mode="bmo",
                success=False,
                error_message=str(e),
                extra=log_extra,
            )
        except Exception as _fish_log_err:
            print(f"[cost_logger] fish log (failure path) skipped: {_fish_log_err}")
        err = str(e).lower()
        if "reference not found" in err or ("400" in str(e) and "reference" in err):
            raise RuntimeError(
                "Fish Audio: voice model id not accepted (HTTP 400 Reference not found). "
                "Fix: In fish.audio open **BMO** (or your voice) → copy the **model / API id** "
                "(long hex string, often 32 chars). It must belong to the **same account** as "
                "your API key. In `.env` use `REFERENCE_ID=...` with **no spaces** and usually "
                "**no quotes**. "
                f"Original error: {e}"
            ) from e
        raise

    save(audio, str(out))

    # Success path. ``estimated_cost_usd`` = utf8_bytes * cost_per_utf8_byte
    # from cost_logging.pricing.json (default $15 per 1M UTF-8 bytes).
    try:
        from cost_logging import log_fish_event as _log_fish_event

        _log_fish_event(
            text=safe_text,
            utf8_bytes=utf8_bytes_count,
            text_characters=len(safe_text),
            model_name=effective_model_name,
            mode="bmo",
            success=True,
            error_message=None,
            raw_response=None,
            extra=log_extra,
        )
    except Exception as _fish_log_err:
        print(f"[cost_logger] fish log skipped: {_fish_log_err}")

    return out


if __name__ == "__main__":
    import sys

    demo = (
        "This is a custom voice from Fish Audio! "
        "You can explore hundreds of different voices on the platform, "
        "or even create your own."
    )
    line = " ".join(sys.argv[1:]).strip() or demo
    dest = generate_bmo_audio(line, "bmo_fish_output.mp3")
    print(f"Wrote {dest.resolve()}")
