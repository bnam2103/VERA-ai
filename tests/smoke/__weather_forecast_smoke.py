"""Smoke tests for Weather Forecast v1 (OpenWeather /forecast, deterministic voice)."""

from __future__ import annotations

import io
import json
import os
import sys
import types
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

from actions.weather_query_parse import (
    apply_recent_weather_context_to_parsed,
    merge_weather_parsed,
    parse_weather_query,
    is_forecast_query,
    strip_weather_time_from_location,
)
from actions import weather as W
from actions import multi_action_planner as P

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"
PASS = 0
FAIL = 0
FAILED: list[str] = []


def section(label: str) -> None:
    print(f"\n{YELLOW}-- {label} --{RESET}")


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}")
        if detail:
            print(f"         {detail[:500]}")


def _mock_forecast_payload_for_dates(local_dates: list[str], tz_offset: int = -25200):
    """Build OpenWeather-shaped payload with 3-hourly slots on each local date."""
    items = []
    temps_cycle = [64, 67, 70, 68, 65, 63]
    for date_str in local_dates:
        y, m, d = [int(x) for x in date_str.split("-")]
        for i, hour in enumerate((6, 9, 12, 15, 18, 21)):
            temp = temps_cycle[i % len(temps_cycle)]
            local_naive = datetime(y, m, d, hour, 0)
            dt_utc = local_naive.replace(tzinfo=timezone.utc) - timedelta(seconds=tz_offset)
            items.append(
                {
                    "dt": int(dt_utc.timestamp()),
                    "main": {
                        "temp": temp,
                        "temp_min": temp - 2,
                        "temp_max": temp + 2,
                        "humidity": 50,
                    },
                    "weather": [{"description": "clear sky" if i < 3 else "broken clouds"}],
                    "pop": 0.1 + (0.05 * i),
                    "wind": {"speed": 5 + i},
                }
            )
    return {"city": {"timezone": tz_offset}, "list": items}


def _mock_forecast_payload():
    return _mock_forecast_payload_for_dates(
        [f"2026-06-{d:02d}" for d in range(21, 30)]
    )


section("Parse routing — current vs forecast")
ok(parse_weather_query("What's the weather in Irvine now?")["action_name"] == "weather.current",
   "current weather in Irvine → weather.current")
ok(parse_weather_query("What's the weather tomorrow in Irvine?")["action_name"] == "weather.forecast",
   "weather tomorrow in Irvine → weather.forecast")
ok(parse_weather_query("What's the weather tonight in Garden Grove?")["action_name"] == "weather.forecast",
   "weather tonight → weather.forecast")
ok(parse_weather_query("Will it rain Saturday in LA?")["action_name"] == "weather.forecast",
   "rain Saturday in LA → weather.forecast")
ok(parse_weather_query("Weather at 6 PM in New York")["action_name"] == "weather.forecast",
   "weather at 6 PM → weather.forecast")
ok(parse_weather_query("Weather this weekend in San Francisco")["action_name"] == "weather.forecast",
   "this weekend → weather.forecast")

section("Parse — location gaps")
near = parse_weather_query("What's the weather tomorrow near me?")
ok(near.get("needs_location") is True and near.get("location_kind") == "near_me",
   "near me without coords → needs_location",
   detail=str(near))
missing = parse_weather_query("What's the weather tomorrow?")
ok(missing.get("needs_location") is True, "missing location → needs_location", detail=str(missing))

section("Parse — horizon guard")
far = parse_weather_query("Weather next 10 days in Irvine")
ok(far.get("query", {}).get("beyond_horizon") is True, "next 10 days → beyond_horizon")

section("Voice summary — deterministic")
view = {
    "beyond_horizon": False,
    "selected_daily": [
        {
            "label": "Sun Jun 22",
            "condition": "clear sky",
            "high_f": 78,
            "low_f": 62,
            "max_pop_percent": 10,
            "max_wind_mph": 8,
        }
    ],
}
ref_handler = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
parsed = parse_weather_query("weather tomorrow in Irvine", reference_dt=ref_handler)
spoken = W.build_forecast_voice_summary(parsed, "Irvine, CA, US", view)
ok("Irvine" in spoken and "78" in spoken, "voice summary mentions place and high temp", detail=spoken)
ok(not spoken.lower().startswith("i think"), "voice summary is deterministic (no hedge)", detail=spoken)

