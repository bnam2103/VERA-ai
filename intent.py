import re
import string

# =========================
# ACTION INTENT (SIDE EFFECTS)
# =========================

COMMAND_INITIATORS = [
    r"can you",
    r"could you",
    r"please",
    r"would you",
    r"i want you to",
    r"vera",
    r"hey vera",
]

FILLER_WORDS = r"(please|just|kindly|go ahead and)?"

REQUEST_PATTERNS = [
    r"you could",
    r"you can",
    r"you would",
    r"do you think.*you could",
    r"would it be possible.*to",
    r"is it possible.*to",
]

COMMAND_VERBS = [
    "exit",
    "open",
    "play",
    "stop",
    "search",
    "check",
    "close",
    "increase",
    "decrease",
    "turn",
    "shut down",
]

# =========================
# QUERY INTENT (NO SIDE EFFECTS)
# =========================

# 🔑 optional prepositions for NEWS only
OPTIONAL_PREPOSITION = r"(about |on )?"

QUERY_OBJECTS = {
    "news": [
        rf"{OPTIONAL_PREPOSITION}the news",
        rf"{OPTIONAL_PREPOSITION}the current news",
        rf"{OPTIONAL_PREPOSITION}the latest news",
        rf"{OPTIONAL_PREPOSITION}the news headlines",
        rf"{OPTIONAL_PREPOSITION}the news updates",
    ],
    "time": [
        r"the time",
        r"the current time",
    ],
    "date": [
        r"the date",
        r"today'?s date",
        r"the current date",
    ],
    "weather": [
        rf"{OPTIONAL_PREPOSITION}the weather",
        rf"{OPTIONAL_PREPOSITION}the current weather",
    ],
}

QUERY_VERBS = [
    r"check",
    r"tell me",
]

QUERY_INTERROGATIVES = [
    r"what is",
    r"what'?s",
]

# =========================
# QUERY MATCHER
# =========================

def is_query(text: str) -> bool:
    t = text.lower().strip().rstrip("?")

    # -------------------------
    # Grammar 1: Interrogative (normal order)
    # "what is the time", "what's on the news"
    # -------------------------
    for objects in QUERY_OBJECTS.values():
        for obj in objects:
            for interrogative in QUERY_INTERROGATIVES:
                if re.search(rf"\b{interrogative}\b\s+{obj}\b", t):
                    return True

    # -------------------------
    # Grammar 1b: Inverted interrogative
    # "what time is it", "what date is today"
    # -------------------------
    if "what time is it" in t:
        return True
    if "what time it is" in t:
        return True
    if "what date is today" in t:
        return True
    if "what date is it" in t:
        return True
    if "what day is today" in t:
        return True
    if "what date it is" in t:
        return True
    if "what day it is" in t:
        return True
    
    # -------------------------
    # Grammar 2: Imperative
    # "check the news", "tell me the time"
    # -------------------------
    for objects in QUERY_OBJECTS.values():
        for obj in objects:
            for verb in QUERY_VERBS:
                if re.search(rf"\b{verb}\b\s+{obj}\b", t):
                    return True

    # -------------------------
    # Grammar 3: Initiator + query verb
    # "can you tell me the news"
    # -------------------------
    for initiator in COMMAND_INITIATORS:
        for verb in QUERY_VERBS:
            for objects in QUERY_OBJECTS.values():
                for obj in objects:
                    pattern = rf"\b{initiator}\b\s+{FILLER_WORDS}\s*{verb}\s+{obj}\b"
                    if re.search(pattern, t):
                        return True

    return False

# =========================
# MAIN COMMAND DETECTOR
# =========================

def is_command(text: str) -> bool:
    t = text.lower().strip()

    # -------------------------
    # 0. Queries (time/date/news)
    # -------------------------
    if is_query(t):
        return True

    # -------------------------
    # 1. Direct imperative (verb first)
    # -------------------------
    words = t.split()
    if words:
        first = words[0].strip(string.punctuation)
        if first in COMMAND_VERBS:
            return True

    # -------------------------
    # 2. Initiator + action verb
    # -------------------------
    for phrase in COMMAND_INITIATORS:
        for verb in COMMAND_VERBS:
            pattern = rf"\b{phrase}\b\s+{FILLER_WORDS}\s*\b{verb}\b"
            if re.search(pattern, t):
                return True

    # -------------------------
    # 3. Request pattern + action verb
    # -------------------------
    for pattern in REQUEST_PATTERNS:
        m = re.search(pattern, t)
        if m:
            start = m.end()
            for verb in COMMAND_VERBS:
                if re.search(rf"\b{verb}\b", t[start:]):
                    return True

    # -------------------------
    # 4. Addressing VERA directly
    # -------------------------
    if t.startswith("vera"):
        after_vera = t[len("vera"):]
        for verb in COMMAND_VERBS:
            if re.search(rf"\b{verb}\b", after_vera):
                return True

    return False


# =========================
# VOICE UI: MUTE INPUT (client-only; infer continuous / interrupt only)
# =========================

_MUTE_VOICE_PATTERNS = [
    r"^mute$",
    r"^mute\s+please$",
    r"^please\s+mute$",
    r"\bcan\s+you\s+mute\b",
    r"\bcould\s+you\s+mute\b",
    r"\bwould\s+you\s+mute\b",
    r"\bplease\s+mute\b",
    r"\bmute\s+(the|my|your)\s+(mic|microphone|input)\b",
    r"\b(turn|switch)\s+off\s+(the\s+)?(mic|microphone|input)\b",
    r"\bsilence\s+(the\s+)?(mic|microphone)\b",
    r"\bquiet\s+(the\s+)?(mic|microphone)\b",
    r"\bcan\s+you\s+(turn\s+off|silence)\s+(the\s+)?(mic|microphone)\b",
    r"\bcould\s+you\s+(turn\s+off|silence)\s+(the\s+)?(mic|microphone)\b",
    r"\bgo\s+mute\b",
    r"\b(i\s+)?want\s+you\s+to\s+mute\b",
    r"\b(i\s+)?need\s+you\s+to\s+mute\b",
    r"^vera,?\s+mute\b",
    r"^hey\s+vera,?\s+mute\b",
]


def is_mute_voice_command(text: str) -> bool:
    """
    True when the user is asking to mute their mic (same as headset mute).
    Matched only for voice /infer with mode continuous or interrupt — not PTT or /text.
    """
    t = text.lower().strip().rstrip("?.!")
    if not t:
        return False
    if re.search(r"\bunmute\b", t):
        return False
    for p in _MUTE_VOICE_PATTERNS:
        if re.search(p, t):
            return True
    return False


# =========================
# TESTS
# =========================
if __name__ == "__main__":
    tests = [
        "can you tell me what's on the news",
        "what's on the news",
        "tell me about the news",
        "tell me the latest news",
        "can you check the news",
        "please check the news for me",
        "what's the time",
        "tell me the time",
        "what time is it?",
        "what date is today?",
        "tell me more",
        "what is going on",
        "you were right earlier",
        "tell me about the latest news headlines",
        "can you tell me about the weather?"
    ]

    for t in tests:
        print(f"{t!r} -> {is_command(t)}")
