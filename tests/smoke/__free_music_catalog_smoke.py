"""Smoke: built-in Free_music catalog assets and canonical sound ids.

Run:  py -3 -X utf8 tests\\smoke\\__free_music_catalog_smoke.py
"""
from __future__ import annotations

import io
import os
import sys

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, _ROOT)

passed = 0
failed = 0


def ok(cond: bool, msg: str) -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  OK  {msg}")
    else:
        failed += 1
        print(f" FAIL {msg}")


def section(title: str) -> None:
    print(f"\n== {title} ==")


section("ambience assets on disk")
for name in ("brown_noise.wav", "white_noise.wav", "rain_sound.wav"):
    path = os.path.join(_ROOT, "Free_music", name)
    ok(os.path.isfile(path) and os.path.getsize(path) > 1000, f"{name} exists and is non-empty")

section("server catalog canonical ids")
from server import _free_music_sound_canonical

for stem, expected_id, expected_title in (
    ("brown_noise", "brown_noise", "Brown Noise"),
    ("Brown Noise", "brown_noise", "Brown Noise"),
    ("white_noise", "white_noise", "White Noise"),
    ("White Noise", "white_noise", "White Noise"),
    ("rain_sound", "rain_sound", "Rain Sounds"),
    ("Rain and Thunder Sound", "rain_sound", "Rain Sounds"),
):
    cid, title = _free_music_sound_canonical(stem)
    ok(cid == expected_id and title == expected_title, f"{stem!r} -> {expected_id!r} / {expected_title!r}")

section("voice mappings still present")
music_py = open(os.path.join(_ROOT, "actions/music.py"), encoding="utf-8").read()
for phrase in ("brown_noise", "white_noise", "rain_sound", "lofi_mix"):
    ok(phrase in music_py, f"music.py references {phrase}")

app_js = open(os.path.join(_ROOT, "app/app.js"), encoding="utf-8").read()
ok("freeMusicSortBuiltinSounds" in app_js, "built-in sounds sorted for UI")
ok("Rain Sounds" in app_js, "Rain Sounds display label present")

print(f"\n== summary: {passed} passed, {failed} failed ==")
sys.exit(1 if failed else 0)
