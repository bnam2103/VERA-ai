"""Load Supabase-related environment variables for the FastAPI backend."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class SupabaseConfig:
    url: str | None
    service_role_key: str | None
    jwt_secret: str | None

    @property
    def auth_configured(self) -> bool:
        """True when JWT verification can run (project URL; HS256 secret and/or JWKS)."""
        return bool(self.url)

    @property
    def db_configured(self) -> bool:
        """True when backend can call PostgREST with the service role key."""
        return bool(self.url and self.service_role_key)


@lru_cache(maxsize=1)
def get_supabase_config() -> SupabaseConfig:
    return SupabaseConfig(
        url=(os.environ.get("SUPABASE_URL") or "").strip() or None,
        service_role_key=(os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip() or None,
        jwt_secret=(os.environ.get("SUPABASE_JWT_SECRET") or "").strip() or None,
    )
