"""Request- and session-scoped cost logging for Vera.

Three append-only JSONL files live under ``LOG_DIR`` (default
``./logs``):

* ``cost_events.jsonl``           — one row per paid provider call
* ``request_cost_summary.jsonl``  — one row per user-facing request
* ``session_cost_summary.jsonl``  — one row per session (on explicit end)

Design notes:

* All ``estimated_cost_usd`` computation is best-effort. Missing price
  fields fall through to ``null`` instead of raising.
* Logging never re-raises into the caller — exceptions inside the logger
  are swallowed and printed so they cannot break a Vera request.
* The current request is tracked with a :class:`contextvars.ContextVar`
  so OpenAI / Serper / Fish callers can record events without threading
  IDs through every signature.
* Session aggregates live in-memory keyed by ``session_id``. They are
  flushed to ``session_cost_summary.jsonl`` only on explicit
  :func:`end_session` calls.

This module deliberately does NOT include RunPod / hosting cost.
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from .credits import (
    classify_credit_action,
    compute_credits,
    credit_config_source,
    load_credit_config,
)
from .pricing import (
    get_fish_price,
    get_openai_price,
    get_serper_price,
    load_pricing,
    pricing_source,
)

# --------------------------------------------------------------------------- #
# File locations and shared file lock.
# --------------------------------------------------------------------------- #
_DEFAULT_LOG_DIR = Path(__file__).resolve().parent.parent / "logs"


def _resolved_log_dir() -> Path:
    raw = (os.environ.get("COST_LOG_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return _DEFAULT_LOG_DIR


LOG_DIR: Path = _resolved_log_dir()
COST_EVENTS_FILE = LOG_DIR / "cost_events.jsonl"
REQUEST_SUMMARY_FILE = LOG_DIR / "request_cost_summary.jsonl"
SESSION_SUMMARY_FILE = LOG_DIR / "session_cost_summary.jsonl"

_NOTE_API_ONLY = (
    "API-only cost (OpenAI + Fish/BMO + Serper). Hosting/server cost excluded."
)

_file_lock = threading.RLock()
_state_lock = threading.RLock()


def _ensure_log_dir() -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:  # pragma: no cover - filesystem oddities
        print(f"[cost_logger] could not create log dir {LOG_DIR}: {e}")


def _append_jsonl(path: Path, row: dict[str, Any]) -> None:
    try:
        _ensure_log_dir()
        line = json.dumps(row, ensure_ascii=False, default=_json_default)
        with _file_lock:
            with path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception as e:
        print(f"[cost_logger] write failed for {path.name}: {e}")


def _json_default(o: Any) -> Any:
    # OpenAI usage objects are pydantic models — dump to dict.
    if hasattr(o, "model_dump"):
        try:
            return o.model_dump()
        except Exception:
            pass
    if hasattr(o, "dict"):
        try:
            return o.dict()
        except Exception:
            pass
    try:
        return str(o)
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Request + session state.
# --------------------------------------------------------------------------- #
@dataclass
class RequestState:
    request_id: str
    started_at: float
    started_at_iso: str
    session_id: str | None = None
    mode: str = "unknown"
    request_type: str = "unknown"
    scenario_name: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    finalized: bool = False
    success: bool = True
    error_message: str | None = None
    completed_at: float | None = None
    completed_at_iso: str | None = None
    latency_ms: float | None = None
    credit_action: str | None = None
    credits_used: int = 0
    credit_reason: str | None = None

    def totals(self) -> dict[str, Any]:
        # A request with zero recorded provider events is a real "no cost"
        # request (e.g., command-only with no LLM call). Report explicit zeros
        # so downstream analysis can treat them as $0 instead of "unknown".
        if not self.events:
            return {
                "total_openai_cost_usd": 0.0,
                "total_fish_cost_usd": 0.0,
                "total_serper_cost_usd": 0.0,
                "total_api_cost_usd": 0.0,
                "credits_charged": None,
                "cost_by_provider": {},
            }
        openai_cost = 0.0
        openai_known = False
        fish_cost = 0.0
        fish_known = False
        serper_cost = 0.0
        serper_known = False
        cost_by_provider: dict[str, float | None] = {}
        credits_charged = 0
        any_credits = False
        for ev in self.events:
            prov = ev.get("provider")
            est = ev.get("estimated_cost_usd")
            if prov == "openai":
                if isinstance(est, (int, float)):
                    openai_cost += float(est)
                    openai_known = True
            elif prov == "fish_audio":
                # Fish Audio API billing is per UTF-8 byte. Legacy "credits"
                # fields are ignored — only ``estimated_cost_usd`` counts.
                if isinstance(est, (int, float)):
                    fish_cost += float(est)
                    fish_known = True
            elif prov == "serper":
                if isinstance(est, (int, float)):
                    serper_cost += float(est)
                    serper_known = True
            if isinstance(est, (int, float)):
                prev = cost_by_provider.get(prov)
                cost_by_provider[prov] = (prev or 0.0) + float(est)
            else:
                cost_by_provider.setdefault(prov or "unknown", None)
        return {
            "total_openai_cost_usd": round(openai_cost, 8) if openai_known else None,
            "total_fish_cost_usd": round(fish_cost, 8) if fish_known else None,
            "total_serper_cost_usd": round(serper_cost, 8) if serper_known else None,
            "total_api_cost_usd": (
                round(openai_cost + fish_cost + serper_cost, 8)
                if (openai_known or fish_known or serper_known)
                else None
            ),
            "credits_charged": credits_charged if any_credits else None,
            "cost_by_provider": cost_by_provider,
        }


@dataclass
class SessionState:
    session_id: str
    started_at: float
    started_at_iso: str
    scenario_name: str | None = None
    requests: int = 0
    total_openai_cost_usd: float = 0.0
    total_fish_cost_usd: float = 0.0
    total_serper_cost_usd: float = 0.0
    total_api_cost_usd: float = 0.0
    cost_by_request_type: dict[str, float] = field(default_factory=dict)
    cost_by_provider: dict[str, float] = field(default_factory=dict)
    highest_cost_request: dict[str, Any] | None = None
    total_credits_used: int = 0
    credits_by_action: dict[str, int] = field(default_factory=dict)


_current_request: ContextVar[RequestState | None] = ContextVar(
    "vera_cost_current_request", default=None
)

_sessions: dict[str, SessionState] = {}
_initialized = False


def init_cost_logging() -> dict[str, Any]:
    """Idempotent setup: prepare log dir + materialize pricing template once."""
    global _initialized
    with _state_lock:
        if _initialized:
            return {"already_initialized": True, "log_dir": str(LOG_DIR)}
        _ensure_log_dir()
        load_pricing()
        load_credit_config()
        _initialized = True
        info = {
            "log_dir": str(LOG_DIR),
            "pricing_source": pricing_source(),
            "credit_config_source": credit_config_source(),
            "files": {
                "cost_events": str(COST_EVENTS_FILE),
                "request_cost_summary": str(REQUEST_SUMMARY_FILE),
                "session_cost_summary": str(SESSION_SUMMARY_FILE),
            },
        }
        print(f"[cost_logger] initialized → {info}")
        return info


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------------- #
# Session lifecycle.
# --------------------------------------------------------------------------- #
def begin_session(session_id: str, scenario_name: str | None = None) -> SessionState:
    sid = str(session_id or "").strip()
    if not sid:
        sid = "anonymous"
    with _state_lock:
        st = _sessions.get(sid)
        if st is None:
            st = SessionState(
                session_id=sid,
                started_at=time.time(),
                started_at_iso=_now_iso(),
                scenario_name=scenario_name,
            )
            _sessions[sid] = st
        elif scenario_name and not st.scenario_name:
            st.scenario_name = scenario_name
        return st


def set_scenario(session_id: str, scenario_name: str) -> None:
    sid = str(session_id or "").strip() or "anonymous"
    name = (scenario_name or "").strip() or None
    with _state_lock:
        st = _sessions.get(sid) or begin_session(sid, name)
        st.scenario_name = name


def list_open_session_ids() -> list[str]:
    """Snapshot of session_ids that have in-memory state (not yet finalized)."""
    with _state_lock:
        return list(_sessions.keys())


def compute_live_session_totals(session_id: str) -> dict[str, Any] | None:
    """Live aggregate for ``session_id`` without writing to disk.

    Reads from ``request_cost_summary.jsonl`` (and ``cost_events.jsonl`` via the
    report builder) so callers can inspect a session that is still active —
    even one that was never registered with :func:`begin_session`. Returns
    ``None`` when there are no rows for the session yet.
    """
    sid = str(session_id or "").strip() or "anonymous"
    # Lazy import to avoid circular: report.py already imports from logger.py.
    from .report import build_report

    report = build_report(session=sid)
    sess = (report.get("sessions") or {}).get(sid)
    if not sess:
        # Fall back to in-memory state when no JSONL rows exist yet but the
        # session was started explicitly (e.g., user called begin_session
        # before any request landed).
        with _state_lock:
            st = _sessions.get(sid)
        if st is None:
            return None
        avg_cost = round(st.total_api_cost_usd / st.requests, 8) if st.requests else None
        return {
            "session_id": st.session_id,
            "scenario_name": st.scenario_name,
            "started_at": st.started_at_iso,
            "last_seen": st.started_at_iso,
            "total_requests": st.requests,
            "total_openai_cost_usd": round(st.total_openai_cost_usd, 8),
            "total_fish_cost_usd": round(st.total_fish_cost_usd, 8),
            "total_serper_cost_usd": round(st.total_serper_cost_usd, 8),
            "total_api_cost_usd": round(st.total_api_cost_usd, 8),
            "average_cost_per_request": avg_cost,
            "cost_by_request_type": {k: round(v, 8) for k, v in st.cost_by_request_type.items()},
            "cost_by_provider": {k: round(v, 8) for k, v in st.cost_by_provider.items()},
            "total_credits_used": int(st.total_credits_used),
            "credits_by_action": {k: int(v) for k, v in st.credits_by_action.items()},
            "highest_cost_request": st.highest_cost_request,
            "source": "in_memory_state_no_jsonl_yet",
            "note": _NOTE_API_ONLY,
        }
    # If begin_session was called, the in-memory state has the canonical
    # scenario_name and start time — prefer those over what build_report sniffed.
    with _state_lock:
        in_mem = _sessions.get(sid)
    scenario = sess.get("scenario_name")
    started = sess.get("first_seen")
    if in_mem is not None:
        if in_mem.scenario_name and not scenario:
            scenario = in_mem.scenario_name
        if in_mem.started_at_iso:
            started = in_mem.started_at_iso
    return {
        "session_id": sess["session_id"],
        "scenario_name": scenario,
        "started_at": started,
        "last_seen": sess.get("last_seen"),
        "total_requests": sess.get("requests", 0),
        "total_openai_cost_usd": round(sess.get("total_openai_cost_usd", 0.0), 8),
        "total_fish_cost_usd": round(sess.get("total_fish_cost_usd", 0.0), 8),
        "total_serper_cost_usd": round(sess.get("total_serper_cost_usd", 0.0), 8),
        "total_api_cost_usd": round(sess.get("total_api_cost_usd", 0.0), 8),
        "average_cost_per_request": sess.get("average_cost_per_request"),
        "cost_by_request_type": sess.get("cost_by_request_type", {}),
        "cost_by_provider": sess.get("cost_by_provider", {}),
        "total_credits_used": int(sess.get("total_credits_used", 0) or 0),
        "credits_by_action": sess.get("credits_by_action", {}),
        "highest_cost_request": sess.get("highest_cost_request"),
        "source": "live_aggregate_from_jsonl",
        "note": _NOTE_API_ONLY,
    }


def end_session(
    session_id: str, scenario_name: str | None = None
) -> dict[str, Any] | None:
    """Append one row to ``session_cost_summary.jsonl`` for ``session_id``.

    Two paths:

    1. **In-memory state exists** (caller used :func:`begin_session` and
       requests have rolled in). Uses canonical start time and rolling totals,
       then pops the session.
    2. **No in-memory state** — reconstructs the summary on the fly from
       ``request_cost_summary.jsonl`` so the user can call this even without
       ever calling :func:`begin_session`. The ``source`` field on the written
       row indicates which path was used.

    ``scenario_name`` overrides whatever was stored on the session (handy when
    end is called from an external script that knows the scenario label but
    the session was started anonymously by the middleware).
    """
    sid = str(session_id or "").strip() or "anonymous"
    completed_at = time.time()
    completed_at_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(completed_at))

    with _state_lock:
        st = _sessions.pop(sid, None)

    if st is not None:
        avg_cost = (
            round(st.total_api_cost_usd / st.requests, 8) if st.requests else None
        )
        row = {
            "timestamp": completed_at_iso,
            "session_id": st.session_id,
            "scenario_name": scenario_name or st.scenario_name,
            "started_at": st.started_at_iso,
            "completed_at": completed_at_iso,
            "duration_s": round(completed_at - st.started_at, 3),
            "total_requests": st.requests,
            "total_openai_cost_usd": round(st.total_openai_cost_usd, 8),
            "total_fish_cost_usd": round(st.total_fish_cost_usd, 8),
            "total_serper_cost_usd": round(st.total_serper_cost_usd, 8),
            "total_api_cost_usd": round(st.total_api_cost_usd, 8),
            "average_cost_per_request": avg_cost,
            "cost_by_request_type": {k: round(v, 8) for k, v in st.cost_by_request_type.items()},
            "cost_by_provider": {k: round(v, 8) for k, v in st.cost_by_provider.items()},
            "total_credits_used": int(st.total_credits_used),
            "credits_by_action": {k: int(v) for k, v in st.credits_by_action.items()},
            "highest_cost_request": st.highest_cost_request,
            "source": "in_memory_state",
            "note": _NOTE_API_ONLY,
        }
        _append_jsonl(SESSION_SUMMARY_FILE, row)
        return row

    live = compute_live_session_totals(sid)
    if live is None:
        return None
    row = {
        "timestamp": completed_at_iso,
        "session_id": live["session_id"],
        "scenario_name": scenario_name or live.get("scenario_name"),
        "started_at": live.get("started_at"),
        "completed_at": completed_at_iso,
        "duration_s": None,
        "total_requests": live.get("total_requests", 0),
        "total_openai_cost_usd": live.get("total_openai_cost_usd", 0.0),
        "total_fish_cost_usd": live.get("total_fish_cost_usd", 0.0),
        "total_serper_cost_usd": live.get("total_serper_cost_usd", 0.0),
        "total_api_cost_usd": live.get("total_api_cost_usd", 0.0),
        "average_cost_per_request": live.get("average_cost_per_request"),
        "cost_by_request_type": live.get("cost_by_request_type", {}),
        "cost_by_provider": live.get("cost_by_provider", {}),
        "total_credits_used": int(live.get("total_credits_used", 0) or 0),
        "credits_by_action": live.get("credits_by_action", {}),
        "highest_cost_request": live.get("highest_cost_request"),
        "source": "reconstructed_from_jsonl",
        "note": _NOTE_API_ONLY,
    }
    _append_jsonl(SESSION_SUMMARY_FILE, row)
    return row


# --------------------------------------------------------------------------- #
# Request lifecycle.
# --------------------------------------------------------------------------- #
def begin_request(
    *,
    session_id: str | None = None,
    mode: str = "unknown",
    request_type: str = "unknown",
    scenario_name: str | None = None,
    request_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> RequestState:
    rid = (request_id or uuid.uuid4().hex[:12]).strip()
    st = RequestState(
        request_id=rid,
        started_at=time.time(),
        started_at_iso=_now_iso(),
        session_id=(session_id or "").strip() or None,
        mode=str(mode or "unknown"),
        request_type=str(request_type or "unknown"),
        scenario_name=scenario_name,
        extra=dict(extra or {}),
    )
    _current_request.set(st)
    return st


def update_request(
    *,
    session_id: str | None = None,
    mode: str | None = None,
    request_type: str | None = None,
    scenario_name: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    st = _current_request.get()
    if st is None or st.finalized:
        return
    if session_id is not None:
        s = str(session_id).strip()
        if s:
            st.session_id = s
            if not st.scenario_name:
                with _state_lock:
                    sess = _sessions.get(s)
                if sess and sess.scenario_name:
                    st.scenario_name = sess.scenario_name
    if mode is not None:
        st.mode = str(mode)
    if request_type is not None:
        st.request_type = str(request_type)
    if scenario_name is not None:
        st.scenario_name = scenario_name
    if extra:
        st.extra.update(extra)


def set_session_id(session_id: str | None) -> None:
    update_request(session_id=session_id)


def current_request() -> RequestState | None:
    return _current_request.get()


def end_request(
    state: RequestState | None = None,
    *,
    success: bool = True,
    error_message: str | None = None,
) -> dict[str, Any] | None:
    st = state if state is not None else _current_request.get()
    if st is None or st.finalized:
        return None
    try:
        st.finalized = True
        st.success = bool(success)
        st.error_message = (str(error_message)[:500] if error_message else None)
        st.completed_at = time.time()
        st.completed_at_iso = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.completed_at)
        )
        st.latency_ms = round((st.completed_at - st.started_at) * 1000.0, 3)
        # Inherit scenario from the parent session if the request didn't carry one.
        if not st.scenario_name and st.session_id:
            with _state_lock:
                sess = _sessions.get(st.session_id)
            if sess and sess.scenario_name:
                st.scenario_name = sess.scenario_name
        totals = st.totals()
        # Credit metering. Measurement only — never blocks the request.
        try:
            action, reason = classify_credit_action(
                mode=st.mode,
                request_type=st.request_type,
                extras=st.extra,
                events=st.events,
                success=st.success,
            )
            st.credit_action = action
            st.credit_reason = reason
            st.credits_used = int(compute_credits(action))
        except Exception as _cred_err:
            st.credit_action = "local_command"
            st.credit_reason = f"classifier_error:{_cred_err!r}"[:200]
            st.credits_used = 0
        row = {
            "timestamp": st.completed_at_iso,
            "session_id": st.session_id,
            "request_id": st.request_id,
            "scenario_name": st.scenario_name,
            "mode": st.mode,
            "request_type": st.request_type,
            "started_at": st.started_at_iso,
            "completed_at": st.completed_at_iso,
            "latency_ms": st.latency_ms,
            "success": st.success,
            "error_message": st.error_message,
            **totals,
            "credit_action": st.credit_action,
            "credits_used": st.credits_used,
            "credit_reason": st.credit_reason,
            "events_count": len(st.events),
            "extra": st.extra or None,
            "note": _NOTE_API_ONLY,
        }
        _append_jsonl(REQUEST_SUMMARY_FILE, row)
        try:
            from auth.request_auth import get_bound_auth_user
            from .credit_enforcement import settle_request_credits

            _auth_user = get_bound_auth_user()
            _uid = getattr(_auth_user, "user_id", None) if _auth_user else None
            if not _uid and st.extra:
                _uid = st.extra.get("auth_user_id")
            _settle_sid = st.session_id or (st.extra or {}).get("settlement_session_id")
            settle_request_credits(
                user_id=_uid,
                session_id=_settle_sid,
                request_id=st.request_id,
                credit_action=st.credit_action,
                credits_used=st.credits_used,
                success=st.success,
                events=st.events,
                estimated_cost_usd=totals.get("total_api_cost_usd"),
                extra={
                    "mode": st.mode,
                    "request_type": st.request_type,
                    "credit_reason": st.credit_reason,
                    **(st.extra or {}),
                },
            )
        except Exception as _settle_err:
            print(f"[credit_cap] settle_request_credits skipped: {_settle_err}")
        if st.session_id:
            _roll_into_session(st, totals)
        return row
    except Exception as e:
        print(f"[cost_logger] end_request error: {e}")
        traceback.print_exc()
        return None
    finally:
        try:
            _current_request.set(None)
        except Exception:
            pass


def finalize_request_cost(
    request_id: str | None = None,
    *,
    success: bool = True,
    error_message: str | None = None,
) -> dict | None:
    """Explicit, idempotent finalize for the in-flight cost request.

    Useful when the middleware can't see all the work — e.g., a route returns
    early but a background pipeline keeps making provider calls, or a streaming
    body iterator is consumed outside the normal Starlette path.

    * If ``request_id`` is provided, the finalize only fires when the current
      request context matches that id. Mismatched calls are no-ops.
    * Safe to call multiple times — :func:`end_request` already guards on
      ``RequestState.finalized``.
    * Returns the written summary row, or ``None`` if there was nothing to do.
    """
    st = _current_request.get()
    if st is None:
        return None
    if request_id and st.request_id != request_id:
        return None
    return end_request(st, success=success, error_message=error_message)


@contextmanager
def request_context(
    *,
    session_id: str | None = None,
    mode: str = "unknown",
    request_type: str = "unknown",
    scenario_name: str | None = None,
    request_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> Iterator[RequestState]:
    state = begin_request(
        session_id=session_id,
        mode=mode,
        request_type=request_type,
        scenario_name=scenario_name,
        request_id=request_id,
        extra=extra,
    )
    success = True
    error_message: str | None = None
    try:
        yield state
    except Exception as e:
        success = False
        error_message = str(e)[:500]
        raise
    finally:
        end_request(state, success=success, error_message=error_message)


def _roll_into_session(req: RequestState, totals: dict[str, Any]) -> None:
    sid = req.session_id or "anonymous"
    with _state_lock:
        sess = _sessions.get(sid) or begin_session(sid, req.scenario_name)
        if req.scenario_name and not sess.scenario_name:
            sess.scenario_name = req.scenario_name
        sess.requests += 1
        oc = totals.get("total_openai_cost_usd") or 0.0
        fc = totals.get("total_fish_cost_usd") or 0.0
        sc = totals.get("total_serper_cost_usd") or 0.0
        tc = totals.get("total_api_cost_usd") or 0.0
        sess.total_openai_cost_usd += float(oc)
        sess.total_fish_cost_usd += float(fc)
        sess.total_serper_cost_usd += float(sc)
        sess.total_api_cost_usd += float(tc)
        rt_key = req.request_type or "unknown"
        sess.cost_by_request_type[rt_key] = (
            sess.cost_by_request_type.get(rt_key, 0.0) + float(tc)
        )
        for prov, prov_cost in (totals.get("cost_by_provider") or {}).items():
            if isinstance(prov_cost, (int, float)):
                sess.cost_by_provider[prov] = (
                    sess.cost_by_provider.get(prov, 0.0) + float(prov_cost)
                )
        # Credit rollup.
        action_key = req.credit_action or "local_command"
        credits = int(req.credits_used or 0)
        sess.total_credits_used += credits
        sess.credits_by_action[action_key] = (
            int(sess.credits_by_action.get(action_key, 0)) + credits
        )
        candidate = {
            "request_id": req.request_id,
            "mode": req.mode,
            "request_type": req.request_type,
            "total_api_cost_usd": float(tc),
            "timestamp": req.completed_at_iso,
        }
        if sess.highest_cost_request is None or float(tc) > float(
            sess.highest_cost_request.get("total_api_cost_usd") or 0.0
        ):
            sess.highest_cost_request = candidate


# --------------------------------------------------------------------------- #
# Provider event helpers.
# --------------------------------------------------------------------------- #
# De-dupe orphan warnings so a hot path can't spam stdout. Keyed by
# (provider, identifier) to make it easy to spot which call site is orphaned.
_orphan_warn_emitted: set[str] = set()


def _attach_request_fields(row: dict[str, Any]) -> None:
    st = _current_request.get()
    if st is None:
        row["session_id"] = None
        row["request_id"] = None
        row["scenario_name"] = None
        try:
            prov = str(row.get("provider") or "unknown")
            ident = str(
                row.get("model")
                or row.get("endpoint")
                or row.get("voice")
                or "?"
            )
            key = f"{prov}:{ident}"
            if key not in _orphan_warn_emitted:
                _orphan_warn_emitted.add(key)
                print(
                    f"[cost_logger][WARN] orphan provider event — no request context. "
                    f"provider={prov} ident={ident}. "
                    "Wrap the caller in cost_logging.request_context(...) or "
                    "ensure the HTTP middleware covers the route that triggered this call."
                )
        except Exception:
            pass
        return
    row["session_id"] = st.session_id
    row["request_id"] = st.request_id
    row["scenario_name"] = st.scenario_name
    st.events.append(row)


def _coerce_int(v: Any) -> int:
    try:
        if v is None:
            return 0
        return int(v)
    except Exception:
        return 0


def _safe_raw(o: Any) -> Any:
    try:
        return json.loads(json.dumps(o, default=_json_default))
    except Exception:
        return _json_default(o)


def log_openai_event(
    *,
    model: str | None,
    endpoint: str = "chat.completions.create",
    usage: Any = None,
    raw_usage: Any = None,
    call_type: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Record one OpenAI API call.

    ``usage`` can be a pydantic ``CompletionUsage`` object or a plain dict with
    at least ``prompt_tokens`` and ``completion_tokens``. Cached and reasoning
    tokens are pulled from common nested keys when present.
    """
    try:
        usage_dict: dict[str, Any] = {}
        if usage is not None:
            usage_dict = _safe_raw(usage) or {}
        if raw_usage is None and usage is not None:
            raw_usage = usage_dict
        prompt_tokens = _coerce_int(usage_dict.get("prompt_tokens"))
        completion_tokens = _coerce_int(usage_dict.get("completion_tokens"))
        total_tokens = _coerce_int(usage_dict.get("total_tokens"))
        details_prompt = usage_dict.get("prompt_tokens_details") or {}
        details_completion = usage_dict.get("completion_tokens_details") or {}
        if not isinstance(details_prompt, dict):
            details_prompt = {}
        if not isinstance(details_completion, dict):
            details_completion = {}
        cached_input = _coerce_int(
            details_prompt.get("cached_tokens")
            or usage_dict.get("cached_tokens")
            or usage_dict.get("input_cached_tokens")
        )
        reasoning = _coerce_int(
            details_completion.get("reasoning_tokens")
            or usage_dict.get("reasoning_tokens")
        )

        billable_input = max(0, prompt_tokens - cached_input)
        price = get_openai_price(model)
        estimated_cost = _calc_openai_cost(
            input_tokens=billable_input,
            cached_input_tokens=cached_input,
            output_tokens=completion_tokens,
            reasoning_tokens=reasoning,
            price=price,
        )

        row: dict[str, Any] = {
            "timestamp": _now_iso(),
            "provider": "openai",
            "model": model or "unknown",
            "endpoint": endpoint,
            "call_type": call_type or endpoint,
            "input_tokens": prompt_tokens,
            "billable_input_tokens": billable_input,
            "cached_input_tokens": cached_input,
            "output_tokens": completion_tokens,
            "reasoning_tokens": reasoning,
            "total_tokens": total_tokens or (prompt_tokens + completion_tokens),
            "estimated_cost_usd": estimated_cost,
            "price_applied": price or None,
            "raw_usage_json": _safe_raw(raw_usage) if raw_usage is not None else None,
            "extra": extra or None,
        }
        _attach_request_fields(row)
        _append_jsonl(COST_EVENTS_FILE, row)
        return row
    except Exception as e:
        print(f"[cost_logger] log_openai_event swallowed error: {e}")
        return {}


