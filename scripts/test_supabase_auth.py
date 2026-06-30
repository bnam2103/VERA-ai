#!/usr/bin/env python3
"""One-shot Supabase Phase 1 auth test (local backend + Supabase Auth).

Usage (from repo root):
  py -3 scripts/test_supabase_auth.py --email you@example.com --password YourPassword

Optional env in .env:
  SUPABASE_URL, SUPABASE_JWT_SECRET, SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_ANON_KEY  (needed to fetch a token; get from Supabase Dashboard → API → anon)

Does not print secrets or full tokens.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

try:
    from dotenv import load_dotenv

    load_dotenv(_ROOT / ".env", encoding="utf-8-sig", override=True)
except ImportError:
    pass

import jwt

from auth.jwt_auth import token_diagnostics, verify_access_token
from auth.supabase_config import SupabaseConfig


def _post_json(url: str, headers: dict, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_json(url: str, headers: dict | None = None) -> dict:
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Test VERA Supabase auth wiring")
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--backend", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    jwt_secret = (os.environ.get("SUPABASE_JWT_SECRET") or "").strip()
    anon = (os.environ.get("SUPABASE_ANON_KEY") or "").strip()
    service = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

    print("=== Config check ===")
    print(f"  SUPABASE_URL:              {'set' if url else 'MISSING'}")
    print(f"  SUPABASE_JWT_SECRET:       {'set' if jwt_secret else 'MISSING'}")
    print(f"  SUPABASE_ANON_KEY:         {'set' if anon else 'MISSING (add to .env for this script)'}")
    print(f"  SUPABASE_SERVICE_ROLE_KEY: {'set' if service else 'MISSING'}")
    print(f"  Backend:                   {args.backend}")

    if not url or not jwt_secret:
        print("\nFAIL: Set SUPABASE_URL and SUPABASE_JWT_SECRET in .env")
        return 1
    if not anon:
        print("\nFAIL: Add SUPABASE_ANON_KEY to .env (Dashboard → API → anon public key)")
        return 1

    print("\n=== 1) Anonymous /api/auth/me ===")
    try:
        anon_body = _get_json(f"{args.backend.rstrip('/')}/api/auth/me")
        print(json.dumps(anon_body, indent=2))
    except urllib.error.URLError as exc:
        print(f"FAIL: Backend not reachable — {exc}")
        print("Start the server: py -3 -m uvicorn server:app --host 127.0.0.1 --port 8000")
        return 1

    print("\n=== 2) Get Supabase access token (password grant) ===")
    token_url = f"{url}/auth/v1/token?grant_type=password"
    headers = {"apikey": anon, "Content-Type": "application/json"}
    try:
        auth = _post_json(
            token_url,
            headers,
            {"email": args.email, "password": args.password},
        )
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"FAIL: Supabase auth HTTP {exc.code}")
        print(detail[:500])
        print("\nTips:")
        print("  - Create the user in Supabase → Authentication → Users")
        print("  - Enable 'Auto confirm' or confirm email")
        print("  - Check email/password")
        return 1

    token = (auth.get("access_token") or "").strip()
    if not token:
        print("FAIL: No access_token in Supabase response")
        return 1
    print(f"  access_token: OK ({len(token)} chars, starts with {token[:12]}...)")

    print("\n=== 3) Inspect token + verify locally ===")
    cfg = SupabaseConfig(url=url, service_role_key=service or None, jwt_secret=jwt_secret or None)
    diag = token_diagnostics(token, cfg)
    print(json.dumps({k: v for k, v in diag.items() if k != "error"}, indent=2))
    if diag.get("error"):
        print(f"  header error: {diag['error']}")

    user = verify_access_token(token, cfg)
    if user is None:
        print("FAIL: Token does not verify (HS256 secret nor JWKS)")
        if diag.get("alg") == "ES256":
            print("  → Token uses ES256. Ensure SUPABASE_URL is correct and server can reach JWKS.")
            print(f"  → JWKS URL: {url}/auth/v1/.well-known/jwks.json")
        elif diag.get("alg") == "HS256":
            print("  → Token uses HS256. Set SUPABASE_JWT_SECRET to Dashboard → JWT Settings → JWT Secret")
        print("  → Restart uvicorn after changing .env")
        return 1
    print(f"  OK user_id={user.user_id} email={user.email}")

    print("\n=== 4) GET /api/auth/me (with Bearer token) ===")
    api_headers = {"Authorization": f"Bearer {token}"}
    try:
        me = _get_json(f"{args.backend.rstrip('/')}/api/auth/me", api_headers)
        print(json.dumps(me, indent=2))
        if not me.get("authenticated"):
            print("FAIL: Backend returned authenticated=false despite valid local verify")
            return 1
    except urllib.error.HTTPError as exc:
        print(f"FAIL: HTTP {exc.code} {exc.read().decode('utf-8', errors='replace')}")
        return 1

    print("\n=== 5) GET /api/profile ===")
    try:
        prof = _get_json(f"{args.backend.rstrip('/')}/api/profile", api_headers)
        print(json.dumps(prof, indent=2))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"FAIL: HTTP {exc.code} {body}")
        if exc.code == 502:
            print("  → Did you run supabase/migrations/001_initial_schema.sql in SQL Editor?")
        return 1

    print("\n=== All checks passed ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