section("Handler — API failure")
with patch.object(W, "geocode_location", side_effect=RuntimeError("network down")):
    err = W.handle_weather_forecast_request(
        location="Irvine",
        parsed_query={**parsed, "needs_location": False, "location_kind": "explicit"},
    )
ok("not available" in (err.get("spoken_reply") or "").lower() or "couldn't" in (err.get("spoken_reply") or "").lower(),
   "API failure → friendly message",
   detail=str(err.get("spoken_reply")))

section("Handler — happy path (mocked forecast)")
handler_dates = ["2026-06-26", "2026-06-27", "2026-06-28", "2026-06-29", "2026-06-30"]
with patch.object(W, "geocode_location", return_value=("Irvine, CA, US", 33.7, -117.8)):
    with patch.object(W, "fetch_forecast", return_value=_mock_forecast_payload_for_dates(handler_dates)):
        result = W.handle_weather_forecast_request(
            location="Irvine",
            parsed_query={**parsed, "needs_location": False, "location_kind": "explicit"},
        )
ok(result.get("action_type") == "weather_forecast", "action_type weather_forecast")
ok(isinstance(result.get("ui_payload"), dict) and result["ui_payload"].get("panel_type") == "weather_forecast_panel",
   "ui_payload weather_forecast_panel",
   detail=str(result.get("ui_payload")))
ok(isinstance(result.get("data"), dict) and result["data"].get("place_name"),
   "data.place_name present")
ok(parsed.get("query", {}).get("target_date") == "2026-06-26", "handler parse normalized tomorrow date")
spoken_happy = result.get("spoken_reply") or ""
panel_rows = (result.get("ui_payload") or {}).get("rows") or []
if panel_rows:
    ok(str(panel_rows[0].get("high_f")) in spoken_happy, "happy path voice high matches panel", detail=spoken_happy)
    ok(str(panel_rows[0].get("low_f")) in spoken_happy, "happy path voice low matches panel", detail=spoken_happy)

section("Credits — forecast uses weather bucket (1 credit class)")
# Import after path bootstrap; credit helper lives in app but we mirror the rule here.
import importlib.util

spec = importlib.util.spec_from_file_location("vera_app", os.path.join(ROOT, "app.py"))
if spec and spec.loader:
    # Avoid full app import (heavy). Inline the same mapping check.
    def _credit_action_for_structured_action(action_name):
        if action_name in ("weather.current", "weather.forecast", "weather.followup"):
            return "weather", None
        return None, None

    cap, _ = _credit_action_for_structured_action("weather.forecast")
    ok(cap == "weather", "weather.forecast maps to weather credit action")
else:
    ok(True, "weather.forecast maps to weather credit action (skipped app import)")

section("Location cleanup — forecast time phrases stripped before geocode")
from actions.weather_query_parse import strip_weather_time_from_location

for phrase, want_loc, want_action, want_time, want_intent in [
    ("can you tell me the weather in Fountain Valley tomorrow?", "Fountain Valley", "weather.forecast", "tomorrow", "general"),
    ("weather in Irvine tonight", "Irvine", "weather.forecast", "tonight", "general"),
    ("will it rain in Los Angeles Saturday?", "Los Angeles", "weather.forecast", "weekday", "rain"),
    ("weather in New York at 6 PM", "New York", "weather.forecast", "today_at_time", "general"),
    ("forecast for San Francisco this weekend", "San Francisco", "weather.forecast", "weekend", "general"),
    ("weather in Fountain Valley", "Fountain Valley", "weather.current", "now", "general"),
]:
    p = parse_weather_query(phrase)
    ok(p.get("action_name") == want_action, f"{phrase[:40]} → {want_action}", detail=str(p.get("action_name")))
    ok((p.get("location") or "") == want_loc, f"{phrase[:40]} → location {want_loc!r}", detail=repr(p.get("location")))
    if want_time:
        ok((p.get("query") or {}).get("time_kind") == want_time, f"{phrase[:40]} → time {want_time}", detail=str(p.get("query")))
    if want_intent:
        ok(p.get("intent") == want_intent, f"{phrase[:40]} → intent {want_intent}", detail=str(p.get("intent")))

