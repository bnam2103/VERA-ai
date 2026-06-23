"""Safe archive / reset / status helpers for Vera cost-log JSONL files."""

from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

from . import logger as _logger

# Canonical active log filenames (under LOG_DIR).
ACTIVE_LOG_FILENAMES: tuple[str, ...] = (
    "cost_events.jsonl",
    "provider_cost_events.jsonl",  # legacy alias — archived if present
    "request_cost_summary.jsonl",
    "session_cost_summary.jsonl",
)

RECOMMENDED_SCENARIO_NAMES: tuple[str, ...] = (
    "light_session",
    "normal_work_mode_session",
    "heavy_reasoning_session",
    "search_heavy_session",
    "voice_heavy_session",
    "file_upload_session",
    "image_upload_session",
)


def cost_log_reset_allowed() -> bool:
    """True when destructive reset is permitted."""
    env = (os.environ.get("ENVIRONMENT") or os.environ.get("ENV") or "").strip().lower()
    if env in ("development", "dev", "local"):
        return True
    if (os.environ.get("COST_LOG_ALLOW_RESET") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    ):
        return True
    return False


def _archive_stamp() -> str:
    return time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime())


def _log_dir() -> Path:
    return _logger.LOG_DIR


def _active_log_paths() -> list[Path]:
    seen: set[Path] = set()
    out: list[Path] = []
    for name in ACTIVE_LOG_FILENAMES:
        p = _log_dir() / name
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def clear_cost_logging_runtime_state() -> None:
    """Drop in-memory session aggregates (does not touch disk)."""
    with _logger._state_lock:
        _logger._sessions.clear()


def _touch_empty(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def _recreate_active_log_files() -> list[str]:
    recreated: list[str] = []
    targets = [
        _logger.COST_EVENTS_FILE,
        _logger.REQUEST_SUMMARY_FILE,
        _logger.SESSION_SUMMARY_FILE,
    ]
    with _logger._file_lock:
        for path in targets:
            _touch_empty(path)
            recreated.append(str(path))
    return recreated


def _move_to_archive(path: Path, archive_dir: Path) -> str | None:
    if not path.is_file():
        return None
    if path.stat().st_size == 0:
        try:
            path.unlink()
        except Exception:
            pass
        return None
    dest = archive_dir / path.name
    if dest.exists():
        dest = archive_dir / f"{path.stem}_{int(time.time())}{path.suffix}"
    shutil.move(str(path), str(dest))
    return str(dest)


def archive_cost_logs() -> dict[str, Any]:
    """Move active log files into ``logs/archive/<timestamp>/`` and recreate empties."""
    log_dir = _log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    archive_root = log_dir / "archive"
    archive_dir = archive_root / _archive_stamp()
    archive_dir.mkdir(parents=True, exist_ok=True)

    moved: list[dict[str, str]] = []
    with _logger._file_lock:
        for path in _active_log_paths():
            dest = _move_to_archive(path, archive_dir)
            if dest:
                moved.append({"from": str(path), "to": dest})
        recreated = _recreate_active_log_files()

    clear_cost_logging_runtime_state()

    return {
        "ok": True,
        "log_dir": str(log_dir),
        "archive_dir": str(archive_dir),
        "moved": moved,
        "active_files_recreated": recreated,
        "note": "Archived files are preserved under logs/archive/. Active logs were recreated empty.",
    }


def reset_cost_logs() -> dict[str, Any]:
    """Truncate/delete active logs. Refuses unless :func:`cost_log_reset_allowed`."""
    if not cost_log_reset_allowed():
        return {
            "ok": False,
            "error": "reset_not_allowed",
            "message": (
                "Cost log reset is disabled. Set ENVIRONMENT=development or "
                "COST_LOG_ALLOW_RESET=true to enable."
            ),
        }

    cleared: list[str] = []
    log_dir = _log_dir()
    with _logger._file_lock:
        for path in _active_log_paths():
            if path.is_file():
                try:
                    path.unlink()
                except Exception as e:
                    return {"ok": False, "error": "reset_failed", "message": str(e)}
                cleared.append(str(path))
        recreated = _recreate_active_log_files()

    clear_cost_logging_runtime_state()

    return {
        "ok": True,
        "log_dir": str(log_dir),
        "cleared": cleared,
        "active_files_recreated": recreated,
        "note": "Active cost logs were truncated. Use archive instead to keep history.",
    }


def _timestamp_candidates(row: dict[str, Any]) -> list[str]:
    keys = (
        "timestamp",
        "started_at",
        "completed_at",
        "started_at_iso",
        "completed_at_iso",
    )
    out: list[str] = []
    for k in keys:
        v = row.get(k)
        if isinstance(v, str) and v.strip():
            out.append(v.strip())
    return out


def _scan_jsonl_file(path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {
        "name": path.name,
        "path": str(path),
        "exists": path.is_file(),
        "size_bytes": 0,
        "row_count": 0,
        "earliest_timestamp": None,
        "latest_timestamp": None,
        "parse_errors": 0,
    }
    if not path.is_file():
        return info

    try:
        info["size_bytes"] = path.stat().st_size
    except Exception:
        pass

    earliest: str | None = None
    latest: str | None = None
    row_count = 0
    parse_errors = 0

    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row_count += 1
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    parse_errors += 1
                    continue
                if not isinstance(row, dict):
                    continue
                for ts in _timestamp_candidates(row):
                    if earliest is None or ts < earliest:
                        earliest = ts
                    if latest is None or ts > latest:
                        latest = ts
    except Exception as e:
        info["read_error"] = str(e)[:200]

    info["row_count"] = row_count
    info["earliest_timestamp"] = earliest
    info["latest_timestamp"] = latest
    info["parse_errors"] = parse_errors
    return info


def get_cost_logs_status() -> dict[str, Any]:
    """Snapshot of active log files + archive folder listing."""
    log_dir = _log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    archive_root = log_dir / "archive"
    archives: list[dict[str, Any]] = []
    if archive_root.is_dir():
        for child in sorted(archive_root.iterdir(), reverse=True):
            if child.is_dir():
                archives.append(
                    {
                        "name": child.name,
                        "path": str(child),
                        "file_count": sum(1 for _ in child.glob("*.jsonl")),
                    }
                )

    files = [_scan_jsonl_file(p) for p in _active_log_paths()]

    with _logger._state_lock:
        open_sessions = len(_logger._sessions)

    return {
        "ok": True,
        "log_dir": str(log_dir),
        "archive_root": str(archive_root),
        "reset_allowed": cost_log_reset_allowed(),
        "recommended_scenario_names": list(RECOMMENDED_SCENARIO_NAMES),
        "open_in_memory_sessions": open_sessions,
        "files": files,
        "archives": archives[:20],
    }
