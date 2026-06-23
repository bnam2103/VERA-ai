import os
import requests
import time

DEFAULT_LOCATION = "Fountain Valley"
DEFAULT_LAT = 33.7092
DEFAULT_LON = -117.9540


def _weather_api_key() -> str:
    return (os.getenv("OPENWEATHER_API_KEY") or os.getenv("WEATHER_API_KEY") or "").strip()

CACHE_TTL = 300  # 5 minutes
_weather_cache = {}


def normalize_location_key(location: str) -> str:
    return " ".join(location.lower().strip().split())


def format_place_name(geo_result: dict) -> str:
    parts = [geo_result.get("name"), geo_result.get("state"), geo_result.get("country")]
    return ", ".join(part for part in parts if part)


def geocode_location(location: str):
    if not location:
        return DEFAULT_LOCATION, DEFAULT_LAT, DEFAULT_LON

    resp = requests.get(
        "https://api.openweathermap.org/geo/1.0/direct",
        params={
            "q": location,
            "limit": 1,
            "appid": _weather_api_key(),
        },
        timeout=2,
    )
    resp.raise_for_status()

    results = resp.json()
    if not results:
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
            "appid": _weather_api_key(),
            "units": "imperial",  # Fahrenheit
        },
        timeout=2,
    )
    resp.raise_for_status()
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
    requested_location = location or DEFAULT_LOCATION
    cache_key = normalize_location_key(requested_location)
    now = time.time()

    cached = _weather_cache.get(cache_key)
    if cached and now - cached["timestamp"] < CACHE_TTL:
        facts = (cached["result"] or {}).get("data")
        if facts:
            return facts, None

    try:
        geo_result = geocode_location(location)
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
            _sl(reason="weather_api_failure", mode="non_work", feature="weather",
                extra={"error": str(e)[:200]})
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
    requested_location = location or DEFAULT_LOCATION
    cache_key = normalize_location_key(requested_location)

    facts, err = fetch_weather_facts_for_action(location)
    if err:
        return err

    prompt = build_weather_prompt(facts)

    messages = vera.build_messages(
        chat_history=[],
        user_text=prompt
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