def _calc_openai_cost(
    *,
    input_tokens: int,
    cached_input_tokens: int,
    output_tokens: int,
    reasoning_tokens: int,
    price: dict[str, float | None],
) -> float | None:
    if not price:
        return None
    inp = price.get("input_per_1m_tokens")
    cached = price.get("cached_input_per_1m_tokens")
    out = price.get("output_per_1m_tokens")
    reason = price.get("reasoning_per_1m_tokens")
    # If we have NO usable price at all, we cannot estimate.
    if all(v is None for v in (inp, cached, out, reason)):
        return None
    cost = 0.0
    used = False
    if inp is not None and input_tokens:
        cost += (input_tokens / 1_000_000.0) * float(inp)
        used = True
    if cached is not None and cached_input_tokens:
        cost += (cached_input_tokens / 1_000_000.0) * float(cached)
        used = True
    elif cached is None and inp is not None and cached_input_tokens:
        # No discounted cached price set — bill cached at the full input rate.
        cost += (cached_input_tokens / 1_000_000.0) * float(inp)
        used = True
    if out is not None and output_tokens:
        cost += (output_tokens / 1_000_000.0) * float(out)
        used = True
    if reason is not None and reasoning_tokens:
        cost += (reasoning_tokens / 1_000_000.0) * float(reason)
        used = True
    elif reason is None and out is not None and reasoning_tokens:
        # No separate reasoning rate set — bill at the output rate.
        cost += (reasoning_tokens / 1_000_000.0) * float(out)
        used = True
    return round(cost, 8) if used else None


