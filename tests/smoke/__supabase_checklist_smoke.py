"""Smoke tests: Supabase checklist API + merge policy."""

from __future__ import annotations

import io
import os
import sys
from unittest.mock import patch

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth.checklist_merge import merge_checklist_items, normalize_checklist_text, _normalize_row
from auth.checklist_routes import router as checklist_router
from auth.jwt_auth import AuthUser

passed = 0
failed = 0

USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


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


section("normalize_checklist_text")
ok(normalize_checklist_text("  Buy   Milk  ") == "buy milk", "trim + lowercase + collapse spaces")

section("merge_checklist_items")
local = [{"id": "a1", "text": "Buy milk", "done": False}]
remote = [{"id": "b1", "text": "buy  milk", "done": True}]
merged = merge_checklist_items(local, remote)
ok(len(merged) == 1, "duplicate normalized text deduped")
ok(merged[0].get("done") is True, "completed=true wins on duplicate")
ok(merged[0].get("text") == "Buy milk", "local text preserved when non-empty")

local2 = [{"id": "x", "text": "Eggs", "done": False}]
remote2 = [{"id": "y", "text": "Bread", "done": True}]
merged2 = merge_checklist_items(local2, remote2)
ok(len(merged2) == 2, "distinct items both kept")
ok(merged2[0].get("text") == "Eggs", "local order preserved first")
ok(merged2[1].get("text") == "Bread", "remote-only appended")

section("strip_checklist_placeholder_items")
from auth.checklist_merge import strip_checklist_placeholder_items

stripped, removed = strip_checklist_placeholder_items(
    [
        {"id": "a", "text": "A", "done": False},
        {"id": "p", "text": "", "done": False},
        {"id": "q", "text": "List item", "done": False},
    ]
)
ok(removed == 2, "strip removes empty and placeholder label")
ok(len(stripped) == 1 and stripped[0].get("text") == "A", "strip keeps real item")

section("merge ignores placeholder rows")
from auth.checklist_merge import _normalize_row

ok(_normalize_row({"id": "1", "text": "", "done": False}) is None, "empty row dropped")
ok(_normalize_row({"id": "2", "text": "List item", "done": False}) is None, "placeholder label dropped")
ok(_normalize_row({"id": "3", "text": "A", "done": False}) is not None, "real item kept")
merged_ph = merge_checklist_items(
    [{"id": "a", "text": "A", "done": False}, {"id": "p1", "text": "", "done": False}],
    [{"id": "b", "text": "C", "done": False}, {"id": "p2", "text": "list item", "done": False}],
)
ok(len(merged_ph) == 2, "merge excludes placeholder rows")
ok({x.get("text") for x in merged_ph} == {"A", "C"}, "merge keeps only real items")

section("GET /api/checklist auth gate")
app = FastAPI()
app.include_router(checklist_router)
client = TestClient(app)
with patch("auth.checklist_routes.get_supabase_config") as mock_cfg:
    mock_cfg.return_value.db_configured = True
    anon = client.get("/api/checklist")
ok(anon.status_code == 401, "anonymous GET => 401")

section("merge endpoint + user isolation (mocked db)")
store: dict[str, list[dict]] = {}
meta_store: dict[str, dict] = {}


def _fake_load(config, user_id):
    return [dict(x) for x in store.get(user_id, [])], meta_store.get(user_id, {}).get("completed_collapsed")


def _fake_replace(config, user_id, items, *, completed_collapsed=None):
    store[user_id] = [dict(x) for x in items]
    if completed_collapsed is not None:
        meta_store.setdefault(user_id, {})["completed_collapsed"] = completed_collapsed
    return len(items)


with patch("auth.checklist_routes.get_supabase_config") as mock_cfg, patch(
    "auth.checklist_routes.require_auth_user"
) as mock_user, patch("auth.checklist_routes.load_checklist_bundle", side_effect=_fake_load), patch(
    "auth.checklist_routes.replace_checklist_for_user", side_effect=_fake_replace
):
    mock_cfg.return_value.db_configured = True

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    r1 = client.post(
        "/api/checklist/merge",
        json={"items": [{"id": "l1", "text": "Task A", "done": False}], "completed_collapsed": False},
    )
    ok(r1.status_code == 200 and len(r1.json().get("items", [])) == 1, "local-only merge seeds remote")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    r2 = client.post(
        "/api/checklist/merge",
        json={
            "items": [{"id": "l2", "text": "task a", "done": False}],
            "completed_collapsed": True,
        },
    )
    body2 = r2.json()
    ok(r2.status_code == 200 and len(body2.get("items", [])) == 1, "refresh merge does not duplicate")
    ok(body2.get("items", [{}])[0].get("done") is False, "local incomplete does not uncomplete remote")

    store[USER_A] = [{"id": "r1", "text": "Remote only", "done": True}]
    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    r3 = client.post(
        "/api/checklist/merge",
        json={"items": [{"id": "l3", "text": "Local only", "done": False}], "completed_collapsed": False},
    )
    body3 = r3.json()
    ok(len(body3.get("items", [])) == 2, "local + remote distinct items merged")

    mock_user.return_value = AuthUser(user_id=USER_B, email="b@example.com")
    r4 = client.get("/api/checklist")
    ok(r4.status_code == 200 and r4.json().get("empty") is True, "user B does not see user A checklist")

section("PUT /api/checklist")
with patch("auth.checklist_routes.get_supabase_config") as mock_cfg, patch(
    "auth.checklist_routes.require_auth_user"
) as mock_user, patch("auth.checklist_routes.replace_checklist_for_user", side_effect=_fake_replace):
    mock_cfg.return_value.db_configured = True
    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    put = client.put(
        "/api/checklist",
        json={"items": [{"id": "p1", "text": "Persist me", "done": True}], "completed_collapsed": True},
    )
    ok(put.status_code == 200 and put.json().get("items_count") == 1, "PUT saves checklist")

print(f"\n{'=' * 40}")
print(f"Passed: {passed}  Failed: {failed}")
if failed:
    sys.exit(1)
