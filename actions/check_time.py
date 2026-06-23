from datetime import datetime, timedelta, timezone
import json
import re
import string

from actions.weather import fetch_weather, geocode_location

# Default timezone for time/date queries when the user does NOT supply a
# specific location. We intentionally use a generic "Pacific Time" label
# (resolved via IANA America/Los_Angeles so DST is handled correctly) rather
# than a city, so the spoken answer doesn't keep saying "Fountain Valley"
# when the user is just asking what time it is.
_DEFAULT_TIME_TZ_NAME = "America/Los_Angeles"
_DEFAULT_TIME_PLACE_NAME = "Pacific Time"

try:
    from zoneinfo import ZoneInfo  # py3.9+
    _DEFAULT_TIME_TZ = ZoneInfo(_DEFAULT_TIME_TZ_NAME)
except Exception as _zi_err:  # pragma: no cover - extremely unusual envs
    # Fall back to a fixed UTC-8 (PST) offset. DST won't be tracked in this
    # branch, but it is only hit when zoneinfo / tzdata isn't installed at
    # all, and the time facts still flow through the LLM which can correct
    # the wording.
    print(f"[check_time] zoneinfo unavailable ({_zi_err!r}); using fixed UTC-8")
    ZoneInfo = None
    _DEFAULT_TIME_TZ = timezone(timedelta(hours=-8), name="PST")

_TIMEZONE_ALIASES = {
    "tokyo": ("Asia/Tokyo", "Tokyo"),
    "japan": ("Asia/Tokyo", "Japan"),
    "ho chi minh city": ("Asia/Ho_Chi_Minh", "Ho Chi Minh City"),
    "ho chi minh": ("Asia/Ho_Chi_Minh", "Ho Chi Minh City"),
    "hcmc": ("Asia/Ho_Chi_Minh", "Ho Chi Minh City"),
    "saigon": ("Asia/Ho_Chi_Minh", "Ho Chi Minh City"),
    "sai gon": ("Asia/Ho_Chi_Minh", "Ho Chi Minh City"),
    "vietnam": ("Asia/Ho_Chi_Minh", "Vietnam"),
    "viet nam": ("Asia/Ho_Chi_Minh", "Vietnam"),
    "paris": ("Europe/Paris", "Paris"),
    "london": ("Europe/London", "London"),
    "new york": ("America/New_York", "New York"),
    "nyc": ("America/New_York", "New York"),
    "irvine": ("America/Los_Angeles", "Irvine"),
    "orange county": ("America/Los_Angeles", "Orange County"),
    "los angeles": ("America/Los_Angeles", "Los Angeles"),
    "la": ("America/Los_Angeles", "Los Angeles"),
}

TIME_PREAMBLE = (
    "Provide the current time clearly and calmly.\n"
    "Use natural spoken language suitable for a voice assistant.\n\n"
    "Tone: practical and straightforward—not funny, not teasing, not cute. "
    "Do not use the listener's name, habits, or personal details.\n\n"
    "State the time and day clearly first (one or two short sentences).\n\n"
    "Proactive care (only when Local hour below supports it—add at most one brief matter-of-fact sentence):\n"
    "- From about 10 PM through 5 AM local time: you may note that it is late and suggest winding down or "
    "heading to bed if they were planning to sleep—plain and helpful, not parental or jokey.\n"
    "- Example: around 1 AM, it is reasonable to say it is very late and they may want to consider sleep soon.\n"
    "- Outside that window (roughly 6 AM through before 10 PM), do not mention sleep or bed.\n\n"
)

DATE_PREAMBLE = (
    "Provide today's date clearly and calmly.\n"
    "Use natural spoken language suitable for a voice assistant.\n"
    "Be factual and neutral—not funny, not teasing; do not personalize.\n\n"
)

DATE_DELTA_PREAMBLE = (
    "Provide the time difference clearly and calmly.\n"
    "Use natural spoken language suitable for a voice assistant.\n"
    "Be factual and neutral—not funny, not teasing; do not personalize.\n\n"
)