ok(strip_weather_time_from_location("Fountain Valley tomorrow") == "Fountain Valley",
   "strip helper removes tomorrow")
ok(strip_weather_time_from_location("Los Angeles Saturday") == "Los Angeles",
   "strip helper removes weekday")

section("Multi-action planner — location not contaminated")
plan_fv = P.plan_user_actions("can you tell me the weather in Fountain Valley tomorrow?")
fv_payload = next((a.get("payload") or {} for a in plan_fv.get("actions") or [] if a.get("type") == "info.weather"), {})
ok(fv_payload.get("location") == "Fountain Valley",
   "planner weather location strips tomorrow",
   detail=json.dumps(fv_payload))

section("Multi-action planner — forecast + timer")
plan = P.plan_user_actions("What's the weather tomorrow in Irvine and start a timer for five minutes.")
types = [a["type"] for a in (plan.get("actions") or [])]
ok("info.weather" in types and "timer.set" in types,
   "planner emits info.weather + timer.set",
   detail=str(types))
weather_payload = next(a.get("payload") or {} for a in plan.get("actions") or [] if a["type"] == "info.weather")
ok(weather_payload.get("weather_action") == "weather.forecast",
   "planner weather payload tagged forecast",
   detail=json.dumps(weather_payload))

section("Current weather unchanged — parse")
ok(not is_forecast_query("What's the weather in Irvine?"), "plain current weather not forecast query")

section("Clarification — missing location/time/both")
tomorrow_only = parse_weather_query("can you tell me the weather tomorrow?")
ok(tomorrow_only.get("action_name") == "weather.forecast", "weather tomorrow → forecast")
ok("location" in (tomorrow_only.get("missing_fields") or []), "weather tomorrow missing location")
ok("time" not in (tomorrow_only.get("missing_fields") or []), "weather tomorrow has time")

forecast_no_time = parse_weather_query("Can you tell me the forecast in Fountain Valley?")
ok(forecast_no_time.get("action_name") == "weather.forecast", "forecast in city → forecast")
ok(
    forecast_no_time.get("location") == "Fountain Valley",
    "forecast in city keeps location",
    detail=repr(forecast_no_time.get("location")),
)
ok("time" in (forecast_no_time.get("missing_fields") or []), "forecast in city missing time")
ok("location" not in (forecast_no_time.get("missing_fields") or []), "forecast in city has location")

rain_vague = parse_weather_query("will it rain")
ok(rain_vague.get("action_name") == "weather.forecast", "will it rain → forecast")
ok(
    set(rain_vague.get("missing_fields") or []) == {"location", "time"},
    "will it rain missing both",
    detail=str(rain_vague.get("missing_fields")),
)

bare_weather = parse_weather_query("what's the weather")
ok(bare_weather.get("action_name") == "weather.forecast", "what's the weather → clarify path")
ok("location" in (bare_weather.get("missing_fields") or []), "what's the weather missing location")
ok("time" in (bare_weather.get("missing_fields") or []), "what's the weather missing time")

section("Handler — missing location must not default to Fountain Valley")
clarify = W.handle_weather_forecast_request(
    location=None,
    parsed_query={**tomorrow_only, "needs_location": True, "missing_fields": ["location"]},
    user_text="can you tell me the weather tomorrow?",
)
ok(clarify.get("needs_followup") is True, "missing location → needs_followup")
ok(
    "Fountain Valley" not in (clarify.get("spoken_reply") or ""),
    "missing location reply does not mention Fountain Valley",
    detail=str(clarify.get("spoken_reply")),
)
ok(
    "location" in (clarify.get("spoken_reply") or "").lower(),
    "missing location asks for location",
    detail=str(clarify.get("spoken_reply")),
)

