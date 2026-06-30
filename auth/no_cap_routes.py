"""Dev-only no-cap testing toggle (session-scoped, env-gated).

Requires VERA_ENABLE_NO_CAP_TOGGLE=true. Returns 404 when disabled so the
endpoint is not discoverable on production deployments.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from fastapi import APIRouter, HTTPException, Query

from cost_logging.no_cap_testing import (
    is_no_cap_active,
    no_cap_toggle_enabled,
    set_no_cap_active,
)

router = APIRouter(tags=["dev-no-cap"])


class NoCapSetBody(BaseModel):
    session_id: str = Field(..., min_length=1, max_length=256)
    active: bool


@router.get("/api/dev/no-cap/status")
def api_no_cap_status(
    session_id: str = Query(..., min_length=1, max_length=256),
) -> dict:
    if not no_cap_toggle_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    sid = session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id is required.")
    return {"enabled": True, "active": is_no_cap_active(sid)}


@router.post("/api/dev/no-cap/set")
def api_no_cap_set(body: NoCapSetBody) -> dict:
    if not no_cap_toggle_enabled():
        raise HTTPException(status_code=404, detail="Not found")
    sid = body.session_id.strip()
    if not sid:
        raise HTTPException(status_code=400, detail="session_id is required.")
    set_no_cap_active(sid, bool(body.active))
    return {"ok": True, "enabled": True, "active": is_no_cap_active(sid)}
