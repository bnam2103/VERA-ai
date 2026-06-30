"""Shared Serper HTTP call logging for cost + credit rollup."""

from __future__ import annotations

from typing import Any


def log_serper_http_call(
    *,
    endpoint: str,
    query: str | None,
    payload: dict[str, Any] | None = None,
    cache_hit: bool = False,
    extra: dict[str, Any] | None = None,
) -> None:
    if cache_hit:
        return
    try:
        from cost_logging import log_serper_event

        log_serper_event(
            endpoint=endpoint,
            query=query,
            query_count=1,
            raw_response={
                "search_metadata": (payload or {}).get("searchParameters"),
                "credits": (payload or {}).get("credits"),
            },
            extra=extra,
        )
    except Exception as exc:
        print(f"[cost_logger] serper log skipped: {exc}")
