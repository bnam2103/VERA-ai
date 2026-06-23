"""Verify Supabase access tokens from Authorization: Bearer headers."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import HTTPException, Request
from jwt import PyJWKClient

from auth.supabase_config import SupabaseConfig, get_supabase_config


@dataclass(frozen=True)
class AuthUser:
    user_id: str
    email: str | None
    authenticated: bool = True


def extract_bearer_token(request: Request) -> str | None:
    auth = (request.headers.get("Authorization") or "").strip()
    if not auth.lower().startswith("bearer "):
        return None
    token = auth[7:].strip()
    return token or None


def _payload_to_auth_user(payload: dict) -> AuthUser | None:
    sub = payload.get("sub")
    if not sub:
        return None
    email = payload.get("email")
    if email is not None:
        email = str(email).strip() or None
    return AuthUser(user_id=str(sub), email=email)


def _decode_hs256(token: str, jwt_secret: str) -> dict | None:
    if not jwt_secret:
        return None
    try:
        return jwt.decode(
            token,
            jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
            options={"require": ["sub", "exp"]},
        )
    except jwt.PyJWTError:
        return None


@lru_cache(maxsize=4)
def _jwks_client_for_url(supabase_url: str) -> PyJWKClient:
    base = supabase_url.rstrip("/")
    return PyJWKClient(f"{base}/auth/v1/.well-known/jwks.json", cache_keys=True)


def _decode_jwks(token: str, supabase_url: str) -> dict | None:
    """Verify ES256/RS256 tokens from Supabase JWT Signing Keys (modern projects)."""
    if not supabase_url:
        return None
    issuer = supabase_url.rstrip("/") + "/auth/v1"
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        return None
    alg = str(header.get("alg") or "").upper()
    if alg == "HS256":
        return None

    try:
        client = _jwks_client_for_url(supabase_url)
        signing_key = client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
            issuer=issuer,
            options={"require": ["sub", "exp"]},
        )
    except jwt.PyJWTError:
        # Some legacy/migrated projects omit issuer or use a slightly different claim set.
        try:
            client = _jwks_client_for_url(supabase_url)
            signing_key = client.get_signing_key_from_jwt(token)
            return jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256", "RS256"],
                audience="authenticated",
                options={"require": ["sub", "exp"]},
            )
        except jwt.PyJWTError:
            return None


def verify_access_token(token: str, config: SupabaseConfig | None = None) -> AuthUser | None:
    """Return AuthUser when the Supabase JWT is valid; None on any failure."""
    cfg = config or get_supabase_config()
    if not token or not cfg.url:
        return None

    payload = _decode_hs256(token, cfg.jwt_secret or "")
    if payload is None:
        payload = _decode_jwks(token, cfg.url)
    if payload is None:
        return None
    return _payload_to_auth_user(payload)


def token_diagnostics(token: str, config: SupabaseConfig | None = None) -> dict:
    """Non-secret debug info for CLI troubleshooting."""
    cfg = config or get_supabase_config()
    out: dict = {"configured_url": bool(cfg.url), "has_jwt_secret": bool(cfg.jwt_secret)}
    if not token:
        out["error"] = "empty_token"
        return out
    try:
        header = jwt.get_unverified_header(token)
        out["alg"] = header.get("alg")
        out["kid"] = header.get("kid")
    except jwt.PyJWTError as exc:
        out["error"] = f"bad_header: {exc}"
        return out
    out["hs256_ok"] = _decode_hs256(token, cfg.jwt_secret or "") is not None
    out["jwks_ok"] = _decode_jwks(token, cfg.url or "") is not None if cfg.url else False
    return out


def resolve_auth_user(
    request: Request,
    config: SupabaseConfig | None = None,
) -> AuthUser | None:
    """Optional auth: missing/invalid token returns None (anonymous). Never raises."""
    cfg = config or get_supabase_config()
    if not cfg.auth_configured:
        return None
    token = extract_bearer_token(request)
    if not token:
        return None
    return verify_access_token(token, cfg)


def require_auth_user(
    request: Request,
    config: SupabaseConfig | None = None,
) -> AuthUser:
    """Required auth for protected routes."""
    user = resolve_auth_user(request, config)
    if user is None:
        cfg = config or get_supabase_config()
        if not cfg.auth_configured:
            raise HTTPException(
                status_code=503,
                detail="Supabase auth is not configured on this server.",
            )
        raise HTTPException(status_code=401, detail="Authentication required.")
    return user
