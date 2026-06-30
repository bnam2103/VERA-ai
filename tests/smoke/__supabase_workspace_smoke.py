"""Smoke tests: Supabase Work Mode workspace API + sanitization."""

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

from auth.jwt_auth import AuthUser
from auth.workspace_db import (
    WORKSPACE_MAX_MESSAGES,
    WORKSPACE_MAX_MESSAGES_JSON_CHARS,
    WORKSPACE_MAX_REGISTRY_JSON_CHARS,
    WORKSPACE_MAX_RENDERED_HTML_CHARS,
    WORKSPACE_MAX_SUMMARY_CHARS,
    WORKSPACE_MAX_TABS,
    WORKSPACE_TAB_SUPABASE_KEYS,
    WorkspacePayloadError,
    _assert_uniform_tab_row_keys,
    _sanitize_messages,
    _sanitize_registry,
    _sanitize_tab_row,
    _tab_row_for_supabase,
    normalize_workspace_put_payload,
)
from auth.workspace_routes import WORKSPACE_API_VERSION, router as workspace_router

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


section("migration constants / caps")
ok(WORKSPACE_MAX_TABS == 8, "max tabs is 8")
ok(WORKSPACE_MAX_SUMMARY_CHARS == 4000, "summary cap 4000")
ok(WORKSPACE_MAX_RENDERED_HTML_CHARS == 120_000, "rendered_html cap 120k")
ok(WORKSPACE_MAX_MESSAGES == 30, "messages count cap 30")
ok(WORKSPACE_MAX_MESSAGES_JSON_CHARS == 50_000, "messages json cap 50k")
ok(WORKSPACE_MAX_REGISTRY_JSON_CHARS == 32_000, "registry json cap 32k")

section("sanitize registry whitelist + cap")
big = "x" * 20_000
reg = _sanitize_registry(
    {
        "lane_id": "lane-1",
        "last_user_request": "hello",
        "main_context_excerpt": big,
        "latest_visible_markdown": big,
        "secret_key": "drop-me",
    }
)
ok("secret_key" not in reg, "unknown registry keys dropped")
ok(len(reg.get("lane_id", "")) <= 80, "lane_id kept")
raw_len = len(__import__("json").dumps(reg))
ok(raw_len <= WORKSPACE_MAX_REGISTRY_JSON_CHARS, "registry json capped")

section("sanitize messages count + chars")
msgs = [{"role": "assistant", "text": "a" * 9000} for _ in range(40)]
sanitized = _sanitize_messages(msgs)
ok(len(sanitized) <= WORKSPACE_MAX_MESSAGES, "messages count capped")
ok(all(len(m.get("text", "")) <= 8000 for m in sanitized), "per-message text capped")

section("sanitize tab row closed clears rendered_html")
row = _sanitize_tab_row(
    USER_A,
    {
        "lane_id": "lane-1",
        "title": "Topic",
        "closed": True,
        "rendered_html": "<p>gone</p>",
        "registry": {"last_user_request": "q"},
    },
    sort_order=0,
)
ok(row is not None and row.get("closed") is True, "closed tab kept")
ok(not row.get("rendered_html"), "closed tab drops rendered_html")

section("sanitize tab row summary + html caps")
row2 = _sanitize_tab_row(
    USER_A,
    {
        "lane_id": "lane-2",
        "title": "T",
        "summary": "s" * 5000,
        "rendered_html": "h" * 130_000,
        "registry": {},
        "messages": [],
    },
    sort_order=1,
)
ok(len(row2.get("summary") or "") <= WORKSPACE_MAX_SUMMARY_CHARS, "summary truncated")
ok(len(row2.get("rendered_html") or "") <= WORKSPACE_MAX_RENDERED_HTML_CHARS, "html truncated")

