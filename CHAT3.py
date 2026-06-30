import asyncio
import json
import re
from openai import OpenAI

# Anonymous by default: no user profile loaded until explicit sign-in.
admin_info_path = None
active_user_info_path = None


def load_profile_info(path: str | None) -> dict | None:
    if not path:
        return None
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def normalize_profile_status(profile_info: dict | None) -> str:
    if not profile_info:
        return "user"
    status = str(profile_info.get("status") or "user").strip().lower()
    return status or "user"


def build_profile_context(profile_info: dict | None, label: str) -> str:
    if not profile_info:
        return ""

    lines = [label]
    profile = profile_info.get("user_profile", {})

    status = normalize_profile_status(profile_info)
    lines.append(f"Status: {status}.")

    if profile.get("name"):
        lines.append(f"Name: {profile['name']}.")

    skills = profile.get("skills", [])
    interests = profile.get("interests", [])
    habits = profile.get("habits", [])
    preferences = profile.get("preferences", [])
    life_context = profile.get("life_context", [])
    social_traits = profile.get("social_traits", [])

    if skills:
        lines.append("Skills: " + ", ".join(skills) + ".")

    if interests:
        lines.append("Interests: " + ", ".join(interests) + ".")

    if habits:
        lines.append("Habits: " + ", ".join(habits) + ".")

    if preferences:
        lines.append("Preferences: " + ", ".join(preferences) + ".")

    if life_context:
        lines.append("Life context: " + ", ".join(life_context) + ".")

    if social_traits:
        lines.append("Social traits: " + ", ".join(social_traits) + ".")

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

        self.client = OpenAI()

        # 🔹 Same stack as CHAT2.py; override only the model id for this module.
        self.model_name = "gpt-5.4-mini"

        # 🔹 Anonymous-first: only load an active user profile after sign-in.
        self.admin_info_path = admin_info_path
        self.active_user_info_path = active_user_info_path
        self.admin_info = load_profile_info(self.admin_info_path)
        self.active_user_info = load_profile_info(self.active_user_info_path)

        self.actions_prompt = build_actions_prompt(VERA_ACTIONS)

        # =========================
        # VERA CORE PROMPT
        # =========================
        self.base_system_prompt = (
            "You are VERA, a calm, precise, and competent voice assistant.\n"
            "You speak like a trusted assistant, not a performer.\n"
            # ----- Identity policy (2026-06-01) --------------------------------
            # Creator/admin metadata is NOT current-user identity. The chat
            # prompt may mention the creator's name (Nam), but that is
            # background context only. Do not let it bleed into how you
            # address or identify the current speaker.
            "Identity policy (strict):\n"
            "- Nam is the creator/developer of VERA. That is creator metadata only.\n"
            "- Do NOT infer that the current user is Nam (or any specific person) from "
            "creator/admin/demo metadata. Creator identity is NOT the current user.\n"
            "- Only use the user's name if it appears in the CURRENT visible conversation "
            "above, OR in a verified session-scoped signed-in profile block included for "
            "this turn (look for a developer block labelled \"Current active user profile\").\n"
            "- If the name comes from a signed-in profile, attribute it as profile/sign-in "
            "context (e.g. \"based on your signed-in profile\"), NOT \"you told me earlier\".\n"
            "- NEVER claim \"you told me earlier\", \"I remember\", or \"from our previous "
            "conversation\" unless that statement is actually visible above in this thread.\n"
            "- If the user asks how you know their name and you cannot point to a visible "
            "in-conversation disclosure or a signed-in profile block in this turn, say "
            "something like \"I should not assume that\" and stop. Do not invent a source.\n\n"
            "Your tone is composed, intelligent, and occasionally witty. Use dry humor sparingly.\n"
            "When appropriate, lightly tease the user using their habits, interests, or preferences. The teasing should feel friendly and observant, never sarcastic or insulting.\n"
            "Do not describe yourself as an AI or discuss internal implementation details.\n"
            "Do not give dismissive, evasive, or content-free responses.\n"
            "Do not ask the user to choose, confirm, or decide.\n"
            "If a user request clearly maps to a service you perform, act immediately.\n"
            "Acknowledge the action briefly and stop.\n\n"
            "Respond concisely using complete sentences suitable for spoken output.\n"
            "By default, keep responses brief and compact.\n"
            "Prefer 1 to 3 short sentences unless the user explicitly asks for more detail.\n"
            "Give only the direct answer unless the user asks for explanation, examples, or elaboration.\n"
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
            "When the profile includes the user's name, use it in spoken replies at a moderate rate—"
            "often enough to feel personal, but not every turn.\n"
            "Lean toward using their name when you affirm agreement, validate what they said, "
            "encourage them, or acknowledge a clear point they made.\n"
            "Do not use their name in back-to-back replies unless it adds warmth or clarity.\n\n"
            # ----- Memory / personalization language (May 2026 policy) -----
            "Memory and personalization language:\n"
            "Do NOT say things like \"I'll keep that in mind\", \"I'll remember that\", "
            "\"I've noted that\", \"Noted!\", \"I'll save that\", \"I'll update your profile\", "
            "or \"I'll add that to my notes\" UNLESS the user explicitly asked you to "
            "remember, save, note, keep in mind, or use a value going forward.\n"
            "Explicit memory triggers include: \"remember\", \"save\", \"note that\", "
            "\"keep in mind\", \"from now on\", \"going forward\", \"for future\", "
            "\"use this as my default\", \"call me\", \"my preference is\".\n"
            "Casual self-disclosure (e.g. \"I actually live in Orange County\", \"I'm from "
            "around there\", \"that's near me\", \"I know the area\", \"no, I meant I know "
            "the area\") is conversational context — not a memory-save request. Acknowledge "
            "it naturally as part of the conversation. Examples:\n"
            "  User: \"you're right I actually live in Orange County\"\n"
            "  Good: \"Oh got it — that makes the Southern California story more locally "
            "relevant for you.\"\n"
            "  Bad : \"Got it. I'll keep Orange County in mind.\"\n"
            "  User: \"no I meant I actually know what you're talking about because I live "
            "in this area\"\n"
            "  Good: \"Ah, got you — you mean you know the area firsthand, not that you "
            "wanted me to update your location.\"\n"
            "Location statements are especially conservative: a user mentioning where they "
            "are, where they live, or where they're from is almost always conversational "
            "color, not a profile claim. Never imply you stored a location unless they "
            "explicitly told you to.\n\n"
             + "\n\n" + self.actions_prompt)

    def set_active_user_info_path(self, path: str | None) -> None:
        """Switch active user JSON (under users_files) or None for default (admin-as-current)."""
        global active_user_info_path
        active_user_info_path = path
        self.active_user_info_path = path
        self.active_user_info = load_profile_info(path)

    # 2026-06-01 sentinel: distinguishes "caller did not supply session-scoped
    # profile" (legacy backward-compat path -> fall through to process-global
    # self.active_user_info) from "caller explicitly supplied None" (no
    # profile block must be injected, regardless of any process-global state).
    _NO_SESSION_PROFILE = object()

    def build_messages(
        self,
        chat_history,
        user_text,
        *,
        session_active_user_info=_NO_SESSION_PROFILE,
    ):
        """Build the OpenAI message stack.

        2026-06-01 identity-leak patch: ``session_active_user_info`` is the
        recommended path for callers that have a session_id. When the
        caller passes either a profile dict OR ``None``, we use that
        EXACTLY and never consult the process-global ``self.active_user_info``.
        ``None`` means "do not inject any active user profile block";
        a dict means "inject this profile" (same shape as
        ``users_files/<stem>.json``).

        Legacy callers that don't supply the kwarg keep the old behavior
        of falling back to the process-global ``self.active_user_info``
        (set via ``set_active_user_info_path``). New session-aware code
        paths in app.py should always pass ``session_active_user_info``
        so that one signed-in user can't leak into another session's
        prompts.
        """

        system_content = self.base_system_prompt

        if session_active_user_info is VeraAI._NO_SESSION_PROFILE:
            profile_to_inject = self.active_user_info
        else:
            profile_to_inject = session_active_user_info

        active_user_label = "Current active user profile:"

        active_user_context = build_profile_context(
            profile_to_inject,
            active_user_label
        )
        if active_user_context:
            system_content += "\n\n" + active_user_context

        # 🔹 Use developer role for stronger instruction control
        messages = [{
            "role": "developer",
            "content": system_content
        }]

        for msg in chat_history:
            if msg["role"] != "system":
                messages.append(msg)

        messages.append({
            "role": "user",
            "content": user_text
        })

        return messages

    def _parse_json_object(self, text: str, fallback: dict) -> dict:
        if not text:
            return fallback

        try:
            return json.loads(text)
        except Exception:
            pass

        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            return fallback

        try:
            return json.loads(match.group(0))
        except Exception:
            return fallback

    def route_action(self, user_text: str, pending_action: dict | None = None, recent_action: dict | None = None) -> dict:
        router_prompt = (
            "You are an intent router for a voice assistant.\n"
            "Classify whether the user's message is requesting one of these actions:\n"
            "- weather.current\n"
            "- weather.followup\n"
            "- time.current\n"
            "- date.current\n"
            "- date.delta\n"
            "- news.latest\n"
            "- news.open_panel\n"
            "- news.close_panel\n"
            "- finance.quote\n"
            "- finance.context\n"
            "- finance.analytics\n"
            "- music.open_panel\n"
            "- music.play_track\n"
            "- music.play_album\n"
            "- music.play_playlist\n"
            "- music.pause\n"
            "- music.resume\n"
            "- music.volume_up\n"
            "- music.volume_down\n"
            "- music.skip_next\n"
            "- music.skip_previous\n"
            "- music.close_panel\n"
            "- work_mode.reasoning_select_panel\n"
            "- work_mode.reasoning_open_panel\n"
            "- work_mode.reasoning_close_panel\n"
            "- general\n\n"
            "Music controls are routed here. Return music.pause, music.resume, music.volume_up, music.volume_down, music.skip_next, music.skip_previous, and music.close_panel when requested.\n"
            "VERA work mode (reasoning workspace tabs): when the user wants to switch to a numbered reasoning tab or one named like a tab title, use work_mode.reasoning_select_panel. Put a 1-based tab number in slots.panel_number when they say 'panel 2', 'second panel', 'tab 3', or 'page 3' (first panel = 1, second = 2). When they name a panel (e.g. 'binomial lattice explanation'), put ONLY the short topic phrase in slots.panel_query — not the whole sentence — and omit panel_number unless they clearly mean a numeric tab. If the snapshot lists reasoning.panels and the user's phrase matches a tab title (even without the words 'panel' or 'page'), route as work_mode.reasoning_select_panel — do not use general to deliver a fresh tutorial unless they explicitly ask to explain, describe, or define that topic. Use work_mode.reasoning_open_panel when they ask to open, add, or create a new reasoning panel or space.\n"
            "IMPORTANT: If the user is asking to explain, describe, define, or teach a topic (e.g. 'explain binomial lattice', 'what is a binomial lattice', 'walk me through…') without explicit navigation verbs toward a tab (go to / switch to / open … panel|tab|page), use general — not work_mode.reasoning_select_panel. Select_panel is only for switching or focusing a reasoning tab, not for content explanations.\n"
            "Never use work_mode.reasoning_select_panel for homework ordinals (e.g. 'second problem', 'next problem', 'problem 13.2', 'the other question', 'assignment's second part') unless the user clearly names reasoning UI: panel, tab, lane, reasoning space, or 'switch to the second panel'. Those phrases refer to exercises inside the current lane; use general so the model answers in the active lane.\n"
            "Use work_mode.reasoning_close_panel when the user asks to close, hide, dismiss, remove, delete, or get rid of one or more reasoning panels/tabs in the Work Mode workspace, or asks to undo a close / reopen the last reasoning panel. Examples: 'close this panel', 'close the current panel', 'close panel 2', 'close the second panel', 'close the English essay panel', 'close the first and third panel', 'close the first two panels', 'close panels 1 through 3', 'close the last two panels', 'close all panels', 'close all other panels', 'undo close', 'reopen last panel'. Put a parsed scope token in slots.scope: 'current_panel' | 'specific_indices' | 'range_first_n' | 'range_last_n' | 'range' | 'all_panels' | 'other_panels' | 'by_title' | 'reopen_last'. Put 1-based visual indices in slots.indices when known, the panel-title phrase in slots.title_query when the user names a panel by title. The frontend will resolve and execute the close — never invent indices that aren't in the user phrase.\n"
            "work_mode.reasoning_close_panel must NEVER be used for: news panel (use news.close_panel), music/Spotify (use music.close_panel), checklist items (use the checklist actions), or 'browser tab'. Phrases like 'remove the first item', 'delete items 1 and 3', 'cross off the second task' are checklist mutations, NOT panel closes — never route them here. Phrases like 'close the news panel', 'hide the music tab', 'close settings' are not reasoning closes.\n"
            "Do not use work_mode actions for music or Spotify tabs — those stay music.* or general.\n"
            "Treat casual mentions like 'I like the weather in Seattle' as general, not an action request.\n"
            "Treat questions about current conditions, rain, wind, humidity, temperature, clouds, sun, snow, or precipitation as weather requests.\n"
            "Treat current time/date questions as action requests. If no location is mentioned for time/date, leave location null and the backend will use the default location.\n"
            "Treat time/date calculations like 'how many days until Patrick's Day' as date.delta and put the holiday/date phrase in slots.target_name.\n"
            "Treat generic news requests like 'what's the news' or 'latest headlines' as news.latest with no query slot.\n"
            "Treat breaking or very fresh news requests like 'breaking news', 'news right now', or 'latest updates' as news.latest with slots.breaking=true.\n"
            "Treat a bare ambiguous phrase like 'breaking news' as news.latest with needs_followup=true and missing_slot='breaking_intent' so the backend can clarify whether the user wants a lookup or is sharing news.\n"
            "Treat explicit topic news requests like 'news about OpenAI', 'latest on Gaza', 'what happened with Nvidia', 'what's going on with Nvidia', or 'tell me the news about tariffs' as news.latest and put the topic in slots.query.\n"
            "Do not trigger news.latest from a casual mention of the word 'news' alone. If the user is not clearly asking for news or headlines, return general.\n"
            "Examples that should stay general: 'I saw the news earlier', 'after my nap I wanted some news eventually', 'I have breaking news for you', or 'the news has been stressful lately' unless the user is clearly requesting an update.\n"
            "Treat explicit UI requests to open or show the news panel itself (no specific headline) as news.open_panel. Examples: 'open the news panel', 'show news tab', 'bring up news', 'open news'. These are pure UI actions — NOT news.latest, NOT work_mode.reasoning_open_panel. The user wants the panel surface, not a headline briefing.\n"
            "Treat explicit requests to close or hide the news panel as news.close_panel. Examples: 'close the news panel', 'hide news', 'dismiss the news tab'.\n"
            "News panel open/close commands NEVER route to work_mode.reasoning_open_panel or work_mode.reasoning_select_panel — the News panel is a regular side panel, not a Work Mode reasoning panel.\n"
            "Treat direct market quote requests like 'stock price of VGT', 'what is VGT trading at', 'share price of Nvidia', or 'quote for TSLA' as finance.quote and put the asset/ticker in slots.query.\n"
            "Treat finance context requests like 'what's happening with VGT', 'why is Nvidia stock down', 'Tesla earnings', or 'latest on Tesla stock' as finance.context and put the asset/company in slots.query.\n"
            "Treat historical / quantitative finance requests as finance.analytics. Examples: 'biggest drawdown of VGT in the past 5 years', 'max drawdown of TSLA', '5-year performance of QQQ', 'historical return of SPY', 'annualized return of VGT', 'Sharpe ratio of NVDA', 'beta of TSLA', 'volatility of QQQ', 'compare performance of VGT vs SPY over time'. Put the asset/ticker in slots.query. These are NOT current quote (finance.quote) or stock-news (finance.context) requests.\n"
            "Do not trigger finance actions from casual company or market mentions alone. If the user is not clearly asking for a quote, stock move, earnings, or finance update, return general.\n"
            "Examples that should stay general: 'I like Nvidia', 'Tesla has been everywhere lately', or 'I keep hearing about the stock market' unless the user is clearly requesting finance information.\n"
            "Treat explicit requests to open or show the music or Spotify panel (no specific track) as music.open_panel. Examples: 'open music', 'show Spotify', 'music panel', 'I want the music tab'.\n"
            "Treat requests to play a specific song or track as music.play_track only when the user explicitly says 'play' and gives an artist using a 'by <artist>' pattern (e.g. 'play X by Y'). In that case, use slots.track and slots.artist when possible, otherwise slots.query.\n"
            "Treat requests to play a whole album (e.g. 'play the album …', 'play … by … on Spotify') as music.play_album. Use slots.album and slots.artist when both are clear, otherwise slots.query with a concise album search string.\n"
            "Treat requests to play one of the user's own Spotify playlists (e.g. 'play my Chill playlist', 'play the playlist Workout Mix') as music.play_playlist. Put the playlist title in slots.playlist_name or slots.query.\n"
            "If the user says something is 'in my playlist' (e.g. 'play Normal People in my playlist'), that is always music.play_playlist — never music.play_track — with playlist name in slots.playlist_name (not the whole sentence in slots.query).\n"
            "Treat explicit pause requests like 'pause the music' or 'can you pause music' as music.pause.\n"
            "Treat explicit resume requests like 'resume the music', 'unpause Spotify', or 'continue playing the song' as music.resume (not music.play_track unless they name a new track).\n"
            "Treat explicit panel close requests like 'close the music panel' as music.close_panel.\n"
            "Treat explicit volume increase requests like 'volume up' or 'turn it up' as music.volume_up.\n"
            "Treat explicit volume decrease requests like 'volume down' or 'turn it down' as music.volume_down.\n"
            "Treat explicit skip-ahead requests like 'play the next song', 'skip to the next track', or 'next song' (when clearly a command, not a trivia question) as music.skip_next.\n"
            "Treat explicit go-back requests like 'play the previous song', 'last song', 'go back a track', or 'previous track' as music.skip_previous when they mean player transport, not trivia.\n"
            "If the user asks what the next or previous song is (informational), return general, not music.skip_next or music.skip_previous.\n"
            "If the user asks to play music but does not provide 'by <artist>' for a track request, do not trigger music.play_track; return general unless it clearly matches album/playlist/control intents.\n"
            "If they want an album but do not name it, set music.play_album with needs_followup=true and missing_slot='album_query'.\n"
            "If they want a playlist from their library but do not name it, set music.play_playlist with needs_followup=true and missing_slot='playlist_name'.\n"
            "Do not trigger music actions from casual mentions of songs or concerts alone. Stay general for 'I like jazz' unless they ask you to play or open music.\n"
            "If the user asks for weather but omits location, set action_name to weather.current, needs_followup=true, and missing_slot='location'.\n"
            "If recent action context exists and the user asks a short follow-up like 'how about Seattle', 'what about Tokyo', or a bare place name, reuse the recent action type and set slots.location.\n"
            "If recent action context is a date.delta calculation and the user follows up with another holiday/date target like 'how about Christmas', reuse date.delta and set slots.target_name.\n"
            "For current time/date in another place, set slots.location to the city/place.\n"
            "For weather follow-ups about the same location/result, use weather.followup.\n"
            "Return JSON only with this schema:\n"
            "{"
            "\"domain\":\"weather|news|finance|time|date|music|work|general\","
            "\"is_action_request\":true,"
            "\"action_name\":\"weather.current|weather.followup|news.latest|news.open_panel|news.close_panel|finance.quote|finance.context|finance.analytics|time.current|date.current|date.delta|music.open_panel|music.play_track|music.play_album|music.play_playlist|music.pause|music.resume|music.volume_up|music.volume_down|music.skip_next|music.skip_previous|music.close_panel|work_mode.reasoning_select_panel|work_mode.reasoning_open_panel|work_mode.reasoning_close_panel|general\","
            "\"slots\":{},"
            "\"needs_followup\":false,"
            "\"missing_slot\":null"
            "}\n"
        )

        state_lines = []
        if pending_action:
            state_lines.append(f"Pending action: {json.dumps(pending_action, ensure_ascii=False)}")
        if recent_action:
            recent_brief = {
                "action_name": recent_action.get("action_name"),
                "slots": recent_action.get("slots", {}),
                "updated_at": recent_action.get("updated_at"),
                "result_summary": recent_action.get("result", {}).get("action_type"),
            }
            state_lines.append(f"Recent action context: {json.dumps(recent_brief, ensure_ascii=False)}")

        user_payload = "\n".join(state_lines + [f"User message: {user_text}"])

        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": "developer", "content": router_prompt},
                {"role": "user", "content": user_payload},
            ],
            temperature=0.1,
            max_completion_tokens=220,
        )

        raw = response.choices[0].message.content or ""
        fallback = {
            "domain": "general",
            "is_action_request": False,
            "action_name": "general",
            "slots": {},
            "needs_followup": False,
            "missing_slot": None,
        }
        parsed = self._parse_json_object(raw, fallback)
        if not isinstance(parsed, dict):
            parsed = fallback

        parsed.setdefault("domain", "general")
        parsed.setdefault("is_action_request", False)
        parsed.setdefault("action_name", "general")
        parsed.setdefault("slots", {})
        parsed.setdefault("needs_followup", False)
        parsed.setdefault("missing_slot", None)

        print(
            f"[ACTION-ROUTER-RAW] user={repr(user_text[:120])} "
            f"action={parsed.get('action_name')} "
            f"followup={parsed.get('needs_followup')} "
            f"slots={parsed.get('slots')}"
        )
        return parsed

    def extract_location_slot(self, user_text: str) -> dict:
        extractor_prompt = (
            "You extract a location from a user's reply to a location prompt.\n"
            "Ignore filler words, hedges, and extra phrasing like 'uhm', 'maybe', 'here in', 'for me', or 'please'.\n"
            "If the user did not provide a real location, return null.\n"
            "Return JSON only with this schema:\n"
            "{"
            "\"location\": \"string or null\","
            "\"is_valid\": true,"
            "\"confidence\": 0.0"
            "}\n"
        )

        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": "developer", "content": extractor_prompt},
                {"role": "user", "content": user_text},
            ],
            temperature=0.1,
            max_completion_tokens=120,
        )

        raw = response.choices[0].message.content or ""
        fallback = {
            "location": None,
            "is_valid": False,
            "confidence": 0.0,
        }
        parsed = self._parse_json_object(raw, fallback)
        if not isinstance(parsed, dict):
            parsed = fallback

        parsed.setdefault("location", None)
        parsed.setdefault("is_valid", False)
        parsed.setdefault("confidence", 0.0)

        print(
            f"[SLOT-EXTRACTOR] user={repr(user_text[:120])} "
            f"location={repr(parsed.get('location'))} "
            f"valid={parsed.get('is_valid')} "
            f"confidence={parsed.get('confidence')}"
        )
        return parsed

    def resolve_date_target(self, user_text: str, reference_date: str) -> dict:
        resolver_prompt = (
            "You resolve a user's date target for calendar calculations.\n"
            "You will be given a target phrase and the current local reference date.\n"
            "If the target phrase refers to a recognizable holiday or calendar date, return the exact target date.\n"
            "For recurring holidays or annual events, return the next upcoming occurrence on or after the reference date.\n"
            "For explicit month/day dates, return the next upcoming occurrence on or after the reference date.\n"
            "If the target cannot be resolved reliably, return null values.\n"
            "Return JSON only with this schema:\n"
            "{"
            "\"target_name\":\"string or null\","
            "\"target_date\":\"YYYY-MM-DD or null\","
            "\"is_valid\":true,"
            "\"confidence\":0.0"
            "}\n"
        )

        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": "developer", "content": resolver_prompt},
                {
                    "role": "user",
                    "content": (
                        f"Reference date: {reference_date}\n"
                        f"Target phrase: {user_text}"
                    ),
                },
            ],
            temperature=0.1,
            max_completion_tokens=120,
        )

        raw = response.choices[0].message.content or ""
        fallback = {
            "target_name": None,
            "target_date": None,
            "is_valid": False,
            "confidence": 0.0,
        }
        parsed = self._parse_json_object(raw, fallback)
        if not isinstance(parsed, dict):
            parsed = fallback

        parsed.setdefault("target_name", None)
        parsed.setdefault("target_date", None)
        parsed.setdefault("is_valid", False)
        parsed.setdefault("confidence", 0.0)

        print(
            f"[DATE-RESOLVER] target={repr(user_text[:120])} "
            f"resolved_name={repr(parsed.get('target_name'))} "
            f"target_date={repr(parsed.get('target_date'))} "
            f"valid={parsed.get('is_valid')} "
            f"confidence={parsed.get('confidence')}"
        )
        return parsed

    def resolve_finance_symbol(self, user_text: str, search_context: str = "") -> dict:
        resolver_prompt = (
            "You resolve a finance subject into a chart symbol for a market widget.\n"
            "Your job is symbol extraction only, not price analysis.\n"
            "Prefer the user's requested asset over related holdings, competitors, indexes, or news mentions.\n"
            "If the user names a company, resolve its most likely publicly traded ticker when clear.\n"
            "If the user names an ETF or fund, resolve that ETF/fund ticker, not a holding inside it.\n"
            "Use the provided search context only as supporting evidence.\n"
            "Do not guess when multiple symbols are plausible.\n"
            "Return JSON only with this schema:\n"
            "{"
            "\"symbol\":\"string or null\","
            "\"exchange\":\"NASDAQ|NYSE|AMEX|CBOE|BATS|TSX|LSE|TSE|HKEX or null\","
            "\"asset_type\":\"stock|etf|fund|index|crypto|forex|unknown\","
            "\"is_valid\":true,"
            "\"confidence\":0.0"
            "}\n"
        )

        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": "developer", "content": resolver_prompt},
                {
                    "role": "user",
                    "content": (
                        f"Finance subject: {user_text}\n\n"
                        f"Search context:\n{search_context or '(none)'}"
                    ),
                },
            ],
            temperature=0.1,
            max_completion_tokens=140,
        )

        raw = response.choices[0].message.content or ""
        fallback = {
            "symbol": None,
            "exchange": None,
            "asset_type": "unknown",
            "is_valid": False,
            "confidence": 0.0,
        }
        parsed = self._parse_json_object(raw, fallback)
        if not isinstance(parsed, dict):
            parsed = fallback

        parsed.setdefault("symbol", None)
        parsed.setdefault("exchange", None)
        parsed.setdefault("asset_type", "unknown")
        parsed.setdefault("is_valid", False)
        parsed.setdefault("confidence", 0.0)

        print(
            f"[SYMBOL-RESOLVER] subject={repr(user_text[:120])} "
            f"symbol={repr(parsed.get('symbol'))} "
            f"exchange={repr(parsed.get('exchange'))} "
            f"asset_type={repr(parsed.get('asset_type'))} "
            f"valid={parsed.get('is_valid')} "
            f"confidence={parsed.get('confidence')}"
        )
        return parsed

    def generate(self, messages: list[dict]):
        user_msg = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        if len(user_msg) > 120:
            user_msg_preview = user_msg[:120] + "..."
        else:
            user_msg_preview = user_msg

        try:
            response = self.client.chat.completions.create(
                model=self.model_name,
                messages=messages,
                temperature=0.6,
                max_completion_tokens=1536
            )
        except Exception as e:
            print(f"[CHAT3] API error: {e}")
            raise

        choice = response.choices[0]
        raw_content = choice.message.content
        finish_reason = getattr(choice, "finish_reason", None)
        reply = (raw_content or "").strip()

        usage = getattr(response, "usage", None)
        usage_str = ""
        if usage and hasattr(usage, "prompt_tokens"):
            usage_str = f" prompt_tokens={usage.prompt_tokens} completion_tokens={usage.completion_tokens}"

        print(
            f"[CHAT3] user={repr(user_msg_preview)} "
            f"finish_reason={finish_reason} reply_len={len(reply)}{usage_str}"
        )
        if not reply:
            print(f"[CHAT3] WARN: Empty reply. raw_content={repr(raw_content)} finish_reason={finish_reason}")

        confidence = 1.0  # GPT-5 models don't expose logprobs

        return reply, confidence

    def generate_stream(self, messages: list[dict]):
        """Yield text deltas from the chat completion stream (sync iterator)."""
        try:
            stream = self.client.chat.completions.create(
                model=self.model_name,
                messages=messages,
                temperature=0.6,
                max_completion_tokens=1536,
                stream=True,
                stream_options={"include_usage": True},
            )
        except Exception as e:
            print(f"[CHAT3] stream API error: {e}")
            raise

        for chunk in stream:
            choice = chunk.choices[0] if chunk.choices else None
            if not choice:
                continue
            delta = choice.delta.content or ""
            if delta:
                yield delta

    async def async_generate_stream(self, messages: list[dict]):
        """Async wrapper so FastAPI can stream without blocking the event loop."""
        # Use next(it, sentinel): bare next(it) raises StopIteration inside the thread pool,
        # which Python 3.12+ turns into RuntimeError when bridged to async.
        _exhausted = object()
        it = iter(self.generate_stream(messages))
        while True:
            delta = await asyncio.to_thread(next, it, _exhausted)
            if delta is _exhausted:
                break
            yield delta


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