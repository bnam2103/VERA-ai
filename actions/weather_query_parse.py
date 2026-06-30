"""Parse natural-language weather queries into current vs forecast routes."""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

FORECAST_HORIZON_DAYS = 5

_WEEKDAY_NAMES = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}

_MONTH_NAMES = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}

_ORDINAL_DAY_WORDS = {
    "first": 1,
    "second": 2,
    "third": 3,
    "fourth": 4,
    "fifth": 5,
    "sixth": 6,
    "seventh": 7,
    "eighth": 8,
    "ninth": 9,
    "tenth": 10,
    "eleventh": 11,
    "twelfth": 12,
    "thirteenth": 13,
    "fourteenth": 14,
    "fifteenth": 15,
    "sixteenth": 16,
    "seventeenth": 17,
    "eighteenth": 18,
    "nineteenth": 19,
    "twentieth": 20,
    "twenty-first": 21,
    "twenty-second": 22,
    "twenty-third": 23,
    "twenty-fourth": 24,
    "twenty-fifth": 25,
    "twenty-sixth": 26,
    "twenty-seventh": 27,
    "twenty-eighth": 28,
    "twenty-ninth": 29,
    "thirtieth": 30,
    "thirty-first": 31,
}

_DAY_TOKEN_PATTERN = (
    r"(?:\d{1,2}(?:st|nd|rd|th)?|"
    r"first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|"
    r"eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|"
    r"eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|"
    r"twenty-fourth|twenty-fifth|twenty-sixth|twenty-seventh|twenty-eighth|"
    r"twenty-ninth|thirtieth|thirty-first)"
)

_CURRENT_CUE_RE = re.compile(
    r"\b(?:right\s+now|currently|current(?:ly)?|at\s+the\s+moment|"
    r"current\s+weather|weather\s+now|how\s+is\s+it\s+now)\b",
    re.IGNORECASE,
)

_FORECAST_WORD_RE = re.compile(
    r"\b(?:forecast| outlook)\b",
    re.IGNORECASE,
)

_FUTURE_TIME_RE = re.compile(
    r"\b(?:"
    r"tomorrow|tonight|later\s+today|this\s+weekend|next\s+weekend|"
    r"this\s+week|next\s+\d+\s+days?|next\s+three\s+days|"
    r"tomorrow\s+(?:morning|afternoon|evening)|"
    r"(?:this|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|night))?|"
    r"(?:january|february|march|april|may|june|july|august|september|october|november|december|"
    r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?|"
    r"first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|"
    r"eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|"
    r"eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|"
    r"twenty-fourth|twenty-fifth|twenty-sixth|twenty-seventh|twenty-eighth|"
    r"twenty-ninth|thirtieth|thirty-first)|"
    r"on\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|"
    r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?|"
    r"first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|"
    r"eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|"
    r"eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|"
    r"twenty-fourth|twenty-fifth|twenty-sixth|twenty-seventh|twenty-eighth|"
    r"twenty-ninth|thirtieth|thirty-first)|"
    r"this\s+(?:morning|afternoon|evening)|"
    r"at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?"
    r")\b",
    re.IGNORECASE,
)

_NEAR_ME_RE = re.compile(
    r"\b(?:near\s+me|around\s+here|around\s+me|close\s+to\s+me|here|my\s+area)\b",
    re.IGNORECASE,
)

_RAIN_INTENT_RE = re.compile(
    r"\b(?:rain|rainy|raining|umbrella|precipitation|snow|snowy|snowing|"
    r"will\s+it\s+rain|chance\s+of\s+rain)\b",
    re.IGNORECASE,
)

_TEMP_INTENT_RE = re.compile(
    r"\b(?:hot|cold|warm|cool|temperature|temp|high|low|degrees)\b",
    re.IGNORECASE,
)

_WIND_INTENT_RE = re.compile(
    r"\b(?:wind|windy|gust|breeze)\b",
    re.IGNORECASE,
)

