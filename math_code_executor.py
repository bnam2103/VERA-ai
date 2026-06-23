"""
Sandboxed Python runner for the Vera Work-Mode math/finance/stats code-first path.

Used only when CHAT_REASONING.classify_math_problem_mode reports
code_required = true. We run untrusted-but-curated model-generated Python in a
fresh subprocess with a wall-clock timeout, a cleaned environment (API keys
stripped), and bounded stdout/stderr capture. The model is instructed to emit
a single line beginning with `## VERA_RESULT_JSON ##` followed by a JSON
object that becomes the authoritative computed result.

This module never imports numpy/scipy/sympy itself — it just spawns the
ambient Python interpreter, which already has those packages available in the
deployed environment (see docker/requirements.txt).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

VERA_MATH_CODE_TIMEOUT_SEC = float(os.environ.get("VERA_MATH_CODE_TIMEOUT_SEC", "10"))
VERA_MATH_CODE_MAX_STDOUT_BYTES = int(os.environ.get("VERA_MATH_CODE_MAX_STDOUT_BYTES", "32000"))
VERA_MATH_CODE_MAX_STDERR_BYTES = int(os.environ.get("VERA_MATH_CODE_MAX_STDERR_BYTES", "12000"))
VERA_MATH_CODE_MAX_CODE_CHARS = int(os.environ.get("VERA_MATH_CODE_MAX_CODE_CHARS", "16000"))

RESULT_MARKER = "## VERA_RESULT_JSON ##"

# Env vars stripped before running model-generated code. Subprocess inherits
# everything else from the parent so installed scientific packages still load.
_SENSITIVE_ENV_PREFIXES = (
    "OPENAI_",
    "AZURE_",
    "ANTHROPIC_",
    "AWS_",
    "GOOGLE_",
    "GCP_",
    "GITHUB_",
    "FISH_",
    "VERA_REASONING_",
    "RUNPOD_",
    "HF_TOKEN",
    "HUGGINGFACE",
    "SERPER_",
    "SECRET",
    "TOKEN",
    "API_KEY",
    "API_SECRET",
    "PASSWORD",
)


def _clean_env() -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in os.environ.items():
        ku = k.upper()
        if any(ku.startswith(p) for p in _SENSITIVE_ENV_PREFIXES):
            continue
        if "KEY" in ku and "PYTHON" not in ku:
            continue
        out[k] = v
    out["PYTHONIOENCODING"] = "utf-8"
    out["PYTHONUNBUFFERED"] = "1"
    return out


def _strip_code_fences(code: str) -> str:
    """Accept either bare code or a ```python ...``` fenced block."""
    s = (code or "").strip()
    if not s:
        return ""
    m = re.search(r"```(?:python|py)?\s*\n(.*?)```", s, flags=re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return s


def _truncate_bytes(s: str, max_bytes: int) -> str:
    if not s:
        return ""
    b = s.encode("utf-8", errors="replace")
    if len(b) <= max_bytes:
        return s
    return b[:max_bytes].decode("utf-8", errors="replace") + "\n…[truncated]"


def _parse_result_marker(stdout: str) -> Optional[dict]:
    """Find the LAST `## VERA_RESULT_JSON ##` line and parse the JSON tail."""
    if not stdout or RESULT_MARKER not in stdout:
        return None
    last_obj: Optional[dict] = None
    for line in stdout.splitlines():
        idx = line.find(RESULT_MARKER)
        if idx < 0:
            continue
        tail = line[idx + len(RESULT_MARKER) :].strip()
        if not tail:
            continue
        try:
            parsed = json.loads(tail)
        except Exception:
            continue
        if isinstance(parsed, dict):
            last_obj = parsed
    return last_obj


def _log_math_code_execution_debug(payload: dict) -> None:
    try:
        print(
            "[MATH_CODE_EXECUTION_DEBUG] "
            + json.dumps(payload, ensure_ascii=False, default=str),
            flush=True,
        )
    except Exception:
        pass


def _run_once(code_path: Path) -> tuple[bool, str, str, Optional[int], Optional[str]]:
    """Returns (success, stdout, stderr, returncode, error_kind)."""
    try:
        completed = subprocess.run(
            [sys.executable, str(code_path)],
            capture_output=True,
            text=True,
            timeout=VERA_MATH_CODE_TIMEOUT_SEC,
            env=_clean_env(),
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        partial_out = (e.stdout or "") if isinstance(e.stdout, str) else (
            e.stdout.decode("utf-8", errors="replace") if e.stdout else ""
        )
        partial_err = (e.stderr or "") if isinstance(e.stderr, str) else (
            e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        )
        return False, partial_out, partial_err, None, "timeout"
    except Exception as e:
        return False, "", f"{type(e).__name__}: {e}", None, "spawn_error"

    out = completed.stdout or ""
    err = completed.stderr or ""
    rc = completed.returncode
    if rc != 0:
        return False, out, err, rc, "nonzero_exit"
    return True, out, err, rc, None


def run_python_with_retry(
    code: str,
    *,
    fix_code_cb=None,
    debug_extra: Optional[dict] = None,
) -> dict:
    """Run model-generated Python with retry-once-on-failure.

    Parameters
    ----------
    code : str
        Initial code (may be fenced).
    fix_code_cb : callable | None
        Optional callable invoked when the first attempt fails. Receives
        (original_code, stdout, stderr, error_kind) and must return a new
        code string. If None, the retry repeats the same code (still useful
        for transient subprocess issues).
    debug_extra : dict | None
        Extra fields to merge into the MATH_CODE_EXECUTION_DEBUG log.

    Returns
    -------
    dict with keys:
        python_used (bool)
        execution_success (bool)
        retry_count (int)
        stdout (str, truncated)
        stderr (str, truncated)
        stdout_preview (str)
        computed_result (dict | None)
        final_code (str)
        error_kind (str | None)
        returncode (int | None)
        elapsed_ms (int)
    """
    started = time.time()
    debug_extra = debug_extra or {}

    cleaned = _strip_code_fences(code)
    if not cleaned:
        out = {
            "python_used": False,
            "execution_success": False,
            "retry_count": 0,
            "stdout": "",
            "stderr": "no code provided",
            "stdout_preview": "",
            "computed_result": None,
            "final_code": "",
            "error_kind": "empty_code",
            "returncode": None,
            "elapsed_ms": int((time.time() - started) * 1000),
        }
        _log_math_code_execution_debug({**out, **debug_extra})
        return out
    if len(cleaned) > VERA_MATH_CODE_MAX_CODE_CHARS:
        cleaned = cleaned[:VERA_MATH_CODE_MAX_CODE_CHARS]

    final_code = cleaned
    retry_count = 0
    last_stdout = ""
    last_stderr = ""
    last_rc: Optional[int] = None
    last_err_kind: Optional[str] = None
    success = False

    tmp_dir = Path(tempfile.mkdtemp(prefix="vera_math_"))
    try:
        for attempt in range(2):
            code_path = tmp_dir / f"attempt_{attempt}.py"
            code_path.write_text(final_code, encoding="utf-8")
            ok, stdout, stderr, rc, err_kind = _run_once(code_path)
            last_stdout = stdout
            last_stderr = stderr
            last_rc = rc
            last_err_kind = err_kind
            if ok:
                success = True
                break
            if attempt == 0 and callable(fix_code_cb):
                retry_count += 1
                try:
                    fixed = fix_code_cb(final_code, stdout, stderr, err_kind)
                except Exception:
                    fixed = None
                fixed_clean = _strip_code_fences(fixed or "")
                if fixed_clean:
                    final_code = fixed_clean[:VERA_MATH_CODE_MAX_CODE_CHARS]
                    continue
            # No callback or callback gave nothing usable — stop retrying.
            break
    finally:
        try:
            for p in tmp_dir.glob("*"):
                try:
                    p.unlink()
                except Exception:
                    pass
            tmp_dir.rmdir()
        except Exception:
            pass

    stdout_truncated = _truncate_bytes(last_stdout, VERA_MATH_CODE_MAX_STDOUT_BYTES)
    stderr_truncated = _truncate_bytes(last_stderr, VERA_MATH_CODE_MAX_STDERR_BYTES)
    computed = _parse_result_marker(stdout_truncated) if success else None
    preview = stdout_truncated.strip()
    if len(preview) > 1200:
        preview = preview[:1200] + "\n…[stdout preview truncated]"

    out = {
        "python_used": True,
        "execution_success": bool(success),
        "retry_count": retry_count,
        "stdout": stdout_truncated,
        "stderr": stderr_truncated,
        "stdout_preview": preview,
        "computed_result": computed,
        "final_code": final_code,
        "error_kind": last_err_kind,
        "returncode": last_rc,
        "elapsed_ms": int((time.time() - started) * 1000),
    }
    _log_math_code_execution_debug({**{k: out[k] for k in out if k != "final_code"}, **debug_extra})
    return out


__all__ = ["run_python_with_retry", "RESULT_MARKER"]
