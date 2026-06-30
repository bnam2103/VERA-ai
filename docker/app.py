# app.py
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from time import time, perf_counter
import asyncio
import numpy as np
import io
import json
import string
from pydub.playback import play
from actions.check_time import handle_time_request 
from actions.check_time import handle_date_request
from actions.weather import handle_weather_request
from intent import is_command
from ASR import transcribe_long
# from LLM import VeraAI
from TTS import speak_to_file
from pydub import AudioSegment
import random
from fastapi.staticfiles import StaticFiles
from actions.news import handle_news_request
# from QWEN import VeraAI
from CHAT import VeraAI
# =========================
# CONFIG
# =========================

MODEL_PATH = None
# MODEL_PATH = r"C:\Users\User\Documents\Fine_Tuning_Projects\LLAMA_LLM_3B_instruct"
SERVER_STATE = "starting"
vera = None
MAX_ACTIVE_USERS = 10
SESSION_TTL = 30 * 60
MAX_TURNS = 20
thinking_allowed = {}
thinking_generation = defaultdict(int)

TARGET_SR = 16000
MIN_AUDIO_BYTES = 1500
MIN_AUDIO_RMS = 0.0030 # 🔑 ENERGY GATE for quiet/short speech
MIN_VOICED_SECONDS = 0.05   # 🔑 NEW
ZCR_MIN = 0.01
ZCR_MAX = 0.40            # 🔑 NEW (TUNER; fast speech fails with lower number)

MAX_FEEDBACK_BYTES = 1 * 1024 * 1024  # 1 MB
MAX_REGEN_ATTEMPTS = 2
CONFIDENCE_THRESHOLD = -0.6

UNCERTAINTY_SYSTEM_TURN = (
    "For this response only:\n"
    "If the question could refer to multiple meanings, cultural references, "
    "or interpretations, do not guess.\n"
    "If you are not confident, explicitly say you are unsure.\n"
    "Prefer the most widely known interpretation, or say you do not know."
)

GRACEFUL_EXIT_REPLY = (
    "I’m sorry, I don’t think I’m understanding this clearly."
)
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


def needs_uncertainty_regen(text: str, confidence: float) -> bool:
    reference_like = "reference" in text.lower()
    return reference_like and confidence < CONFIDENCE_THRESHOLD
# =========================
# SIMPLE INTENTS
# =========================
def enter_thinking():
    return {"status": "thinking"}

def detect_intent(text: str, history):
    if is_command(text):
        if any(k in text.lower() for k in ["what time is it", "current time", "the time", "what time it is"]):
            t0 = perf_counter()
            reply = handle_time_request(vera)
            t_llm = perf_counter() - t0
            return reply, t_llm
        elif any(k in text.lower() for k in ["what date is it", "current date", "the date", "today's date", "what date is today", "what date it is", "what day is today", "what day it is"]):
            t0 = perf_counter()
            reply = handle_date_request(vera)
            t_llm = perf_counter() - t0
            return reply, t_llm
        elif any(k in text.lower() for k in [
            "the news",
            "the current news",
            "the latest news",
            "the news headlines",
            "the news updates",
            "today's headlines"
            ]):
            print("Handling news request...")
            t0 = perf_counter()
            reply = handle_news_request(vera)
            t_llm = perf_counter() - t0
            return reply, t_llm
        elif any(k in text.lower() for k in ["current weather", "the weather", "what's the weather", "what is the weather"]):
            print("Handling weather request...")
            t0 = perf_counter()
            reply = handle_weather_request(vera)
            t_llm = perf_counter() - t0
            return reply, t_llm
    return None, 0.0
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


async def allow_filler_after_delay(
    session_id: str,
    generation: int,
    delay: float
):
    await asyncio.sleep(delay)

    # Only allow filler if no reset happened since this timer started
    if thinking_generation.get(session_id) == generation:
        thinking_allowed[session_id] = True

# =========================
# INFERENCE
# =========================
@app.post("/command")
async def command(
    session_id: str = Form(...),
    action: str = Form(...)
):
    raise HTTPException(400, "Unknown command")

