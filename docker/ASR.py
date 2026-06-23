import os
import numpy as np
import torch
from transformers import WhisperProcessor, WhisperForConditionalGeneration

# =========================
# CONFIG
# =========================

MODEL_PATH = os.getenv("ASR_MODEL_PATH", "nambn0321/vera_asr")
SAMPLE_RATE = 16000

# =========================
# LOAD MODEL (ON STARTUP)
# =========================

print("Loading ASR model...")

processor = WhisperProcessor.from_pretrained(MODEL_PATH)
model = WhisperForConditionalGeneration.from_pretrained(MODEL_PATH)

device = "cuda" if torch.cuda.is_available() else "cpu"
model = model.to(device).float()
model.eval()

print(f"ASR loaded on: {device}")

# =========================
# AUDIO CHUNKING
# =========================

def chunk_audio(audio, sample_rate=16000, max_seconds=30, overlap_seconds=1):
    max_samples = int(max_seconds * sample_rate)
    overlap = int(overlap_seconds * sample_rate)

    chunks = []
    start = 0

    while start < len(audio):
        end = start + max_samples
        chunk = audio[start:end]

        if len(chunk) == 0:
            break

        chunks.append(chunk)
        start = end - overlap

    return chunks


MAX_SAMPLES = SAMPLE_RATE * 30


# =========================
# TRANSCRIPTION
# =========================

def transcribe_long(audio_np):
    chunks = chunk_audio(audio_np)

    texts = []
    logprobs = []

    for chunk in chunks:
        if len(chunk) > MAX_SAMPLES:
            chunk = chunk[:MAX_SAMPLES]

        inputs = processor(
            chunk,
            sampling_rate=SAMPLE_RATE,
            return_tensors="pt"
        )

        input_features = inputs.input_features.to(device)

        with torch.no_grad():
            outputs = model.generate(
                input_features,
                return_dict_in_generate=True,
                output_scores=True
            )

        text = processor.batch_decode(
            outputs.sequences,
            skip_special_tokens=True
        )[0].strip()

        if not text:
            continue

        # ----- Confidence -----
        scores = outputs.scores
        tokens = outputs.sequences[0][1:]

        token_logprobs = []
        for step_scores, token_id in zip(scores, tokens):
            logprob = torch.log_softmax(step_scores[0], dim=-1)[token_id]
            token_logprobs.append(logprob.item())

        if token_logprobs:
            avg_logprob = sum(token_logprobs) / len(token_logprobs)
            logprobs.append(avg_logprob)

        texts.append(text)

    if not texts or not logprobs:
        return "", -10.0

    final_text = " ".join(texts).strip()
    final_confidence = sum(logprobs) / len(logprobs)

    return final_text, final_confidence