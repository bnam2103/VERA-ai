# Patch notes

## Version — BMO

### BMO face: SVG emotion layer (TTS)

- **Three mouth states** on the BMO page, driven by discrete SVG layers (no morph tweening):
  - **Idle** — vector smile stroke only (calm / quiet moments while speaking).
  - **Surprised** — rounded “O” mouth (ellipse) for mid-energy speech.
  - **Happy** — full open mouth: green cavity, white teeth band, tongue; teeth aligned to meet the upper “roof” of the cavity.
- **When it runs:** While BMO’s reply audio plays (`#bmo-audio`), the UI listens through the same Web Audio graph used for TTS and updates **`data-bmo-tts-emotion`** on **`#bmo-smile-svg`** (`idle` | `surprised` | `happy`).
- **How it reacts (audio, not text):** Loudness is derived from the **time-domain signal (RMS)** plus **voice-band FFT peak** energy — **not** the words on screen. A **slow baseline** vs **short-term “excess”** pattern is used so **happy** tends to hit on **syllable / energy spikes**, **surprised** on steadier voiced stretches, and **idle** on very quiet gaps — so the face feels tied to **prosody**, not the literal phrase.
- **Styling:** Stronger outline stroke on **happy / surprised** filled shapes vs the **idle** smile path; tongue stays without a heavy outline.

### Layout (mobile)

- On **narrow viewports (≤768px)**, the **side chat log column is hidden** so the phone view focuses on the character and input dock. Conversation nodes still exist in the DOM for the app logic.

### BMO startup sound

- **`startup-typing.wav` is not used on the BMO page** (no typing SFX, no post-load intro clip). VERA still uses it for the startup typewriter line.

### BMO voice (Fish Audio) vs VERA (local TTS)

- **VERA** (`client=vera`, default): reply audio from **`TTS.py`** / SpeechT5 (`.wav`).
- **BMO page** sends **`client=bmo`** on `/infer` and `/text`. If **`FISH_API_KEY`** (or `FISH_AUDIO_API_KEY`) and **`REFERENCE_ID`** are set **in the same process as `app.py`** (not only in a separate terminal where you ran `bmo_tts.py`), Fish runs (→ `.mp3`). Easiest: copy **`.env.example`** → **`.env`** next to `app.py` (requires **`python-dotenv`**, loaded at startup). Otherwise fall back to local TTS.
- **`pip install "fish-audio-sdk[utils]"`** — do not install the unrelated PyPI package named `fishaudio`.

### Related assets

- **`bmo-emotions-test.html`** — standalone layout reference for happy / surprised / idle art (optional for designers).

---

*Earlier infra tweaks (session memory cleanup, latency logging, router fast paths, voice reply bubble timing) live in code comments and server logs; shout if you want them called out in a separate “Platform” section.*
