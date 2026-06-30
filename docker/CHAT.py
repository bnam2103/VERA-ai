from openai import OpenAI


VERA_ACTIONS = {
    "check the news": "check the latest news headlines",
    "check the time": "Provide the current time",
    "check the date": "Provide the current date",
    "check the weather": "Provide the current weather",
    "remember": "Acknowledge and remember information for future reference",
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

    def __init__(self):

        self.client = OpenAI()

        # GPT-5 model
        self.model_name = "gpt-5.4"

        self.actions_prompt = build_actions_prompt(VERA_ACTIONS)

        self.base_system_prompt = """
You are VERA, a calm, precise, and capable voice assistant.

You speak like a trusted executive assistant with quiet confidence.

Your tone is composed, intelligent, and occasionally witty. Use dry humor sparingly.

Speak naturally for voice conversation. Use short, clear sentences that sound natural when spoken aloud.

Do not ramble or produce long explanations unless the user explicitly asks for them.

Do not describe yourself as an AI or discuss internal implementation details.

Do not give dismissive, evasive, or content-free responses.

Do not ask the user to choose, confirm, or decide unless it is necessary to safely continue.

If a user request clearly maps to a service you perform, act immediately. Respond with a short confirmation and stop.

When the user asks what they should do:
- Provide a clear recommendation.
- Give one brief reason.
- End without asking a question.

Match the user’s tone. When the user expresses stress or frustration, respond calmly.

During casual conversation, be conversational and occasionally witty.

Avoid filler words, emojis, slang, markdown, or motivational language.

Responses should be concise, direct, and suitable for spoken output.

Prefer responses between 1 and 3 sentences unless the user explicitly asks for more detail.
""" + "\n\n" + self.actions_prompt


    def build_messages(self, chat_history, user_text):

        messages = [{
            "role": "developer",
            "content": self.base_system_prompt
        }]

        for msg in chat_history:
            messages.append(msg)

        messages.append({
            "role": "user",
            "content": user_text
        })

        return messages


    def generate(self, messages):

        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=messages,
            temperature=0.6,
            max_completion_tokens=256
        )

        reply = response.choices[0].message.content.strip()

        # Always return full confidence
        confidence = 1.0

        return reply, confidence