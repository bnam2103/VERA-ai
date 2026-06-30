"""Per-request Supabase auth binding (from Authorization header)."""

from __future__ import annotations

from contextvars import ContextVar

from fastapi import Request

from auth.jwt_auth import AuthUser, extract_bearer_token, resolve_auth_user

_bound_auth_user: ContextVar[AuthUser | None] = ContextVar("_bound_auth_user", default=None)
_bound_request: ContextVar[Request | None] = ContextVar("_bound_request", default=None)


def bind_request_auth_user(request: Request | None) -> AuthUser | None:
    _bound_request.set(request)
    user = resolve_auth_user(request) if request is not None else None
    _bound_auth_user.set(user)
    return user


def get_bound_request() -> Request | None:
    return _bound_request.get()


def get_bound_auth_user() -> AuthUser | None:
    user = _bound_auth_user.get()
    if user is not None:
        return user
    req = _bound_request.get()
    if req is None:
        return None
    user = resolve_auth_user(req)
    if user is not None:
        _bound_auth_user.set(user)
    return user


def clear_bound_auth_user() -> None:
    _bound_auth_user.set(None)
    _bound_request.set(None)


def auth_bind_diagnostics() -> dict[str, object]:
    req = _bound_request.get()
    token = extract_bearer_token(req) if req is not None else None
    user = get_bound_auth_user()
    return {
        "has_request": req is not None,
        "has_authorization_header": bool(token),
        "jwt_present": bool(token),
        "bound_user_id": user.user_id if user else None,
        "jwt_user_id": user.user_id if user else None,
    }
