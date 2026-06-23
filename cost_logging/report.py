"""Cost report CLI.

Usage::

    py -m cost_logging.report                   # full report
    py -m cost_logging.report --json            # raw JSON instead of tables
    py -m cost_logging.report --session SID     # focus on one session
    py -m cost_logging.report --since 2026-05-20
    py -m cost_logging.report --logs path/to/logs

The report aggregates ``request_cost_summary.jsonl`` (per-request rolled up
costs) and ``cost_events.jsonl`` (per-provider events). It rebuilds session
totals on the fly so you don't need to have called ``end_session`` first.

All costs are API-only (OpenAI + Fish/BMO + Serper). RunPod / server hosting
cost is NOT included.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

try:
    from .logger import (
        COST_EVENTS_FILE,
        LOG_DIR,
        REQUEST_SUMMARY_FILE,
        SESSION_SUMMARY_FILE,
    )
except Exception:  # pragma: no cover - allow running outside package
    LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
    COST_EVENTS_FILE = LOG_DIR / "cost_events.jsonl"
    REQUEST_SUMMARY_FILE = LOG_DIR / "request_cost_summary.jsonl"
    SESSION_SUMMARY_FILE = LOG_DIR / "session_cost_summary.jsonl"


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    if not path.is_file():
        return
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def _passes_since(ts: str | None, since_iso: str | None) -> bool:
    if not since_iso:
        return True
    if not ts:
        return False
    return str(ts) >= since_iso


def _passes_session(row: dict[str, Any], session: str | None) -> bool:
    if not session:
        return True
    return str(row.get("session_id") or "") == session


def _fmt_cost(v: Any) -> str:
    if v is None:
        return "—"
    try:
        return f"${float(v):.6f}"
    except Exception:
        return str(v)


def build_report(
    *,
    logs_dir: Path | None = None,
    session: str | None = None,
    since_iso: str | None = None,
) -> dict[str, Any]:
    base = Path(logs_dir).resolve() if logs_dir else LOG_DIR
    req_path = base / "request_cost_summary.jsonl"
    evt_path = base / "cost_events.jsonl"
    sess_path = base / "session_cost_summary.jsonl"

    requests_total = 0
    cost_by_provider: dict[str, float] = defaultdict(float)
    cost_by_request_type: dict[str, float] = defaultdict(float)
    count_by_request_type: dict[str, int] = defaultdict(int)
    credits_by_action: dict[str, int] = defaultdict(int)
    count_by_action: dict[str, int] = defaultdict(int)
    total_credits = 0
    sessions: dict[str, dict[str, Any]] = {}
    highest_request: dict[str, Any] | None = None
    grand_total = 0.0

    for row in _iter_jsonl(req_path):
        if not _passes_since(row.get("timestamp"), since_iso):
            continue
        if not _passes_session(row, session):
            continue
        requests_total += 1
        tc = row.get("total_api_cost_usd") or 0.0
        try:
            tc = float(tc)
        except Exception:
            tc = 0.0
        grand_total += tc
        rt = row.get("request_type") or "unknown"
        cost_by_request_type[rt] += tc
        count_by_request_type[rt] += 1
        for prov, prov_cost in (row.get("cost_by_provider") or {}).items():
            if isinstance(prov_cost, (int, float)):
                cost_by_provider[prov] += float(prov_cost)
        try:
            row_credits = int(row.get("credits_used") or 0)
        except Exception:
            row_credits = 0
        row_action = str(row.get("credit_action") or "local_command")
        total_credits += row_credits
        credits_by_action[row_action] += row_credits
        count_by_action[row_action] += 1
        sid = row.get("session_id") or "anonymous"
        sess = sessions.setdefault(
            sid,
            {
                "session_id": sid,
                "scenario_name": row.get("scenario_name"),
                "requests": 0,
                "total_openai_cost_usd": 0.0,
                "total_fish_cost_usd": 0.0,
                "total_serper_cost_usd": 0.0,
                "total_api_cost_usd": 0.0,
                "cost_by_request_type": defaultdict(float),
                "cost_by_provider": defaultdict(float),
                "total_credits_used": 0,
                "credits_by_action": defaultdict(int),
                "highest_cost_request": None,
                "first_seen": row.get("started_at") or row.get("timestamp"),
                "last_seen": row.get("completed_at") or row.get("timestamp"),
            },
        )
        if row.get("scenario_name") and not sess["scenario_name"]:
            sess["scenario_name"] = row["scenario_name"]
        sess["requests"] += 1
        sess["total_openai_cost_usd"] += float(row.get("total_openai_cost_usd") or 0.0)
        sess["total_fish_cost_usd"] += float(row.get("total_fish_cost_usd") or 0.0)
        sess["total_serper_cost_usd"] += float(row.get("total_serper_cost_usd") or 0.0)
        sess["total_api_cost_usd"] += tc
        sess["cost_by_request_type"][rt] += tc
        sess["total_credits_used"] += row_credits
        sess["credits_by_action"][row_action] += row_credits
        for prov, prov_cost in (row.get("cost_by_provider") or {}).items():
            if isinstance(prov_cost, (int, float)):
                sess["cost_by_provider"][prov] += float(prov_cost)
        if sess["last_seen"] is None or (row.get("completed_at") or "") > (sess["last_seen"] or ""):
            sess["last_seen"] = row.get("completed_at") or row.get("timestamp")
        if highest_request is None or tc > float(highest_request.get("total_api_cost_usd") or 0.0):
            highest_request = {
                "session_id": sid,
                "request_id": row.get("request_id"),
                "request_type": rt,
                "mode": row.get("mode"),
                "total_api_cost_usd": tc,
                "credit_action": row_action,
                "credits_used": row_credits,
                "timestamp": row.get("timestamp"),
            }
        if sess["highest_cost_request"] is None or tc > float(
            (sess["highest_cost_request"] or {}).get("total_api_cost_usd") or 0.0
        ):
            sess["highest_cost_request"] = {
                "request_id": row.get("request_id"),
                "request_type": rt,
                "mode": row.get("mode"),
                "total_api_cost_usd": tc,
                "credit_action": row_action,
                "credits_used": row_credits,
                "timestamp": row.get("timestamp"),
            }

    events_seen = 0
    for _ in _iter_jsonl(evt_path):
        events_seen += 1

    completed_sessions = list(_iter_jsonl(sess_path))

    # Convert defaultdicts to plain dicts for JSON output.
    for sess in sessions.values():
        sess["cost_by_request_type"] = {k: round(v, 8) for k, v in sess["cost_by_request_type"].items()}
        sess["cost_by_provider"] = {k: round(v, 8) for k, v in sess["cost_by_provider"].items()}
        sess["credits_by_action"] = {k: int(v) for k, v in sess["credits_by_action"].items()}
        sess["average_cost_per_request"] = (
            round(sess["total_api_cost_usd"] / sess["requests"], 8) if sess["requests"] else None
        )
        sess["average_credits_per_request"] = (
            round(sess["total_credits_used"] / sess["requests"], 4)
            if sess["requests"]
            else None
        )

    avg_per_request_overall = (
        round(grand_total / requests_total, 8) if requests_total else None
    )
    avg_per_session = (
        round(grand_total / len(sessions), 8) if sessions else None
    )

    return {
        "log_dir": str(base),
        "requests_total": requests_total,
        "events_total": events_seen,
        "sessions_open_or_implicit": len(sessions),
        "sessions_explicitly_ended": len(completed_sessions),
        "total_api_cost_usd": round(grand_total, 8),
        "average_cost_per_request": avg_per_request_overall,
        "average_cost_per_session": avg_per_session,
        "cost_by_provider": {k: round(v, 8) for k, v in cost_by_provider.items()},
        "cost_by_request_type": {k: round(v, 8) for k, v in cost_by_request_type.items()},
        "average_cost_by_request_type": {
            k: round(cost_by_request_type[k] / count_by_request_type[k], 8)
            for k in cost_by_request_type
        },
        "total_credits_used": int(total_credits),
        "credits_by_action": {k: int(v) for k, v in credits_by_action.items()},
        "count_by_action": {k: int(v) for k, v in count_by_action.items()},
        "average_credits_per_request": (
            round(total_credits / requests_total, 4) if requests_total else None
        ),
        "highest_cost_request": highest_request,
        "sessions": sessions,
        "note": "API-only cost (OpenAI + Fish/BMO + Serper). Hosting/server cost excluded.",
    }


def _print_table(title: str, rows: list[tuple[str, Any]]) -> None:
    print(f"\n{title}")
    print("-" * max(8, len(title)))
    if not rows:
        print("  (no data)")
        return
    width = max(len(str(r[0])) for r in rows)
    for k, v in rows:
        print(f"  {str(k).ljust(width)}  {v}")


def _print_human(report: dict[str, Any]) -> None:
    print("=" * 64)
    print("VERA cost report (API-only, hosting excluded)")
    print(f"log_dir = {report['log_dir']}")
    print(
        f"requests={report['requests_total']}  events={report['events_total']}  "
        f"sessions_seen={report['sessions_open_or_implicit']}  "
        f"sessions_ended={report['sessions_explicitly_ended']}"
    )
    print(
        f"TOTAL  {_fmt_cost(report['total_api_cost_usd'])}   "
        f"avg/request  {_fmt_cost(report['average_cost_per_request'])}   "
        f"avg/session  {_fmt_cost(report['average_cost_per_session'])}"
    )
    print(
        f"CREDITS  total={report.get('total_credits_used', 0)}   "
        f"avg/request={report.get('average_credits_per_request') or 0}"
    )
    _print_table(
        "Cost by provider",
        sorted(
            ((k, _fmt_cost(v)) for k, v in report["cost_by_provider"].items()),
            key=lambda r: r[0],
        ),
    )
    _print_table(
        "Cost by request_type (totals)",
        sorted(
            ((k, _fmt_cost(v)) for k, v in report["cost_by_request_type"].items()),
            key=lambda r: r[0],
        ),
    )
    _print_table(
        "Average cost per request_type",
        sorted(
            (
                (k, _fmt_cost(v))
                for k, v in report["average_cost_by_request_type"].items()
            ),
            key=lambda r: r[0],
        ),
    )
    credits_rows = []
    for action, credits in sorted(
        (report.get("credits_by_action") or {}).items(),
        key=lambda kv: (-int(kv[1]), kv[0]),
    ):
        count = (report.get("count_by_action") or {}).get(action, 0)
        credits_rows.append((action, f"{int(credits):>5}   ({count} req)"))
    _print_table("Credits by action", credits_rows)
    h = report.get("highest_cost_request")
    if h:
        print("\nHighest-cost request")
        print("-" * 22)
        print(
            f"  session={h.get('session_id')}  request_id={h.get('request_id')}"
        )
        print(
            f"  type={h.get('request_type')}  mode={h.get('mode')}  "
            f"cost={_fmt_cost(h.get('total_api_cost_usd'))}  at={h.get('timestamp')}"
        )
    print("\nPer-session breakdown")
    print("-" * 22)
    if not report["sessions"]:
        print("  (no sessions yet)")
    for sid, sess in sorted(
        report["sessions"].items(), key=lambda kv: -float(kv[1]["total_api_cost_usd"])
    ):
        print(
            f"  {sid}  scenario={sess['scenario_name'] or '-'}  "
            f"requests={sess['requests']}  "
            f"total={_fmt_cost(sess['total_api_cost_usd'])}  "
            f"avg/req={_fmt_cost(sess['average_cost_per_request'])}  "
            f"credits={sess.get('total_credits_used', 0)}"
        )
        for prov, c in sess["cost_by_provider"].items():
            print(f"      provider {prov:<12} {_fmt_cost(c)}")
        for action, credits in sorted(
            (sess.get("credits_by_action") or {}).items(),
            key=lambda kv: (-int(kv[1]), kv[0]),
        ):
            print(f"      credits  {action:<28} {int(credits):>5}")
    print()
    print(report["note"])


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--json", action="store_true", help="Emit raw JSON.")
    p.add_argument("--session", help="Filter to one session_id.")
    p.add_argument(
        "--since",
        help="ISO timestamp (e.g. 2026-05-20T00:00:00Z) — drop earlier rows.",
    )
    p.add_argument(
        "--logs",
        help="Path to logs directory (default: cost_logging default).",
    )
    args = p.parse_args(argv)

    report = build_report(
        logs_dir=Path(args.logs) if args.logs else None,
        session=args.session,
        since_iso=args.since,
    )
    if args.json:
        json.dump(report, sys.stdout, indent=2, default=str)
        sys.stdout.write("\n")
    else:
        _print_human(report)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
