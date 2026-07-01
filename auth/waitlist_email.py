"""Optional waitlist confirmation email (stub until provider env is configured)."""

from __future__ import annotations

import logging
import os

_log = logging.getLogger(__name__)


def _confirmation_email_configured() -> bool:
    return bool(
        (os.environ.get("RESEND_API_KEY") or "").strip()
        or (os.environ.get("POSTMARK_SERVER_TOKEN") or "").strip()
        or (os.environ.get("SENDGRID_API_KEY") or "").strip()
    )


def send_waitlist_confirmation_email(email: str) -> bool:
    """Send a waitlist confirmation email when a provider is configured.

    TODO: Integrate Resend, Postmark, or SendGrid for production confirmation emails.
    Signup succeeds even when this returns False.
    """
    if not _confirmation_email_configured():
        return False

    # TODO: Resend/Postmark/SendGrid integration — template + send API call.
    _log.info("[waitlist] confirmation email skipped (provider stub): %s", email[:64])
    return False