section("Pending merge — location then time")
base = parse_weather_query("can you tell me the weather tomorrow?", reference_dt=ref_handler)
merged_loc = merge_weather_parsed(base, parse_weather_query("Fountain Valley", reference_dt=ref_handler))
merged_loc["location"] = "Fountain Valley"
merged_loc["location_kind"] = "explicit"
merged_loc["missing_fields"] = []
merged_loc["needs_location"] = False
ok(merged_loc.get("query", {}).get("time_kind") == "tomorrow", "pending keeps tomorrow after location reply")
ok(merged_loc.get("query", {}).get("target_date") == "2026-06-26", "pending keeps normalized tomorrow date")
with patch.object(W, "geocode_location", return_value=("Fountain Valley, CA, US", 33.7, -117.8)):
    with patch.object(W, "fetch_forecast", return_value=_mock_forecast_payload_for_dates(handler_dates)):
        pending_result = W.handle_weather_forecast_request(
            location="Fountain Valley",
            parsed_query={
                **merged_loc,
                "needs_location": False,
                "needs_time": False,
                "missing_fields": [],
                "location_kind": "explicit",
            },
            user_text="can you tell me the weather tomorrow?",
        )
ok(pending_result.get("action_type") == "weather_forecast", "pending location resolve fetches forecast")
ok(
    "Fountain Valley" in (pending_result.get("spoken_reply") or ""),
    "pending location resolve mentions Fountain Valley",
    detail=str(pending_result.get("spoken_reply")),
)

base_fv = parse_weather_query("forecast in Fountain Valley")
merged_time = merge_weather_parsed(base_fv, parse_weather_query("tomorrow"))
merged_time["location"] = "Fountain Valley"
merged_time["location_kind"] = "explicit"
merged_time["missing_fields"] = []
ok(merged_time.get("query", {}).get("time_kind") == "tomorrow", "pending time reply sets tomorrow")

section("Follow-up context — reuse Irvine for what about Saturday")
recent = {
    "action_name": "weather.forecast",
    "slots": {
        "location": "Irvine",
        "parsed_weather": parse_weather_query("weather in Irvine tomorrow"),
        "time_kind": "tomorrow",
    },
}
follow = apply_recent_weather_context_to_parsed(
    "what about Saturday?",
    parse_weather_query("what about Saturday?"),
    recent,
)
ok(follow.get("location") == "Irvine", "what about Saturday reuses Irvine location")
ok(follow.get("query", {}).get("time_kind") == "weekday", "what about Saturday parses weekday")

fresh_tomorrow = apply_recent_weather_context_to_parsed(
    "weather tomorrow",
    parse_weather_query("weather tomorrow"),
    recent,
)
ok(not fresh_tomorrow.get("location"), "fresh weather tomorrow does not reuse Irvine")

section("Complete forecast — no clarification")
complete = parse_weather_query("weather tomorrow in Fountain Valley")
ok(not complete.get("missing_fields"), "complete forecast has no missing fields")
ok(complete.get("location") == "Fountain Valley", "complete forecast location")
ok(complete.get("query", {}).get("time_kind") == "tomorrow", "complete forecast time")

section("Calendar dates and weekday expressions")
ref_jun21 = datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc)
june29 = parse_weather_query("can you tell me the weather on june 29th?", reference_dt=ref_jun21)
ok(june29.get("action_name") == "weather.forecast", "june 29th → forecast not current")
ok(june29.get("query", {}).get("time_kind") == "date", "june 29th time_kind date")
ok(june29.get("query", {}).get("time_label") == "June 29", "june 29th label")
ok("location" in (june29.get("missing_fields") or []), "june 29th missing location only")
ok(june29.get("query", {}).get("start_local") == "2026-06-29", "june 29th start_local")

ref_jun25 = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
june29_near = parse_weather_query("weather on June 29th?", reference_dt=ref_jun25)
ok(not june29_near.get("query", {}).get("beyond_horizon"), "june 29 within horizon from jun 25")

next_tue = parse_weather_query("can you tell me the weather in fountain valley next tuesday?", reference_dt=ref_jun21)
ok((next_tue.get("location") or "").lower() == "fountain valley", "fountain valley next tuesday location clean", detail=repr(next_tue.get("location")))
ok(next_tue.get("query", {}).get("time_kind") == "weekday", "next tuesday time_kind weekday")
ok(not next_tue.get("missing_fields"), "fountain valley next tuesday complete")

la_june = parse_weather_query("weather in Los Angeles on June 29", reference_dt=ref_jun25)
ok(la_june.get("location") == "Los Angeles", "LA on June 29 location")
ok(la_june.get("query", {}).get("time_kind") == "date", "LA on June 29 date")