_LOCATION_IN_RE = re.compile(
    r"\b(?:in|at|for|near)\s+(?:the\s+)?(?P<loc>[^,?;!.]+?)(?:\s*[?.!,]|$|\s+and\s+|\s+tomorrow|\s+tonight|\s+this\s+|\s+next\s+|\s+at\s+\d|\s+on\s+)",
    re.IGNORECASE,
)

_AT_TIME_RE = re.compile(
    r"\bat\s+(?P<hour>\d{1,2})(?::(?P<min>\d{2}))?\s*(?P<ampm>am|pm|a\.m\.|p\.m\.)?",
    re.IGNORECASE,
)

_NEXT_DAYS_RE = re.compile(
    r"\bnext\s+(?P<n>\d+|three|two|four|five)\s+days?\b",
    re.IGNORECASE,
)

_CALENDAR_DATE_RE = re.compile(
    r"\b(?:on\s+)?(?P<month>january|february|march|april|may|june|july|august|september|october|november|december|"
    r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(?P<day>"
    + _DAY_TOKEN_PATTERN
    + r")\b",
    re.IGNORECASE,
)

_WEEKDAY_EXPR_RE = re.compile(
    r"\b(?:(?P<prefix>this|next)\s+)?(?P<weekday>monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
    r"(?:\s+(?P<part>morning|afternoon|evening|night))?\b",
    re.IGNORECASE,
)

_TIME_STRIP_SUFFIX_RE = re.compile(
    r"\s+(?:"
    r"tomorrow(?:\s+(?:morning|afternoon|evening|night))?|"
    r"tonight|today|"
    r"this\s+(?:morning|afternoon|evening|weekend|week)|"
    r"next\s+(?:weekend|week|\d+|three|two|four|five)\s+days?|"
    r"next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"this\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    r"(?:on\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|"
    r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+"
    + _DAY_TOKEN_PATTERN
    + r"|"
    r"(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|night))?|"
    r"(?:morning|afternoon|evening|night)|"
    r"(?:at|around)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?"
    r").*$",
    re.IGNORECASE,
)

_DAY_WORDS = {"three": 3, "two": 2, "four": 4, "five": 5}


def _clean_location(raw: str) -> str:
    return strip_weather_time_from_location(raw)


def strip_weather_time_from_location(raw: str) -> str:
    """Remove trailing/embedded forecast time phrases before geocoding."""
    loc = (raw or "").strip().strip(".,;:!? ")
    if not loc:
        return ""
    loc = re.sub(r"^(?:the\s+)", "", loc, flags=re.IGNORECASE).strip()
    loc = re.sub(r"\s+now$", "", loc, flags=re.IGNORECASE).strip()
    prev = None
    while prev != loc:
        prev = loc
        loc = _TIME_STRIP_SUFFIX_RE.sub("", loc).strip()
    return loc.strip(".,;:!? ")


def _extract_location(text: str) -> tuple[str | None, str]:
    """Return (location, location_kind). kind: explicit | near_me | missing."""
    raw = (text or "").strip()
    if not raw:
        return None, "missing"
    if _NEAR_ME_RE.search(raw):
        return None, "near_me"
    m_in = re.search(
        r"\bin\s+(?:the\s+)?(?P<loc>.+?)(?=\s*[?.!,]|$|\s+(?:tomorrow|tonight|next|this|on|at)\b)",
        raw,
        re.IGNORECASE,
    )
    if m_in:
        loc = _clean_location(m_in.group("loc"))
        if loc and not _NEAR_ME_RE.search(loc) and not re.match(r"^\d", loc):
            return loc, "explicit"
    m = _LOCATION_IN_RE.search(raw)
    if m:
        loc = _clean_location(m.group("loc"))
        if loc and not _NEAR_ME_RE.search(loc) and not re.match(r"^\d", loc):
            if not re.search(r"\b(?:am|pm|a\.m\.|p\.m\.)\b", loc, re.IGNORECASE):
                return loc, "explicit"
    return None, "missing"


def _detect_intent(text: str) -> str:
    low = (text or "").lower()
    if _RAIN_INTENT_RE.search(low):
        return "rain"
    if _WIND_INTENT_RE.search(low):
        return "wind"
    if _TEMP_INTENT_RE.search(low):
        return "temperature"
    return "general"


def _parse_at_time(text: str) -> tuple[int | None, int | None]:
    m = _AT_TIME_RE.search(text or "")
    if not m:
        return None, None
    hour = int(m.group("hour"))
    minute = int(m.group("min") or 0)
    ampm = (m.group("ampm") or "").lower().replace(".", "")
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if not ampm and hour <= 12 and "evening" in (text or "").lower() and hour < 12:
        hour += 12
    return hour, minute


def _calendar_label(month_num: int, day_num: int) -> str:
    month_name = date(2000, month_num, 1).strftime("%B")
    return f"{month_name} {day_num}"


def parse_calendar_day_token(token: str) -> int | None:
    """Parse ``29``, ``29th``, or ``fourth`` into a day-of-month integer."""
    raw = str(token or "").strip().lower().rstrip(".")
    if not raw:
        return None
    if raw.isdigit():
        day = int(raw)
        return day if 1 <= day <= 31 else None
    m = re.fullmatch(r"(\d{1,2})(?:st|nd|rd|th)", raw)
    if m:
        day = int(m.group(1))
        return day if 1 <= day <= 31 else None
    normalized = raw.replace(" ", "-")
    day = _ORDINAL_DAY_WORDS.get(normalized)
    if day is not None and 1 <= day <= 31:
        return day
    return None


def _parse_calendar_date(text: str, ref_local: datetime) -> dict[str, Any] | None:
    m = _CALENDAR_DATE_RE.search(text or "")
    if not m:
        return None
    month_key = m.group("month").lower().rstrip(".")
    month_num = _MONTH_NAMES.get(month_key)
    if not month_num:
        return None
    day_num = parse_calendar_day_token(m.group("day"))
    if day_num is None:
        return None
    year = ref_local.year
    try:
        target = date(year, month_num, day_num)
    except ValueError:
        return None
    if target < ref_local.date() - timedelta(days=60):
        try:
            target = date(year + 1, month_num, day_num)
        except ValueError:
            return None
    beyond = _date_beyond_horizon(target, ref_local.date())
    return {
        "time_kind": "date",
        "time_label": _calendar_label(month_num, day_num),
        "target_date": target.isoformat(),
        "start_local": target.isoformat(),
        "end_local": target.isoformat(),
        "target_weekday": None,
        "target_hour": None,
        "target_minute": None,
        "day_count": 1,
        "beyond_horizon": beyond,
    }


def _date_beyond_horizon(target: date, ref_day: date) -> bool:
    days_ahead = (target - ref_day).days
    return days_ahead > FORECAST_HORIZON_DAYS or days_ahead < 0


def _log_horizon_check(
    requested_date: str,
    ref_day: date,
    beyond: bool,
    *,
    first_slot_date: str | None = None,
    last_slot_date: str | None = None,
) -> None:
    try:
        min_date = ref_day.isoformat()
        max_date = (ref_day + timedelta(days=FORECAST_HORIZON_DAYS)).isoformat()
        print(
            "[weather_forecast_horizon_check] "
            + json.dumps(
                {
                    "requested_date": requested_date,
                    "min_date": min_date,
                    "max_date": max_date,
                    "first_slot_date": first_slot_date,
                    "last_slot_date": last_slot_date,
                    "in_range": not beyond,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def _resolve_weekday_date(ref_local: datetime, weekday_idx: int, *, prefix: str = "") -> date:
    today = ref_local.date()
    delta = (weekday_idx - today.weekday()) % 7
    pref = (prefix or "").lower()
    if pref == "next":
        if delta == 0:
            delta = 7
    elif pref == "this":
        if delta == 0 and ref_local.hour >= 20:
            delta = 7
    else:
        if delta == 0 and ref_local.hour >= 20:
            delta = 7
    return today + timedelta(days=delta)


def _parse_weekday_expression(text: str, ref_local: datetime) -> dict[str, Any] | None:
    m = _WEEKDAY_EXPR_RE.search(text or "")
    if not m:
        return None
    weekday_name = m.group("weekday").lower()
    weekday_idx = _WEEKDAY_NAMES.get(weekday_name)
    if weekday_idx is None:
        return None
    prefix = (m.group("prefix") or "").lower()
    part = (m.group("part") or "").lower()
    target = _resolve_weekday_date(ref_local, weekday_idx, prefix=prefix)
    beyond = _date_beyond_horizon(target, ref_local.date())
    label = weekday_name.capitalize()
    if prefix == "next":
        label = f"Next {label}"
    elif prefix == "this":
        label = f"This {label}"
    hour = None
    if part == "morning":
        hour = 9
        label = f"{label} morning"
    elif part == "afternoon":
        hour = 15
        label = f"{label} afternoon"
    elif part in ("evening", "night"):
        hour = 19
        label = f"{label} evening"
    _log_horizon_check(target.isoformat(), ref_local.date(), beyond)
    return {
        "time_kind": "weekday",
        "time_label": label,
        "target_date": target.isoformat(),
        "start_local": target.isoformat(),
        "end_local": target.isoformat(),
        "target_weekday": weekday_idx,
        "target_hour": hour,
        "target_minute": 0 if hour is not None else None,
        "day_count": 1,
        "beyond_horizon": beyond,
        "weekday_prefix": prefix or None,
    }


def _attach_local_range(out: dict[str, Any], ref_local: datetime) -> dict[str, Any]:
    """Fill start_local/end_local when missing."""
    if out.get("start_local") and out.get("end_local"):
        return out
    time_kind = out.get("time_kind") or "now"
    today = ref_local.date()
    if time_kind == "tomorrow" or time_kind.startswith("tomorrow_"):
        d = today + timedelta(days=1)
        out["target_date"] = d.isoformat()
        out["start_local"] = d.isoformat()
        out["end_local"] = d.isoformat()
    elif time_kind == "tonight" or time_kind in ("later_today", "today_at_time", "at_time"):
        out["target_date"] = today.isoformat()
        out["start_local"] = today.isoformat()
        out["end_local"] = today.isoformat()
    elif time_kind == "weekday" and out.get("target_date"):
        out["start_local"] = out["target_date"]
        out["end_local"] = out["target_date"]
    elif time_kind == "date" and out.get("target_date"):
        out["start_local"] = out["target_date"]
        out["end_local"] = out["target_date"]
    elif time_kind in ("weekend", "next_weekend"):
        sat = today + timedelta(days=(5 - today.weekday()) % 7)
        if time_kind == "next_weekend":
            sat = sat + timedelta(days=7)
        sun = sat + timedelta(days=1)
        out["start_local"] = sat.isoformat()
        out["end_local"] = sun.isoformat()
    elif time_kind == "next_n_days":
        n = int(out.get("day_count") or 1)
        out["start_local"] = (today + timedelta(days=1)).isoformat()
        out["end_local"] = (today + timedelta(days=n)).isoformat()
    return out


def _parse_time_query(text: str, *, ref_local: datetime | None = None) -> dict[str, Any]:
    ref = ref_local or datetime.now(timezone.utc)
    low = (text or "").lower()
    out: dict[str, Any] = {
        "time_kind": "now",
        "time_label": "Now",
        "target_weekday": None,
        "target_hour": None,
        "target_minute": None,
        "target_date": None,
        "start_local": None,
        "end_local": None,
        "day_count": 1,
        "beyond_horizon": False,
    }

    cal = _parse_calendar_date(text, ref)
    if cal:
        _log_horizon_check(cal["target_date"], ref.date(), cal["beyond_horizon"])
        return cal

    wk = _parse_weekday_expression(text, ref)
    if wk:
        return wk

    if re.search(r"\bthis\s+morning\b", low):
        out.update(time_kind="later_today", time_label="This morning", target_hour=9)
        return _attach_local_range(out, ref)
    if re.search(r"\bthis\s+afternoon\b", low):
        out.update(time_kind="later_today", time_label="This afternoon", target_hour=15)
        return _attach_local_range(out, ref)
    if re.search(r"\bthis\s+evening\b", low):
        out.update(time_kind="later_today", time_label="This evening", target_hour=19)
        return _attach_local_range(out, ref)

    if re.search(r"\blater\s+today\b", low):
        out.update(time_kind="later_today", time_label="Later today")
        return _attach_local_range(out, ref)

    if re.search(r"\btonight\b", low):
        out.update(time_kind="tonight", time_label="Tonight", target_hour=20, target_minute=0)
        return _attach_local_range(out, ref)

    m_next = _NEXT_DAYS_RE.search(low)
    if m_next:
        n_raw = m_next.group("n").lower()
        n = _DAY_WORDS.get(n_raw, int(n_raw) if n_raw.isdigit() else 3)
        out.update(time_kind="next_n_days", time_label=f"Next {n} days", day_count=n)
        if n > FORECAST_HORIZON_DAYS:
            out["beyond_horizon"] = True
        return _attach_local_range(out, ref)

    if re.search(r"\bthis\s+week\b", low):
        out.update(time_kind="this_week", time_label="This week", day_count=5)
        return _attach_local_range(out, ref)

    if re.search(r"\bthis\s+weekend\b", low):
        out.update(time_kind="weekend", time_label="This weekend", day_count=2)
        return _attach_local_range(out, ref)

    if re.search(r"\bnext\s+weekend\b", low):
        out.update(time_kind="next_weekend", time_label="Next weekend", day_count=2)
        return _attach_local_range(out, ref)

    if re.search(r"\btomorrow\s+morning\b", low):
        out.update(time_kind="tomorrow_morning", time_label="Tomorrow morning", target_hour=9)
        return _attach_local_range(out, ref)
    if re.search(r"\btomorrow\s+afternoon\b", low):
        out.update(time_kind="tomorrow_afternoon", time_label="Tomorrow afternoon", target_hour=15)
        return _attach_local_range(out, ref)
    if re.search(r"\btomorrow\s+evening\b", low):
        out.update(time_kind="tomorrow_evening", time_label="Tomorrow evening", target_hour=19)
        return _attach_local_range(out, ref)
    if re.search(r"\btomorrow\b", low):
        out.update(time_kind="tomorrow", time_label="Tomorrow")
        return _attach_local_range(out, ref)

    hour, minute = _parse_at_time(text)
    if hour is not None:
        label = f"At {hour % 12 or 12}:{minute:02d} {'PM' if hour >= 12 else 'AM'}"
        out.update(time_kind="at_time", time_label=label, target_hour=hour, target_minute=minute)
        if not re.search(r"\btomorrow\b", low) and not _WEEKDAY_EXPR_RE.search(low):
            out["time_kind"] = "today_at_time"
            out["time_label"] = f"Today {label.lower()}"
        return _attach_local_range(out, ref)

    if _FORECAST_WORD_RE.search(low):
        out.update(time_kind="multi_day", time_label="Forecast", day_count=3)
        return out

    return out


_BARE_WEATHER_ASK_RE = re.compile(
    r"^\s*(?:"
    r"(?:what(?:'s|s| is)|how(?:'s|s| is))\s+(?:the\s+)?weather\b|"
    r"weather\s+forecast\b|"
    r"will\s+it\s+(?:rain|snow)\b|"
    r"(?:is\s+there|any)\s+(?:rain|snow)\b"
    r")\s*[?.!]?\s*$",
    re.IGNORECASE,
)

_CONTINUATION_CUE_RE = re.compile(
    r"\b(?:what\s+about|how\s+about)\b",
    re.IGNORECASE,
)


def is_bare_vague_weather_ask(text: str) -> bool:
    return bool(_BARE_WEATHER_ASK_RE.search((text or "").strip()))


def is_weather_continuation_phrase(text: str) -> bool:
    return bool(_CONTINUATION_CUE_RE.search(text or ""))


def is_fresh_forecast_time_anchor(text: str) -> bool:
    """True when the user named a future time without a continuation cue (no prior-context reuse)."""
    raw = (text or "").strip()
    if not raw or is_weather_continuation_phrase(raw):
        return False
    return bool(_FUTURE_TIME_RE.search(raw))


def is_forecast_query(text: str) -> bool:
    raw = (text or "").strip()
    if not raw:
        return False
    if _CURRENT_CUE_RE.search(raw):
        return False
    if _FORECAST_WORD_RE.search(raw):
        return True
    if _FUTURE_TIME_RE.search(raw):
        return True
    if _RAIN_INTENT_RE.search(raw) and re.search(r"\bwill\b", raw, re.IGNORECASE):
        return True
    if is_bare_vague_weather_ask(raw):
        return True
    return False


def _has_specific_forecast_time(time_info: dict[str, Any]) -> bool:
    time_kind = str(time_info.get("time_kind") or "now").strip()
    return time_kind not in ("now", "multi_day")


def _forecast_needs_time_clarification(raw: str, time_info: dict[str, Any], action_name: str) -> bool:
    if action_name != "weather.forecast":
        return False
    if _has_specific_forecast_time(time_info):
        return False
    time_kind = str(time_info.get("time_kind") or "now").strip()
    if time_kind == "multi_day":
        return True
    if is_bare_vague_weather_ask(raw):
        return True
    if _RAIN_INTENT_RE.search(raw) and not _FUTURE_TIME_RE.search(raw):
        return True
    return False


def compute_weather_missing_fields(
    raw: str,
    *,
    location: str | None,
    location_kind: str,
    time_info: dict[str, Any],
    action_name: str,
) -> list[str]:
    """Return ordered missing slot names: location, time, or both."""
    missing: list[str] = []
    has_location = bool(str(location or "").strip()) and location_kind == "explicit"
    if location_kind in ("missing", "near_me") or not has_location:
        missing.append("location")
    if _forecast_needs_time_clarification(raw, time_info, action_name):
        missing.append("time")
    return missing


def parse_weather_query(text: str, *, reference_dt: datetime | None = None) -> dict[str, Any]:
    """Return a structured parse dict for routing and forecast selection."""
    raw = (text or "").strip()
    ref = reference_dt or datetime.now(timezone.utc)
    location_raw, location_kind = _extract_location(raw)
    location = strip_weather_time_from_location(location_raw or "") if location_raw else None
    time_info = _parse_time_query(raw, ref_local=ref)
    intent = _detect_intent(raw)
    action_name = "weather.forecast" if is_forecast_query(raw) else "weather.current"

    if _has_specific_forecast_time(time_info) and not _CURRENT_CUE_RE.search(raw):
        action_name = "weather.forecast"

    missing_fields = compute_weather_missing_fields(
        raw,
        location=location,
        location_kind=location_kind,
        time_info=time_info,
        action_name=action_name,
    )
    needs_location = "location" in missing_fields
    needs_time = "time" in missing_fields

    result = {
        "raw_text": raw,
        "action_name": action_name,
        "location": location,
        "location_kind": location_kind,
        "needs_location": needs_location,
        "needs_time": needs_time,
        "missing_fields": missing_fields,
        "intent": intent,
        "query": {
            "time_kind": time_info.get("time_kind") or "now",
            "time_label": time_info.get("time_label") or "Now",
            "target_weekday": time_info.get("target_weekday"),
            "target_hour": time_info.get("target_hour"),
            "target_minute": time_info.get("target_minute"),
            "target_date": time_info.get("target_date"),
            "start_local": time_info.get("start_local"),
            "end_local": time_info.get("end_local"),
            "day_count": time_info.get("day_count") or 1,
            "beyond_horizon": bool(time_info.get("beyond_horizon")),
        },
    }

    try:
        print(
            "[weather_forecast_parse] "
            + json.dumps(
                {
                    "raw_text": raw[:240],
                    "action_name": action_name,
                    "parsed_location": location_raw,
                    "stripped_location": location,
                    "location": location,
                    "location_kind": location_kind,
                    "normalized_date": result["query"].get("target_date")
                    or result["query"].get("start_local"),
                    "time_kind": result["query"]["time_kind"],
                    "time_label": result["query"]["time_label"],
                    "start_local": result["query"].get("start_local"),
                    "end_local": result["query"].get("end_local"),
                    "intent": intent,
                    "needs_location": needs_location,
                    "needs_time": needs_time,
                    "missing_fields": missing_fields,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass

    return result


def patch_has_forecast_time(patch: dict[str, Any]) -> bool:
    q = patch.get("query") or {}
    return _has_specific_forecast_time(q)


def merge_weather_parsed(
    base: dict[str, Any],
    patch: dict[str, Any],
    *,
    merge_time: bool = True,
    merge_location: bool = True,
) -> dict[str, Any]:
    """Merge a clarification reply parse into a prior pending weather parse."""
    out = dict(base or {})
    out_query = dict(out.get("query") or {})
    patch_query = dict(patch.get("query") or {})

    if merge_location and patch.get("location"):
        out["location"] = patch.get("location")
        out["location_kind"] = patch.get("location_kind") or "explicit"

    if merge_time and patch_has_forecast_time(patch):
        for key in (
            "time_kind",
            "time_label",
            "target_weekday",
            "target_hour",
            "target_minute",
            "target_date",
            "start_local",
            "end_local",
            "day_count",
            "beyond_horizon",
        ):
            if patch_query.get(key) is not None:
                out_query[key] = patch_query[key]

    if patch.get("intent") and patch.get("intent") != "general":
        out["intent"] = patch.get("intent")

    out["query"] = out_query
    out["action_name"] = "weather.forecast"
    out["needs_location"] = False
    out["needs_time"] = False
    out["missing_fields"] = []
    return out


def apply_recent_weather_context_to_parsed(
    raw: str,
    parsed: dict[str, Any],
    recent: dict | None,
) -> dict[str, Any]:
    """Reuse recent weather location/time only for clear follow-ups — never fresh time-only asks."""
    if not recent or recent.get("action_name") not in ("weather.current", "weather.forecast"):
        return parsed
    if is_fresh_forecast_time_anchor(raw):
        return parsed

    prior_slots = dict(recent.get("slots") or {})
    recent_loc = str(prior_slots.get("location") or "").strip()
    recent_query = dict(prior_slots.get("parsed_weather") or {}).get("query") or {}
    if not recent_loc:
        data = (recent.get("result") or {}).get("data") or {}
        recent_loc = str(data.get("place_name") or "").strip()

    out = dict(parsed)
    out_query = dict(out.get("query") or {})
    missing = list(out.get("missing_fields") or [])

    continuation = is_weather_continuation_phrase(raw)
    rain_followup = bool(
        _RAIN_INTENT_RE.search(raw or "")
        and recent
        and not out.get("location")
        and "location" in missing
    )
    if not continuation and not rain_followup:
        return parsed

    if recent_loc and ("location" in missing or not out.get("location")):
        out["location"] = recent_loc
        out["location_kind"] = "explicit"
        missing = [m for m in missing if m != "location"]

    if "time" in missing and _has_specific_forecast_time(recent_query):
        for key in (
            "time_kind",
            "time_label",
            "target_weekday",
            "target_hour",
            "target_minute",
            "target_date",
            "start_local",
            "end_local",
            "day_count",
            "beyond_horizon",
        ):
            if recent_query.get(key) is not None:
                out_query[key] = recent_query[key]
        missing = [m for m in missing if m != "time"]

    out["query"] = out_query
    out["missing_fields"] = missing
    out["needs_location"] = "location" in missing
    out["needs_time"] = "time" in missing
    return out


def weekday_index_after(ref_local: datetime, target_weekday: int) -> datetime.date:
    """Next occurrence of weekday (0=Mon) on or after ref_local.date()."""
    today = ref_local.date()
    delta = (target_weekday - today.weekday()) % 7
    if delta == 0 and ref_local.hour >= 20:
        delta = 7
    return today + timedelta(days=delta)


__all__ = [
    "parse_weather_query",
    "is_forecast_query",
    "is_bare_vague_weather_ask",
    "is_weather_continuation_phrase",
    "is_fresh_forecast_time_anchor",
    "compute_weather_missing_fields",
    "merge_weather_parsed",
    "patch_has_forecast_time",
    "apply_recent_weather_context_to_parsed",
    "weekday_index_after",
    "strip_weather_time_from_location",
    "parse_calendar_day_token",
    "FORECAST_HORIZON_DAYS",
]
