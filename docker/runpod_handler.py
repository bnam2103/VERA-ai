import runpod
import asyncio
import base64
import tempfile
import os
from fastapi import UploadFile
from starlette.datastructures import UploadFile as StarletteUploadFile
from io import BytesIO

# Import your existing backend logic
from app import text_input, infer, TextInput


def run_async(func, *args):
    """
    Run async FastAPI functions inside RunPod sync handler
    """
    return asyncio.run(func(*args))


def make_upload_file(audio_bytes):
    """
    Convert base64 audio into UploadFile for FastAPI infer()
    """
    file = BytesIO(audio_bytes)
    upload = StarletteUploadFile(filename="audio.wav", file=file)
    return upload


def handler(job):

    job_input = job.get("input", {})

    session_id = job_input.get("session_id", "runpod")

    # ---------- TEXT REQUEST ----------
    if "text" in job_input:

        data = TextInput(
            session_id=session_id,
            text=job_input["text"]
        )

        result = run_async(text_input, data)

        return result

    # ---------- AUDIO REQUEST ----------
    if "audio" in job_input:

        audio_base64 = job_input["audio"]
        audio_bytes = base64.b64decode(audio_base64)

        upload = make_upload_file(audio_bytes)

        result = run_async(
            infer,
            audio=upload,
            session_id=session_id,
            mode="continuous"
        )

        return result

    return {
        "error": "Invalid input. Provide 'text' or 'audio'."
    }


runpod.serverless.start({"handler": handler})