@app.get("/thinking_allowed")
async def thinking_allowed_endpoint(session_id: str):
    return {
        "allow_filler": thinking_allowed.get(session_id, False)
    }

@app.post("/infer")
async def infer(
    audio: UploadFile = File(...),
    session_id: str = Form(...),
    mode: str = Form("continuous"),  
):
    speech_end_ts = perf_counter()
    t_start = speech_end_ts
    t_asr = 0.0
    t_llm = 0.0
    t_tts = 0.0

    session_id = safe_id(session_id)
    cleanup_sessions()

    if session_id not in user_last_seen and len(user_last_seen) >= MAX_ACTIVE_USERS:
        raise HTTPException(429, "Server at capacity")

    user_last_seen[session_id] = time()
    total_sessions_seen.add(session_id)

    audio_bytes = await audio.read()
    if len(audio_bytes) < MIN_AUDIO_BYTES:
        return {"skip": True}

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

    print(
        f"[AUDIO] rms={raw_rms:.4f} "
        f"zcr={zcr:.3f} "
        f"voiced={voiced_sec:.3f}s "
        f"spec={spec_ratio:.2f}"
    )

    if (
        raw_rms < MIN_AUDIO_RMS or
        zcr < ZCR_MIN or zcr > ZCR_MAX or
        voiced_sec < MIN_VOICED_SECONDS
        # spec_ratio > 0.3          # 🔑 headset discriminator
    ):
        print("[AUDIO] Dropped non-headset / noise")
        return {"skip": True}

    # remove DC offset
    samples -= np.mean(samples)

    # normalize AFTER gating
    peak = np.max(np.abs(samples))
    if peak > 0:
        samples /= peak

    # =========================
    # ASR
    # =========================

    async with asr_lock:
        t0 = perf_counter()
        transcript, confidence = transcribe_long(samples)
        print(f"[ASR] conf={confidence:.3f} text=\"{transcript}\"")
        t_asr = perf_counter() - t0

        if confidence < -0.5: #(TUNER)
            print("[ASR] Dropped low-confidence transcription")
            return {"skip": True}

    if not transcript:
        return {"skip": True}

    thinking_generation[session_id] += 1
    gen = thinking_generation[session_id]

    thinking_allowed[session_id] = False
    asyncio.create_task(
        allow_filler_after_delay(session_id, gen, 0.1)
    )
    print(f"[ASR] \"{transcript}\"")

    # =========================
    # COMMAND HANDLING
    # =========================

    history = user_histories[session_id]

    # =========================
    # LLM
    # =========================

    intent_result = detect_intent(transcript, history)

    # detect_intent returns (reply, t_llm) for non-LLM paths
    # We only bypass if it was NOT a pure LLM call
    if is_command(transcript):
        reply, t_llm = intent_result

    else:
        # --- POLICY-AWARE GENERATION ---
        messages = vera.build_messages(history, transcript)
        base_messages = messages

        regen_attempts = 0
        used_uncertainty_prompt = False

        reply, confidence = vera.generate(messages)

        while (
            needs_uncertainty_regen(transcript, confidence)
            and regen_attempts < MAX_REGEN_ATTEMPTS
        ):
            regen_attempts += 1

            if not used_uncertainty_prompt:
                messages = base_messages + [{
                    "role": "system",
                    "content": UNCERTAINTY_SYSTEM_TURN
                }]
                used_uncertainty_prompt = True
            else:
                messages = base_messages + [
                    {
                        "role": "system",
                        "content": UNCERTAINTY_SYSTEM_TURN
                    },
                    {
                        "role": "system",
                        "content": (
                            "For this response only:\n"
                            "Provide the most widely known interpretation.\n"
                            "Do not hedge or explain uncertainty."
                        )
                    }
                ]

            reply, confidence = vera.generate(messages)
        print(f"[LLM] conf={confidence:.3f}")    
        # 🚨 FINAL SAFETY VALVE (confidence-only)
        if confidence < CONFIDENCE_THRESHOLD:
            reply = GRACEFUL_EXIT_REPLY

        t_llm = 0.0  

    history.append({"role": "user", "content": transcript})
    history.append({"role": "assistant", "content": reply})

    if len(history) > MAX_TURNS * 2:
        history[:] = history[-MAX_TURNS * 2:]

    # =========================
    # TTS
    # =========================

    tts_dir = user_tts_dir(session_id)
    fname = f"{timestamp()}.wav"
    path = tts_dir / fname
    if isinstance(reply, tuple):
        reply = reply[0]
    async with tts_lock:
        tts_start_ts = perf_counter()   
        speak_to_file(reply, path)
        t_tts = perf_counter() - tts_start_ts
    speech_to_tts_latency = tts_start_ts - speech_end_ts

    t_total = perf_counter() - t_start

    print(
    "[LATENCY] "
        f"Speech→TTS={speech_to_tts_latency:.3f}s | "
        f"ASR={t_asr:.3f}s | "
        f"LLM={t_llm:.3f}s | "
        f"TTS={t_tts:.3f}s | "
        f"TOTAL={t_total:.3f}s"
    )

    return {
        "transcript": transcript,
        "reply": reply,
        "audio_url": f"/audio/{session_id}/{today()}/{fname}",
    }

