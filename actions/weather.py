import json
import os
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests

from actions.weather_query_parse import parse_weather_query, weekday_index_after

DEFAULT_LOCATION = "Fountain Valley"
DEFAULT_LAT = 33.7092
DEFAULT_LON = -117.9540
FALLBACK_API_KEY = "9406cd799a8355297a79841d07a313d1"
FORECAST_HORIZON_DAYS = 5

CACHE_TTL = 300  # 5 minutes
_weather_cache = {}
_forecast_cache = {}


def _api_key() -> str:
    return (os.environ.get("OPENWEATHER_API_KEY") or "").strip() or FALLBACK_API_KEY


def normalize_location_key(location: str) -> str:
    return " ".join(location.lower().strip().split())


def format_place_name(geo_result: dict) -> str:
    parts = [geo_result.get("name"), geo_result.get("state"), geo_result.get("country")]
    return ", ".join(part for part in parts if part)


def geocode_location(location: str):
    loc = str(location or "").strip()
    if not loc:
        return None

    try:
        print(
            "[weather_geocode_attempt] "
            + json.dumps({"location": loc[:120]}, ensure_ascii=False),
            flush=True,
        )
    except Exception:
        pass

    resp = requests.get(
        "https://api.openweathermap.org/geo/1.0/direct",
        params={
            "q": location,
            "limit": 1,
            "appid": _api_key(),
        },
        timeout=4,
    )
    resp.raise_for_status()

    try:
        from cost_logging import log_openweather_event

        log_openweather_event(endpoint="openweather.geocode", call_count=1, extra={"query": location})
    except Exception as _ow_err:
        print(f"[cost_logger] openweather geocode log skipped: {_ow_err}")

    results = resp.json()
    if not results:
        try:
            print(
                "[weather_geocode_failed] "
                + json.dumps({"location": (location or "")[:120]}, ensure_ascii=False),
                flush=True,
            )
        except Exception:
            pass
        return None

    top = results[0]
    place_name = format_place_name(top) or location
    return place_name, top["lat"], top["lon"]


def fetch_weather(lat: float, lon: float):
    resp = requests.get(
        "https://api.openweathermap.org/data/2.5/weather",
        params={
            "lat": lat,
            "lon": lon,
            "appid": _api_key(),
            "units": "imperial",
        },
        timeout=4,
    )
    resp.raise_for_status()

    try:
        from cost_logging import log_openweather_event

        log_openweather_event(
            endpoint="openweather.weather",
            call_count=1,
            extra={"lat": lat, "lon": lon},
        )
    except Exception as _ow_err:
        print(f"[cost_logger] openweather weather log skipped: {_ow_err}")

    return resp.json()


