# ---------------------------------------------------------------------------
# UNUSED MODULE — `cleanup_old_tts` is not called from anywhere in the
# production runtime (`app.py`, `actions/`, `cost_logging/`, etc.). If you
# want the TTS audio cache purged on a schedule, wire this into the
# startup tasks in `app.py` or run it from a cron job. Safe to delete if
# you do not plan to use it.
# ---------------------------------------------------------------------------
import shutil
from datetime import datetime, timedelta
from pathlib import Path

def cleanup_old_tts(days=3):
    cutoff = datetime.now() - timedelta(days=days)
    base = Path("tts_outputs")

    for folder in base.iterdir():
        if folder.is_dir():
            folder_date = datetime.strptime(folder.name, "%Y-%m-%d")
            if folder_date < cutoff:
                shutil.rmtree(folder)