# =========================
# AUDIO SERVING
# =========================

@app.get("/audio/{session_id}/{date}/{filename}")
def get_audio(session_id: str, date: str, filename: str):
    path = Path("tts_outputs") / safe_id(session_id) / date / filename
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/wav")

# =========================
# HEALTH & METRICS
# =========================
async def load_model():
    global vera, SERVER_STATE
    # await asyncio.sleep(3)
    try:
        print("Loading model...")
        vera = VeraAI()
        SERVER_STATE = "ready"
        print("Model ready.")

    except Exception as e:
        SERVER_STATE = "offline"
        print("Model failed:", e)

@app.on_event("startup")
async def startup():
    global SERVER_STATE

    SERVER_STATE = "starting"
    asyncio.create_task(load_model())

@app.get("/status")
def status():
    return {"state": SERVER_STATE}

@app.get("/ping")
def ping():
    return {"status": "ok"}

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/metrics")
def metrics():
    cleanup_sessions()
    return {
        "active_users": len(user_last_seen),
        "total_sessions_seen": len(total_sessions_seen),
    }

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

    # =========================
    # LLM
    # =========================

    intent_result = detect_intent(text, history)

    if is_command(text):
        reply, _ = intent_result

    else:
        messages = vera.build_messages(history, text)
        base_messages = messages

        regen_attempts = 0
        used_uncertainty_prompt = False

        reply, confidence = vera.generate(messages)

        while (
            needs_uncertainty_regen(text, confidence)
            and regen_attempts < MAX_REGEN_ATTEMPTS
        ):
            regen_attempts += 1

            if not used_uncertainty_prompt:
                messages = base_messages + [{
                    "role": "system",
                    "content": UNCERTAINTY_SYSTEM_TURN
                }]
                used_uncertainty_prompt = True
            else:
                messages = base_messages + [
                    {
                        "role": "system",
                        "content": UNCERTAINTY_SYSTEM_TURN
                    },
                    {
                        "role": "system",
                        "content": (
                            "For this response only:\n"
                            "Provide the most widely known interpretation.\n"
                            "Do not hedge or explain uncertainty."
                        )
                    }
                ]

            reply, confidence = vera.generate(messages)
        print(f"[LLM] conf={confidence:.3f}")
        if confidence < CONFIDENCE_THRESHOLD:
            reply = GRACEFUL_EXIT_REPLY

    history.append({"role": "user", "content": text})
    history.append({"role": "assistant", "content": reply})

    if len(history) > MAX_TURNS * 2:
        history[:] = history[-MAX_TURNS * 2:]

    # =========================
    # TTS
    # =========================

    tts_dir = user_tts_dir(session_id)
    fname = f"{timestamp()}.wav"
    path = tts_dir / fname
    if isinstance(reply, tuple):
        reply = reply[0]
    async with tts_lock:
        speak_to_file(reply, path)

    t_total = perf_counter() - t_start

    print(
        "[LATENCY][TEXT] "
        f"LLM={t_total:.3f}s"
    )

    return {
        "reply": reply,
        "audio_url": f"/audio/{session_id}/{today()}/{fname}",
    }