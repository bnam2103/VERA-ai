# Built-in productivity music

Audio is served by the API (`GET /api/free-music/catalog` and `GET /api/free-music/stream`).

## Layout

- **`lofi_mix/`** or **`lofi mix/`** (folder) — treated as one **playlist**. Put multiple `.mp3` / `.wav` / `.ogg` / `.m4a` / `.flac` / `.opus` files here; they play in alphabetical order and repeat from the first track after the last.
- **Root files** — each audio file directly under `Free_music/` is a **single** ambience item (loops in the player), for example:
  - `white_noise.wav` → **White Noise**
  - `brown_noise.wav` → **Brown Noise**
  - `rain_sound.wav` → **Rain Sounds**

Display titles are derived from the filename (underscores become spaces). The API also accepts legacy human filenames such as `Brown Noise.mp3` and maps them to the same built-in ids.

## Regenerate default ambience loops (dev)

If the canonical WAV files are missing locally:

```bash
py -3 scripts/generate_free_music_ambience.py
```

This writes short loopable WAV files for brown / white / rain sounds. Replace them with higher-quality MP3s on the server if desired (see `.gitignore` for optional legacy filenames).

## After adding files

Restart `uvicorn` if it is already running so new files are picked up.
