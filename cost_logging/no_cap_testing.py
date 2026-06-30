"""In-memory dev/testing toggle: skip credit cap enforcement per session_id.

WARNING: Set VERA_ENABLE_NO_CAP_TOGGLE=true only on private dev/staging hosts.
Never enable on public production — accounting still runs, but caps are not enforced
for sessions that opt in via the testing UI.

Enforcement skip only; record_credit_usage / ledger / daily rollup unchanged.
"""

from __future__ import annotations

import os

# session_id -> active (True when no-cap testing is on for that browser tab)
_NO_CAP_BY_SESSION: dict[str, bool] = {}


def no_cap_toggle_enabled() -> bool:
    """True when the dev no-cap API + frontend control may be used."""
    return os.environ.get("VERA_ENABLE_NO_CAP_TOGGLE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def is_no_cap_active(session_id: str | None) -> bool:
    if not no_cap_toggle_enabled():
        return False
    sid = (session_id or "").strip()
    if not sid:
        return False
    return _NO_CAP_BY_SESSION.get(sid) is True


def set_no_cap_active(session_id: str | None, active: bool) -> None:
    sid = (session_id or "").strip()
    if not sid:
        return
    if active:
        _NO_CAP_BY_SESSION[sid] = True
    else:
        _NO_CAP_BY_SESSION.pop(sid, None)


def reset_no_cap_state() -> None:
    """Clear in-memory no-cap flags (smoke tests)."""
    _NO_CAP_BY_SESSION.clear()