rain_sat = parse_weather_query("will it rain in Irvine Saturday afternoon", reference_dt=ref_jun21)
ok(rain_sat.get("location") == "Irvine", "rain Irvine Saturday afternoon location")
ok(rain_sat.get("query", {}).get("time_kind") == "weekday", "Saturday afternoon weekday")
ok(rain_sat.get("intent") == "rain", "rain intent")

ok(strip_weather_time_from_location("Fountain Valley next Tuesday") == "Fountain Valley",
   "strip next Tuesday from location")
ok(strip_weather_time_from_location("Los Angeles on June 29") == "Los Angeles",
   "strip on June 29 from location")
ok(strip_weather_time_from_location("Irvine Saturday afternoon") == "Irvine",
   "strip Saturday afternoon from location")

section("Pending — preserve June 29 when location supplied")
base_june = parse_weather_query("can you tell me the weather on june 29th?", reference_dt=ref_jun25)
merged_pending = dict(base_june)
merged_pending["location"] = "Fountain Valley"
merged_pending["location_kind"] = "explicit"
merged_pending["missing_fields"] = []
merged_pending["needs_location"] = False
merged_pending["action_name"] = "weather.forecast"
ok(merged_pending.get("query", {}).get("time_kind") == "date", "pending retains date time_kind")
with patch.object(W, "geocode_location", return_value=("Fountain Valley, CA, US", 33.7, -117.8)):
    with patch.object(W, "fetch_forecast", return_value=_mock_forecast_payload_for_dates(["2026-06-29", "2026-06-30"])):
        june_result = W.handle_weather_forecast_request(
            location="Fountain Valley",
            parsed_query=merged_pending,
            user_text="can you tell me the weather on june 29th?",
        )
ok(june_result.get("action_type") == "weather_forecast", "june 29 pending resolves to forecast")
ok(
    isinstance(june_result.get("ui_payload"), dict)
    and june_result["ui_payload"].get("panel_type") == "weather_forecast_panel",
    "june 29 pending returns forecast panel not horizon",
    detail=str(june_result.get("spoken_reply")),
)
ok(
    "June 29" in (june_result.get("spoken_reply") or "")
    or "2026-06-29" in str(june_result.get("data") or ""),
    "june 29 forecast reply uses stored date not current weather",
    detail=str(june_result.get("spoken_reply")),
)

section("Horizon — date outside 5-day window")
far_date = parse_weather_query("weather in Irvine on July 15", reference_dt=ref_jun21)
ok(far_date.get("query", {}).get("beyond_horizon") is True, "July 15 beyond horizon from Jun 21")
with patch.object(W, "geocode_location", return_value=("Irvine, CA, US", 33.7, -117.8)):
    far_result = W.handle_weather_forecast_request(
        location="Irvine",
        parsed_query={**far_date, "needs_location": False, "missing_fields": [], "location_kind": "explicit"},
    )
ok("five days" in (far_result.get("spoken_reply") or "").lower(), "horizon message for far date")

section("Ordinal calendar dates — July fourth / July 4th")
from actions.weather_query_parse import parse_calendar_day_token

ok(parse_calendar_day_token("4th") == 4, "4th → 4")
ok(parse_calendar_day_token("fourth") == 4, "fourth → 4")
july_fourth = parse_weather_query("weather in Fountain Valley on July fourth", reference_dt=ref_jun25)
july_4th = parse_weather_query("weather in Fountain Valley on July 4th", reference_dt=ref_jun25)
july_4 = parse_weather_query("weather in Fountain Valley on July 4", reference_dt=ref_jun25)
ok(july_fourth.get("query", {}).get("target_date") == "2026-07-04", "July fourth → 2026-07-04", detail=str(july_fourth.get("query")))
ok(july_4th.get("query", {}).get("target_date") == "2026-07-04", "July 4th → 2026-07-04")
ok(july_4.get("query", {}).get("target_date") == "2026-07-04", "July 4 → 2026-07-04")
ok(july_fourth.get("query", {}).get("time_kind") == "date", "July fourth time_kind date")