def log_fish_event(
    *,
    text: str | None = None,
    text_characters: int | None = None,
    utf8_bytes: int | None = None,
    model_name: str | None = None,
    voice: str | None = None,
    mode: str | None = None,
    request_id: str | None = None,
    turn_id: str | None = None,
    success: bool = True,
    error_message: str | None = None,
    raw_response: Any = None,
    extra: dict[str, Any] | None = None,
    # Legacy kwargs kept for back-compat; ignored for cost — Fish Audio API
    # billing is strictly UTF-8 bytes, not "web credits" / "per-1k chars".
    credits_used: int | float | None = None,
) -> dict[str, Any]:
    """Record a single Fish Audio TTS call.

    Cost is computed from UTF-8 byte length of the text actually sent to
    Fish Audio:

        utf8_bytes = len(text.encode("utf-8"))
        estimated_cost_usd = utf8_bytes * cost_per_utf8_byte

    The legacy ``credits_used`` argument is accepted but ignored, since the
    HTTP API does not bill in web-playground credits. Old pricing keys
    (``cost_per_fish_credit`` / ``cost_per_1000_credits`` /
    ``cost_per_1000_characters_fallback``) are no longer consulted.
    """
    try:
        resolved_model = (model_name or voice or "default").strip() or "default"
        # Always prefer real UTF-8 byte length over character count. Fall back
        # to encoding ``text`` if the caller did not pre-compute bytes.
        if utf8_bytes is None and text is not None:
            try:
                utf8_bytes = len(text.encode("utf-8"))
            except Exception:
                utf8_bytes = None
        if text_characters is None and text is not None:
            text_characters = len(text)

        price = get_fish_price(resolved_model)
        cost_per_byte = price.get("cost_per_utf8_byte")
        estimated_cost: float | None = None
        if utf8_bytes is not None and cost_per_byte is not None:
            try:
                estimated_cost = round(int(utf8_bytes) * float(cost_per_byte), 8)
            except Exception:
                estimated_cost = None

        billing_unit = price.get("billing_unit") or "utf8_byte"

        row: dict[str, Any] = {
            "timestamp": _now_iso(),
            "provider": "fish_audio",
            "model_name": resolved_model,
            "billing_unit": billing_unit,
            "text_character_count": int(text_characters or 0),
            "utf8_bytes": int(utf8_bytes) if isinstance(utf8_bytes, (int, float)) else None,
            "cost_per_utf8_byte": cost_per_byte,
            "estimated_cost_usd": estimated_cost,
            "success": bool(success),
            "error_message": (str(error_message)[:300] if error_message else None),
            "mode": (mode or None),
            "request_id": (request_id or None),
            "turn_id": (turn_id or None),
            "price_applied": price or None,
            "raw_response_usage_json": _safe_raw(raw_response) if raw_response is not None else None,
            "extra": extra or None,
        }
        # Surface structured debug for ops parity with other capability logs.
        # Kept best-effort so logging never fails the TTS request.
        try:
            print(
                "[FISH_AUDIO_COST_DEBUG]",
                json.dumps(
                    {
                        "model_name": row["model_name"],
                        "billing_unit": row["billing_unit"],
                        "text_character_count": row["text_character_count"],
                        "utf8_bytes": row["utf8_bytes"],
                        "cost_per_utf8_byte": row["cost_per_utf8_byte"],
                        "estimated_cost_usd": row["estimated_cost_usd"],
                        "request_id": row["request_id"],
                        "turn_id": row["turn_id"],
                        "success": row["success"],
                    },
                    default=str,
                ),
                flush=True,
            )
        except Exception:
            pass
        _attach_request_fields(row)
        _append_jsonl(COST_EVENTS_FILE, row)
        return row
    except Exception as e:
        print(f"[cost_logger] log_fish_event swallowed error: {e}")
        return {}