HOLIDAY_ALIASES = {
    "patricks day": (3, 17, "St. Patrick's Day"),
    "patrick's day": (3, 17, "St. Patrick's Day"),
    "st patricks day": (3, 17, "St. Patrick's Day"),
    "st patrick's day": (3, 17, "St. Patrick's Day"),
    "christmas": (12, 25, "Christmas"),
    "chrismas": (12, 25, "Christmas"),
    "christmas day": (12, 25, "Christmas"),
    "new years day": (1, 1, "New Year's Day"),
    "new year's day": (1, 1, "New Year's Day"),
    "independence day": (7, 4, "Independence Day"),
    "halloween": (10, 31, "Halloween"),
    "valentines day": (2, 14, "Valentine's Day"),
    "valentine's day": (2, 14, "Valentine's Day"),
}


def _normalize_target_name(text: str) -> str:
    normalized = text.lower().strip()
    normalized = normalized.translate(str.maketrans("", "", string.punctuation))
    normalized = re.sub(r"\bhow many days until\b", "", normalized).strip()
    normalized = re.sub(r"\bdays until\b", "", normalized).strip()
    normalized = re.sub(r"\buntil\b", "", normalized).strip()
    return normalized


def _resolve_default_pacific_datetime() -> dict:
    """Return a Pacific-Time facts dict without hitting any external API.

    Used whenever a time/date query does not include an explicit location.
    Keeps the schema identical to the geocoded path so downstream callers
    don't need to branch.
    """
    local_now = datetime.now(timezone.utc).astimezone(_DEFAULT_TIME_TZ)
    utc_offset_seconds = int(local_now.utcoffset().total_seconds()) if local_now.utcoffset() else -8 * 3600
    return {
        "place_name": _DEFAULT_TIME_PLACE_NAME,
        "lat": None,
        "lon": None,
        "utc_offset_seconds": utc_offset_seconds,
        "local_now": local_now,
    }


def _normalize_time_location_alias(location: str | None) -> tuple[str, str, str]:
    raw = str(location or "").strip()
    normalized = raw.lower()
    normalized = normalized.translate(str.maketrans("", "", string.punctuation))
    normalized = re.sub(r"\s+", " ", normalized).strip()
    if not normalized:
        return raw, "", ""
    if normalized in _TIMEZONE_ALIASES:
        tz_name, place_name = _TIMEZONE_ALIASES[normalized]
        return raw, tz_name, place_name
    return raw, "", ""