section("normalize_workspace_put_payload")
norm = normalize_workspace_put_payload(
    {
        "client_revision": 1,
        "active_lane_id": "lane-a",
        "tabs": [
            {"lane_id": "lane-a", "sort_order": 0, "rendered_html": "h" * 130_000},
            {"lane_id": "", "sort_order": 1},
            {"lane_id": "lane-b", "sort_order": 2, "title": "B", "is_active": True},
        ],
    }
)
ok(len(norm["tabs"]) == 2, "empty lane_id tab skipped")
ok(len(norm["tabs"][0]["rendered_html"] or "") == WORKSPACE_MAX_RENDERED_HTML_CHARS, "normalize truncates html")
ok(norm["active_lane_id"] == "lane-a", "active_lane_id kept when valid")

norm3 = normalize_workspace_put_payload(
    {
        "client_revision": 5,
        "active_lane_id": "missing-lane",
        "tabs": [
            {"lane_id": "lane-1", "sort_order": 0, "title": "One"},
            {"lane_id": "lane-2", "sort_order": 1, "title": "Two", "is_active": True},
            {"lane_id": "lane-3", "sort_order": 2, "title": "Three"},
        ],
    }
)
ok(len(norm3["tabs"]) == 3, "three-tab snapshot accepted")
ok(norm3["active_lane_id"] == "lane-2", "invalid active_lane_id falls back to is_active tab")

over_norm = normalize_workspace_put_payload(
    {"client_revision": 1, "tabs": [{"lane_id": f"l{i}"} for i in range(WORKSPACE_MAX_TABS + 1)]}
)
ok(len(over_norm["tabs"]) == WORKSPACE_MAX_TABS, "too many tabs truncated not rejected")

section("tab row omits invalid client updated_at")
row_ts = _tab_row_for_supabase(
    USER_A,
    {
        "lane_id": "lane-a",
        "sort_order": 0,
        "title": "T",
        "updated_at": 1782372913557,
        "last_opened_at": "not-a-timestamp",
    },
    sort_order=0,
)
ok(row_ts is not None, "tab row built")
ok("updated_at" not in row_ts, "client numeric updated_at not sent to Supabase")
ok(row_ts.get("last_opened_at") is None, "invalid last_opened_at stored as null")

section("supabase tab rows uniform keys (PGRST102)")
mixed_rows = [
    _tab_row_for_supabase(
        USER_A,
        {
            "lane_id": "lane-open",
            "sort_order": 0,
            "title": "Open",
            "is_active": True,
            "closed": False,
            "rendered_html": "<p>content</p>",
            "messages": [{"role": "assistant", "text": "hi"}],
            "registry": {"last_user_request": "q"},
            "last_opened_at": "2026-06-21T12:00:00.000Z",
        },
        sort_order=0,
    ),
    _tab_row_for_supabase(
        USER_A,
        {
            "lane_id": "lane-closed-1",
            "sort_order": 1,
            "title": "Closed 1",
            "closed": True,
            "registry": {},
        },
        sort_order=1,
    ),
    _tab_row_for_supabase(
        USER_A,
        {
            "lane_id": "lane-closed-2",
            "sort_order": 2,
            "title": "Closed 2",
            "closed": True,
        },
        sort_order=2,
    ),
]
ok(len(mixed_rows) == 3, "built 3 mixed tab rows")
key_sets = {frozenset(r.keys()) for r in mixed_rows if r}
ok(len(key_sets) == 1, "all mixed rows share identical key sets")
ok(key_sets.pop() == frozenset(WORKSPACE_TAB_SUPABASE_KEYS), "keys match WORKSPACE_TAB_SUPABASE_KEYS")
try:
    _assert_uniform_tab_row_keys(mixed_rows)
    ok(True, "uniform key assertion passes for mixed rows")
except Exception:
    ok(False, "uniform key assertion passes for mixed rows")

section("migration SQL shape (file presence)")
migration_path = os.path.join(_ROOT, "supabase", "migrations", "007_work_mode_workspace.sql")
with open(migration_path, encoding="utf-8") as f:
    sql = f.read()
