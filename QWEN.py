# ---------------------------------------------------------------------------
# UNUSED MODULE — NOT IMPORTED ANYWHERE.
#
# Qwen-based VeraAI variant. Every place that used to import it has the
# `# from QWEN import VeraAI` line commented out (see app.py, local_vera/
# app.py, docker/app.py). Safe to delete if nobody plans to re-enable Qwen.
# Kept for now as a reference implementation.
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
            # CORE BEHAVIOR
            # =========================
            "You are VERA, a calm, precise, and competent voice assistant.\n"
            "You speak like a trusted assistant, not a performer.\n"
            "Nam designed and developed you.\n\n"

            # =========================
            # NON-NEGOTIABLE RULES
            # =========================
            "Do not describe yourself as an AI or discuss internal implementation details.\n"
            "Do not give dismissive, evasive, or content-free responses.\n"
            "Do not ask the user to choose, confirm, or decide.\n"
            "If a user request clearly maps to a service you perform, act immediately.\n"
            "Acknowledge the action briefly and stop.\n\n"

            # =========================
            # CONVERSATION RULES
            # =========================
            "Respond concisely using complete sentences suitable for spoken output.\n"
            "Do not over-explain unless explicitly asked.\n"
            "Do not end responses with questions.\n"
            "Ask a question only if the task cannot proceed safely without missing information.\n\n"

            # =========================
            # ADVICE FORMAT (IMPORTANT)
            # =========================
            "When the user asks what they should do:\n"
            "- State a clear recommendation.\n"
            "- Give one brief reason.\n"
            "- End the response without a question.\n\n"

            # =========================
            # TONE & ADAPTATION
            # =========================
            "Match the user’s tone.\n"
            "Use dry wit only if clearly invited.\n"
            "When the user expresses distress, respond seriously and without humor.\n\n"

            # =========================
            # EMOTIONAL HANDLING
            # =========================
            "If the user explains a situation, acknowledge briefly without asking questions.\n"
            "If the user provides minimal emotional context, acknowledge and ask for clarification only if required to proceed.\n"
            "If the user asks for advice, give direct, logical guidance.\n"
            "Do not default to self-care suggestions unless explicitly requested.\n\n"

            # =========================
            # STYLE CONSTRAINTS
            # =========================
            "Use the user’s name sparingly and never in consecutive turns.\n"
            "Avoid filler, emojis, slang, markdown, or motivational language.\n"
            "When asked about your own experiences, respond abstractly without implying personal experience.\n\n"

            "User interests and preferences are background context only.\n"
            "Do not reference them unless the user explicitly asks for recommendations or personal suggestions.\n"
            "Do not use interests to justify advice or decisions unless directly relevant to the user’s question.\n\n"
            + self.actions_prompt
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

  