def fetch_forecast(lat: float, lon: float):
    resp = requests.get(
        "https://api.openweathermap.org/data/2.5/forecast",
        params={
            "lat": lat,
            "lon": lon,
            "appid": _api_key(),
            "units": "imperial",
        },
        timeout=4,
    )
    resp.raise_for_status()

    try:
        from cost_logging import log_openweather_event

        log_openweather_event(
            endpoint="openweather.forecast",
            call_count=1,
            extra={"lat": lat, "lon": lon},
        )
    except Exception as _ow_err:
        print(f"[cost_logger] openweather forecast log skipped: {_ow_err}")

    try:
        print(
            "[weather_forecast_fetch] "
            + json.dumps(
                {
                    "lat": lat,
                    "lon": lon,
                    "slot_count": len((resp.json() or {}).get("list") or []),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass

    return resp.json()


def extract_weather_facts(place_name: str, data: dict) -> dict:
    rain = data.get("rain", {})
    snow = data.get("snow", {})

    return {
        "place_name": place_name,
        "temperature_f": round(data["main"]["temp"]),
        "feels_like_f": round(data["main"].get("feels_like", data["main"]["temp"])),
        "condition": data["weather"][0]["description"],
        "wind_mph": round(data["wind"].get("speed", 0)),
        "wind_gust_mph": round(data["wind"].get("gust", 0)) if data["wind"].get("gust") is not None else None,
        "humidity_percent": data["main"].get("humidity"),
        "pressure_hpa": data["main"].get("pressure"),
        "cloudiness_percent": data.get("clouds", {}).get("all"),
        "visibility_m": data.get("visibility"),
        "rain_1h_mm": rain.get("1h", 0.0),
        "rain_3h_mm": rain.get("3h", 0.0),
        "snow_1h_mm": snow.get("1h", 0.0),
        "snow_3h_mm": snow.get("3h", 0.0),
    }


def _local_dt_from_utc(dt_utc: datetime, tz_offset_sec: int) -> datetime:
    return dt_utc + timedelta(seconds=int(tz_offset_sec or 0))


def extract_forecast_slots(data: dict) -> tuple[list[dict], int]:
    tz_offset = int((data.get("city") or {}).get("timezone") or 0)
    slots: list[dict] = []
    for item in data.get("list") or []:
        dt_utc = datetime.fromtimestamp(int(item["dt"]), tz=timezone.utc)
        local = _local_dt_from_utc(dt_utc, tz_offset)
        main = item.get("main") or {}
        weather0 = (item.get("weather") or [{}])[0]
        wind = item.get("wind") or {}
        pop = float(item.get("pop") or 0.0)
        hour12 = local.strftime("%I").lstrip("0") or "12"
        local_time = f"{hour12}:{local.strftime('%M %p')}"
        slots.append(
            {
                "dt_utc": dt_utc.isoformat(),
                "local_date": local.date().isoformat(),
                "local_time": local_time,
                "local_hour": local.hour,
                "temp_f": round(float(main.get("temp", 0))),
                "temp_min_f": round(float(main.get("temp_min", main.get("temp", 0)))),
                "temp_max_f": round(float(main.get("temp_max", main.get("temp", 0)))),
                "condition": str(weather0.get("description") or "").strip(),
                "pop_percent": round(pop * 100),
                "wind_mph": round(float(wind.get("speed") or 0)),
                "humidity_percent": main.get("humidity"),
            }
        )
    return slots, tz_offset


def aggregate_daily(slots: list[dict]) -> list[dict]:
    by_date: dict[str, list[dict]] = {}
    for s in slots:
        by_date.setdefault(s["local_date"], []).append(s)
    daily: list[dict] = []
    for date_key in sorted(by_date.keys()):
        group = by_date[date_key]
        metrics = summarize_daily_group(group)
        daily.append(
            {
                "date": date_key,
                "label": datetime.fromisoformat(date_key).strftime("%a %b %d").replace(" 0", " "),
                **metrics,
                "slots": group,
            }
        )
    return daily


def summarize_daily_group(group: list[dict]) -> dict[str, Any]:
    """Single source of truth for daily high/low/rain/wind/condition."""
    temps = [g["temp_f"] for g in group]
    pops = [g["pop_percent"] for g in group]
    winds = [g["wind_mph"] for g in group]
    conditions = [g["condition"] for g in group if g.get("condition")]
    return {
        "high_f": max(temps) if temps else None,
        "low_f": min(temps) if temps else None,
        "max_pop_percent": max(pops) if pops else 0,
        "max_wind_mph": max(winds) if winds else 0,
        "condition": max(set(conditions), key=conditions.count) if conditions else "",
    }


def _log_forecast_slots_selected(selected_slots: list[dict], *, target_dates: list[str]) -> None:
    try:
        print(
            "[weather_forecast_slots_selected] "
            + json.dumps(
                {
                    "count": len(selected_slots),
                    "target_dates": target_dates,
                    "slot_times_local": [s.get("local_time") for s in selected_slots],
                    "local_dates": sorted({s.get("local_date") for s in selected_slots if s.get("local_date")}),
                    "temps": [s.get("temp_f") for s in selected_slots],
                    "pops": [s.get("pop_percent") for s in selected_slots],
                    "winds": [s.get("wind_mph") for s in selected_slots],
                    "conditions": [s.get("condition") for s in selected_slots],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception:
        pass


def _log_forecast_summary_calc(daily_rows: list[dict]) -> None:
    try:
        rows = []
        for day in daily_rows:
            rows.append(
                {
                    "date": day.get("date"),
                    "high": day.get("high_f"),
                    "low": day.get("low_f"),
                    "max_pop": day.get("max_pop_percent"),
                    "max_wind": day.get("max_wind_mph"),
                    "representative_condition": day.get("condition"),
                }
            )
        print(
            "[weather_forecast_summary_calc] "
            + json.dumps({"rows": rows}, ensure_ascii=False),
            flush=True,
        )
    except Exception:
        pass


def _date_beyond_forecast_horizon(d: date, today: date) -> bool:
    return d > today + timedelta(days=FORECAST_HORIZON_DAYS)


def _single_day_from_query(q: dict, today: date) -> tuple[list[str], bool] | None:
    td = q.get("target_date") or q.get("start_local")
    if not td:
        return None
    try:
        d = date.fromisoformat(str(td))
    except ValueError:
        return None
    if _date_beyond_forecast_horizon(d, today):
        return [], True
    return [str(td)], False


def _date_range_from_query(q: dict, today: date) -> tuple[list[str], bool] | None:
    start = q.get("start_local")
    end = q.get("end_local")
    if not start or not end or start == end:
        return None
    try:
        s = date.fromisoformat(str(start))
        e = date.fromisoformat(str(end))
    except ValueError:
        return None
    if _date_beyond_forecast_horizon(e, today):
        return [], True
    out: list[str] = []
    cur = s
    while cur <= e:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out, False


def _target_dates(parsed: dict, tz_offset: int, slots: list[dict]) -> tuple[list[str], bool]:
    q = parsed.get("query") or {}
    time_kind = q.get("time_kind") or "now"
    ref_utc = datetime.now(timezone.utc)
    ref_local = _local_dt_from_utc(ref_utc, tz_offset)
    today = ref_local.date()
    all_dates = sorted({s["local_date"] for s in slots})
    if not all_dates:
        return [], False

    def _date_str(d):
        return d.isoformat()

    range_resolved = _date_range_from_query(q, today)
    if range_resolved is not None:
        return range_resolved

    if time_kind == "tomorrow" or time_kind.startswith("tomorrow_"):
        resolved = _single_day_from_query(q, today)
        if resolved is not None:
            return resolved
        return [_date_str(today + timedelta(days=1))], False
    if time_kind == "tonight":
        resolved = _single_day_from_query(q, today)
        if resolved is not None:
            return resolved
        return [_date_str(today)], False
    if time_kind in ("later_today", "today_at_time", "at_time"):
        resolved = _single_day_from_query(q, today)
        if resolved is not None:
            return resolved
        return [_date_str(today)], False
    if time_kind == "weekend":
        resolved = _date_range_from_query(
            {
                "start_local": q.get("start_local"),
                "end_local": q.get("end_local"),
            },
            today,
        )
        if resolved is not None:
            return resolved
        sat = today + timedelta(days=(5 - today.weekday()) % 7)
        if sat == today and ref_local.hour >= 12:
            sat = today + timedelta(days=7)
        sun = sat + timedelta(days=1)
        return [_date_str(sat), _date_str(sun)], False
    if time_kind == "next_weekend":
        resolved = _date_range_from_query(
            {
                "start_local": q.get("start_local"),
                "end_local": q.get("end_local"),
            },
            today,
        )
        if resolved is not None:
            return resolved
        sat = today + timedelta(days=(5 - today.weekday()) % 7 + 7)
        sun = sat + timedelta(days=1)
        return [_date_str(sat), _date_str(sun)], False
    if time_kind == "this_week":
        return all_dates[: min(5, len(all_dates))], False
    if time_kind == "next_n_days":
        resolved = _date_range_from_query(q, today)
        if resolved is not None:
            return resolved
        n = int(q.get("day_count") or 3)
        if n > FORECAST_HORIZON_DAYS:
            return [], True
        out = []
        for i in range(n):
            d = today + timedelta(days=i + 1)
            out.append(_date_str(d))
        return out, False
    if time_kind == "date" and q.get("target_date"):
        resolved = _single_day_from_query(q, today)
        if resolved is not None:
            return resolved
        return [], False
    if time_kind == "weekday":
        resolved = _single_day_from_query(q, today)
        if resolved is not None:
            return resolved
        if q.get("target_weekday") is not None:
            target = weekday_index_after(ref_local, int(q["target_weekday"]))
            if target > today + timedelta(days=FORECAST_HORIZON_DAYS):
                return [], True
            return [_date_str(target)], False
    if time_kind == "multi_day":
        n = min(int(q.get("day_count") or 3), len(all_dates))
        return all_dates[:n], False
    return all_dates[:3], False


def select_forecast_view(slots: list[dict], parsed: dict, tz_offset: int) -> dict:
    daily = aggregate_daily(slots)
    slot_dates = sorted({s["local_date"] for s in slots})
    target_dates, beyond = _target_dates(parsed, tz_offset, slots)
    first_slot_date = slot_dates[0] if slot_dates else None
    last_slot_date = slot_dates[-1] if slot_dates else None

    if target_dates and slot_dates:
        missing = [td for td in target_dates if td not in slot_dates]
        if missing:
            try:
                from actions.weather_query_parse import _log_horizon_check

                ref_local = _local_dt_from_utc(datetime.now(timezone.utc), tz_offset)
                for td in missing:
                    _log_horizon_check(
                        td,
                        ref_local.date(),
                        True,
                        first_slot_date=first_slot_date,
                        last_slot_date=last_slot_date,
                    )
            except Exception:
                pass
            return {
                "beyond_horizon": True,
                "daily": daily,
                "selected_slots": [],
                "selected_daily": [],
                "first_slot_date": first_slot_date,
                "last_slot_date": last_slot_date,
            }

    if beyond:
        return {
            "beyond_horizon": True,
            "daily": daily,
            "selected_slots": [],
            "selected_daily": [],
            "first_slot_date": first_slot_date,
            "last_slot_date": last_slot_date,
        }

    selected_daily = [d for d in daily if d["date"] in target_dates] if target_dates else daily[: min(3, len(daily))]
    if target_dates and not selected_daily:
        return {
            "beyond_horizon": True,
            "daily": daily,
            "selected_slots": [],
            "selected_daily": [],
            "first_slot_date": first_slot_date,
            "last_slot_date": last_slot_date,
        }

    q = parsed.get("query") or {}
    selected_slots: list[dict] = []
    if q.get("time_kind") in ("at_time", "today_at_time", "tonight", "tomorrow_morning", "tomorrow_afternoon", "tomorrow_evening"):
        target_hour = q.get("target_hour")
        pool = selected_daily[0]["slots"] if selected_daily else slots
        if target_hour is not None and pool:
            best = min(pool, key=lambda s: abs(int(s["local_hour"]) - int(target_hour)))
            selected_slots = [best]
        elif q.get("time_kind") == "tonight" and pool:
            evening = [s for s in pool if s["local_hour"] >= 17]
            selected_slots = evening[:1] if evening else pool[-1:]
    else:
        for day in selected_daily:
            selected_slots.extend(day.get("slots") or [])

    _log_forecast_slots_selected(selected_slots, target_dates=target_dates)
    _log_forecast_summary_calc(selected_daily)

    return {
        "beyond_horizon": False,
        "daily": daily,
        "selected_daily": selected_daily,
        "selected_slots": selected_slots,
        "first_slot_date": first_slot_date,
        "last_slot_date": last_slot_date,
    }


def build_forecast_voice_summary(parsed: dict, place_name: str, view: dict) -> str:
    if view.get("beyond_horizon"):
        return (
            "I can only forecast about five days ahead with the current weather service. "
            "Try a closer date."
        )

    q = parsed.get("query") or {}
    time_label = q.get("time_label") or "the forecast period"
    intent = parsed.get("intent") or "general"
    daily = view.get("selected_daily") or []
    if not daily:
        return f"I couldn't find a forecast for {place_name} for {time_label}."

    if len(daily) == 1:
        day = daily[0]
        high = day.get("high_f")
        low = day.get("low_f")
        cond = day.get("condition") or "mixed conditions"
        pop = day.get("max_pop_percent") or 0
        wind = day.get("max_wind_mph") or 0
        parts = [
            f"For {time_label} in {place_name}, expect {cond}",
            f"with a high near {high} and a low near {low} degrees",
        ]
        if intent == "rain" or pop >= 30:
            parts.append(f"around a {pop} percent chance of rain")
        elif pop >= 15:
            parts.append(f"with about a {pop} percent chance of rain")
        if intent == "wind" or wind >= 15:
            parts.append(f"and winds up to about {wind} miles per hour")
        return ", ".join(parts) + "."

    summaries = []
    for day in daily[:3]:
        summaries.append(
            f"{day.get('label')}: {day.get('condition') or 'mixed conditions'}, "
            f"high {day.get('high_f')} and low {day.get('low_f')}"
            + (f", up to {day.get('max_pop_percent')}% rain" if (day.get('max_pop_percent') or 0) >= 25 else "")
        )
    return f"Here's the forecast for {place_name}. " + "; ".join(summaries) + "."


def _forecast_ui_rows(view: dict) -> list[dict]:
    rows = []
    for day in view.get("selected_daily") or []:
        rows.append(
            {
                "label": day.get("label") or day.get("date"),
                "date": day.get("date"),
                "condition": day.get("condition") or "",
                "high_f": day.get("high_f"),
                "low_f": day.get("low_f"),
                "rain_percent": day.get("max_pop_percent"),
                "wind_mph": day.get("max_wind_mph"),
            }
        )
    return rows


def _forecast_note(parsed: dict, view: dict) -> str:
    intent = parsed.get("intent") or "general"
    daily = view.get("selected_daily") or []
    if not daily:
        return ""
    pop = max((d.get("max_pop_percent") or 0) for d in daily)
    if intent == "rain" or pop >= 50:
        return "Rain is likely — an umbrella may be useful."
    if pop >= 25:
        return "Some rain is possible."
    high = max((d.get("high_f") or 0) for d in daily)
    if intent == "temperature" and high >= 90:
        return "It may feel quite hot."
    if intent == "temperature" and max((d.get("low_f") or 99) for d in daily) <= 40:
        return "Dress warmly — lows may be chilly."
    return ""


def handle_weather_forecast_request(
    *,
    location: str | None = None,
    parsed_query: dict | None = None,
    user_text: str | None = None,
):
    parsed = parsed_query or parse_weather_query(user_text or "")
    q = parsed.get("query") or {}

    if parsed.get("needs_location") or parsed.get("needs_time") or parsed.get("missing_fields"):
        missing = list(parsed.get("missing_fields") or [])
        if parsed.get("needs_location") and "location" not in missing:
            missing.insert(0, "location")
        if parsed.get("needs_time") and "time" not in missing:
            missing.append("time")
        if "location" in missing and parsed.get("location_kind") == "near_me":
            msg = "I don't have your location yet. Which city should I check the forecast for?"
        elif "location" in missing and "time" in missing:
            msg = "What location and time should I check?"
        elif "time" in missing:
            msg = "For when should I check the forecast?"
        else:
            msg = "What location should I check?"
        return {
            "spoken_reply": msg,
            "action_type": "weather_forecast",
            "data": None,
            "ui_payload": None,
            "needs_followup": True,
            "missing_slot": (
                "both"
                if "location" in missing and "time" in missing
                else ("time" if "time" in missing else "location")
            ),
        }

    requested_location = str(location or parsed.get("location") or "").strip()
    if not requested_location:
        return {
            "spoken_reply": "What location should I check?",
            "action_type": "weather_forecast",
            "data": None,
            "ui_payload": None,
            "needs_followup": True,
            "missing_slot": "location",
        }

    if q.get("beyond_horizon"):
        return {
            "spoken_reply": (
                "I can only forecast about five days ahead with the current weather service."
            ),
            "action_type": "weather_forecast",
            "data": None,
            "ui_payload": None,
        }

    cache_key = normalize_location_key(
        f"forecast:{requested_location}:{q.get('time_kind')}:{q.get('target_date') or q.get('start_local') or ''}"
    )
    now = time.time()
    cached = _forecast_cache.get(cache_key)
    if cached and now - cached["timestamp"] < CACHE_TTL:
        return cached["result"]

    try:
        geo_result = geocode_location(requested_location)
        if geo_result is None:
            return {
                "spoken_reply": "I couldn't recognize that location.",
                "action_type": "weather_forecast",
                "data": None,
                "ui_payload": None,
            }

        place_name, lat, lon = geo_result
        try:
            print(
                "[weather_forecast_fetch] "
                + json.dumps(
                    {
                        "location": place_name,
                        "time_label": q.get("time_label"),
                        "time_kind": q.get("time_kind"),
                        "normalized_date": q.get("target_date") or q.get("start_local"),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass
        data = fetch_forecast(lat, lon)
        slots, tz_offset = extract_forecast_slots(data)
        view = select_forecast_view(slots, parsed, tz_offset)
        try:
            from actions.weather_query_parse import _log_horizon_check

            ref_local = _local_dt_from_utc(datetime.now(timezone.utc), tz_offset)
            norm_date = q.get("target_date") or q.get("start_local")
            if norm_date:
                _log_horizon_check(
                    str(norm_date),
                    ref_local.date(),
                    bool(view.get("beyond_horizon")),
                    first_slot_date=view.get("first_slot_date"),
                    last_slot_date=view.get("last_slot_date"),
                )
        except Exception:
            pass

        if view.get("beyond_horizon"):
            return {
                "spoken_reply": (
                    "I can only forecast about five days ahead with the current weather service."
                ),
                "action_type": "weather_forecast",
                "data": {"place_name": place_name, "query": q},
                "ui_payload": None,
            }

        selected_daily = view.get("selected_daily") or []
        summary_block = {}
        if selected_daily:
            highs = [d.get("high_f") for d in selected_daily if d.get("high_f") is not None]
            lows = [d.get("low_f") for d in selected_daily if d.get("low_f") is not None]
            summary_block = {
                "condition": selected_daily[0].get("condition") or "",
                "high_f": max(highs) if highs else None,
                "low_f": min(lows) if lows else None,
                "max_pop_percent": max((d.get("max_pop_percent") or 0) for d in selected_daily),
                "max_wind_mph": max((d.get("max_wind_mph") or 0) for d in selected_daily),
            }

        spoken = build_forecast_voice_summary(parsed, place_name, view)
        try:
            print(
                "[weather_forecast_voice] "
                + json.dumps(
                    {
                        "place_name": place_name,
                        "time_label": q.get("time_label"),
                        "spoken_reply": spoken,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass

        rows = _forecast_ui_rows(view)
        note = _forecast_note(parsed, view)
        ui_payload = {
            "panel_type": "weather_forecast_panel",
            "title": "Weather forecast",
            "location": place_name,
            "time_range_label": q.get("time_label") or "Forecast",
            "summary": spoken,
            "rows": rows,
            "notes": note,
        }
        try:
            print(
                "[weather_forecast_panel] "
                + json.dumps(
                    {
                        "location": place_name,
                        "time_range_label": q.get("time_label"),
                        "normalized_date": q.get("target_date") or q.get("start_local"),
                        "row_count": len(rows),
                        "rows": rows,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception:
            pass

        result = {
            "spoken_reply": spoken,
            "action_type": "weather_forecast",
            "data": {
                "place_name": place_name,
                "query": q,
                "summary": summary_block,
                "slots": view.get("selected_slots") or [],
                "daily": selected_daily,
            },
            "ui_payload": ui_payload,
        }
        _forecast_cache[cache_key] = {"result": result, "timestamp": now}
        return result

    except Exception as e:
        print("Weather forecast fetch error:", e)
        try:
            from safety_limits import FallbackMessages as _SF, log_safety_block as _sl

            _sl(reason="weather_forecast_api_failure", mode="non_work", feature="weather", extra={"error": str(e)[:200]})
            _msg = _SF.WEATHER_FAILURE
        except Exception:
            _msg = "Weather information is not available right now."
        return {
            "spoken_reply": _msg,
            "action_type": "weather_forecast",
            "data": None,
            "ui_payload": None,
            "service_failure": "weather",
        }


def build_weather_prompt(facts: dict) -> str:
    return (
        f"Provide the current weather for {facts['place_name']} clearly and calmly.\n"
        "Use natural spoken language suitable for a voice assistant.\n\n"
        "Tone for this briefing only: practical and straightforward—not funny, not cute, not teasing. "
        "Do not use the listener's name, habits, interests, or schedule.\n\n"
        "Give the main answer in one or two short sentences: temperature, overall conditions, and wind when notable.\n"
        "Then you may add at most one brief proactive sentence of practical care when the data below clearly supports it "
        "(e.g. rain or storms → umbrella or waterproof layer; very hot → shade or hydration; very cold or big wind-chill gap → "
        "extra layer; snow or ice → traction or warmth). Keep it matter-of-fact, not preachy.\n"
        "If conditions are ordinary, skip the extra sentence.\n"
        "Do not lead with humidity, pressure, visibility, or cloud percentage unless needed for clarity.\n\n"
        f"Temperature: {facts['temperature_f']} degrees Fahrenheit\n"
        f"Feels like: {facts['feels_like_f']} degrees Fahrenheit\n"
        f"Conditions: {facts['condition']}\n"
        f"Wind speed: {facts['wind_mph']} miles per hour\n"
        f"Wind gust: {facts['wind_gust_mph']} miles per hour\n"
        f"Humidity: {facts['humidity_percent']} percent\n"
        f"Pressure: {facts['pressure_hpa']} hPa\n"
        f"Cloud cover: {facts['cloudiness_percent']} percent\n"
        f"Visibility: {facts['visibility_m']} meters\n"
        f"Rain (last 1h): {facts['rain_1h_mm']} mm\n"
        f"Rain (last 3h): {facts['rain_3h_mm']} mm\n"
        f"Snow (last 1h): {facts['snow_1h_mm']} mm\n"
        f"Snow (last 3h): {facts['snow_3h_mm']} mm\n"
    )


def fetch_weather_facts_for_action(location=None):
    """
    Geocode + OpenWeather fetch only (no LLM). Returns (facts, None) or (None, error_action_result).
    """
    requested_location = str(location or "").strip()
    if not requested_location:
        return None, {
            "spoken_reply": "Which location should I check?",
            "action_type": "weather",
            "data": None,
            "ui_payload": None,
            "needs_followup": True,
            "missing_slot": "location",
        }
    cache_key = normalize_location_key(requested_location)
    now = time.time()

    cached = _weather_cache.get(cache_key)
    if cached and now - cached["timestamp"] < CACHE_TTL:
        facts = (cached["result"] or {}).get("data")
        if facts:
            return facts, None

    try:
        geo_result = geocode_location(requested_location)
        if geo_result is None:
            return None, {
                "spoken_reply": "I couldn't recognize that location.",
                "action_type": "weather",
                "data": None,
                "ui_payload": None,
            }

        place_name, lat, lon = geo_result
        data = fetch_weather(lat, lon)
        facts = extract_weather_facts(place_name, data)
        return facts, None

    except Exception as e:
        print("Weather fetch error:", e)
        try:
            from safety_limits import FallbackMessages as _SF, log_safety_block as _sl

            _sl(reason="weather_api_failure", mode="non_work", feature="weather", extra={"error": str(e)[:200]})
            _msg = _SF.WEATHER_FAILURE
        except Exception:
            _msg = "Weather information is not available right now."
        return None, {
            "spoken_reply": _msg,
            "action_type": "weather",
            "data": None,
            "ui_payload": None,
            "service_failure": "weather",
        }


def cache_weather_action_result(cache_key: str, result: dict) -> None:
    _weather_cache[cache_key] = {
        "result": result,
        "timestamp": time.time(),
    }


def handle_weather_request(vera, location=None):
    requested_location = str(location or "").strip()
    if not requested_location:
        return {
            "spoken_reply": "Which location should I check?",
            "action_type": "weather",
            "data": None,
            "ui_payload": None,
            "needs_followup": True,
            "missing_slot": "location",
        }
    cache_key = normalize_location_key(requested_location)

    facts, err = fetch_weather_facts_for_action(requested_location)
    if err:
        return err

    prompt = build_weather_prompt(facts)

    messages = vera.build_messages(
        chat_history=[],
        user_text=prompt,
    )

    text, _ = vera.generate(messages)

    result = {
        "spoken_reply": text,
        "action_type": "weather",
        "data": facts,
        "ui_payload": None,
    }

    cache_weather_action_result(cache_key, result)

    return result
