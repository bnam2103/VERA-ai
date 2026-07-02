#!/usr/bin/env python3
"""Generate loopable built-in ambience WAV files under Free_music/.

Run:  py -3 scripts/generate_free_music_ambience.py

These files back the Work Mode built-in sounds tab and voice commands such as
"play brown noise". Original high-quality MP3s may still be deployed manually
(see Free_music/README.md); this script recreates the canonical snake_case assets.
"""
from __future__ import annotations

import random
import struct
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "Free_music"
RATE = 44100
SECONDS = 20


def write_mono_wav(path: Path, samples: list[int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        frames = b"".join(struct.pack("<h", max(-32767, min(32767, int(sample)))) for sample in samples)
        handle.writeframes(frames)


def gen_white(seconds: int = SECONDS, amp: int = 12000) -> list[int]:
    return [random.randint(-amp, amp) for _ in range(seconds * RATE)]


def gen_brown(seconds: int = SECONDS, amp: int = 6000) -> list[int]:
    out: list[int] = []
    value = 0.0
    for _ in range(seconds * RATE):
        value += random.uniform(-1, 1)
        value *= 0.9995
        out.append(int(value * amp))
    return out


def gen_rain(seconds: int = SECONDS, amp: int = 9000) -> list[int]:
    out: list[int] = []
    b0 = b1 = b2 = 0.0
    droplets = {random.randint(0, seconds * RATE - 1) for _ in range(seconds * 8)}
    for i in range(seconds * RATE):
        white = random.uniform(-1, 1)
        b0 = 0.997 * b0 + white * 0.03
        b1 = 0.985 * b1 + white * 0.05
        b2 = 0.95 * b2 + white * 0.08
        sample = (b0 + b1 + b2) * amp * 0.4
        if i in droplets:
            sample += random.uniform(0.4, 1.0) * amp * 0.9
        elif (i - 1) in droplets or (i + 1) in droplets:
            sample += random.uniform(0.1, 0.3) * amp * 0.4
        out.append(int(sample))
    return out


def main() -> None:
    write_mono_wav(ROOT / "white_noise.wav", gen_white())
    write_mono_wav(ROOT / "brown_noise.wav", gen_brown())
    write_mono_wav(ROOT / "rain_sound.wav", gen_rain())
    print("Wrote Free_music/white_noise.wav, brown_noise.wav, rain_sound.wav")


if __name__ == "__main__":
    main()