ok("work_mode_workspaces" in sql, "workspaces table in migration")
ok("work_mode_workspace_tabs" in sql, "workspace_tabs table in migration")
ok("enable row level security" in sql.lower(), "RLS enabled in migration")
ok("auth.uid() = user_id" in sql, "RLS uses auth.uid() = user_id")

section("GET /api/work-mode/workspace auth gate")
app = FastAPI()
app.include_router(workspace_router)
client = TestClient(app)
with patch("auth.workspace_routes.get_supabase_config") as mock_cfg:
    mock_cfg.return_value.db_configured = True
    anon = client.get("/api/work-mode/workspace")
ok(anon.status_code == 401, "anonymous GET => 401")

section("workspace API user isolation + replace semantics (mocked db)")
store_ws: dict[str, dict] = {}
store_tabs: dict[str, list[dict]] = {}


def _fake_load(config, user_id):
    if user_id not in store_ws:
        return None
    tabs = [dict(x) for x in store_tabs.get(user_id, [])]
    ws = dict(store_ws[user_id])
    ws["tabs"] = tabs
    return ws


def _fake_replace(config, user_id, payload):
    normalized = normalize_workspace_put_payload(payload)
    tabs_in = normalized.get("tabs") if isinstance(normalized.get("tabs"), list) else []
    rows = []
    for idx, tab in enumerate(tabs_in[:WORKSPACE_MAX_TABS]):
        row = _sanitize_tab_row(user_id, tab, sort_order=idx)
        if row:
            rows.append(row)
    store_tabs[user_id] = rows
    store_ws[user_id] = {
        "schema_version": 1,
        "active_lane_id": normalized.get("active_lane_id"),
        "max_tabs": WORKSPACE_MAX_TABS,
        "client_revision": int(normalized.get("client_revision") or 0),
        "tabs": rows,
    }
    return {
        "tab_count": len(rows),
        "client_revision": int(normalized.get("client_revision") or 0),
        "active_lane_id": normalized.get("active_lane_id"),
    }


def _fake_delete(config, user_id):
    store_ws.pop(user_id, None)
    store_tabs.pop(user_id, None)


