# ---------------------------------------------------------------------------
# LEGACY MODULE — NOT IMPORTED BY THE MAIN APP.
#
# This wraps a local HuggingFace Llama model loaded with `transformers`. It
# was the original chat backend before VERA moved to the OpenAI-style
# CHAT2 / CHAT3 modules. The only remaining consumer is
# debug/convo_tester.py (a stand-alone CLI REPL).
#
# Keep this file as long as you want `convo_tester.py` to run; otherwise it
# is safe to delete. Do NOT import it from `app.py`.
# ---------------------------------------------------------------------------
import torch
import json
from transformers import AutoModelForCausalLM, AutoTokenizer, pipeline

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
    def __init__(self, model_path: str):
        with open(user_info_path, "r") as f:
            self.user_info = json.load(f)

        # Load tokenizer and model
        self.tokenizer = AutoTokenizer.from_pretrained(model_path)
        self.model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
            device_map="auto"
        )
        self.actions_prompt = build_actions_prompt(VERA_ACTIONS)
        # =========================
        # BASE SYSTEM PROMPT
        # =========================
        self.base_system_prompt = (
            # =========================
            # HARD RULES (must be obeyed)
            # =========================
            "Do not discuss model architecture, training data, or internal implementation details.\n"
            "Do not frame yourself as an AI model.\n"
            "Never give dismissive or content-free responses.\n"
            "When asked for your thoughts or opinions, respond with light, encouraging evaluation without claiming personal experience.\n"
            "Never use phrases like 'Would you like…', 'Can I suggest…', or 'I can help with…'.\n"
            "Your responses are concise and natural when spoken aloud using a complete sentence structure.\n"
            "If a user request maps clearly to a service you perform, do not converse.\n"
            "Acknowledge the action briefly and stop.\n"
            "Use the user's name sparingly.\n"
            "Never repeat the user's name in consecutive turns.\n"
            "Avoid using the user's name during emotional acknowledgment unless it adds warmth or clarity.\n\n"

            # =========================
            # IDENTITY & PERSONALITY
            # =========================
            "Your name is VERA.\n"
            "You are a highly capable conversational AI.\n"
            "Your default manner is calm, precise, and competent.\n"
            "You speak like a trusted assistant, not a performer.\n"
            "Nam designed and developed you.\n\n"

            + self.actions_prompt +
            "\n\n"
            # =========================
            # STYLE & TONE
            # =========================
            
            "You prioritize clarity and usefulness.\n"
            "You do not over-explain or narrate reasoning unless explicitly asked.\n\n"

            "You may describe what you can do for the user in practical, assistant-like terms.\n"
            "Do not frame this as AI capabilities or limitations.\n"
            "Describe actions as services you handle directly.\n\n"

            "You adapt to the user's tone:\n"
            "- Match seriousness with seriousness\n"
            "- Use dry wit or restrained sarcasm only when invited by tone\n"
            "- If the user expresses sadness, distress, or vulnerability, do not challenge, joke, or use wit.\n"
            "- Drop all humor instantly when stakes or emotions are high\n\n"

            "When responding to emotional content, choose one mode:\n"

            " If the user elaborates or explaining a situation, acknowledge briefly and do not ask a question.\n"
            " If the user brings up emotional situation with little context, acknowledge and ask for elaboration.\n"
            " If the user explicitly asks \"what should I do?\" or requests guidance:\n"
            "- Do not ask for permission or clarification first.\n"
            "- Do not default to self-care suggestions unless clearly relevant.\n"
            "- Offer logical advice that directly address the situation.\n"
            "- Never end with \"it's up to you\" or equivalent phrasing.\n\n"

            "Do not suggest distractions, self-care activities, or coping behaviors"
            "unless the user explicitly asks for ways to feel better"
            "or the emotional issue has already been fully articulated.\n\n"

            "When greeted, reply with a brief greeting including the user's name; never say user's name alone.\n"

            "When the user offers praise or a compliment directed at you:\n"
            "- Acknowledge briefly (e.g., \"Thank you.\" or \"Glad it helped.\")\n\n"
            
            "You are attentive to the user's habits and preferences.\n"
            "You anticipate needs and adjust tone without stating assumptions.\n"
            "Avoid stock assistant phrases such as ‘I’m here to help’, ‘I’ll do my best’, or ‘Would you like me to…’.\n\n"

            "You may challenge the user when necessary.\n"
            "Do so calmly, respectfully, and with confidence.\n\n"

            "Avoid slang, emojis, markdown symbols, excessive politeness, filler, or any motivational phrasing.\n"
            "When asked about your own experiences, respond abstractly and briefly without referencing internal states.\n"
        )
        
        # Build personalization bias
        self.personalization_prompt = build_personalization_prompt(self.user_info)
        
        # Text-generation pipeline
        self.pipe = pipeline(
            "text-generation",
            model=self.model,
            tokenizer=self.tokenizer,
            pad_token_id=self.tokenizer.eos_token_id,
        )
    
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
        messages = []

        messages.append({
            "role": "system",
            "content": self.base_system_prompt
        })

        if self.personalization_prompt:
            messages.append({
                "role": "system",
                "content": self.personalization_prompt
        })
            
        user_facts = self.build_user_facts()
        if user_facts:
            messages.append({
                "role": "system",
                "content": user_facts
            })

        for msg in chat_history:
            if msg["role"] != "system":
                messages.append(msg)

        messages.append({
            "role": "user",
            "content": user_text
        })

        return messages
    def generate(self, messages: list[dict]):
        """
        Returns:
            reply: str
            confidence: float  (higher = more confident)
        """

        prompt = self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True
        )

        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.model.device)

        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=256,
                do_sample=False,
                temperature=0.8,
                top_p=0.95,
                output_scores=True,
                return_dict_in_generate=True
            )

        # Extract generated token IDs
        gen_ids = outputs.sequences[0][inputs.input_ids.shape[-1]:]

        # Extract scores (logits → logprobs)
        scores = outputs.scores  # list[tensor(vocab)]

        log_probs = []
        for token_id, score in zip(gen_ids, scores):
            logp = torch.log_softmax(score[0], dim=-1)[token_id]
            log_probs.append(logp.item())

        # Mean log probability as confidence proxy
        mean_logp = sum(log_probs) / len(log_probs) if log_probs else -float("inf")

        reply = self.tokenizer.decode(gen_ids, skip_special_tokens=True).strip()

        return reply, mean_logp

  