# app.py
import os
from pathlib import Path

# Load `.env` from this folder so Fish keys work when you start uvicorn/Cursor (not only CLI tests).
_ENV_FILE = Path(__file__).resolve().parent / ".env"
try:
    from dotenv import load_dotenv

    # utf-8-sig: avoids a BOM on Windows breaking the first variable name
    # override=True: values in `.env` win over empty user-level env vars
    _dotenv_loaded = load_dotenv(_ENV_FILE, encoding="utf-8-sig", override=True)
    if _ENV_FILE.is_file():
        print(f"[ENV] .env file: {_ENV_FILE} (applied={_dotenv_loaded})")
    else:
        print(f"[ENV] No file at {_ENV_FILE} — Fish keys must be set in the shell or create `.env` here.")
except ImportError:
    _dotenv_loaded = False
    if _ENV_FILE.is_file():
        print(
            "[ENV] `python-dotenv` not installed; `.env` is ignored. "
            "Run: py -m pip install python-dotenv"
        )

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from datetime import datetime
from collections import defaultdict
from time import time, perf_counter
from typing import Optional, AsyncIterator, Callable
import asyncio
import logging
import numpy as np
import io
import json
import re
import uuid
import string
from pydub.playback import play
from actions.check_time import handle_time_request
from actions.check_time import handle_date_request
from actions.check_time import handle_date_delta_request
from actions.check_time import is_supported_date_target
from actions.check_time import prepare_time_stream_messages
from actions.check_time import prepare_date_stream_messages
from actions.check_time import prepare_date_delta_stream_messages
from actions.finance import handle_finance_context_request, handle_finance_quote_request
from actions.finance import prepare_finance_quote_streaming, prepare_finance_context_streaming
from actions.news import prepare_news_streaming_messages
from actions.weather import handle_weather_request
from actions.weather import (
    DEFAULT_LOCATION,
    fetch_weather_facts_for_action,
    cache_weather_action_result,
    build_weather_prompt,
    normalize_location_key,
)
from intent import is_command, is_mute_voice_command
from ASR import transcribe_long
# from LLM import VeraAI
from TTS import speak_to_file, split_sentences_for_tts, pop_first_complete_segment
from bmo_tts import bmo_fish_configured, generate_bmo_audio
from pydub import AudioSegment
import random
from fastapi.staticfiles import StaticFiles
from actions.news import handle_news_request
# from QWEN import VeraAI
# from CHAT2 import VeraAI
from CHAT3 import VeraAI

# =========================
# CONFIG
# =========================

USERS_FILES_DIR = Path(__file__).resolve().parent / "users_files"

MODEL_PATH = None
# MODEL_PATH = r"C:\Users\User\Documents\Fine_Tuning_Projects\LLAMA_LLM_3B_instruct"
SERVER_STATE = "starting"
vera = None
MAX_ACTIVE_USERS = 10
SESSION_TTL = 30 * 60
MAX_TURNS = 20

TARGET_SR = 16000
MIN_AUDIO_BYTES = 1500
MIN_AUDIO_RMS = 0.0030 # 🔑 ENERGY GATE for quiet/short speech
MIN_VOICED_SECONDS = 0.05   # 🔑 NEW
ZCR_MIN = 0.01
ZCR_MAX = 0.40            # 🔑 NEW (TUNER; fast speech fails with lower number)

MAX_FEEDBACK_BYTES = 1 * 1024 * 1024  # 1 MB
EMPTY_REPLY_FALLBACK = "I'm sorry but there's some limitations that prevents me from answering this question."

# Sentence-level TTS: one file per segment (paragraph and/or sentence). Default ON; set VERA_TTS_SENTENCE_CHUNKS=0 to disable.
_RAW_TTS_CHUNK = os.environ.get("VERA_TTS_SENTENCE_CHUNKS", "1")


def tts_sentence_chunks_enabled() -> bool:
    """Read env each call so deploys without .env still default to chunked mode unless explicitly disabled."""
    raw = os.environ.get("VERA_TTS_SENTENCE_CHUNKS", "1")
    return raw.strip().lower() not in ("0", "false", "no")


TTS_SENTENCE_CHUNKS = tts_sentence_chunks_enabled()
print(
    f"[TTS] VERA_TTS_SENTENCE_CHUNKS raw={_RAW_TTS_CHUNK!r} → "
    f"sentence_chunking={'ON' if TTS_SENTENCE_CHUNKS else 'OFF'} "
    f"(opt-out: set to 0 | false | no)"
)


def _ndjson_stream_headers() -> dict[str, str]:
    """Reduce proxy buffering so each synthesized chunk can reach the client promptly."""
    return {
        "Cache-Control": "no-cache, no-store, no-transform",
        "Pragma": "no-cache",
        "X-Accel-Buffering": "no",
    }
WEATHER_LOCATION_PROMPT = "Which location should I check?"
WEATHER_LOCATION_INVALID_REPLY = "I couldn't recognize that location."
FINANCE_QUOTE_SUBJECT_PROMPT = "Which stock or ticker should I check?"
FINANCE_CONTEXT_SUBJECT_PROMPT = "Which company or ticker do you want finance context for?"
FINANCE_SUBJECT_INVALID_REPLY = "I couldn't tell which stock or company you meant."
PENDING_ACTION_TTL = 90
RECENT_ACTION_TTL = 300
# =========================
# APP
# =========================

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
_assets_dir = Path(__file__).resolve().parent / "assets"
if _assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="assets")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# =========================
# MODELS & LOCKS
# =========================


asr_lock = asyncio.Lock()
llm_lock = asyncio.Lock()
tts_lock = asyncio.Lock()

# =========================
# SESSION STATE
# =========================

user_histories = defaultdict(list)
user_last_seen = {}
total_sessions_seen = set()
pending_action = {}
recent_action_context = {}

# =========================
# HELPERS
# =========================

def safe_id(value: str) -> str:
    return "".join(c for c in value if c.isalnum() or c in ("_", "-"))

def today():
    return datetime.now().strftime("%Y-%m-%d")

def timestamp():
    return datetime.now().strftime("%H-%M-%S")

def cleanup_sessions():
    now = time()
    expired = [
        sid for sid, last in user_last_seen.items()
        if now - last > SESSION_TTL
    ]
    for sid in expired:
        user_histories.pop(sid, None)
        user_last_seen.pop(sid, None)
        pending_action.pop(sid, None)
        recent_action_context.pop(sid, None)
        # These were never pruned → unbounded growth and slower dict/GC over days.
    expired_pending = [
        sid for sid, state in pending_action.items()
        if state.get("expires_at", 0) < now
    ]
    for sid in expired_pending:
        pending_action.pop(sid, None)

    expired_recent = [
        sid for sid, state in recent_action_context.items()
        if now - state.get("updated_at", now) > RECENT_ACTION_TTL
    ]
    for sid in expired_recent:
        recent_action_context.pop(sid, None)

def zero_crossing_rate(samples: np.ndarray) -> float:
    return np.mean(samples[:-1] * samples[1:] < 0)

def voiced_duration(samples: np.ndarray, sr: int, thresh: float) -> float:
    mask = np.abs(samples) > thresh
    if not mask.any():
        return 0.0
    idx = np.where(mask)[0]
    return (idx[-1] - idx[0]) / sr

def spectral_ratio(samples, sr):
    spec = np.abs(np.fft.rfft(samples))
    freqs = np.fft.rfftfreq(len(samples), 1/sr)

    low = spec[(freqs >= 80) & (freqs <= 500)].mean()
    high = spec[(freqs >= 2000) & (freqs <= 6000)].mean()

    return high / (low + 1e-6)


def get_pending_action(session_id: str):
    state = pending_action.get(session_id)
    if not state:
        return None

    if state.get("expires_at", 0) < time():
        pending_action.pop(session_id, None)
        return None

    return state


def set_pending_action(session_id: str, action_name: str, missing_slot: str, slots: dict | None = None):
    pending_action[session_id] = {
        "action_name": action_name,
        "missing_slot": missing_slot,
        "slots": slots or {},
        "expires_at": time() + PENDING_ACTION_TTL,
    }


def clear_pending_action(session_id: str):
    pending_action.pop(session_id, None)


def get_recent_action_context(session_id: str):
    state = recent_action_context.get(session_id)
    if not state:
        return None

    if time() - state.get("updated_at", 0) > RECENT_ACTION_TTL:
        recent_action_context.pop(session_id, None)
        return None

    return state


def set_recent_action_context(session_id: str, action_name: str, slots: dict, result: dict):
    recent_action_context[session_id] = {
        "action_name": action_name,
        "slots": slots or {},
        "result": result,
        "updated_at": time(),
    }


def action_result_reply(action_result: dict | None) -> str | None:
    if not action_result:
        return None
    return action_result.get("spoken_reply")