with patch("auth.workspace_routes.get_supabase_config") as mock_cfg, patch(
    "auth.workspace_routes.require_auth_user"
) as mock_user, patch("auth.workspace_routes.load_workspace_bundle", side_effect=_fake_load), patch(
    "auth.workspace_routes.replace_workspace_for_user", side_effect=_fake_replace
), patch("auth.workspace_routes.delete_workspace_for_user", side_effect=_fake_delete):
    mock_cfg.return_value.db_configured = True

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    put1 = client.put(
        "/api/work-mode/workspace",
        json={
            "client_revision": 1,
            "active_lane_id": "lane-a",
            "tabs": [
                {
                    "lane_id": "lane-a",
                    "sort_order": 0,
                    "title": "Alpha",
                    "is_active": True,
                    "registry": {"last_user_request": "q1"},
                    "rendered_html": "<p>A</p>",
                },
                {
                    "lane_id": "lane-b",
                    "sort_order": 1,
                    "title": "Beta",
                    "registry": {"last_user_request": "q2"},
                    "rendered_html": "<p>B</p>",
                },
            ],
        },
    )
    ok(put1.status_code == 200 and put1.json().get("tab_count") == 2, "PUT saves two tabs")
    ok(put1.json().get("workspace_api_version") == WORKSPACE_API_VERSION, "PUT returns api version")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    get1 = client.get("/api/work-mode/workspace")
    body1 = get1.json()
    ok(get1.status_code == 200 and len(body1.get("tabs", [])) == 2, "GET returns saved tabs")
    ok(body1.get("active_lane_id") == "lane-a", "active lane restored")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    put2 = client.put(
        "/api/work-mode/workspace",
        json={
            "client_revision": 2,
            "active_lane_id": "lane-a",
            "tabs": [
                {
                    "lane_id": "lane-a",
                    "sort_order": 0,
                    "title": "Alpha",
                    "is_active": True,
                    "closed": True,
                    "registry": {},
                    "rendered_html": "",
                }
            ],
        },
    )
    ok(put2.status_code == 200, "PUT replace succeeds")
    get2 = client.get("/api/work-mode/workspace").json()
    ok(len(get2.get("tabs", [])) == 1, "cleared tab replace drops removed lanes")
    ok(get2["tabs"][0].get("closed") is True, "closed state persisted")

    mock_user.return_value = AuthUser(user_id=USER_B, email="b@example.com")
    get_b = client.get("/api/work-mode/workspace")
    ok(get_b.status_code == 200 and get_b.json().get("empty") is True, "user B isolated from user A")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    too_many = [
        {"lane_id": f"lane-{i}", "sort_order": i, "title": f"T{i}"} for i in range(WORKSPACE_MAX_TABS + 1)
    ]
    put_many = client.put(
        "/api/work-mode/workspace",
        json={"client_revision": 3, "tabs": too_many},
    )
    ok(put_many.status_code == 200, "PUT truncates > max tabs instead of 400")
    ok(put_many.json().get("tab_count") == WORKSPACE_MAX_TABS, "truncated tab_count is max")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    bad_tabs = client.put(
        "/api/work-mode/workspace",
        json={"client_revision": 1, "tabs": "not-an-array"},
    )
    ok(bad_tabs.status_code == 400, "invalid tabs type returns 400")
    bad_body = bad_tabs.json()
    ok(bad_body.get("error") == "invalid_workspace_payload", "flat error key on 400")
    ok(bad_body.get("field") == "tabs", "flat field key on 400")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    put_big = client.put(
        "/api/work-mode/workspace",
        json={
            "client_revision": 4,
            "active_lane_id": "lane-a",
            "tabs": [
                {
                    "lane_id": "lane-a",
                    "sort_order": 0,
                    "title": "Big",
                    "rendered_html": "x" * 130_000,
                }
            ],
        },
    )
    ok(put_big.status_code == 200, "PUT accepts oversized rendered_html (truncated)")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    tiny = client.put(
        "/api/work-mode/workspace",
        json={
            "client_revision": 99,
            "active_lane_id": "tiny-lane",
            "tabs": [
                {
                    "lane_id": "tiny-lane",
                    "sort_order": 0,
                    "title": "Tiny",
                    "rendered_html": "<p>ok</p>",
                }
            ],
        },
    )
    ok(tiny.status_code == 200 and tiny.json().get("tab_count") == 1, "tiny 1-tab PUT returns 200")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    mixed_put = client.put(
        "/api/work-mode/workspace",
        json={
            "client_revision": 50,
            "active_lane_id": "lane-open",
            "tabs": [
                {
                    "lane_id": "lane-open",
                    "sort_order": 0,
                    "title": "Open",
                    "is_active": True,
                    "closed": False,
                    "rendered_html": "<p>x</p>" * 100,
                    "messages": [{"role": "assistant", "text": "answer"}],
                    "registry": {"last_user_request": "question"},
                    "last_opened_at": "2026-06-21T12:00:00.000Z",
                },
                {"lane_id": "lane-closed-1", "sort_order": 1, "title": "C1", "closed": True},
                {"lane_id": "lane-closed-2", "sort_order": 2, "title": "C2", "closed": True},
            ],
        },
    )
    ok(mixed_put.status_code == 200 and mixed_put.json().get("tab_count") == 3, "mixed open+closed PUT returns 200")

    mock_user.return_value = AuthUser(user_id=USER_A, email="a@example.com")
    delete = client.delete("/api/work-mode/workspace")
    ok(delete.status_code == 200 and delete.json().get("deleted") is True, "DELETE clears workspace")

print(f"\n{'=' * 40}")
print(f"Passed: {passed}  Failed: {failed}")
if failed:
    sys.exit(1)
