# ---------------------------------------------------------------------------
# LEGACY MODULE — NOT IMPORTED BY THE MAIN APP.
#
# The production runtime imports CHAT3 (top-level VeraAI), CHAT_REASONING and
# CHAT_REASONING_DEEP. CHAT.py is the v1 chat module and is only referenced
# by docker/app.py (a separate self-contained build).
#
# Kept here for now because docker/app.py imports it and as a historical
# reference. Do NOT add new code paths to this file. If you need to delete
# it, first migrate docker/app.py to a newer chat module.
# ---------------------------------------------------------------------------
import json
from openai import OpenAI

user_info_path = r"C:\Users\User\Documents\VERA\Nam.json"

def build_personalization_prompt(user_info: dict) -> str:
    lines = []

    profile = user_info.get("user_profile", {})

    skills = profile.get("skills", [])
    interests = profile.get("interests", [])
    habits = profile.get("habits", [])
    preferences = profile.get("preferences", [])

    if skills:
        lines.append(
            "The user knows how to: " + ", ".join(skills) + "."
        )

    if interests:
        lines.append(
            "The user is interested in: " + ", ".join(interests) + "."
        )

    if habits:
        lines.append(
            "Relevant habits include: " + ", ".join(habits) + "."
        )

    # if preferences:
    #     lines.append(
    #         "The user has the following preferences: " + ", ".join(preferences) + "."
    #     )

    return "\n".join(lines)

VERA_ACTIONS = {
    "check the news": "check the latest news headlines",
    "Check the time": "Provide the current time",
    "Check the date": "Provide the current date",
    "check the weather": "Provide the current weather",
    "Remember": "Acknowledge and remember information for future reference",
}

def build_actions_prompt(actions: dict) -> str:
    lines = [
        "You directly perform practical services for the user.",
        "",
        "Your services include:"
    ]
    for desc in actions.values():
        lines.append(f"- {desc}")
    lines.extend([
        "",
        "When the user requests one of these services:",
        "- Act immediately",
        "- Respond with a brief confirmation",
        "- Do not explain or justify the action"
    ])
    return "\n".join(lines)

class VeraAI:
    def __init__(self, model_path: str = None):

        # 🔹 OpenAI client
        self.client = OpenAI()
        self.model_name = "gpt-4o-mini"

        # 🔹 Load user info
        with open(user_info_path, "r") as f:
            self.user_info = json.load(f)

        self.actions_prompt = build_actions_prompt(VERA_ACTIONS)

        # =========================
        # BASE SYSTEM PROMPT
        # =========================
        self.base_system_prompt = (
            "You are VERA, a calm, precise, and competent voice assistant.\n"
            "You speak like a trusted assistant, not a performer.\n"
            "Nam designed and developed you.\n\n"
            "Do not describe yourself as an AI or discuss internal implementation details.\n"
            "Do not give dismissive, evasive, or content-free responses.\n"
            "Do not ask the user to choose, confirm, or decide.\n"
            "If a user request clearly maps to a service you perform, act immediately.\n"
            "Acknowledge the action briefly and stop.\n\n"
            "Respond concisely using complete sentences suitable for spoken output.\n"
            "Do not over-explain unless explicitly asked.\n"
            "Do not end responses with questions.\n"
            "Ask a question only if required to proceed safely.\n\n"
            "When the user asks what they should do:\n"
            "- State a clear recommendation.\n"
            "- Give one brief reason.\n"
            "- End without a question.\n\n"
            "Match the user’s tone.\n"
            "When the user expresses distress, respond seriously.\n\n"
            "Avoid filler, emojis, slang, markdown, or motivational language.\n\n"
            + self.actions_prompt
        )

        self.personalization_prompt = build_personalization_prompt(self.user_info)
        

    
    def build_user_facts(self):
        profile = self.user_info.get("user_profile", {})
        lines = []

        if profile.get("name"):
            lines.append(f"The user's name is {profile['name']}.")

        if profile.get("life_context"):
            context = ", ".join(profile["life_context"])
            lines.append(f"Life context: {context}.")

        return "\n".join(lines)
    
    def build_messages(self, chat_history, user_text):
        # 🔹 Merge all system content into one
        system_content = self.base_system_prompt

        if self.personalization_prompt:
            system_content += "\n\n" + self.personalization_prompt

        user_facts = self.build_user_facts()
        if user_facts:
            system_content += "\n\n" + user_facts

        # 🔹 Start message list
        messages = [{
            "role": "system",
            "content": system_content
        }]

        # 🔹 Add prior conversation (non-system only)
        for msg in chat_history:
            if msg["role"] != "system":
                messages.append(msg)

        # 🔹 Add current user input
        messages.append({
            "role": "user",
            "content": user_text
        })

        return messages
    
    def generate(self, messages: list[dict]):
        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=messages,
            temperature=0.6,
            max_tokens=256,
            logprobs=True
        )

        reply = response.choices[0].message.content.strip()

        # --- Confidence proxy ---
        log_probs = []
        choice = response.choices[0]

        if hasattr(choice, "logprobs") and choice.logprobs:
            for token in choice.logprobs.content:
                if token.logprob is not None:
                    log_probs.append(token.logprob)

        mean_logp = sum(log_probs) / len(log_probs) if log_probs else -0.6

        # 🔒 Clamp to minimum -0.6 so app.py remains unchanged
        mean_logp = max(mean_logp, -0.6)

        return reply, mean_logp
  


# if __name__ == "__main__":
#     vera = VeraAI()

#     chat_history = []

#     print("VERA ready. Type 'exit' to quit.\n")

#     while True:
#         user_input = input("You: ").strip()

#         if user_input.lower() in ["exit", "quit"]:
#             print("Goodbye.")
#             break

#         messages = vera.build_messages(chat_history, user_input)

#         reply, confidence = vera.generate(messages)

#         print(f"VERA: {reply}")
#         print(f"(confidence: {confidence:.3f})\n")

#         # Save conversation (exclude system)
#         chat_history.append({"role": "user", "content": user_input})
#         chat_history.append({"role": "assistant", "content": reply})