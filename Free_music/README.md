# Built-in productivity music

Audio is served by the API (`GET /api/free-music/catalog` and `GET /api/free-music/stream`).

## Layout

- **`lofi_mix/`** (folder) — treated as one **playlist**. Put multiple `.mp3` / `.wav` / `.ogg` / `.m4a` / `.flac` / `.opus` files here; they play in alphabetical order and repeat from the first track after the last.
- **Root files** — each audio file directly under `Free_music/` is a **single** item (good for ambience loops), for example:
  - `white_noise.mp3`
  - `brown_noise.mp3`
  - `rain_sound.mp3`

Display titles are derived from the filename (underscores become spaces).

## After adding files

Restart `uvicorn` if it is already running so new files are picked up.