def _log_time_tool_resolution(
    *,
    raw_location: str,
    normalized_location: str,
    timezone_name: str,
    failed_reason: str = "",
) -> None:
    try:
        print(
            "[time_tool_resolution] "
            + json.dumps(
                {
                    "time_tool_location_raw": raw_location,
                    "time_tool_location_normalized": normalized_location,
                    "timezone_resolved": timezone_name,
                    "timezone_resolution_failed_reason": failed_reason,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def _resolve_location_datetime(location: str | None = None):
    # No explicit location -> default to Pacific Time directly. This avoids
    # routing the default through OpenWeather geocoding (which used to return
    # "Fountain Valley") just to recover a timezone offset.
    if not location or not str(location).strip():
        _log_time_tool_resolution(
            raw_location="",
            normalized_location=_DEFAULT_TIME_PLACE_NAME,
            timezone_name=_DEFAULT_TIME_TZ_NAME,
        )
        return _resolve_default_pacific_datetime()

    raw_location, timezone_name, place_name = _normalize_time_location_alias(location)
    if timezone_name:
        try:
            tz = ZoneInfo(timezone_name) if ZoneInfo is not None else None
        except Exception:
            if timezone_name == _DEFAULT_TIME_TZ_NAME:
                tz = _DEFAULT_TIME_TZ
            else:
                tz = None
        if tz is not None:
            local_now = datetime.now(timezone.utc).astimezone(tz)
            utc_offset_seconds = (
                int(local_now.utcoffset().total_seconds())
                if local_now.utcoffset()
                else 0
            )
            _log_time_tool_resolution(
                raw_location=raw_location,
                normalized_location=place_name,
                timezone_name=timezone_name,
            )
            return {
                "place_name": place_name,
                "lat": None,
                "lon": None,
                "utc_offset_seconds": utc_offset_seconds,
                "local_now": local_now,
            }
        _log_time_tool_resolution(
            raw_location=raw_location,
            normalized_location=place_name,
            timezone_name="",
            failed_reason=f"zoneinfo_unavailable:{timezone_name}",
        )

    geo_result = geocode_location(location)
    if geo_result is None:
        _log_time_tool_resolution(
            raw_location=str(location or "").strip(),
            normalized_location="",
            timezone_name="",
            failed_reason="geocode_no_match",
        )
        return None

    place_name, lat, lon = geo_result
    weather_data = fetch_weather(lat, lon)
    utc_offset_seconds = weather_data.get("timezone", 0)
    tz = timezone(timedelta(seconds=utc_offset_seconds))
    local_now = datetime.now(timezone.utc).astimezone(tz)
    _log_time_tool_resolution(
        raw_location=str(location or "").strip(),
        normalized_location=place_name,
        timezone_name=f"utc_offset_seconds:{utc_offset_seconds}",
    )

    return {
        "place_name": place_name,
        "lat": lat,
        "lon": lon,
        "utc_offset_seconds": utc_offset_seconds,
        "local_now": local_now,
    }


def _get_time_facts(location: str | None = None):
    resolved = _resolve_location_datetime(location)
    if resolved is None:
        return None

    now = resolved["local_now"]
    return {
        "place_name": resolved["place_name"],
        "time_12h": now.strftime("%I:%M %p"),
        "hour_24": now.hour,
        "weekday": now.strftime("%A"),
        "full_date": now.strftime("%A, %B %d, %Y"),
        "utc_offset_seconds": resolved["utc_offset_seconds"],
    }


def prepare_time_stream_messages(vera, location: str | None = None):
    """Returns (messages, facts) or None if location invalid."""
    facts = _get_time_facts(location)
    if facts is None:
        return None
    prompt = (
        TIME_PREAMBLE +
        f"Location: {facts['place_name']}\n"
        f"Time: {facts['time_12h']}\n"
        f"Local hour (24h, for judging late night): {facts['hour_24']}\n"
        f"Day: {facts['weekday']}\n"
    )
    messages = vera.build_messages(chat_history=[], user_text=prompt)
    return messages, facts


def handle_time_request(vera, location: str | None = None):
    p = prepare_time_stream_messages(vera, location)
    if p is None:
        return {
            "spoken_reply": "I couldn't recognize that location.",
            "action_type": "time",
            "data": None,
            "ui_payload": None,
        }
    messages, facts = p
    response, _ = vera.generate(messages)
    return {
        "spoken_reply": response,
        "action_type": "time",
        "data": facts,
        "ui_payload": None,
    }


def _get_date_facts(location: str | None = None):
    resolved = _resolve_location_datetime(location)
    if resolved is None:
        return None

    today = resolved["local_now"]
    return {
        "place_name": resolved["place_name"],
        "full_date": today.strftime("%A, %B %d, %Y"),
        "weekday": today.strftime("%A"),
        "utc_offset_seconds": resolved["utc_offset_seconds"],
    }


def prepare_date_stream_messages(vera, location: str | None = None):
    """Returns (messages, facts) or None if location invalid."""
    facts = _get_date_facts(location)
    if facts is None:
        return None
    prompt = (
        DATE_PREAMBLE +
        f"Location: {facts['place_name']}\n"
        f"Date: {facts['full_date']}\n"
    )
    messages = vera.build_messages(chat_history=[], user_text=prompt)
    return messages, facts


def handle_date_request(vera, location: str | None = None):
    p = prepare_date_stream_messages(vera, location)
    if p is None:
        return {
            "spoken_reply": "I couldn't recognize that location.",
            "action_type": "date",
            "data": None,
            "ui_payload": None,
        }
    messages, facts = p
    response, _ = vera.generate(messages)
    return {
        "spoken_reply": response,
        "action_type": "date",
        "data": facts,
        "ui_payload": None,
    }


def _parse_month_day_target(target_name: str, reference_now: datetime):
    cleaned = _normalize_target_name(target_name)
    cleaned = re.sub(
        r"\b(\d{1,2})(st|nd|rd|th)\b",
        lambda m: m.group(1),
        cleaned,
    )

    for fmt in ("%B %d", "%b %d"):
        try:
            parsed = datetime.strptime(cleaned.title(), fmt)
            candidate = datetime(reference_now.year, parsed.month, parsed.day, tzinfo=reference_now.tzinfo)
            if candidate.date() < reference_now.date():
                candidate = datetime(reference_now.year + 1, parsed.month, parsed.day, tzinfo=reference_now.tzinfo)
            return candidate, parsed.strftime("%B %d")
        except ValueError:
            continue

    return None, None


def _resolve_target_date(target_name: str, reference_now: datetime):
    normalized = _normalize_target_name(target_name)
    if not normalized:
        return None, None

    if normalized in HOLIDAY_ALIASES:
        month, day, label = HOLIDAY_ALIASES[normalized]
        candidate = datetime(reference_now.year, month, day, tzinfo=reference_now.tzinfo)
        if candidate.date() < reference_now.date():
            candidate = datetime(reference_now.year + 1, month, day, tzinfo=reference_now.tzinfo)
        return candidate, label

    parsed, label = _parse_month_day_target(normalized, reference_now)
    if parsed is not None:
        return parsed, label

    return None, None


def _resolve_target_date_with_fallback(vera, target_name: str, reference_now: datetime):
    target_date, target_label = _resolve_target_date(target_name, reference_now)
    if target_date is not None:
        return target_date, target_label

    resolved = vera.resolve_date_target(
        user_text=target_name,
        reference_date=reference_now.date().isoformat(),
    )
    if not resolved.get("is_valid"):
        return None, None

    target_date_text = (resolved.get("target_date") or "").strip()
    if not target_date_text:
        return None, None

    try:
        parsed_date = datetime.strptime(target_date_text, "%Y-%m-%d")
    except ValueError:
        return None, None

    target_date = datetime(
        parsed_date.year,
        parsed_date.month,
        parsed_date.day,
        tzinfo=reference_now.tzinfo,
    )
    target_label = (resolved.get("target_name") or target_name).strip()
    return target_date, target_label


def is_supported_date_target(target_name: str) -> bool:
    reference_now = datetime.now(timezone.utc)
    target_date, _ = _resolve_target_date(target_name, reference_now)
    return target_date is not None


def prepare_date_delta_stream_messages(vera, target_name: str, location: str | None = None):
    """Returns (messages, facts) or None if location or target date invalid."""
    resolved = _resolve_location_datetime(location)
    if resolved is None:
        return None

    reference_now = resolved["local_now"]
    target_date, target_label = _resolve_target_date_with_fallback(vera, target_name, reference_now)
    if target_date is None:
        return None

    days_until = (target_date.date() - reference_now.date()).days
    facts = {
        "place_name": resolved["place_name"],
        "target_name": target_label,
        "target_date": target_date.strftime("%A, %B %d, %Y"),
        "days_until": days_until,
        "utc_offset_seconds": resolved["utc_offset_seconds"],
    }

    prompt = (
        DATE_DELTA_PREAMBLE +
        f"Location: {facts['place_name']}\n"
        f"Target: {facts['target_name']}\n"
        f"Target date: {facts['target_date']}\n"
        f"Days until target: {facts['days_until']}\n"
    )
    messages = vera.build_messages(chat_history=[], user_text=prompt)
    return messages, facts


def handle_date_delta_request(vera, target_name: str, location: str | None = None):
    p = prepare_date_delta_stream_messages(vera, target_name, location)
    if p is None:
        resolved = _resolve_location_datetime(location)
        if resolved is None:
            return {
                "spoken_reply": "I couldn't recognize that location.",
                "action_type": "date",
                "data": None,
                "ui_payload": None,
            }
        return {
            "spoken_reply": "I couldn't work out that date yet.",
            "action_type": "date",
            "data": None,
            "ui_payload": None,
        }
    messages, facts = p
    response, _ = vera.generate(messages)
    return {
        "spoken_reply": response,
        "action_type": "date",
        "data": facts,
        "ui_payload": None,
    }

def is_time_or_date_query(text: str) -> bool:
    text = text.lower()
    text = text.translate(str.maketrans("", "", string.punctuation))

    if any(keyword in text for keyword in ["current date", "current time"]):
        return True
    return False

# print(is_time_or_date_query("What time is it now?"))