def extract_short_followup_value(text: str) -> str | None:
    raw = text.strip().strip(string.punctuation + " ")
    if not raw:
        return None

    has_followup_prefix = bool(
        re.match(
            r"^(how about|what about|and|about|then|instead|for|actually(?:,\s*)?i meant|i meant|no,?\s*i meant)\b",
            raw,
            flags=re.IGNORECASE,
        )
    )
    if not has_followup_prefix:
        return None

    cleaned = raw
    cleaned = re.sub(
        r"^(how about|what about|and|about|then|instead|for|actually(?:,\s*)?i meant|i meant|no,?\s*i meant)\s+",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"\s+(?:as well|too|also|right now|for me|please)\s*$",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = cleaned.strip().strip(string.punctuation + " ")
    if not cleaned:
        return None

    words = cleaned.lower().split()
    if len(words) > 4:
        return None

    return cleaned


def clean_location_text(text: str | None) -> str:
    if text is None:
        return ""

    location = str(text).strip().strip(string.punctuation + " ")
    location = re.sub(r"^(in|for|at)\s+", "", location, flags=re.IGNORECASE)
    location = re.sub(
        r"\s+(?:as well|too|also|right now|for me|please)\s*$",
        "",
        location,
        flags=re.IGNORECASE,
    )
    return location.strip().strip(string.punctuation + " ")


def extract_weather_location(text: str) -> str | None:
    prefix = r"(?:hey vera[\s,]+|vera[\s,]+|can you\s+|could you\s+|would you\s+|please\s+)*"
    patterns = [
        rf"^{prefix}what(?:'s|s| is) the weather in (?P<location>.+)$",
        rf"^{prefix}what(?:'s|s| is) the weather like in (?P<location>.+)$",
        rf"^{prefix}tell me the weather in (?P<location>.+)$",
        rf"^{prefix}tell me what the weather is like in (?P<location>.+)$",
        rf"^{prefix}check the weather in (?P<location>.+)$",
        rf"^{prefix}current weather in (?P<location>.+)$",
        rf"^{prefix}how(?:'s|s| is) the weather in (?P<location>.+)$",
        rf"^{prefix}how(?:'s|s| is) the weather like in (?P<location>.+)$",
        rf"^{prefix}is it raining in (?P<location>.+)$",
        rf"^{prefix}is it rainy in (?P<location>.+)$",
        rf"^{prefix}is there rain in (?P<location>.+)$",
        rf"^{prefix}is it snowing in (?P<location>.+)$",
        rf"^{prefix}is it snowy in (?P<location>.+)$",
        rf"^{prefix}is there snow in (?P<location>.+)$",
        rf"^{prefix}is it sunny in (?P<location>.+)$",
        rf"^{prefix}is it clear in (?P<location>.+)$",
        rf"^{prefix}is it cloudy in (?P<location>.+)$",
        rf"^{prefix}is it overcast in (?P<location>.+)$",
        rf"^{prefix}is it foggy in (?P<location>.+)$",
        rf"^{prefix}is it humid in (?P<location>.+)$",
        rf"^{prefix}is it windy in (?P<location>.+)$",
        rf"^{prefix}how much rain is there in (?P<location>.+)$",
        rf"^{prefix}what(?:'s|s| is) the precipitation in (?P<location>.+)$",
        rf"^{prefix}weather for (?P<location>.+)$",
        rf"^{prefix}weather in (?P<location>.+)$",
    ]

    for pattern in patterns:
        match = re.match(pattern, text.strip(), flags=re.IGNORECASE)
        if not match:
            continue

        location = clean_location_text(match.group("location"))
        if location:
            return location

    return None


def is_plausible_location(text: str) -> bool:
    location = clean_location_text(text)
    if not location or len(location) > 80:
        return False

    if not re.search(r"[A-Za-z]", location):
        return False

    lowered = location.lower()
    if lowered in {
        "pause",
        "unpause",
        "resume",
        "stop",
        "cancel",
        "never mind",
        "nevermind",
    }:
        return False

    if any(phrase in lowered for phrase in ["what time", "what date", "the news", "the weather"]):
        return False

    return True


def resolve_pending_weather_request(session_id: str, text: str, filler_generation: int | None = None):
    clear_pending_action(session_id)

    extracted = vera.extract_location_slot(text)
    location = clean_location_text(extracted.get("location"))
    if not location:
        location = extract_weather_location(text) or clean_location_text(text)
    if not is_plausible_location(location):
        return {
            "spoken_reply": WEATHER_LOCATION_INVALID_REPLY,
            "action_type": "weather",
            "data": None,
            "ui_payload": None,
        }, 0.0

    t0 = perf_counter()
    action_result = handle_weather_request(vera, location=location)
    if action_result.get("data"):
        set_recent_action_context(
            session_id,
            "weather.current",
            {"location": location},
            action_result,
        )
    t_llm = perf_counter() - t0
    return action_result, t_llm


def is_weather_followup(text: str) -> bool:
    lowered = text.lower()
    keywords = [
        "weather",
        "rain",
        "raining",
        "precipitation",
        "sunny",
        "clear",
        "cloudy",
        "overcast",
        "foggy",
        "humid",
        "humidity",
        "wind",
        "windy",
        "temperature",
        "temp",
        "feels like",
        "cloud",
        "visibility",
        "pressure",
        "snow",
    ]
    return any(keyword in lowered for keyword in keywords)


def build_weather_context_message(weather_facts: dict) -> str:
    return (
        "Use this recent weather snapshot as context for follow-up weather questions. "
        "It describes current conditions only, not a forecast. "
        "Answer in a practical, neutral tone: no jokes, teasing, or personalization. "
        "You may add one brief practical tip when the data supports it (e.g. rain and umbrella), same as a weather briefing.\n\n"
        f"Location: {weather_facts['place_name']}\n"
        f"Temperature: {weather_facts['temperature_f']} F\n"
        f"Feels like: {weather_facts['feels_like_f']} F\n"
        f"Conditions: {weather_facts['condition']}\n"
        f"Wind speed: {weather_facts['wind_mph']} mph\n"
        f"Wind gust: {weather_facts['wind_gust_mph']} mph\n"
        f"Humidity: {weather_facts['humidity_percent']} percent\n"
        f"Pressure: {weather_facts['pressure_hpa']} hPa\n"
        f"Cloud cover: {weather_facts['cloudiness_percent']} percent\n"
        f"Visibility: {weather_facts['visibility_m']} meters\n"
        f"Rain in last 1 hour: {weather_facts['rain_1h_mm']} mm\n"
        f"Rain in last 3 hours: {weather_facts['rain_3h_mm']} mm\n"
        f"Snow in last 1 hour: {weather_facts['snow_1h_mm']} mm\n"
        f"Snow in last 3 hours: {weather_facts['snow_3h_mm']} mm\n"
    )


def add_weather_context(messages: list[dict], weather_facts: dict) -> list[dict]:
    augmented = list(messages)
    augmented.insert(-1, {
        "role": "system",
        "content": build_weather_context_message(weather_facts)
    })
    return augmented


def inject_recent_action_context(messages: list[dict], session_id: str, user_text: str) -> list[dict]:
    context = get_recent_action_context(session_id)
    if not context:
        return messages

    if context.get("action_name") != "weather.current":
        return messages

    weather_facts = context.get("result", {}).get("data")
    if not weather_facts or not is_weather_followup(user_text):
        return messages

    return add_weather_context(messages, weather_facts)


def answer_direct_weather_question(
    text: str,
    session_id: str | None,
    action_result: dict,
) -> str:
    weather_facts = action_result.get("data")
    if not weather_facts:
        return action_result_reply(action_result) or WEATHER_LOCATION_INVALID_REPLY

    if session_id is not None:
        set_recent_action_context(
            session_id,
            "weather.current",
            {"location": weather_facts.get("place_name")},
            action_result,
        )

    lowered = text.lower()
    if "weather" in lowered:
        return action_result_reply(action_result) or WEATHER_LOCATION_INVALID_REPLY

    messages = vera.build_messages([], text)
    messages = add_weather_context(messages, weather_facts)
    reply, _ = vera.generate(messages)
    return reply
# =========================
# SIMPLE INTENTS
# =========================
def enter_thinking():
    return {"status": "thinking"}

def detect_intent(text: str, history, session_id: str | None = None, filler_generation: int | None = None):
    route = route_action_request(session_id or "", text)
    if not route.get("is_action_request"):
        return None, 0.0

    action_result, t_llm = execute_structured_action(session_id or "", text, route, filler_generation=filler_generation)
    if action_result is None:
        return None, t_llm

    return action_result_reply(action_result), t_llm
    # else:
    #     messages = vera.build_messages(history, text)

    #     t0 = perf_counter()
    #     reply, _ = vera.generate(messages)
    #     reply = reply.strip()
    #     t_llm = perf_counter() - t0

    #     return reply, t_llm

# =========================
# PROMPT BUILDER
# =========================

# def build_messages(history, user_text):
#     system = (
#         vera.base_system_prompt
#         + "\n\nYou are VERA, a calm professional voice assistant."
#         + "\nDo not use markdown, emojis, or formatting."
#         + "\nYour output will be spoken aloud."
#     )

#     messages = [{"role": "system", "content": system}]
#     messages.extend(history)
#     messages.append({"role": "user", "content": user_text})
#     return messages

# =========================
# AUDIO PATHS
# =========================

def user_tts_dir(session_id):
    p = Path("tts_outputs") / session_id / today()
    p.mkdir(parents=True, exist_ok=True)
    return p

def user_feedback_dir(session_id):
    p = Path("feedback") / session_id
    p.mkdir(parents=True, exist_ok=True)
    return p

# =========================
# METRICS LOGGER
# =========================

async def log_metrics():
    while True:
        cleanup_sessions()
        print(
            f"[METRICS] users={len(user_last_seen)}/{MAX_ACTIVE_USERS} | "
            f"ASR={asr_lock.locked()} LLM={llm_lock.locked()} TTS={tts_lock.locked()}"
        )
        await asyncio.sleep(10)


def normalize_route(route: dict | None) -> dict:
    fallback = {
        "domain": "general",
        "is_action_request": False,
        "action_name": "general",
        "slots": {},
        "needs_followup": False,
        "missing_slot": None,
    }
    if not isinstance(route, dict):
        return fallback

    merged = dict(fallback)
    merged.update(route)
    if not isinstance(merged.get("slots"), dict):
        merged["slots"] = {}
    return merged


def clean_action_query(text: str | None) -> str:
    value = str(text or "").strip().strip(string.punctuation + " ")
    value = re.sub(r"\s+(?:right now|for me|please)\s*$", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+(?:also|and)\s+(?:why|what|how)\b.*$", "", value, flags=re.IGNORECASE)
    return value.strip().strip(string.punctuation + " ")


def clean_finance_subject_text(text: str | None) -> str:
    value = clean_action_query(text)
    value = re.sub(
        r"^(?:uh+|um+|erm+|hmm+|mm+|ah+|like|maybe|probably|i\s+mean|it'?s|its|about|for)\s+",
        "",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"^(?:the\s+)?(?:stock|stock price|share price|price|quote|ticker)\s+(?:of\s+|for\s+)?",
        "",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(r"^(?:the\s+)?(?:company|stock|ticker)\s*$", "", value, flags=re.IGNORECASE)
    return value.strip().strip(string.punctuation + " ")


def is_likely_finance_subject(query: str) -> bool:
    lowered = query.lower().strip()
    if not lowered:
        return False

    finance_keywords = [
        "stock",
        "stocks",
        "share",
        "shares",
        "etf",
        "fund",
        "ticker",
        "quote",
        "market",
        "earnings",
        "nasdaq",
        "nyse",
    ]
    if any(keyword in lowered for keyword in finance_keywords):
        return True

    compact = re.sub(r"[^a-z]", "", lowered)
    if compact and len(compact) <= 5 and " " not in lowered:
        return True

    return False


def is_breaking_news_phrase(text: str) -> bool:
    lowered = text.lower().strip()
    if not lowered:
        return False

    return bool(
        re.match(
            r"^(?:(?:can you tell me|tell me|give me|show me)\s+|(?:what(?:'s|s| is))\s+|(?:any)\s+)?"
            r"(?:(?:some|any)\s+)?"
            r"(?:the\s+)?(?:latest\s+)?"
            r"(?:breaking news|news right now|latest updates|what just happened|what happened just now)"
            r"(?:\s+right now)?[?!.\s]*$",
            lowered,
        )
    )


def is_ambiguous_breaking_news_phrase(text: str) -> bool:
    lowered = text.lower().strip()
    if not lowered:
        return False

    return bool(re.match(r"^(?:the\s+)?(?:latest\s+)?breaking news[?!.\s]*$", lowered))


def is_explicit_news_request(text: str, query: str | None = None, breaking: bool = False) -> bool:
    raw = (text or "").strip().lower()
    if not raw:
        return False

    if breaking:
        return is_breaking_news_phrase(raw)

    if query:
        return bool(
            re.search(
                r"\b(?:news\s+about|news\s+on|latest\s+on|what happened with|what(?:'s|s)\s+going\s+on\s+in|whats?\s+going\s+in|breaking news about|latest updates about|latest updates on)\b",
                raw,
            )
        )

    return bool(
        re.search(
            r"\b(?:what(?:'s|s| is)\s+the\s+news|latest\s+headlines|latest\s+news|breaking\s+news|news\s+right\s+now|update\s+me\s+on\s+the\s+news|tell\s+me\s+(?:some\s+|the\s+)?news|any\s+news)\b",
            raw,
        )
    )


def is_finance_followup_request(text: str, query: str | None = None, recent_action: dict | None = None) -> bool:
    raw = (text or "").strip().lower()
    cleaned_query = clean_finance_subject_text(query)
    if not raw or not cleaned_query or not is_plausible_finance_subject(cleaned_query):
        return False

    recent_action_name = (recent_action or {}).get("action_name")
    if recent_action_name not in {"finance.quote", "finance.context"}:
        return False

    if re.match(r"^(?:how about|what about|and|about)\b", raw):
        return True

    if re.search(r"\b(?:again|instead|according to|using|via|from)\b", raw):
        return True

    if re.search(r"\b(?:check|quote|price|stock|ticker|shares|trading)\b", raw):
        return True

    return False


def is_explicit_finance_request(text: str, action_name: str, query: str | None = None, recent_action: dict | None = None) -> bool:
    raw = (text or "").strip().lower()
    if not raw:
        return False

    if is_finance_followup_request(raw, query=query, recent_action=recent_action):
        return True

    if action_name == "finance.quote":
        return bool(
            re.search(
                r"\b(?:stock price|share price|price of|quote for|trading at|market cap|how much is)\b",
                raw,
            )
        )

    if action_name == "finance.context":
        if re.search(
            r"\b(?:what(?:'s|s| is)\s+happening with|what(?:'s|s| is)\s+going on with|why is|do you know why|what happened to|latest on .+ stock|tell me about .+ earnings|tell me about .+ guidance|how is .+ stock doing)\b",
            raw,
        ):
            return True

        if query and is_likely_finance_subject(query) and re.search(
            r"\b(?:down|up|drop|dropped|dropping|fall|fell|falling|rise|rose|rising|surge|surged|slump|slumped|tank|tanked|selloff|sell-off|red|green)\b",
            raw,
        ):
            return True

        if query and re.search(r"\b(?:earnings|guidance|outlook|stock|shares|etf|fund|ticker|market|quote)\b", raw):
            return True

        return False

    return False


def is_plausible_finance_subject(text: str | None) -> bool:
    subject = clean_finance_subject_text(text)
    if not subject or len(subject) > 80:
        return False

    lowered = subject.lower()
    if lowered in {
        "stock",
        "stocks",
        "share",
        "shares",
        "stock price",
        "share price",
        "price",
        "quote",
        "ticker",
        "company",
        "market",
    }:
        return False

    if not re.search(r"[A-Za-z0-9]", subject):
        return False

    return True


def resolve_pending_breaking_news_request(session_id: str, text: str, filler_generation: int | None = None):
    lowered = text.strip().lower()
    if not lowered:
        set_pending_action(session_id, "news.latest", "breaking_intent", {"breaking": True})
        return {
            "spoken_reply": "Do you want me to look up breaking news, or do you have breaking news for me?",
            "action_type": "news",
            "data": None,
            "ui_payload": None,
        }, 0.0

    query_choice = bool(
        re.search(
            r"\b(?:former|first|first one|the first one|first option|the first option|look it up|query it|search it|check it|fetch it|show me|tell me|give me|for me|from the web|online|you tell me|you look it up)\b",
            lowered,
        )
    )
    share_choice = bool(
        re.search(
            r"\b(?:latter|second|second one|the second one|second option|the second option|from me|for you|i have|i've got|i got|my news|hear me out|mine|my turn)\b",
            lowered,
        )
    )

    query_intent = (
        is_breaking_news_phrase(lowered)
        or bool(re.search(r"\b(?:query|look up|search|check|fetch|show me|tell me|give me|for me|from the web|online)\b", lowered))
        or lowered in {"yes", "yeah", "yep", "sure", "do that"}
        or query_choice
    )
    share_intent = share_choice

    if query_intent and not share_intent:
        clear_pending_action(session_id)
        t0 = perf_counter()
        action_result = handle_news_request(vera, query=None, breaking=True)
        set_recent_action_from_result(session_id, "news.latest", {"breaking": True}, action_result)
        return action_result, perf_counter() - t0

    if share_intent and not query_intent:
        clear_pending_action(session_id)
        return None, 0.0

    set_pending_action(session_id, "news.latest", "breaking_intent", {"breaking": True})
    return {
        "spoken_reply": "Do you want me to look up breaking news, or do you have breaking news for me?",
        "action_type": "news",
        "data": None,
        "ui_payload": None,
    }, 0.0


def resolve_pending_finance_request(session_id: str, text: str, pending: dict, filler_generation: int | None = None):
    action_name = pending.get("action_name")
    subject = clean_finance_subject_text(text)
    if not is_plausible_finance_subject(subject):
        prompt = (
            FINANCE_QUOTE_SUBJECT_PROMPT
            if action_name == "finance.quote"
            else FINANCE_CONTEXT_SUBJECT_PROMPT
        )
        set_pending_action(session_id, action_name, pending.get("missing_slot", "query"), pending.get("slots", {}))
        return {
            "spoken_reply": prompt,
            "action_type": "finance",
            "data": None,
            "ui_payload": None,
        }, 0.0

    clear_pending_action(session_id)
    slots = dict(pending.get("slots", {}))
    slots["query"] = subject

    t0 = perf_counter()
    if action_name == "finance.quote":
        action_result = handle_finance_quote_request(vera, query=subject)
    else:
        action_result = handle_finance_context_request(vera, query=subject)

    set_recent_action_from_result(session_id, action_name, slots, action_result)
    return action_result, perf_counter() - t0


def normalize_followup_query(candidate: str) -> str:
    value = clean_action_query(candidate)
    value = re.sub(r"^(?:the|more on|about)\s+", "", value, flags=re.IGNORECASE)
    return value.strip().strip(string.punctuation + " ")


def is_news_refinement_phrase(query: str) -> bool:
    lowered = query.lower()
    return any(
        keyword in lowered for keyword in [
            "economy",
            "economic",
            "business",
            "company",
            "companies",
            "market",
            "markets",
            "politics",
            "political",
            "government",
            "war",
            "conflict",
            "tech",
            "technology",
        ]
    )


def build_news_followup_query(base_query: str | None, candidate: str) -> str:
    followup = normalize_followup_query(candidate)
    if not followup:
        return ""

    base = clean_action_query(base_query)
    if base and is_news_refinement_phrase(followup):
        return f"{base} {followup}".strip()

    return followup


def build_finance_followup_route(recent_action: str, recent_query: str | None, candidate: str) -> dict | None:
    followup = normalize_followup_query(candidate)
    if not followup:
        return None

    recent_subject = clean_action_query(recent_query)
    lowered = followup.lower()

    if re.search(r"\b(?:price|quote|trading at|trading)\b", lowered):
        subject = recent_subject or followup
        if not subject:
            return None
        return {
            "is_action_request": True,
            "action_name": "finance.quote",
            "slots": {"query": subject},
        }

    if re.search(r"\b(?:why|happening|going on|news|earnings|guidance|outlook)\b", lowered):
        subject = recent_subject or followup
        if not subject:
            return None
        return {
            "is_action_request": True,
            "action_name": "finance.context",
            "slots": {"query": subject},
        }

    if is_likely_finance_subject(followup):
        return {
            "is_action_request": True,
            "action_name": recent_action,
            "slots": {"query": followup},
        }

    if recent_subject:
        return {
            "is_action_request": True,
            "action_name": "finance.context",
            "slots": {"query": f"{recent_subject} {followup}".strip()},
        }

    return None


def heuristic_route_action(text: str) -> dict | None:
    raw = text.strip()
    if not raw:
        return None

    if is_ambiguous_breaking_news_phrase(raw):
        return {
            "domain": "news",
            "is_action_request": True,
            "action_name": "news.latest",
            "slots": {"breaking": True},
            "needs_followup": True,
            "missing_slot": "breaking_intent",
        }

    if is_breaking_news_phrase(raw):
        return {
            "domain": "news",
            "is_action_request": True,
            "action_name": "news.latest",
            "slots": {"breaking": True},
            "needs_followup": False,
            "missing_slot": None,
        }

    latest_on_match = re.match(
        r"^(?:can you tell me\s+)?latest on (?P<query>.+?)(?:\s+stock)?$",
        raw,
        flags=re.IGNORECASE,
    )
    if latest_on_match:
        query = clean_action_query(latest_on_match.group("query"))
        if not query:
            return None
        action_name = "finance.context" if is_likely_finance_subject(query) else "news.latest"
        domain = "finance" if action_name == "finance.context" else "news"
        return {
            "domain": domain,
            "is_action_request": True,
            "action_name": action_name,
            "slots": {"query": query},
            "needs_followup": False,
            "missing_slot": None,
        }

    patterns = [
        (
            "finance.quote",
            [
                r"^(?:can you tell me\s+)?(?:the\s+)?stock price of (?P<query>.+)$",
                r"^(?:can you tell me\s+)?(?:the\s+)?share price of (?P<query>.+)$",
                r"^(?:what(?:'s|s| is)\s+)?the price of (?P<query>.+)$",
                r"^(?:can you tell me\s+)?quote for (?P<query>.+)$",
                r"^(?:what(?:'s|s| is)\s+)(?P<query>.+?) trading at(?:\s+right now)?$",
            ],
        ),
        (
            "finance.context",
            [
                r"^(?:can you tell me\s+)?what(?:'s|s) happening with (?P<query>.+)$",
                r"^(?:can you tell me\s+)?what(?:'s|s) going on with (?P<query>.+)$",
            ],
        ),
        (
            "news.latest",
            [
                r"^(?:can you tell me\s+)?what(?:'s|s) going on in (?P<query>.+)$",
                r"^(?:can you tell me\s+)?whats going in (?P<query>.+)$",
                r"^(?:can you tell me\s+)?(?:the\s+)?breaking news(?:\s+about|\s+on)? (?P<query>.+)$",
                r"^(?:can you tell me\s+)?(?:the\s+)?latest updates(?:\s+about|\s+on)? (?P<query>.+)$",
            ],
        ),
    ]

    for action_name, action_patterns in patterns:
        for pattern in action_patterns:
            match = re.match(pattern, raw, flags=re.IGNORECASE)
            if not match:
                continue

            query = clean_action_query(match.group("query"))
            if not query:
                return None

            if action_name == "finance.context":
                if not is_likely_finance_subject(query):
                    action_name = "news.latest"
                domain = "news" if action_name == "news.latest" else "finance"
            else:
                domain = "news" if action_name == "news.latest" else "finance"

            return {
                "domain": domain,
                "is_action_request": True,
                "action_name": action_name,
                "slots": {"query": query},
                "needs_followup": False,
                "missing_slot": None,
            }

    return None


def route_action_request(session_id: str, text: str) -> dict:
    def finalize(route: dict | None) -> dict:
        normalized = normalize_route(route)
        print(
            f"[ACTION-ROUTER] user={repr(text[:120])} "
            f"action={normalized.get('action_name')} "
            f"followup={normalized.get('needs_followup')} "
            f"slots={normalized.get('slots')}"
        )
        return normalized

    recent_action = get_recent_action_context(session_id)
    heuristic = heuristic_route_action(text)
    if heuristic is not None:
        normalized = normalize_route(heuristic)
        if normalized.get("action_name") == "news.latest":
            if normalized.get("needs_followup") and normalized.get("missing_slot") == "breaking_intent":
                return finalize(normalized)
        return finalize(normalized)

    normalized = normalize_route(
        vera.route_action(
            text,
            pending_action=get_pending_action(session_id),
            recent_action=recent_action,
        )
    )
    if normalized.get("action_name") == "news.latest":
        if normalized.get("needs_followup") and normalized.get("missing_slot") == "breaking_intent":
            return finalize(normalized)

    return finalize(normalized)


def set_recent_action_from_result(session_id: str, action_name: str, slots: dict, action_result: dict):
    if action_result.get("data") is None and action_result.get("ui_payload") is None:
        return
    set_recent_action_context(session_id, action_name, slots, action_result)


def execute_structured_action(session_id: str, text: str, route: dict, filler_generation: int | None = None) -> tuple[dict | None, float]:
    action_name = route.get("action_name")
    slots = route.get("slots", {})
    t0 = perf_counter()

    if route.get("needs_followup"):
        if action_name == "weather.current" and route.get("missing_slot") == "location":
            set_pending_action(session_id, "weather.current", "location", slots)
            action_result = {
                "spoken_reply": WEATHER_LOCATION_PROMPT,
                "action_type": "weather",
                "data": None,
                "ui_payload": None,
            }
            return action_result, perf_counter() - t0
        if action_name == "news.latest" and route.get("missing_slot") == "breaking_intent":
            set_pending_action(session_id, "news.latest", "breaking_intent", slots)
            action_result = {
                "spoken_reply": "Do you want me to look up breaking news, or do you have breaking news for me?",
                "action_type": "news",
                "data": None,
                "ui_payload": None,
            }
            return action_result, perf_counter() - t0
        if action_name in {"finance.quote", "finance.context"} and route.get("missing_slot") in {"query", "ticker", "subject", None}:
            missing_slot = route.get("missing_slot") or "query"
            set_pending_action(session_id, action_name, missing_slot, slots)
            action_result = {
                "spoken_reply": (
                    FINANCE_QUOTE_SUBJECT_PROMPT
                    if action_name == "finance.quote"
                    else FINANCE_CONTEXT_SUBJECT_PROMPT
                ),
                "action_type": "finance",
                "data": None,
                "ui_payload": None,
            }
            return action_result, perf_counter() - t0
        return None, 0.0

    if action_name == "weather.current":
        location = clean_location_text(slots.get("location", ""))
        if not location:
            set_pending_action(session_id, "weather.current", "location", slots)
            action_result = {
                "spoken_reply": WEATHER_LOCATION_PROMPT,
                "action_type": "weather",
                "data": None,
                "ui_payload": None,
            }
            return action_result, perf_counter() - t0

        action_result = handle_weather_request(vera, location=location)
        if action_result.get("data"):
            reply = answer_direct_weather_question(text, session_id, action_result)
            action_result = {**action_result, "spoken_reply": reply}
            set_recent_action_from_result(session_id, action_name, {"location": location, **slots}, action_result)
        return action_result, perf_counter() - t0

    if action_name == "weather.followup":
        recent = get_recent_action_context(session_id)
        if recent and recent.get("action_name") == "weather.current":
            action_result = dict(recent.get("result", {}))
            action_result["spoken_reply"] = answer_direct_weather_question(text, session_id, action_result)
            set_recent_action_from_result(session_id, "weather.current", recent.get("slots", {}), action_result)
            return action_result, perf_counter() - t0
        return None, 0.0

    if action_name == "time.current":
        location = clean_location_text(slots.get("location", ""))
        action_result = handle_time_request(vera, location=location or None)
        effective_slots = dict(slots)
        effective_slots["location"] = location or action_result.get("data", {}).get("place_name")
        set_recent_action_from_result(session_id, action_name, effective_slots, action_result)
        return action_result, perf_counter() - t0

    if action_name == "date.current":
        location = clean_location_text(slots.get("location", ""))
        action_result = handle_date_request(vera, location=location or None)
        effective_slots = dict(slots)
        effective_slots["location"] = location or action_result.get("data", {}).get("place_name")
        set_recent_action_from_result(session_id, action_name, effective_slots, action_result)
        return action_result, perf_counter() - t0

    if action_name == "date.delta":
        target_name = (slots.get("target_name") or slots.get("target") or "").strip()
        location = clean_location_text(slots.get("location", ""))
        if not target_name:
            return None, 0.0
        action_result = handle_date_delta_request(vera, target_name=target_name, location=location or None)
        action_data = action_result.get("data") or {}
        effective_slots = dict(slots)
        effective_slots["target_name"] = target_name
        effective_slots["location"] = location or action_data.get("place_name")
        set_recent_action_from_result(session_id, action_name, effective_slots, action_result)
        return action_result, perf_counter() - t0

    if action_name == "news.latest":
        query = (slots.get("query") or slots.get("topic") or "").strip()
        breaking = bool(slots.get("breaking"))
        action_result = handle_news_request(vera, query=query or None, breaking=breaking)
        set_recent_action_from_result(session_id, action_name, slots, action_result)
        return action_result, perf_counter() - t0

    if action_name == "finance.quote":
        query = (slots.get("query") or slots.get("ticker") or slots.get("subject") or "").strip()
        if not query:
            return None, 0.0
        action_result = handle_finance_quote_request(vera, query=query)
        set_recent_action_from_result(session_id, action_name, {"query": query, **slots}, action_result)
        return action_result, perf_counter() - t0

    if action_name == "finance.context":
        query = (slots.get("query") or slots.get("ticker") or slots.get("subject") or "").strip()
        if not query:
            return None, 0.0
        action_result = handle_finance_context_request(vera, query=query)
        set_recent_action_from_result(session_id, action_name, {"query": query, **slots}, action_result)
        return action_result, perf_counter() - t0

    return None, 0.0


class PreparedStreamingAction:
    """Structured action routed to async_generate_stream + sentence TTS (same as general chat)."""

    __slots__ = ("messages", "meta_action_type", "meta_action_payload", "finalize")

    def __init__(
        self,
        messages: list[dict],
        meta_action_type: str | None,
        meta_action_payload: dict | None,
        finalize: Callable[[str], dict],
    ):
        self.messages = messages
        self.meta_action_type = meta_action_type
        self.meta_action_payload = meta_action_payload
        self.finalize = finalize


def build_weather_stream_messages(vera, transcript: str, facts: dict) -> list[dict]:
    """Match handle_weather_request + answer_direct_weather_question without generate."""
    lowered = transcript.lower()
    if "weather" in lowered:
        return vera.build_messages([], build_weather_prompt(facts))
    messages = vera.build_messages([], transcript)
    return add_weather_context(messages, facts)


def prepare_streaming_structured_action(
    session_id: str,
    text: str,
    route: dict,
    filler_generation: int | None = None,
) -> PreparedStreamingAction | None:
    """Mirror execute_structured_action but return LLM messages + finalize() instead of blocking generate."""
    action_name = route.get("action_name")
    slots = route.get("slots", {})

    if route.get("needs_followup"):
        return None

    if action_name == "weather.current":
        location = clean_location_text(slots.get("location", ""))
        if not location:
            return None
        facts, err = fetch_weather_facts_for_action(location)
        if err:
            return None
        messages = build_weather_stream_messages(vera, text, facts)
        cache_key = normalize_location_key(location or DEFAULT_LOCATION)
        effective_slots = dict(slots)
        effective_slots["location"] = location or facts.get("place_name")

        def finalize(full_reply: str) -> dict:
            ar = {
                "spoken_reply": full_reply,
                "action_type": "weather",
                "data": facts,
                "ui_payload": None,
            }
            cache_weather_action_result(cache_key, ar)
            set_recent_action_from_result(session_id, "weather.current", effective_slots, ar)
            return ar

        return PreparedStreamingAction(messages, "weather", None, finalize)

    if action_name == "weather.followup":
        recent = get_recent_action_context(session_id)
        if not recent or recent.get("action_name") != "weather.current":
            return None
        action_result = dict(recent.get("result", {}))
        facts = action_result.get("data")
        if not facts:
            return None
        messages = build_weather_stream_messages(vera, text, facts)

        def finalize(full_reply: str) -> dict:
            ar = {**action_result, "spoken_reply": full_reply}
            set_recent_action_from_result(session_id, "weather.current", recent.get("slots", {}), ar)
            return ar

        return PreparedStreamingAction(messages, "weather", None, finalize)

    if action_name == "time.current":
        location = clean_location_text(slots.get("location", ""))
        p = prepare_time_stream_messages(vera, location or None)
        if p is None:
            return None
        messages, facts = p
        effective_slots = dict(slots)
        effective_slots["location"] = location or facts.get("place_name")

        def finalize(full_reply: str) -> dict:
            ar = {
                "spoken_reply": full_reply,
                "action_type": "time",
                "data": facts,
                "ui_payload": None,
            }
            set_recent_action_from_result(session_id, "time.current", effective_slots, ar)
            return ar

        return PreparedStreamingAction(messages, "time", None, finalize)

    if action_name == "date.current":
        location = clean_location_text(slots.get("location", ""))
        p = prepare_date_stream_messages(vera, location or None)
        if p is None:
            return None
        messages, facts = p
        effective_slots = dict(slots)
        effective_slots["location"] = location or facts.get("place_name")

        def finalize(full_reply: str) -> dict:
            ar = {
                "spoken_reply": full_reply,
                "action_type": "date",
                "data": facts,
                "ui_payload": None,
            }
            set_recent_action_from_result(session_id, "date.current", effective_slots, ar)
            return ar

        return PreparedStreamingAction(messages, "date", None, finalize)

    if action_name == "date.delta":
        target_name = (slots.get("target_name") or slots.get("target") or "").strip()
        location = clean_location_text(slots.get("location", ""))
        if not target_name:
            return None
        p = prepare_date_delta_stream_messages(vera, target_name, location or None)
        if p is None:
            return None
        messages, facts = p
        effective_slots = dict(slots)
        effective_slots["target_name"] = target_name
        effective_slots["location"] = location or facts.get("place_name")

        def finalize(full_reply: str) -> dict:
            ar = {
                "spoken_reply": full_reply,
                "action_type": "date",
                "data": facts,
                "ui_payload": None,
            }
            set_recent_action_from_result(session_id, "date.delta", effective_slots, ar)
            return ar

        return PreparedStreamingAction(messages, "date", None, finalize)

    if action_name == "news.latest":
        query = (slots.get("query") or slots.get("topic") or "").strip()
        breaking = bool(slots.get("breaking"))
        prepared = prepare_news_streaming_messages(vera, query or None, breaking)
        if prepared is None:
            return None
        messages, ui_payload, fin = prepared

        def finalize(full_reply: str) -> dict:
            ar = fin(full_reply)
            set_recent_action_from_result(session_id, "news.latest", slots, ar)
            return ar

        return PreparedStreamingAction(messages, "news", ui_payload, finalize)

    if action_name == "finance.quote":
        query = (slots.get("query") or slots.get("ticker") or slots.get("subject") or "").strip()
        if not query:
            return None
        prepared = prepare_finance_quote_streaming(vera, query)
        if prepared is None:
            return None
        messages, ui_payload, fin = prepared

        def finalize(full_reply: str) -> dict:
            ar = fin(full_reply)
            set_recent_action_from_result(session_id, "finance.quote", {"query": query, **slots}, ar)
            return ar

        return PreparedStreamingAction(messages, "finance", ui_payload, finalize)

    if action_name == "finance.context":
        query = (slots.get("query") or slots.get("ticker") or slots.get("subject") or "").strip()
        if not query:
            return None
        prepared = prepare_finance_context_streaming(vera, query)
        if prepared is None:
            return None
        messages, ui_payload, fin = prepared

        def finalize(full_reply: str) -> dict:
            ar = fin(full_reply)
            set_recent_action_from_result(session_id, "finance.context", {"query": query, **slots}, ar)
            return ar

        return PreparedStreamingAction(messages, "finance", ui_payload, finalize)

    return None


def resolve_recent_action_followup(session_id: str, text: str, filler_generation: int | None = None) -> tuple[dict | None, float]:
    recent = get_recent_action_context(session_id)
    if not recent:
        return None, 0.0

    candidate = extract_short_followup_value(text)
    if not candidate:
        return None, 0.0

    action_name = recent.get("action_name")
    recent_slots = recent.get("slots", {})
    route = None

    if action_name in {"weather.current", "time.current", "date.current"} and is_plausible_location(candidate):
        route = {
            "is_action_request": True,
            "action_name": action_name,
            "slots": {"location": candidate},
        }
    elif action_name == "date.delta":
        if is_supported_date_target(candidate):
            route = {
                "is_action_request": True,
                "action_name": "date.delta",
                "slots": {
                    "target_name": candidate,
                    "location": recent_slots.get("location"),
                },
            }
        elif is_plausible_location(candidate):
            route = {
                "is_action_request": True,
                "action_name": "date.delta",
                "slots": {
                    "target_name": recent_slots.get("target_name"),
                    "location": candidate,
                },
            }
        else:
            route = {
                "is_action_request": True,
                "action_name": "date.delta",
                "slots": {
                    "target_name": candidate,
                    "location": recent_slots.get("location"),
                },
            }
    elif action_name == "news.latest":
        query = build_news_followup_query(recent_slots.get("query"), candidate)
        if query:
            route = {
                "is_action_request": True,
                "action_name": "news.latest",
                "slots": {"query": query},
            }
    elif action_name in {"finance.quote", "finance.context"}:
        route = build_finance_followup_route(action_name, recent_slots.get("query"), candidate)

    if not route:
        return None, 0.0

    action_result, t_llm = execute_structured_action(session_id, text, normalize_route(route), filler_generation=filler_generation)
    if action_result is None:
        return None, t_llm

    if action_result.get("data") is None:
        return None, 0.0

    return action_result, t_llm


def prepare_streaming_followup(session_id: str, text: str, filler_generation: int | None = None) -> PreparedStreamingAction | None:
    recent = get_recent_action_context(session_id)
    if not recent:
        return None

    candidate = extract_short_followup_value(text)
    if not candidate:
        return None

    action_name = recent.get("action_name")
    recent_slots = recent.get("slots", {})
    route = None

    if action_name in {"weather.current", "time.current", "date.current"} and is_plausible_location(candidate):
        route = {
            "is_action_request": True,
            "action_name": action_name,
            "slots": {"location": candidate},
        }
    elif action_name == "date.delta":
        if is_supported_date_target(candidate):
            route = {
                "is_action_request": True,
                "action_name": "date.delta",
                "slots": {
                    "target_name": candidate,
                    "location": recent_slots.get("location"),
                },
            }
        elif is_plausible_location(candidate):
            route = {
                "is_action_request": True,
                "action_name": "date.delta",
                "slots": {
                    "target_name": recent_slots.get("target_name"),
                    "location": candidate,
                },
            }
        else:
            route = {
                "is_action_request": True,
                "action_name": "date.delta",
                "slots": {
                    "target_name": candidate,
                    "location": recent_slots.get("location"),
                },
            }
    elif action_name == "news.latest":
        query = build_news_followup_query(recent_slots.get("query"), candidate)
        if query:
            route = {
                "is_action_request": True,
                "action_name": "news.latest",
                "slots": {"query": query},
            }
    elif action_name in {"finance.quote", "finance.context"}:
        route = build_finance_followup_route(action_name, recent_slots.get("query"), candidate)

    if not route:
        return None

    return prepare_streaming_structured_action(session_id, text, normalize_route(route), filler_generation=filler_generation)


def try_prepare_streaming_action_messages(
    session_id: str, text: str, history: list[dict], filler_generation: int | None = None
) -> PreparedStreamingAction | None:
    _ = history  # same signature as resolve_reply_if_not_general_llm; routing does not use history today
    pending = get_pending_action(session_id)
    if pending and pending.get("action_name") == "weather.current" and pending.get("missing_slot") == "location":
        return None
    if pending and pending.get("action_name") == "news.latest" and pending.get("missing_slot") == "breaking_intent":
        return None
    if pending and pending.get("action_name") in {"finance.quote", "finance.context"}:
        return None

    from_followup = prepare_streaming_followup(session_id, text, filler_generation)
    if from_followup is not None:
        return from_followup

    route = route_action_request(session_id, text)
    if not route.get("is_action_request"):
        return None
    return prepare_streaming_structured_action(session_id, text, route, filler_generation=filler_generation)


def run_general_llm(history: list[dict], text: str, session_id: str) -> tuple[str, float]:
    messages = vera.build_messages(history, text)
    messages = inject_recent_action_context(messages, session_id, text)

    t0 = perf_counter()
    reply, confidence = vera.generate(messages)
    t_llm = perf_counter() - t0
    print(f"[LLM] conf={confidence:.3f}")

    return reply, t_llm


def resolve_reply_if_not_general_llm(
    session_id: str, text: str, history: list[dict], filler_generation: int | None = None
) -> tuple[str, float, dict | None] | None:
    """
    If routing would call run_general_llm, return None.
    Otherwise return the same (reply, t_llm, action_result) as process_user_input for action/followup paths.
    """
    pending = get_pending_action(session_id)
    if pending and pending.get("action_name") == "weather.current" and pending.get("missing_slot") == "location":
        action_result, t_llm = resolve_pending_weather_request(session_id, text, filler_generation=filler_generation)
        return action_result_reply(action_result) or WEATHER_LOCATION_INVALID_REPLY, t_llm, action_result
    if pending and pending.get("action_name") == "news.latest" and pending.get("missing_slot") == "breaking_intent":
        action_result, t_llm = resolve_pending_breaking_news_request(session_id, text, filler_generation=filler_generation)
        if action_result is not None:
            return action_result_reply(action_result) or EMPTY_REPLY_FALLBACK, t_llm, action_result
    if pending and pending.get("action_name") in {"finance.quote", "finance.context"}:
        action_result, t_llm = resolve_pending_finance_request(session_id, text, pending, filler_generation=filler_generation)
        return action_result_reply(action_result) or FINANCE_SUBJECT_INVALID_REPLY, t_llm, action_result

    followup_result, followup_t_llm = resolve_recent_action_followup(session_id, text, filler_generation=filler_generation)
    if followup_result is not None:
        reply = action_result_reply(followup_result) or EMPTY_REPLY_FALLBACK
        return reply, followup_t_llm, followup_result

    route = route_action_request(session_id, text)
    if route.get("is_action_request"):
        action_result, t_llm = execute_structured_action(session_id, text, route, filler_generation=filler_generation)
        if action_result is not None:
            reply = action_result_reply(action_result) or EMPTY_REPLY_FALLBACK
            return reply, t_llm, action_result

    return None


def process_user_input(session_id: str, text: str, history: list[dict], filler_generation: int | None = None) -> tuple[str, float, dict | None]:
    resolved = resolve_reply_if_not_general_llm(session_id, text, history, filler_generation=filler_generation)
    if resolved is not None:
        return resolved
    reply, t_llm = run_general_llm(history, text, session_id)
    return reply, t_llm, None


def _sync_synthesize_segment(
    seg: str,
    session_id: str,
    date_str: str,
    tts_dir: Path,
    use_bmo_fish: bool,
    client: str,
) -> str:
    """Blocking TTS for one segment; returns relative URL /audio/..."""
    ext = ".mp3" if use_bmo_fish else ".wav"
    fname = f"{timestamp()}-{uuid.uuid4().hex[:10]}{ext}"
    path = tts_dir / fname

    if use_bmo_fish:
        try:
            generate_bmo_audio(seg, path)
        except Exception as e:
            print(f"[TTS][BMO][FISH] fallback to local SpeechT5: {e}")
            fname = f"{timestamp()}-{uuid.uuid4().hex[:10]}.wav"
            path = tts_dir / fname
            speak_to_file(seg, path)
    else:
        if (client or "vera").strip().lower() == "bmo" and not bmo_fish_configured():
            print(
                "[TTS][BMO] Fish not configured — set FISH_API_KEY + REFERENCE_ID "
                "for the same process that runs app.py (e.g. `.env` next to app.py + "
                "`pip install python-dotenv`), or export vars before starting uvicorn."
            )
        speak_to_file(seg, path)

    return f"/audio/{session_id}/{date_str}/{fname}"


def _segments_for_tts(reply: str) -> list[str]:
    if not reply or not str(reply).strip():
        reply = EMPTY_REPLY_FALLBACK
    if tts_sentence_chunks_enabled():
        segments = split_sentences_for_tts(reply)
        if not segments:
            segments = [reply.strip() or EMPTY_REPLY_FALLBACK]
    else:
        segments = [reply.strip() or EMPTY_REPLY_FALLBACK]
    return segments


def _cumulative_reply_display(parts: list[str]) -> str:
    """Join completed TTS segments for incremental assistant bubble text."""
    return " ".join(s.strip() for s in parts if s and str(s).strip()).strip()


async def iter_tts_chunk_ndjson_lines(session_id: str, reply: str, client: str) -> AsyncIterator[str]:
    """
    Yield one NDJSON line per synthesized chunk as soon as it's ready (streaming TTS).
    Each line: {"type":"chunk","index":i,"url":"/audio/..."}
    """
    if not reply or not str(reply).strip():
        reply = EMPTY_REPLY_FALLBACK
    tts_dir = user_tts_dir(session_id)
    use_bmo_fish = (client or "vera").strip().lower() == "bmo" and bmo_fish_configured()
    segments = _segments_for_tts(reply)
    date_str = today()
    cum_parts: list[str] = []
    for i, seg in enumerate(segments):
        async with tts_lock:
            rel = await asyncio.to_thread(
                _sync_synthesize_segment,
                seg,
                session_id,
                date_str,
                tts_dir,
                use_bmo_fish,
                client,
            )
        cum_parts.append(seg)
        reply_so_far = _cumulative_reply_display(cum_parts)
        line = json.dumps(
            {"type": "chunk", "index": i, "url": rel, "reply_so_far": reply_so_far},
            ensure_ascii=False,
        ) + "\n"
        yield line
        await asyncio.sleep(0)

async def iter_infer_tts_ndjson_stream(
    *,
    infer_t0: float,
    session_id: str,
    transcript: str,
    reply: str,
    client: str,
    action_result,
    t_pre_asr: float,
    t_asr_lock: float,
    t_asr_transcribe: float,
    t_asr_lock_end: float,
    t_llm_start: float,
    t_llm_end: float,
    t_llm_reported: float,
) -> AsyncIterator[str]:
    """NDJSON: meta → chunk lines → done (full infer latency)."""
    if not reply or not str(reply).strip():
        reply = EMPTY_REPLY_FALLBACK

    t_bridge = t_llm_start - t_asr_lock_end
    t_llm_wall = t_llm_end - t_llm_start
    segs = _segments_for_tts(reply)

    meta = {
        "type": "meta",
        "transcript": transcript,
        "reply": reply,
        "session_id": session_id,
        "client": client,
        "tts_segment_count": len(segs),
        "action_payload": action_result.get("ui_payload") if action_result else None,
        "action_type": action_result.get("action_type") if action_result else None,
    }
    yield json.dumps(meta, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)

    t_tts_start = perf_counter()
    t_post_llm = t_tts_start - t_llm_end
    audio_urls: list[str] = []
    first_chunk_ts: float | None = None

    async for line in iter_tts_chunk_ndjson_lines(session_id, reply, client):
        if first_chunk_ts is None:
            first_chunk_ts = perf_counter() - t_tts_start
        yield line
        obj = json.loads(line.strip())
        if obj.get("type") == "chunk" and obj.get("url"):
            audio_urls.append(obj["url"])

    t_tts = perf_counter() - t_tts_start
    t_total = perf_counter() - infer_t0

    _print_infer_latency_breakdown(
        pre_asr=t_pre_asr,
        asr_lock=t_asr_lock,
        asr_transcribe=t_asr_transcribe,
        bridge=t_bridge,
        llm=t_llm_wall,
        post_llm=t_post_llm,
        tts=t_tts,
        total=t_total,
    )
    print(
        f"[LATENCY_DETAIL] process_user_input internal t_llm={t_llm_reported:.3f}s "
        f"(subset of LLM column when paths return partial timings)"
    )

    latency_payload = _infer_latency_json(
        pre_asr=t_pre_asr,
        asr_lock=t_asr_lock,
        asr_transcribe=t_asr_transcribe,
        bridge=t_bridge,
        llm=t_llm_wall,
        post_llm=t_post_llm,
        tts=t_tts,
        total=t_total,
        llm_internal_reported=t_llm_reported,
    )
    if first_chunk_ts is not None:
        latency_payload["tts_first_chunk_s"] = round(first_chunk_ts, 4)

    done = {
        "type": "done",
        "transcript": transcript,
        "reply": reply,
        "audio_url": audio_urls[0] if audio_urls else "",
        "audio_urls": audio_urls,
        "tts_segment_count": len(audio_urls),
        "latency": latency_payload,
    }
    yield json.dumps(done, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)


async def iter_text_tts_ndjson_stream(
    *,
    t_start: float,
    session_id: str,
    user_text: str,
    reply: str,
    client: str,
    action_result,
    t_llm_end: float,
    t_llm_wall: float,
) -> AsyncIterator[str]:
    """NDJSON: meta → chunk lines → done (text path latency)."""
    if not reply or not str(reply).strip():
        reply = EMPTY_REPLY_FALLBACK

    segs = _segments_for_tts(reply)
    meta = {
        "type": "meta",
        "user_text": user_text,
        "reply": reply,
        "session_id": session_id,
        "client": client,
        "tts_segment_count": len(segs),
        "action_payload": action_result.get("ui_payload") if action_result else None,
        "action_type": action_result.get("action_type") if action_result else None,
    }
    yield json.dumps(meta, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)

    t_tts_start = perf_counter()
    t_post_llm = t_tts_start - t_llm_end
    audio_urls: list[str] = []
    first_chunk_ts: float | None = None

    async for line in iter_tts_chunk_ndjson_lines(session_id, reply, client):
        if first_chunk_ts is None:
            first_chunk_ts = perf_counter() - t_tts_start
        yield line
        obj = json.loads(line.strip())
        if obj.get("type") == "chunk" and obj.get("url"):
            audio_urls.append(obj["url"])

    t_tts = perf_counter() - t_tts_start
    t_total = perf_counter() - t_start

    print(
        "[LATENCY][TEXT] "
        f"LLM={t_llm_wall:.3f}s TTS={t_tts:.3f}s TOTAL={t_total:.3f}s"
    )

    latency = {
        "total_s": round(t_total, 4),
        "llm_s": round(t_llm_wall, 4),
        "post_llm_s": round(t_post_llm, 4),
        "tts_s": round(t_tts, 4),
        "short_circuit": "text",
    }
    if first_chunk_ts is not None:
        latency["tts_first_chunk_s"] = round(first_chunk_ts, 4)

    done = {
        "type": "done",
        "reply": reply,
        "audio_url": audio_urls[0] if audio_urls else "",
        "audio_urls": audio_urls,
        "tts_segment_count": len(audio_urls),
        "latency": latency,
    }
    yield json.dumps(done, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)


async def _pump_llm_segments_to_queue(
    messages: list[dict],
    segment_queue: asyncio.Queue,
    out_state: dict,
) -> None:
    """
    Consume the LLM token stream and push complete sentence segments onto segment_queue.
    Ends with None sentinel. LLM keeps running while TTS works in parallel (do not await TTS here).

    out_state keys set: reply_accum (str), t_llm_first_token_ts (float | None), t_llm_end (float | None).
    """
    buffer = ""
    out_state["reply_accum"] = ""
    out_state["t_llm_first_token_ts"] = None
    out_state["t_llm_end"] = None
    try:
        async for delta in vera.async_generate_stream(messages):
            if out_state["t_llm_first_token_ts"] is None:
                out_state["t_llm_first_token_ts"] = perf_counter()
            out_state["reply_accum"] += delta
            buffer += delta
            while True:
                popped, buffer = pop_first_complete_segment(buffer)
                if not popped:
                    break
                await segment_queue.put(popped)
        out_state["t_llm_end"] = perf_counter()
        if buffer.strip():
            await segment_queue.put(buffer.strip())
    finally:
        await segment_queue.put(None)


async def iter_infer_tts_ndjson_stream_llm_stream(
    *,
    infer_t0: float,
    session_id: str,
    transcript: str,
    client: str,
    t_pre_asr: float,
    t_asr_lock: float,
    t_asr_transcribe: float,
    t_asr_lock_end: float,
    t_llm_start: float,
    t_bridge: float,
    history: list[dict],
    messages_override: list[dict] | None = None,
    meta_action_type: str | None = None,
    meta_action_payload: dict | None = None,
    finalize_action_result: Callable[[str], dict] | None = None,
) -> AsyncIterator[str]:
    """
    NDJSON: meta (reply empty until done) → TTS chunk lines as each sentence is ready
    while the LLM streams; then done. Pipelines first-sentence TTS with later LLM tokens.
    """
    if messages_override is not None:
        messages = messages_override
    else:
        messages = vera.build_messages(history, transcript)
        messages = inject_recent_action_context(messages, session_id, transcript)

    meta = {
        "type": "meta",
        "transcript": transcript,
        "reply": "",
        "session_id": session_id,
        "client": client,
        "tts_segment_count": 0,
        "action_payload": meta_action_payload,
        "action_type": meta_action_type,
        "llm_streaming": True,
    }
    yield json.dumps(meta, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)

    tts_dir = user_tts_dir(session_id)
    use_bmo_fish = (client or "vera").strip().lower() == "bmo" and bmo_fish_configured()
    date_str = today()
    audio_urls: list[str] = []
    chunk_index = 0
    reply_so_far_parts: list[str] = []
    t_tts_start: float | None = None
    first_chunk_ts: float | None = None
    t_first_chunk_emitted: float | None = None
    t_first_tts_segment_done: float | None = None

    # Producer keeps pulling LLM tokens while TTS runs — do not await TTS inside async_generate_stream.
    segment_queue: asyncio.Queue = asyncio.Queue()
    llm_stream_state: dict = {}
    prod_task = asyncio.create_task(_pump_llm_segments_to_queue(messages, segment_queue, llm_stream_state))

    while True:
        popped = await segment_queue.get()
        if popped is None:
            break
        if t_tts_start is None:
            t_tts_start = perf_counter()
        async with tts_lock:
            rel = await asyncio.to_thread(
                _sync_synthesize_segment,
                popped,
                session_id,
                date_str,
                tts_dir,
                use_bmo_fish,
                client,
            )
        if t_first_tts_segment_done is None:
            t_first_tts_segment_done = perf_counter()
        if first_chunk_ts is None and t_tts_start is not None:
            first_chunk_ts = perf_counter() - t_tts_start
        audio_urls.append(rel)
        reply_so_far_parts.append(popped)
        reply_so_far = _cumulative_reply_display(reply_so_far_parts)
        line = (
            json.dumps(
                {"type": "chunk", "index": chunk_index, "url": rel, "reply_so_far": reply_so_far},
                ensure_ascii=False,
            )
            + "\n"
        )
        chunk_index += 1
        if t_first_chunk_emitted is None:
            t_first_chunk_emitted = perf_counter()
        yield line
        await asyncio.sleep(0)

    await prod_task

    reply_accum = llm_stream_state.get("reply_accum", "")
    t_llm_first_token_ts = llm_stream_state.get("t_llm_first_token_ts")
    t_llm_end = llm_stream_state.get("t_llm_end") or perf_counter()
    t_llm_wall = t_llm_end - t_llm_start
    t_llm_reported = t_llm_wall

    full_reply = reply_accum.strip() or EMPTY_REPLY_FALLBACK
    if not audio_urls and full_reply:
        if t_tts_start is None:
            t_tts_start = perf_counter()
        async with tts_lock:
            rel = await asyncio.to_thread(
                _sync_synthesize_segment,
                full_reply,
                session_id,
                date_str,
                tts_dir,
                use_bmo_fish,
                client,
            )
        if t_first_tts_segment_done is None:
            t_first_tts_segment_done = perf_counter()
        if first_chunk_ts is None and t_tts_start is not None:
            first_chunk_ts = perf_counter() - t_tts_start
        audio_urls.append(rel)
        if t_first_chunk_emitted is None:
            t_first_chunk_emitted = perf_counter()
        yield (
            json.dumps(
                {"type": "chunk", "index": 0, "url": rel, "reply_so_far": full_reply},
                ensure_ascii=False,
            )
            + "\n"
        )
        await asyncio.sleep(0)

    t_tts_wall = t_tts_start if t_tts_start is not None else t_llm_end
    t_tts = perf_counter() - t_tts_wall
    t_post_llm = max(0.0, (t_tts_start or t_llm_end) - t_llm_end)
    t_total = perf_counter() - infer_t0

    llm_first_token_s = (
        (t_llm_first_token_ts - t_llm_start) if t_llm_first_token_ts is not None else None
    )
    llm_first_sentence_ready_s = (
        (t_first_chunk_emitted - t_llm_start) if t_first_chunk_emitted is not None else None
    )

    first_tts_audio_ready_total_s = None
    first_tts_audio_ready_after_pre_asr_s = None
    first_tts_audio_ready_after_asr_end_s = None
    if t_first_tts_segment_done is not None:
        first_tts_audio_ready_total_s = t_first_tts_segment_done - infer_t0
        first_tts_audio_ready_after_pre_asr_s = t_first_tts_segment_done - infer_t0 - t_pre_asr
        first_tts_audio_ready_after_asr_end_s = t_first_tts_segment_done - t_asr_lock_end

    if finalize_action_result is not None:
        finalize_action_result(full_reply)

    history.append({"role": "user", "content": transcript})
    history.append({"role": "assistant", "content": full_reply})
    if len(history) > MAX_TURNS * 2:
        history[:] = history[-MAX_TURNS * 2 :]

    _print_infer_latency_breakdown(
        pre_asr=t_pre_asr,
        asr_lock=t_asr_lock,
        asr_transcribe=t_asr_transcribe,
        bridge=t_bridge,
        llm=t_llm_wall,
        post_llm=t_post_llm,
        tts=t_tts,
        total=t_total,
    )
    print(
        f"[LATENCY_DETAIL] stream LLM + sentence TTS t_llm={t_llm_reported:.3f}s "
        f"tts_segments={len(audio_urls)}"
    )
    if llm_first_token_s is not None:
        print(
            f"[LATENCY_DETAIL] LLM first token (TTFT from LLM phase start)={llm_first_token_s:.3f}s | "
            f"first sentence TTS + NDJSON chunk ready={llm_first_sentence_ready_s:.3f}s"
            if llm_first_sentence_ready_s is not None
            else f"[LATENCY_DETAIL] LLM first token (TTFT)={llm_first_token_s:.3f}s"
        )
    if first_tts_audio_ready_total_s is not None:
        print(
            "[LATENCY_DETAIL] first TTS segment file ready (server): "
            f"infer_start→{first_tts_audio_ready_total_s:.3f}s | "
            f"after_PreASR→{first_tts_audio_ready_after_pre_asr_s:.3f}s | "
            f"after_ASR_end→{first_tts_audio_ready_after_asr_end_s:.3f}s"
        )

    latency_payload = _infer_latency_json(
        pre_asr=t_pre_asr,
        asr_lock=t_asr_lock,
        asr_transcribe=t_asr_transcribe,
        bridge=t_bridge,
        llm=t_llm_wall,
        post_llm=t_post_llm,
        tts=t_tts,
        total=t_total,
        llm_internal_reported=t_llm_reported,
        llm_first_token_s=llm_first_token_s,
        llm_first_sentence_ready_s=llm_first_sentence_ready_s,
        first_tts_audio_ready_total_s=first_tts_audio_ready_total_s,
        first_tts_audio_ready_after_pre_asr_s=first_tts_audio_ready_after_pre_asr_s,
        first_tts_audio_ready_after_asr_end_s=first_tts_audio_ready_after_asr_end_s,
    )
    if first_chunk_ts is not None:
        latency_payload["tts_first_chunk_s"] = round(first_chunk_ts, 4)

    done = {
        "type": "done",
        "transcript": transcript,
        "reply": full_reply,
        "audio_url": audio_urls[0] if audio_urls else "",
        "audio_urls": audio_urls,
        "tts_segment_count": len(audio_urls),
        "latency": latency_payload,
    }
    yield json.dumps(done, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)


async def iter_text_tts_ndjson_stream_llm_stream(
    *,
    t_start: float,
    t_llm_start: float,
    session_id: str,
    user_text: str,
    client: str,
    history: list[dict],
    messages_override: list[dict] | None = None,
    meta_action_type: str | None = None,
    meta_action_payload: dict | None = None,
    finalize_action_result: Callable[[str], dict] | None = None,
) -> AsyncIterator[str]:
    """Text path: stream LLM → sentence TTS chunks; meta has empty reply until done."""
    if messages_override is not None:
        messages = messages_override
    else:
        messages = vera.build_messages(history, user_text)
        messages = inject_recent_action_context(messages, session_id, user_text)

    meta = {
        "type": "meta",
        "user_text": user_text,
        "reply": "",
        "session_id": session_id,
        "client": client,
        "tts_segment_count": 0,
        "action_payload": meta_action_payload,
        "action_type": meta_action_type,
        "llm_streaming": True,
    }
    yield json.dumps(meta, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)

    tts_dir = user_tts_dir(session_id)
    use_bmo_fish = (client or "vera").strip().lower() == "bmo" and bmo_fish_configured()
    date_str = today()
    audio_urls: list[str] = []
    chunk_index = 0
    reply_so_far_parts: list[str] = []
    t_tts_start: float | None = None
    first_chunk_ts: float | None = None
    t_first_chunk_emitted: float | None = None
    t_first_tts_segment_done: float | None = None

    segment_queue: asyncio.Queue = asyncio.Queue()
    llm_stream_state: dict = {}
    prod_task = asyncio.create_task(_pump_llm_segments_to_queue(messages, segment_queue, llm_stream_state))

    while True:
        popped = await segment_queue.get()
        if popped is None:
            break
        if t_tts_start is None:
            t_tts_start = perf_counter()
        async with tts_lock:
            rel = await asyncio.to_thread(
                _sync_synthesize_segment,
                popped,
                session_id,
                date_str,
                tts_dir,
                use_bmo_fish,
                client,
            )
        if t_first_tts_segment_done is None:
            t_first_tts_segment_done = perf_counter()
        if first_chunk_ts is None and t_tts_start is not None:
            first_chunk_ts = perf_counter() - t_tts_start
        audio_urls.append(rel)
        reply_so_far_parts.append(popped)
        reply_so_far = _cumulative_reply_display(reply_so_far_parts)
        if t_first_chunk_emitted is None:
            t_first_chunk_emitted = perf_counter()
        yield (
            json.dumps(
                {"type": "chunk", "index": chunk_index, "url": rel, "reply_so_far": reply_so_far},
                ensure_ascii=False,
            )
            + "\n"
        )
        chunk_index += 1
        await asyncio.sleep(0)

    await prod_task

    reply_accum = llm_stream_state.get("reply_accum", "")
    t_llm_first_token_ts = llm_stream_state.get("t_llm_first_token_ts")
    t_llm_end = llm_stream_state.get("t_llm_end") or perf_counter()
    t_llm_wall = t_llm_end - t_llm_start

    full_reply = reply_accum.strip() or EMPTY_REPLY_FALLBACK
    if not audio_urls and full_reply:
        if t_tts_start is None:
            t_tts_start = perf_counter()
        async with tts_lock:
            rel = await asyncio.to_thread(
                _sync_synthesize_segment,
                full_reply,
                session_id,
                date_str,
                tts_dir,
                use_bmo_fish,
                client,
            )
        if t_first_tts_segment_done is None:
            t_first_tts_segment_done = perf_counter()
        if first_chunk_ts is None and t_tts_start is not None:
            first_chunk_ts = perf_counter() - t_tts_start
        audio_urls.append(rel)
        if t_first_chunk_emitted is None:
            t_first_chunk_emitted = perf_counter()
        yield (
            json.dumps(
                {"type": "chunk", "index": 0, "url": rel, "reply_so_far": full_reply},
                ensure_ascii=False,
            )
            + "\n"
        )
        await asyncio.sleep(0)

    t_tts_wall = t_tts_start if t_tts_start is not None else t_llm_end
    t_tts = perf_counter() - t_tts_wall
    t_post_llm = max(0.0, (t_tts_start or t_llm_end) - t_llm_end)
    t_total = perf_counter() - t_start

    llm_first_token_s = (
        (t_llm_first_token_ts - t_llm_start) if t_llm_first_token_ts is not None else None
    )
    llm_first_sentence_ready_s = (
        (t_first_chunk_emitted - t_llm_start) if t_first_chunk_emitted is not None else None
    )

    first_tts_audio_ready_total_s = None
    if t_first_tts_segment_done is not None:
        first_tts_audio_ready_total_s = t_first_tts_segment_done - t_start

    if finalize_action_result is not None:
        finalize_action_result(full_reply)

    history.append({"role": "user", "content": user_text})
    history.append({"role": "assistant", "content": full_reply})
    if len(history) > MAX_TURNS * 2:
        history[:] = history[-MAX_TURNS * 2 :]

    print(
        "[LATENCY][TEXT][stream_llm] "
        f"LLM={t_llm_wall:.3f}s TTS={t_tts:.3f}s TOTAL={t_total:.3f}s segments={len(audio_urls)}"
    )
    if llm_first_token_s is not None:
        if llm_first_sentence_ready_s is not None:
            print(
                f"[LATENCY_DETAIL][TEXT] LLM first token (TTFT)={llm_first_token_s:.3f}s | "
                f"first sentence TTS + NDJSON chunk ready={llm_first_sentence_ready_s:.3f}s"
            )
        else:
            print(f"[LATENCY_DETAIL][TEXT] LLM first token (TTFT)={llm_first_token_s:.3f}s")
    if first_tts_audio_ready_total_s is not None:
        print(
            "[LATENCY_DETAIL][TEXT] first TTS segment file ready (server): "
            f"text_start→{first_tts_audio_ready_total_s:.3f}s"
        )

    latency = {
        "total_s": round(t_total, 4),
        "llm_s": round(t_llm_wall, 4),
        "post_llm_s": round(t_post_llm, 4),
        "tts_s": round(t_tts, 4),
        "short_circuit": "text",
    }
    if first_chunk_ts is not None:
        latency["tts_first_chunk_s"] = round(first_chunk_ts, 4)
    if llm_first_token_s is not None:
        latency["llm_first_token_s"] = round(llm_first_token_s, 4)
    if llm_first_sentence_ready_s is not None:
        latency["llm_first_sentence_ready_s"] = round(llm_first_sentence_ready_s, 4)
    if first_tts_audio_ready_total_s is not None:
        latency["first_tts_audio_ready_total_s"] = round(first_tts_audio_ready_total_s, 4)

    done = {
        "type": "done",
        "reply": full_reply,
        "audio_url": audio_urls[0] if audio_urls else "",
        "audio_urls": audio_urls,
        "tts_segment_count": len(audio_urls),
        "latency": latency,
    }
    yield json.dumps(done, ensure_ascii=False) + "\n"
    await asyncio.sleep(0)


async def synthesize_reply_audio(session_id: str, reply: str, client: str = "vera") -> tuple[str, list[str]]:
    """
    Returns (reply_text, list of /audio/... paths). Multiple paths when sentence chunking is on.
    """
    tts_dir = user_tts_dir(session_id)
    use_bmo_fish = (client or "vera").strip().lower() == "bmo" and bmo_fish_configured()

    if not reply or not str(reply).strip():
        reply = EMPTY_REPLY_FALLBACK

    segments = _segments_for_tts(reply)
    urls: list[str] = []
    date_str = today()

    for seg in segments:
        async with tts_lock:
            rel = await asyncio.to_thread(
                _sync_synthesize_segment,
                seg,
                session_id,
                date_str,
                tts_dir,
                use_bmo_fish,
                client,
            )
        urls.append(rel)

    if tts_sentence_chunks_enabled():
        preview = (reply[:120] + "…") if len(reply) > 120 else reply
        print(f"[TTS] sentence chunking: segments={len(urls)} preview={preview!r}")
        if len(urls) == 1:
            print(
                "[TTS] hint: only 1 segment — very long single line with no .?! or blank lines; "
                "or chunking disabled (VERA_TTS_SENTENCE_CHUNKS=0)."
            )

    return reply, urls

# =========================
# INFERENCE
# =========================
@app.post("/command")
async def command(
    session_id: str = Form(...),
    action: str = Form(...)
):
    raise HTTPException(400, "Unknown command")

def _infer_latency_json(
    *,
    pre_asr: float,
    asr_lock: float,
    asr_transcribe: float,
    total: float,
    bridge: float | None = None,
    llm: float | None = None,
    post_llm: float | None = None,
    tts: float | None = None,
    llm_internal_reported: float | None = None,
    short_circuit: str | None = None,
    llm_first_token_s: float | None = None,
    llm_first_sentence_ready_s: float | None = None,
    first_tts_audio_ready_total_s: float | None = None,
    first_tts_audio_ready_after_pre_asr_s: float | None = None,
    first_tts_audio_ready_after_asr_end_s: float | None = None,
) -> dict:
    """Structured timings for `/infer` JSON + browser console (seconds)."""
    out: dict = {
        "pre_asr_s": round(pre_asr, 4),
        "asr_lock_s": round(asr_lock, 4),
        "asr_transcribe_s": round(asr_transcribe, 4),
        "total_s": round(total, 4),
    }
    if short_circuit:
        out["short_circuit"] = short_circuit
    if bridge is not None:
        out["bridge_s"] = round(bridge, 4)
    if llm is not None:
        out["llm_s"] = round(llm, 4)
    if post_llm is not None:
        out["post_llm_s"] = round(post_llm, 4)
    if tts is not None:
        out["tts_s"] = round(tts, 4)
    if llm_internal_reported is not None:
        out["llm_internal_reported_s"] = round(llm_internal_reported, 4)
    if llm_first_token_s is not None:
        out["llm_first_token_s"] = round(llm_first_token_s, 4)
    if llm_first_sentence_ready_s is not None:
        out["llm_first_sentence_ready_s"] = round(llm_first_sentence_ready_s, 4)
    if first_tts_audio_ready_total_s is not None:
        out["first_tts_audio_ready_total_s"] = round(first_tts_audio_ready_total_s, 4)
    if first_tts_audio_ready_after_pre_asr_s is not None:
        out["first_tts_audio_ready_after_pre_asr_s"] = round(
            first_tts_audio_ready_after_pre_asr_s, 4
        )
    if first_tts_audio_ready_after_asr_end_s is not None:
        out["first_tts_audio_ready_after_asr_end_s"] = round(
            first_tts_audio_ready_after_asr_end_s, 4
        )
    if (
        bridge is not None
        and llm is not None
        and post_llm is not None
        and tts is not None
    ):
        summed = pre_asr + asr_lock + bridge + llm + post_llm + tts
        out["sum_segments_s"] = round(summed, 4)
        out["drift_s"] = round(total - summed, 4)
    return out


def _infer_latency_early(infer_t0: float, reason: str) -> dict:
    """Before ASR or no ASR split (e.g. tiny audio, audio gate)."""
    return {
        "short_circuit": reason,
        "total_s": round(perf_counter() - infer_t0, 4),
    }


def _print_infer_latency_breakdown(
    *,
    pre_asr: float,
    asr_lock: float,
    asr_transcribe: float,
    bridge: float,
    llm: float,
    post_llm: float,
    tts: float,
    total: float,
) -> None:
    """Sequential phases should sum to ~TOTAL; drift is unaccounted overhead / timer granularity."""
    summed = pre_asr + asr_lock + bridge + llm + post_llm + tts
    drift = total - summed
    print(
        "[LATENCY] "
        f"PreASR={pre_asr:.3f}s | ASR={asr_lock:.3f}s | Bridge={bridge:.3f}s | "
        f"LLM={llm:.3f}s | PostLLM={post_llm:.3f}s | TTS={tts:.3f}s | "
        f"TOTAL={total:.3f}s | Σ={summed:.3f}s Δ={drift:+.4f}s"
    )
    print(
        f"[LATENCY_DETAIL] ASR transcribe_long only={asr_transcribe:.3f}s "
        f"(rest of ASR lock = gate/mute/prints inside lock)"
    )


@app.post("/infer")
async def infer(
    audio: Optional[UploadFile] = File(None),
    session_id: str = Form(...),
    mode: str = Form("continuous"),
    client: str = Form("vera"),
    interrupt_debug: Optional[str] = Form(None),
    stream_tts: str = Form("0"),
    transcript: Optional[str] = Form(None),
    use_browser_asr: str = Form("0"),
):
    infer_t0 = perf_counter()
    want_stream_tts = str(stream_tts or "").strip().lower() in ("1", "true", "yes", "on")

    is_interrupt = (mode or "").strip().lower() == "interrupt"
    infer_mode = (mode or "").strip().lower()

    session_id = safe_id(session_id)
    cleanup_sessions()

    if session_id not in user_last_seen and len(user_last_seen) >= MAX_ACTIVE_USERS:
        raise HTTPException(429, "Server at capacity")

    user_last_seen[session_id] = time()
    total_sessions_seen.add(session_id)

    audio_bytes = b""
    if audio is not None:
        audio_bytes = await audio.read()

    use_browser = str(use_browser_asr or "").strip().lower() in ("1", "true", "yes", "on")
    client_transcript = (transcript or "").strip() if transcript else ""
    browser_transcript = use_browser and bool(client_transcript)

    if browser_transcript:
        transcript = client_transcript
        t_pre_asr = perf_counter() - infer_t0
        t_asr_transcribe = 0.0
        t_asr_lock_start = infer_t0
        t_asr_lock = 0.0
        t_asr_lock_end = perf_counter()
        print(
            f"[ASR] browser_client mode={infer_mode} session={session_id} text=\"{transcript}\""
        )
        if is_interrupt and interrupt_debug:
            try:
                dbg = json.loads(interrupt_debug)
                print(f"[INTERRUPT][CLIENT] {json.dumps(dbg, ensure_ascii=False)}")
            except Exception:
                print(f"[INTERRUPT][CLIENT] invalid_json len={len(interrupt_debug)}")

        if (
            infer_mode in ("continuous", "interrupt")
            and transcript
            and is_mute_voice_command(transcript)
        ):
            print(
                f"[INTENT] mute_voice_command mode={infer_mode} session={session_id} "
                f"text={transcript!r} conf=n/a_browser"
            )
            t_short = perf_counter() - infer_t0
            return {
                "client_action": "mute_input",
                "transcript": transcript,
                "latency": _infer_latency_json(
                    pre_asr=t_pre_asr,
                    asr_lock=t_asr_lock,
                    asr_transcribe=t_asr_transcribe,
                    total=t_short,
                    short_circuit="mute",
                ),
            }

        if not transcript:
            if is_interrupt:
                print("[INTERRUPT] skip: empty transcript (browser)")
            return {
                "skip": True,
                "latency": _infer_latency_early(infer_t0, "empty_transcript"),
            }

    elif len(audio_bytes) < MIN_AUDIO_BYTES:
        if is_interrupt:
            print(
                f"[INTERRUPT] skip: bytes={len(audio_bytes)} "
                f"(<{MIN_AUDIO_BYTES}) session={session_id}"
            )
        return {"skip": True, "latency": _infer_latency_early(infer_t0, "bytes_too_small")}

    else:
        try:
            seg = AudioSegment.from_file(io.BytesIO(audio_bytes))
        except Exception:
            raise HTTPException(400, "Invalid audio format")

        seg = seg.set_channels(1).set_frame_rate(TARGET_SR)

        samples = np.array(seg.get_array_of_samples(), dtype=np.float32)
        if seg.sample_width == 2:          # int16
            samples /= 32768.0
        elif seg.sample_width == 4:        # int32
            samples /= 2147483648.0
        # robust normalization (always correct)
        raw = samples.copy()

        raw_rms = np.sqrt(np.mean(raw ** 2))
        zcr = zero_crossing_rate(raw)
        voiced_sec = voiced_duration(raw, TARGET_SR, thresh=0.02)
        spec_ratio = spectral_ratio(raw, TARGET_SR)
        peak_raw = float(np.max(np.abs(raw))) if len(raw) else 0.0
        crest = peak_raw / (raw_rms + 1e-8)
        dur_s = len(raw) / float(TARGET_SR)

        if is_interrupt:
            if interrupt_debug:
                try:
                    dbg = json.loads(interrupt_debug)
                    print(f"[INTERRUPT][CLIENT] {json.dumps(dbg, ensure_ascii=False)}")
                except Exception:
                    print(f"[INTERRUPT][CLIENT] invalid_json len={len(interrupt_debug)}")
            print(
                f"[INTERRUPT][AUDIO] session={session_id} bytes={len(audio_bytes)} "
                f"dur_s={dur_s:.3f} rms={raw_rms:.4f} zcr={zcr:.3f} "
                f"voiced={voiced_sec:.3f}s spec={spec_ratio:.2f} crest={crest:.1f} "
                f"gate: min_rms={MIN_AUDIO_RMS} zcr_range=[{ZCR_MIN},{ZCR_MAX}] "
                f"min_voiced={MIN_VOICED_SECONDS}s"
            )
        else:
            print(
                f"[AUDIO] rms={raw_rms:.4f} "
                f"zcr={zcr:.3f} "
                f"voiced={voiced_sec:.3f}s "
                f"spec={spec_ratio:.2f}"
            )

        if (
            raw_rms < MIN_AUDIO_RMS or
            voiced_sec < MIN_VOICED_SECONDS
        ):
            if is_interrupt:
                print(
                    "[INTERRUPT] dropped: audio_gate "
                    f"(rms_ok={raw_rms >= MIN_AUDIO_RMS} "
                    f"zcr_in_band={ZCR_MIN <= zcr <= ZCR_MAX} (not gated) "
                    f"voiced_ok={voiced_sec >= MIN_VOICED_SECONDS})"
                )
            else:
                print("[AUDIO] Dropped non-headset / noise")
            return {"skip": True, "latency": _infer_latency_early(infer_t0, "audio_gate")}

        # remove DC offset
        samples -= np.mean(samples)

        # normalize AFTER gating
        peak = np.max(np.abs(samples))
        if peak > 0:
            samples /= peak

        # =========================
        # ASR
        # =========================

        t_asr_lock_start = perf_counter()
        t_pre_asr = t_asr_lock_start - infer_t0

        async with asr_lock:
            t_tr0 = perf_counter()
            transcript, confidence = transcribe_long(samples)
            t_asr_transcribe = perf_counter() - t_tr0

            # Mute intent first: bypass ASR confidence gate and all downstream "thinking".
            if (
                infer_mode in ("continuous", "interrupt")
                and transcript
                and is_mute_voice_command(transcript)
            ):
                print(
                    f"[INTENT] mute_voice_command mode={infer_mode} session={session_id} "
                    f"text={transcript!r} conf={confidence:.3f}"
                )
                t_asr_lock_end = perf_counter()
                t_asr_lock = t_asr_lock_end - t_asr_lock_start
                print(
                    "[LATENCY] short_circuit=mute "
                    f"PreASR={t_pre_asr:.3f}s | ASR={t_asr_lock:.3f}s "
                    f"(transcribe={t_asr_transcribe:.3f}s) | "
                    f"TOTAL={perf_counter() - infer_t0:.3f}s"
                )
                t_short = perf_counter() - infer_t0
                return {
                    "client_action": "mute_input",
                    "transcript": transcript,
                    "latency": _infer_latency_json(
                        pre_asr=t_pre_asr,
                        asr_lock=t_asr_lock,
                        asr_transcribe=t_asr_transcribe,
                        total=t_short,
                        short_circuit="mute",
                    ),
                }

            print(f"[ASR] conf={confidence:.3f} text=\"{transcript}\"")
            if is_interrupt:
                print(
                    f"[INTERRUPT][ASR] session={session_id} conf={confidence:.3f} "
                    f"text={transcript!r}"
                )

            if confidence < -0.5: #(TUNER)
                if is_interrupt:
                    print("[INTERRUPT] skip: low ASR confidence")
                else:
                    print("[ASR] Dropped low-confidence transcription")
                t_asr_lock_end = perf_counter()
                t_asr_lock = t_asr_lock_end - t_asr_lock_start
                print(
                    "[LATENCY] short_circuit=asr_confidence "
                    f"PreASR={t_pre_asr:.3f}s | ASR={t_asr_lock:.3f}s "
                    f"(transcribe={t_asr_transcribe:.3f}s) | "
                    f"TOTAL={perf_counter() - infer_t0:.3f}s"
                )
                t_short = perf_counter() - infer_t0
                return {
                    "skip": True,
                    "latency": _infer_latency_json(
                        pre_asr=t_pre_asr,
                        asr_lock=t_asr_lock,
                        asr_transcribe=t_asr_transcribe,
                        total=t_short,
                        short_circuit="asr_confidence",
                    ),
                }

        t_asr_lock_end = perf_counter()
        t_asr_lock = t_asr_lock_end - t_asr_lock_start

        if not transcript:
            if is_interrupt:
                print("[INTERRUPT] skip: empty transcript")
            print(
                "[LATENCY] short_circuit=empty_transcript "
                f"PreASR={t_pre_asr:.3f}s | ASR={t_asr_lock:.3f}s "
                f"(transcribe={t_asr_transcribe:.3f}s) | "
                f"TOTAL={perf_counter() - infer_t0:.3f}s"
            )
            t_short = perf_counter() - infer_t0
            return {
                "skip": True,
                "latency": _infer_latency_json(
                    pre_asr=t_pre_asr,
                    asr_lock=t_asr_lock,
                    asr_transcribe=t_asr_transcribe,
                    total=t_short,
                    short_circuit="empty_transcript",
                ),
            }

        print(f"[ASR] \"{transcript}\"")

    # =========================
    # COMMAND HANDLING
    # =========================

    history = user_histories[session_id]
    t_llm_start = perf_counter()
    t_bridge = t_llm_start - t_asr_lock_end

    if want_stream_tts:
        async def ndjson_infer():
            # First bytes to the client: ASR only — no routing / LLM / TTS yet.
            yield (
                json.dumps({"type": "asr", "transcript": transcript}, ensure_ascii=False) + "\n"
            ).encode("utf-8")

            prepared_stream = try_prepare_streaming_action_messages(session_id, transcript, history)

            if prepared_stream is not None:
                ps = prepared_stream
                async for line in iter_infer_tts_ndjson_stream_llm_stream(
                    infer_t0=infer_t0,
                    session_id=session_id,
                    transcript=transcript,
                    client=client,
                    t_pre_asr=t_pre_asr,
                    t_asr_lock=t_asr_lock,
                    t_asr_transcribe=t_asr_transcribe,
                    t_asr_lock_end=t_asr_lock_end,
                    t_llm_start=t_llm_start,
                    t_bridge=t_bridge,
                    history=history,
                    messages_override=ps.messages,
                    meta_action_type=ps.meta_action_type,
                    meta_action_payload=ps.meta_action_payload,
                    finalize_action_result=ps.finalize,
                ):
                    yield line.encode("utf-8")
                return

            resolved = resolve_reply_if_not_general_llm(session_id, transcript, history)

            if resolved is None:
                async for line in iter_infer_tts_ndjson_stream_llm_stream(
                    infer_t0=infer_t0,
                    session_id=session_id,
                    transcript=transcript,
                    client=client,
                    t_pre_asr=t_pre_asr,
                    t_asr_lock=t_asr_lock,
                    t_asr_transcribe=t_asr_transcribe,
                    t_asr_lock_end=t_asr_lock_end,
                    t_llm_start=t_llm_start,
                    t_bridge=t_bridge,
                    history=history,
                ):
                    yield line.encode("utf-8")
                return

            reply, t_llm_reported, action_result = resolved
            t_llm_end = perf_counter()

            history.append({"role": "user", "content": transcript})
            history.append({"role": "assistant", "content": reply})

            if len(history) > MAX_TURNS * 2:
                history[:] = history[-MAX_TURNS * 2 :]

            async for line in iter_infer_tts_ndjson_stream(
                infer_t0=infer_t0,
                session_id=session_id,
                transcript=transcript,
                reply=reply,
                client=client,
                action_result=action_result,
                t_pre_asr=t_pre_asr,
                t_asr_lock=t_asr_lock,
                t_asr_transcribe=t_asr_transcribe,
                t_asr_lock_end=t_asr_lock_end,
                t_llm_start=t_llm_start,
                t_llm_end=t_llm_end,
                t_llm_reported=t_llm_reported,
            ):
                yield line.encode("utf-8")

        return StreamingResponse(
            ndjson_infer(),
            media_type="application/x-ndjson",
            headers=_ndjson_stream_headers(),
        )

    resolved = resolve_reply_if_not_general_llm(session_id, transcript, history)

    if resolved is not None:
        reply, t_llm_reported, action_result = resolved
    else:
        reply, t_llm_reported, action_result = process_user_input(session_id, transcript, history)
    t_llm_end = perf_counter()
    t_llm_wall = t_llm_end - t_llm_start

    history.append({"role": "user", "content": transcript})
    history.append({"role": "assistant", "content": reply})

    if len(history) > MAX_TURNS * 2:
        history[:] = history[-MAX_TURNS * 2:]

    t_tts_start = perf_counter()
    t_post_llm = t_tts_start - t_llm_end
    reply, audio_urls = await synthesize_reply_audio(session_id, reply, client=client)
    audio_url = audio_urls[0] if audio_urls else ""
    t_tts = perf_counter() - t_tts_start
    t_total = perf_counter() - infer_t0

    _print_infer_latency_breakdown(
        pre_asr=t_pre_asr,
        asr_lock=t_asr_lock,
        asr_transcribe=t_asr_transcribe,
        bridge=t_bridge,
        llm=t_llm_wall,
        post_llm=t_post_llm,
        tts=t_tts,
        total=t_total,
    )
    print(
        f"[LATENCY_DETAIL] process_user_input internal t_llm={t_llm_reported:.3f}s "
        f"(subset of LLM column when paths return partial timings)"
    )

    latency_payload = _infer_latency_json(
        pre_asr=t_pre_asr,
        asr_lock=t_asr_lock,
        asr_transcribe=t_asr_transcribe,
        bridge=t_bridge,
        llm=t_llm_wall,
        post_llm=t_post_llm,
        tts=t_tts,
        total=t_total,
        llm_internal_reported=t_llm_reported,
    )

    return {
        "transcript": transcript,
        "reply": reply,
        "audio_url": audio_url,
        "audio_urls": audio_urls,
        "tts_segment_count": len(audio_urls),
        "action_payload": action_result.get("ui_payload") if action_result else None,
        "action_type": action_result.get("action_type") if action_result else None,
        "latency": latency_payload,
    }

# =========================
# AUDIO SERVING
# =========================

@app.get("/audio/{session_id}/{date}/{filename}")
def get_audio(session_id: str, date: str, filename: str):
    path = Path("tts_outputs") / safe_id(session_id) / date / filename
    if not path.exists():
        raise HTTPException(404)
    suffix = path.suffix.lower()
    media_type = "audio/mpeg" if suffix == ".mp3" else "audio/wav"
    return FileResponse(path, media_type=media_type)

# =========================
# HEALTH & METRICS
# =========================


class _QuietPollAccessLogFilter(logging.Filter):
    """Hide high-frequency client poll lines from uvicorn access logs."""

    _SUBSTR = ("GET /status ",)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        return not any(s in msg for s in self._SUBSTR)


async def load_model():
    global vera, SERVER_STATE
    # await asyncio.sleep(3)
    try:
        print("Loading model...")
        vera = VeraAI(MODEL_PATH)
        SERVER_STATE = "ready"
        print("Model ready.")

    except Exception as e:
        SERVER_STATE = "offline"
        print("Model failed:", e)

@app.on_event("startup")
async def startup():
    global SERVER_STATE

    logging.getLogger("uvicorn.access").addFilter(_QuietPollAccessLogFilter())

    SERVER_STATE = "starting"
    try:
        from bmo_tts import bmo_fish_configured

        if bmo_fish_configured():
            print("[BMO Fish] Credentials loaded — BMO page will use Fish TTS.")
        else:
            print(
                "[BMO Fish] Not configured in this process — check `.env` next to app.py "
                "or visit GET /health/bmo-tts"
            )
    except Exception as e:
        print("[BMO Fish] Startup check error:", e)

    asyncio.create_task(load_model())

@app.get("/status")
def status():
    return {"state": SERVER_STATE}

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/health/tts-settings")
def health_tts_settings():
    """Confirm whether sentence-level TTS chunking is active (default on unless VERA_TTS_SENTENCE_CHUNKS=0)."""
    return {
        "tts_sentence_chunks": tts_sentence_chunks_enabled(),
        "vera_tts_sentence_chunks_env": os.environ.get("VERA_TTS_SENTENCE_CHUNKS", "<unset, default on>"),
    }


@app.get("/health/bmo-tts")
def health_bmo_tts():
    """Debug: shows whether Fish env vars are visible to this server (no secrets returned)."""
    from bmo_tts import bmo_fish_configured, reference_id_source, api_key_source

    key_set = bool(api_key_source())
    ref_set = bool(reference_id_source())
    return {
        "env_file_path": str(_ENV_FILE),
        "env_file_exists": _ENV_FILE.is_file(),
        "fish_api_key_set": key_set,
        "reference_id_set": ref_set,
        "bmo_fish_ready": bmo_fish_configured(),
        "hint": "Open BMO page so requests send client=bmo. Names: FISH_API_KEY or FISH_AUDIO_API_KEY; REFERENCE_ID (or FISH_REFERENCE_ID / BMO_REFERENCE_ID).",
    }

@app.get("/metrics")
def metrics():
    cleanup_sessions()
    return {
        "active_users": len(user_last_seen),
        "total_sessions_seen": len(total_sessions_seen),
    }


_USER_FILE_NAME_RE = re.compile(r"^[a-zA-Z0-9._-]{1,80}$")


def _safe_user_json_stem(username: str) -> str:
    name = (username or "").strip()
    if not _USER_FILE_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="Invalid username.")
    return name


class UserSignInBody(BaseModel):
    username: str
    password: str


@app.get("/api/user/active")
def api_user_active():
    """Current active user profile path (None = default / admin-as-current)."""
    if vera is None:
        return {
            "active_user_info_path": None,
            "server_ready": False,
            "username": None,
        }
    p = vera.active_user_info_path
    username = None
    if p:
        try:
            username = Path(p).stem
        except Exception:
            username = None
    return {
        "active_user_info_path": p,
        "server_ready": SERVER_STATE == "ready",
        "username": username,
    }


def _resolve_user_profile_path(stem: str) -> Path | None:
    """Return users_files/<stem>.json if present; else case-insensitive *.json match (Windows-friendly)."""
    base = USERS_FILES_DIR.resolve()
    if not base.is_dir():
        return None
    exact = (base / f"{stem}.json").resolve()
    try:
        exact.relative_to(base)
    except ValueError:
        return None
    if exact.is_file():
        return exact
    stem_lower = stem.lower()
    for p in base.glob("*.json"):
        if p.stem.lower() == stem_lower:
            return p.resolve()
    return None


def _password_matches(expected, submitted: str) -> bool:
    if expected is None:
        return False
    a = str(expected).strip()
    b = (submitted or "").strip()
    return a == b


@app.post("/api/user/sign-in")
def api_user_sign_in(body: UserSignInBody):
    """Authenticate against users_files/<username>.json field \"password\"; set active user profile."""
    global vera
    if vera is None or SERVER_STATE != "ready":
        raise HTTPException(status_code=503, detail="Server not ready.")
    stem = _safe_user_json_stem(body.username)
    path = _resolve_user_profile_path(stem)
    if path is None or not path.is_file():
        raise HTTPException(status_code=401, detail="Wrong password or username.")
    try:
        # utf-8-sig: BOM from some editors must not break the first JSON key
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception:
        raise HTTPException(status_code=401, detail="Wrong password or username.")
    expected = data.get("password")
    if not _password_matches(expected, body.password):
        raise HTTPException(status_code=401, detail="Wrong password or username.")
    path_str = str(path)
    vera.set_active_user_info_path(path_str)
    return {"ok": True, "active_user_info_path": path_str, "username": stem}


@app.post("/api/user/sign-out")
def api_user_sign_out():
    """Reset to default (active_user_info_path None — same as Nam.json admin-as-current behavior)."""
    global vera
    if vera is None:
        raise HTTPException(status_code=503, detail="Server not ready.")
    vera.set_active_user_info_path(None)
    return {"ok": True, "active_user_info_path": None, "username": None}


# =========================
# FEEDBACK
# =========================

class Feedback(BaseModel):
    session_id: str
    feedback: str
    userAgent: str | None = None
    timestamp: str | None = None

@app.post("/feedback")
async def receive_feedback(data: Feedback):
    size = len(data.feedback.encode("utf-8"))
    if size > MAX_FEEDBACK_BYTES:
        raise HTTPException(413, "Feedback exceeds 1MB limit")

    path = user_feedback_dir(safe_id(data.session_id)) / "feedback.jsonl"

    entry = data.dict()
    entry["timestamp"] = entry.get("timestamp") or datetime.utcnow().isoformat()

    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    return {"status": "ok"}

class TextInput(BaseModel):
    session_id: str
    text: str
    client: str = "vera"
    stream_tts: bool = False

@app.post("/text")
async def text_input(data: TextInput):
    t_start = perf_counter()

    session_id = safe_id(data.session_id)
    text = data.text.strip()

    if not text:
        raise HTTPException(400, "Empty text")
    
    print(f"[TEXT] \"{text}\"")
    
    cleanup_sessions()

    if session_id not in user_last_seen and len(user_last_seen) >= MAX_ACTIVE_USERS:
        raise HTTPException(429, "Server at capacity")

    user_last_seen[session_id] = time()
    total_sessions_seen.add(session_id)

    # =========================
    # COMMAND HANDLING
    # =========================

    history = user_histories[session_id]
    t_llm_start = perf_counter()

    prepared_stream: PreparedStreamingAction | None = None
    if data.stream_tts:
        prepared_stream = try_prepare_streaming_action_messages(session_id, text, history)

    if data.stream_tts and prepared_stream is not None:
        ps = prepared_stream

        async def ndjson_text():
            async for line in iter_text_tts_ndjson_stream_llm_stream(
                t_start=t_start,
                t_llm_start=t_llm_start,
                session_id=session_id,
                user_text=text,
                client=data.client,
                history=history,
                messages_override=ps.messages,
                meta_action_type=ps.meta_action_type,
                meta_action_payload=ps.meta_action_payload,
                finalize_action_result=ps.finalize,
            ):
                yield line.encode("utf-8")

        return StreamingResponse(
            ndjson_text(),
            media_type="application/x-ndjson",
            headers=_ndjson_stream_headers(),
        )

    resolved = resolve_reply_if_not_general_llm(session_id, text, history)

    if data.stream_tts and resolved is None:
        async def ndjson_text():
            async for line in iter_text_tts_ndjson_stream_llm_stream(
                t_start=t_start,
                t_llm_start=t_llm_start,
                session_id=session_id,
                user_text=text,
                client=data.client,
                history=history,
            ):
                yield line.encode("utf-8")

        return StreamingResponse(
            ndjson_text(),
            media_type="application/x-ndjson",
            headers=_ndjson_stream_headers(),
        )

    if resolved is not None:
        reply, _, action_result = resolved
    else:
        reply, _, action_result = process_user_input(session_id, text, history)
    t_llm_end = perf_counter()
    t_llm_wall = t_llm_end - t_llm_start

    history.append({"role": "user", "content": text})
    history.append({"role": "assistant", "content": reply})

    if len(history) > MAX_TURNS * 2:
        history[:] = history[-MAX_TURNS * 2:]

    # =========================
    # TTS
    # =========================

    if data.stream_tts:

        async def ndjson_text():
            async for line in iter_text_tts_ndjson_stream(
                t_start=t_start,
                session_id=session_id,
                user_text=text,
                reply=reply,
                client=data.client,
                action_result=action_result,
                t_llm_end=t_llm_end,
                t_llm_wall=t_llm_wall,
            ):
                yield line.encode("utf-8")

        return StreamingResponse(
            ndjson_text(),
            media_type="application/x-ndjson",
            headers=_ndjson_stream_headers(),
        )

    reply, audio_urls = await synthesize_reply_audio(session_id, reply, client=data.client)
    audio_url = audio_urls[0] if audio_urls else ""

    t_total = perf_counter() - t_start

    print(
        "[LATENCY][TEXT] "
        f"LLM={t_llm_wall:.3f}s TOTAL={t_total:.3f}s"
    )

    return {
        "reply": reply,
        "audio_url": audio_url,
        "audio_urls": audio_urls,
        "tts_segment_count": len(audio_urls),
        "action_payload": action_result.get("ui_payload") if action_result else None,
        "action_type": action_result.get("action_type") if action_result else None,
        "latency": {
            "total_s": round(t_total, 4),
            "llm_s": round(t_llm_wall, 4),
            "short_circuit": "text",
        },
    }


# Serve index.html, styles.css, and other repo-root assets from the same origin as the API
# so sign-in and other POST /api/* calls hit this FastAPI process (not file:// or another port).
_REPO_SITE_ROOT = Path(__file__).resolve().parent
app.mount("/", StaticFiles(directory=str(_REPO_SITE_ROOT), html=True), name="vera_site")