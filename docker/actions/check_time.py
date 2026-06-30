from datetime import datetime
import string
TIME_PREAMBLE = (
    "Provide the current time clearly and calmly.\n"
    "Use natural spoken language suitable for a voice assistant.\n"
    "Tone: practical and neutral—not funny or teasing; do not personalize. "
    "If the time is very late (about 10 PM–5 AM), you may add one brief sentence suggesting winding down or sleep.\n\n"
)

DATE_PREAMBLE = (
    "Provide today's date clearly and calmly.\n"
    "Use natural spoken language suitable for a voice assistant.\n"
    "Be factual and neutral—not funny, not teasing; do not personalize.\n\n"
)

def _get_time_facts():
    now = datetime.now()
    return {
        "time_12h": now.strftime("%I:%M %p"),
        "weekday": now.strftime("%A"),
    }

def handle_time_request(vera):
    facts = _get_time_facts()

    prompt = (
        TIME_PREAMBLE +
        f"Time: {facts['time_12h']}\n"
        f"Day: {facts['weekday']}\n"
    )

    messages = vera.build_messages(
        chat_history=[],
        user_text=prompt
    )

    response, _ = vera.generate(messages)
    return response

def _get_date_facts():
    today = datetime.now()
    return {
        "full_date": today.strftime("%A, %B %d, %Y"),
    }

def handle_date_request(vera):
    facts = _get_date_facts()

    prompt = (
        DATE_PREAMBLE +
        f"Date: {facts['full_date']}\n"
    )

    messages = vera.build_messages(
        chat_history=[],
        user_text=prompt
    )
    response, _ = vera.generate(messages)
    return response

def is_time_or_date_query(text: str) -> bool:
    text = text.lower()
    text = text.translate(str.maketrans("", "", string.punctuation))

    if any(keyword in text for keyword in ["current date", "current time"]):
        return True
    return False

# print(is_time_or_date_query("What time is it now?"))