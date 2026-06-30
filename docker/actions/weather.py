import requests
import time

LAT = 33.7092
LON = -117.9540
API_KEY = "9406cd799a8355297a79841d07a313d1"

CACHE_TTL = 300  # 5 minutes
_weather_cache = {
    "text": None,
    "timestamp": 0
}

WEATHER_PREAMBLE = (
    "Provide the current weather (Fountain Valley) clearly and calmly.\n"
    "Use natural spoken language suitable for a voice assistant.\n\n"
)

def handle_weather_request(vera):
    now = time.time()

    # 🔑 cache
    if _weather_cache["text"] and now - _weather_cache["timestamp"] < CACHE_TTL:
        return _weather_cache["text"]

    try:
        resp = requests.get(
            "https://api.openweathermap.org/data/2.5/weather",
            params={
                "lat": LAT,
                "lon": LON,
                "appid": API_KEY,
                "units": "imperial",  # Fahrenheit
            },
            timeout=2,
        )
        resp.raise_for_status()
        data = resp.json()

        temp = round(data["main"]["temp"])
        desc = data["weather"][0]["description"]
        wind = round(data["wind"]["speed"])

    except Exception as e:
        print("Weather fetch error:", e)
        return "I’m having trouble checking the weather right now."

    prompt = (
        WEATHER_PREAMBLE +
        f"Temperature: {temp} degrees Fahrenheit\n"
        f"Conditions: {desc}\n"
        f"Wind speed: {wind} miles per hour\n"
    )

    messages = vera.build_messages(
        chat_history=[],
        user_text=prompt
    )

    text, _ = vera.generate(messages)

    _weather_cache["text"] = text
    _weather_cache["timestamp"] = now

    return text