def log_serper_event(
    *,
    endpoint: str | None = None,
    query: str | None = None,
    query_count: int = 1,
    raw_response: Any = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        price = get_serper_price(endpoint)
        per_call = price.get("cost_per_search_call")
        qc = max(0, int(query_count or 0))
        estimated_cost = round(qc * float(per_call), 8) if per_call is not None else None
        row: dict[str, Any] = {
            "timestamp": _now_iso(),
            "provider": "serper",
            "endpoint": endpoint or "serper.search",
            "query_count": qc,
            "query_preview": (str(query)[:140] if query else None),
            "cost_per_query": per_call,
            "estimated_cost_usd": estimated_cost,
            "price_applied": price or None,
            "raw_response_meta_json": _safe_raw(raw_response) if raw_response is not None else None,
            "extra": extra or None,
        }
        _attach_request_fields(row)
        _append_jsonl(COST_EVENTS_FILE, row)
        return row
    except Exception as e:
        print(f"[cost_logger] log_serper_event swallowed error: {e}")
        return {}


def log_openweather_event(
    *,
    endpoint: str,
    call_count: int = 1,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        qc = max(0, int(call_count or 0))
        row: dict[str, Any] = {
            "timestamp": _now_iso(),
            "provider": "openweather",
            "endpoint": endpoint,
            "call_count": qc,
            "estimated_cost_usd": None,
            "extra": extra or None,
        }
        _attach_request_fields(row)
        _append_jsonl(COST_EVENTS_FILE, row)
        return row
    except Exception as e:
        print(f"[cost_logger] log_openweather_event swallowed error: {e}")
        return {}