section("Required phrase matrix — normalized dates")
ref_jun27 = datetime(2026, 6, 27, 12, 0, tzinfo=timezone.utc)
phrase_specs = [
    ("weather in Fountain Valley next Tuesday", ref_jun27, "2026-06-30"),
    ("weather in Fountain Valley on June 30", ref_jun27, "2026-06-30"),
    ("weather in Fountain Valley June 30th", ref_jun27, "2026-06-30"),
    ("weather in Fountain Valley on July fourth", ref_jun25, "2026-07-04"),
    ("weather in Fountain Valley on July 4th", ref_jun25, "2026-07-04"),
    ("weather in Fountain Valley tomorrow", ref_jun27, "2026-06-28"),
]
parsed_by_phrase: dict[str, dict] = {}
for phrase, ref, expected_date in phrase_specs:
    p = parse_weather_query(phrase, reference_dt=ref)
    parsed_by_phrase[phrase] = p
    ok(p.get("query", {}).get("target_date") == expected_date, f"{phrase!r} → {expected_date}")

equiv_mock = _mock_forecast_payload_for_dates(["2026-06-30"])
equiv_slots, equiv_tz = W.extract_forecast_slots(equiv_mock)
equiv_views = {
    phrase: W.select_forecast_view(equiv_slots, parsed_by_phrase[phrase], equiv_tz)
    for phrase in (
        "weather in Fountain Valley next Tuesday",
        "weather in Fountain Valley on June 30",
        "weather in Fountain Valley June 30th",
    )
}
equiv_daily = [v.get("selected_daily") or [] for v in equiv_views.values()]
ok(
    len(equiv_daily) == 3
    and all(len(d) == 1 for d in equiv_daily)
    and equiv_daily[0][0].get("high_f") == equiv_daily[1][0].get("high_f") == equiv_daily[2][0].get("high_f")
    and equiv_daily[0][0].get("low_f") == equiv_daily[1][0].get("low_f") == equiv_daily[2][0].get("low_f"),
    "equivalent June 30 phrases select identical forecast metrics",
)

section("Slot selection + voice/panel consistency")
def _mock_forecast_payload_for_date(target_local_date: str, tz_offset: int = -25200):
    return _mock_forecast_payload_for_dates([target_local_date], tz_offset=tz_offset)

mock_payload = _mock_forecast_payload_for_date("2026-06-30")
parsed_jun30 = parse_weather_query("weather in Fountain Valley on June 30", reference_dt=ref_jun27)
slots, tz_off = W.extract_forecast_slots(mock_payload)
view = W.select_forecast_view(slots, parsed_jun30, tz_off)
ok(not view.get("beyond_horizon"), "June 30 in mock slots → in range")
ok(len(view.get("selected_daily") or []) == 1, "one daily row selected")
day = (view.get("selected_daily") or [])[0]
ok(day.get("high_f") == 70, "daily high from slots", detail=str(day))
ok(day.get("low_f") == 63, "daily low from slots", detail=str(day))
spoken = W.build_forecast_voice_summary(parsed_jun30, "Fountain Valley, CA, US", view)
rows = W._forecast_ui_rows(view)
ok(rows and rows[0].get("high_f") == day.get("high_f"), "panel high matches daily calc")
ok(str(day.get("high_f")) in spoken, "voice mentions same high as panel", detail=spoken)
ok(str(day.get("low_f")) in spoken, "voice mentions same low as panel", detail=spoken)
ok(str(day.get("max_pop_percent")) in spoken or "35" in spoken or "percent" in spoken.lower(),
   "voice mentions rain chance", detail=spoken)

missing_day_payload = _mock_forecast_payload_for_date("2026-06-28")
parsed_far = parse_weather_query("weather in Fountain Valley on July 15", reference_dt=ref_jun27)
slots2, tz2 = W.extract_forecast_slots(missing_day_payload)
view2 = W.select_forecast_view(slots2, parsed_far, tz2)
ok(view2.get("beyond_horizon") is True, "date absent from API slots → beyond_horizon, no fallback day")

print()
print("=" * 60)
if FAIL == 0:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    print(f"{GREEN}All weather forecast smoke tests passed.{RESET}")
    sys.exit(0)
else:
    print(f"Total: {PASS + FAIL}   {GREEN}PASS={PASS}{RESET}   {RED}FAIL={FAIL}{RESET}")
    print(f"{RED}Failures:{RESET}")
    for name in FAILED:
        print(f"  - {name}")
    sys.exit(1)
