"""Smoke tests for the 2026-06-01 identity-leak patch.

Covers the five layers of the fix that prevent VERA from assuming the
current user is Nam based on creator/admin/demo/profile context:

  PART 1 - CHAT3 base_system_prompt identity policy. The developer prompt
  must contain the explicit policy block separating creator metadata from
  current-user identity, and must forbid "you told me earlier" fabricated
  source attribution.

  PART 2 - CHAT3 build_messages session_active_user_info override. The
  new keyword argument must take precedence over the process-global
  self.active_user_info, and when explicitly passed as None must NEVER
  inject a "Current active user profile" block (even if the process-
  global active user is set).

  PART 3 - CHAT_REASONING._profile_block admin leak. Work Mode used to
  always inject the persistent admin profile (users_files/Nam.json) as
  a system block. The patched _profile_block must return "" by default
  and must NEVER produce a block containing "Persistent admin profile"
  or the admin's name.

  PART 4 - Identity-challenge detection and fastpath wording. Covers
  every spec phrasing:
      - "How do you know my name is Nam?"
      - "Why do you think my name is Nam?"
      - "Did I tell you my name?"
      - "How do you know who I am?"
      - "Why are you calling me Nam?"
      - "What's my name?" / "Do you know my name?"
      - "Am I Nam?"
  Plus the four grounding sources (history > session facts > profile >
  none) and the safe-fallback wording.

  PART 5 - Acceptance scenarios from the spec:
      A. Clean session, no signed-in profile, "How do you know my name
         is Nam?" -> safe fallback, no claim that user told VERA.
      B. Clean session (process-global Nam.json mentioned in creator
         prompt), "Am I Nam?" -> safe fallback (no assumption).
      C. Current chat contains "My name is Alex", "What's my name?"
         -> Alex, from visible chat history.
      D. Signed-in session profile name is Alex, "What's my name?"
         -> "Your signed-in profile says Alex."
      E. Work Mode clean session, "How do you know my name is Nam?"
         -> same safe fallback (no admin-profile leak).

Run:  py -3 -X utf8 tests\\smoke\\__identity_leak_smoke.py
"""
from __future__ import annotations

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")))

import io
import json as _json
import os
import sys
import tempfile
import types

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# Stub heavy audio modules (same shape as __about_me_handler_smoke.py).
_TTS_STUB_NAMES = (
    "synthesize_reply_audio", "synthesize_audio", "tts_init", "transcribe",
    "transcribe_long", "load_model", "warmup", "speak_to_file",
    "split_sentences_for_tts", "pop_first_complete_segment",
    "stream_tts_chunks", "tts_chunks", "warmup_tts", "warmup_asr",
    "init_tts", "init_asr", "preload",
)
for modname in ("TTS", "STT", "ASR"):
    if modname not in sys.modules:
        stub = types.ModuleType(modname)
        for name in _TTS_STUB_NAMES:
            setattr(stub, name, lambda *a, **kw: b"")
        sys.modules[modname] = stub

import app  # noqa: E402
import CHAT3  # noqa: E402
import CHAT_REASONING  # noqa: E402


# app.vera is set inside the FastAPI startup hook, which the test harness
# never triggers. Construct a VeraAI instance directly so we can inspect
# the base_system_prompt and exercise build_messages without firing the
# real LLM.
if app.vera is None:
    try:
        app.vera = CHAT3.VeraAI()
    except Exception as _vera_exc:
        print(f"  (warn: constructing CHAT3.VeraAI() failed: {_vera_exc})")

GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"

PASS = 0
FAIL = 0
FAILED: list[str] = []


def ok(cond: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  {GREEN}PASS{RESET}  {name}")
    else:
        FAIL += 1
        FAILED.append(name)
        print(f"  {RED}FAIL{RESET}  {name}{(' - ' + detail) if detail else ''}")


def section(title: str) -> None:
    print(f"\n{YELLOW}-- {title} --{RESET}")


# =========================================================================
# PART 1 - CHAT3 base_system_prompt identity policy
# =========================================================================
section("PART 1 - CHAT3 base_system_prompt identity policy")

_prompt = app.vera.base_system_prompt

ok("Identity policy" in _prompt, "policy header present")
ok(
    "creator/developer of VERA" in _prompt or "creator/developer" in _prompt.lower(),
    "policy mentions creator/developer role",
)
ok(
    "Creator identity is NOT the current user" in _prompt,
    "policy explicitly separates creator from current user",
)
ok(
    "you told me earlier" in _prompt.lower(),
    "policy forbids 'you told me earlier' attribution",
)
ok(
    "I should not assume that" in _prompt or "should not assume" in _prompt.lower(),
    "policy provides safe-fallback example",
)
# Important: the OLD line "Treat the persistent admin profile as the
# creator/owner context for VERA" was the leak source. It must be gone.
ok(
    "treat the persistent admin profile as the creator/owner context for VERA"
    not in _prompt.lower(),
    "old admin-as-current line removed",
)


# =========================================================================
# PART 2 - CHAT3 build_messages session_active_user_info override
# =========================================================================
section("PART 2 - CHAT3 build_messages session-scoped override")


def _dev_text_of(messages: list[dict]) -> str:
    if not messages:
        return ""
    dev = messages[0]
    if not isinstance(dev, dict):
        return ""
    if str(dev.get("role")) != "developer":
        return ""
    return str(dev.get("content") or "")


# Set process-global active user to a Nam-shaped profile to simulate the
# old leaky baseline. The override should now isolate prompts from this.
_saved_path = getattr(app.vera, "active_user_info_path", None)
_saved_info = getattr(app.vera, "active_user_info", None)

_fake_nam = {
    "user_profile": {
        "name": "Nam",
        "interests": ["coding"],
        "habits": ["coffee"],
    }
}
app.vera.active_user_info = _fake_nam

# 2.a Legacy path (kwarg omitted) - still uses process-global for backward
# compat with CLI / older call sites.
msgs_legacy = app.vera.build_messages([], "hi")
ok(
    "Nam" in _dev_text_of(msgs_legacy),
    "legacy build_messages without kwarg still injects process-global Nam (back-compat)",
)

# 2.b Explicit None override - profile block must NOT appear. The policy
# text itself mentions the label "Current active user profile" (as a
# documentation reference), so test for the actual injection pattern
# ("\n\nCurrent active user profile:\n" preceded by blank line, with a
# real bullet block after) rather than the substring alone.
msgs_none = app.vera.build_messages([], "hi", session_active_user_info=None)
_dev_none = _dev_text_of(msgs_none)
# The injection appends "\n\n<label>\n<bullets>" to system_content.
# build_profile_context outputs "- Name: ..." bullets, which never appear
# inside the policy text. So a clean check is: the dev prompt must NOT
# contain a "- Name:" bullet at all when the override is None.
ok(
    "- Name:" not in _dev_none and "Name: Nam" not in _dev_none,
    "session_active_user_info=None blocks profile injection",
)
ok(
    "Name: Nam" not in _dev_none,
    "session_active_user_info=None hides Nam profile fields",
)

# 2.c Explicit dict override - uses the override's name, not the global.
_fake_alex = {"user_profile": {"name": "Alex", "interests": ["surfing"]}}
msgs_alex = app.vera.build_messages([], "hi", session_active_user_info=_fake_alex)
_dev_alex = _dev_text_of(msgs_alex)
ok(
    "Alex" in _dev_alex,
    "session override Alex injects Alex into developer prompt",
)
ok(
    "Name: Nam" not in _dev_alex,
    "session override Alex does NOT leak Nam from process-global",
)

# Restore process-global state.
app.vera.active_user_info_path = _saved_path
app.vera.active_user_info = _saved_info


# =========================================================================
# PART 3 - CHAT_REASONING._profile_block admin leak removed
# =========================================================================
section("PART 3 - CHAT_REASONING._profile_block admin leak removed")

# CHAT_REASONING may not be importable if the project is missing optional
# deps; if it loaded, exercise the patched _profile_block.
try:
    _reasoner = CHAT_REASONING.ReasoningAI()
except Exception as _exc:
    _reasoner = None
    print(f"  (skip: ReasoningAI() not constructible: {_exc})")

if _reasoner is not None:
    block_default = _reasoner._profile_block()
    ok(
        "Persistent admin profile" not in block_default,
        "_profile_block default no longer prints 'Persistent admin profile' header",
    )
    ok(
        "Name: Nam" not in block_default,
        "_profile_block default no longer leaks admin name Nam",
    )

    # 3.b Explicit session override with no profile -> empty block.
    block_none = _reasoner._profile_block(session_active_user_info=None)
    ok(
        block_none == "",
        "_profile_block(session_active_user_info=None) returns empty string",
    )

    # 3.c Explicit dict override - uses the override profile.
    block_alex = _reasoner._profile_block(
        session_active_user_info={"user_profile": {"name": "Alex"}}
    )
    ok(
        "Alex" in block_alex,
        "_profile_block honors explicit session override",
    )
    ok(
        "Persistent admin profile" not in block_alex,
        "_profile_block override still omits admin block",
    )


# =========================================================================
# PART 4 - Identity-challenge detection and fastpath wording
# =========================================================================
section("PART 4 - Identity-challenge detection")

# 4.a Spec phrasings - all should match.
_CHALLENGE_PHRASES = [
    "How do you know my name is Nam?",
    "Why do you think my name is Nam?",
    "Did I tell you my name?",
    "How do you know who I am?",
    "Why are you calling me Nam?",
    "What's my name?",
    "What is my name?",
    "Do you know my name?",
    "Do you know what my name is?",
    "Am I Nam?",
    "Who am I?",
    "tell me my name",
]
for q in _CHALLENGE_PHRASES:
    matched, _claimed = app._detect_identity_challenge(q)
    ok(matched, f"detect identity challenge: {q!r}")

# 4.b Negatives - normal questions should NOT match.
_NEGATIVES = [
    "what is a tech sell-off?",
    "play feather by sabrina carpenter",
    "what's the weather today?",
    "set a 5 minute timer",
    "tell me about the lakers",
    "do you know what time it is?",  # superficially close to "do you know my name"
    "what time is it?",
]
for q in _NEGATIVES:
    matched, _claimed = app._detect_identity_challenge(q)
    ok(not matched, f"non-identity left alone: {q!r}")

# 4.c Claimed-name extraction.
m, name = app._detect_identity_challenge("How do you know my name is Nam?")
ok(m and (name or "").lower() == "nam", "claimed_name='Nam' extracted")
m, name = app._detect_identity_challenge("Am I Alex?")
ok(m and (name or "").lower() == "alex", "claimed_name='Alex' extracted from 'Am I Alex?'")
m, name = app._detect_identity_challenge("What's my name?")
ok(m and not name, "plain 'what's my name?' has no claimed_name")


# =========================================================================
# Reset session state across scenarios.
# =========================================================================

def _reset_session_state() -> None:
    """Clear all session-scoped state so each scenario starts clean."""
    try:
        app._session_active_user.clear()
    except Exception:
        pass
    try:
        app.session_user_facts.clear()
    except Exception:
        pass
    try:
        app.user_histories.clear()
    except Exception:
        pass


# =========================================================================
# PART 5 - Acceptance scenarios
# =========================================================================
section("PART 5 - Acceptance scenarios")

# Scenario A: Clean session, no signed-in profile.
_reset_session_state()
# Also force process-global active_user_info to Nam to simulate the worst
# possible leaky baseline. With the patch in place the fastpath MUST NOT
# claim "you told me earlier".
_saved_path = getattr(app.vera, "active_user_info_path", None)
_saved_info = getattr(app.vera, "active_user_info", None)
app.vera.active_user_info = _fake_nam

reply_A = app._identity_challenge_fastpath_reply(
    "How do you know my name is Nam?",
    session_id="sess-A",
    history=[],
)
ok(reply_A is not None, "Scenario A: identity challenge matched")
ok(
    "shouldn't guess" in (reply_A or "").lower()
    or "don't know for sure" in (reply_A or "").lower(),
    "Scenario A: safe natural fallback wording (no assumption)",
    detail=repr(reply_A),
)
ok(
    "you told me earlier" not in (reply_A or "").lower(),
    "Scenario A: never claims 'you told me earlier'",
    detail=repr(reply_A),
)
ok(
    "from our previous conversation" not in (reply_A or "").lower(),
    "Scenario A: never claims 'from our previous conversation'",
    detail=repr(reply_A),
)

# Scenario B: Clean session, creator prompt mentions Nam, 'Am I Nam?'.
_reset_session_state()
reply_B = app._identity_challenge_fastpath_reply(
    "Am I Nam?",
    session_id="sess-B",
    history=[],
)
ok(reply_B is not None, "Scenario B: identity challenge matched")
ok(
    (
        "shouldn't guess" in (reply_B or "").lower()
        or "don't know for sure" in (reply_B or "").lower()
    )
    and "nam" not in (reply_B or "").lower(),
    "Scenario B: VERA does not confirm Nam",
    detail=repr(reply_B),
)

# Scenario C: Current chat contains 'My name is Alex', 'What's my name?'.
_reset_session_state()
history_C = [
    {"role": "user", "content": "My name is Alex."},
    {"role": "assistant", "content": "Got it."},
]
reply_C = app._identity_challenge_fastpath_reply(
    "What's my name?",
    session_id="sess-C",
    history=history_C,
)
ok(reply_C is not None, "Scenario C: identity challenge matched")
ok(
    "Alex" in (reply_C or ""),
    "Scenario C: reply names Alex from visible chat",
    detail=repr(reply_C),
)
ok(
    "earlier in this conversation" in (reply_C or "").lower()
    or "mentioned" in (reply_C or "").lower(),
    "Scenario C: source attributed to visible chat",
    detail=repr(reply_C),
)
ok(
    "Nam" not in (reply_C or ""),
    "Scenario C: Nam does NOT leak from process-global",
    detail=repr(reply_C),
)

# Scenario D: Signed-in session profile name is Alex.
_reset_session_state()
# Create a temporary signed-in user profile keyed under a fake stem and
# point the per-session map at it. The fastpath looks up the profile via
# _ensure_user_profile_json_path / _read_user_profile_json, which read
# from users_files/<stem>.json.

# We piggyback on the real users_files dir using a one-off stem.
_users_dir = _os.path.join(_os.path.dirname(_os.path.abspath(app.__file__)), "users_files")
_tmp_stem = "__tmp_smoke_alex"
_tmp_path = _os.path.join(_users_dir, f"{_tmp_stem}.json")
_made_tmp_profile = False
try:
    with open(_tmp_path, "w", encoding="utf-8") as _fh:
        _json.dump(
            {"user_profile": {"name": "Alex", "interests": ["surfing"]}},
            _fh,
        )
    _made_tmp_profile = True
    app._session_active_user["sess-D"] = _tmp_stem

    reply_D = app._identity_challenge_fastpath_reply(
        "What's my name?",
        session_id="sess-D",
        history=[],
    )
    ok(reply_D is not None, "Scenario D: identity challenge matched")
    ok(
        "Alex" in (reply_D or ""),
        "Scenario D: reply names Alex from signed-in profile",
        detail=repr(reply_D),
    )
    ok(
        "signed-in profile" in (reply_D or "").lower(),
        "Scenario D: reply attributes to signed-in profile",
        detail=repr(reply_D),
    )
    ok(
        "Nam" not in (reply_D or ""),
        "Scenario D: Nam process-global does NOT leak through",
        detail=repr(reply_D),
    )
finally:
    if _made_tmp_profile:
        try:
            _os.remove(_tmp_path)
        except Exception:
            pass

# Scenario E: Work Mode clean session - same safe fallback (no admin-profile
# leak). We use the same fastpath because /infer is a single entrypoint.
_reset_session_state()
reply_E = app._identity_challenge_fastpath_reply(
    "How do you know my name is Nam?",
    session_id="sess-E-workmode",
    history=[],
)
ok(reply_E is not None, "Scenario E: identity challenge matched (Work Mode entry)")
ok(
    "shouldn't guess" in (reply_E or "").lower()
    or "don't know for sure" in (reply_E or "").lower(),
    "Scenario E: Work Mode safe natural fallback",
    detail=repr(reply_E),
)
ok(
    "Nam" not in (reply_E or ""),
    "Scenario E: Nam does not appear in Work Mode reply",
    detail=repr(reply_E),
)

# Restore process-global state at end.
app.vera.active_user_info_path = _saved_path
app.vera.active_user_info = _saved_info


# =========================================================================
# PART 6 - Source precedence (history > session facts > profile)
# =========================================================================
section("PART 6 - Source precedence")

# 6.a History wins over signed-in profile.
_reset_session_state()
_saved_path = getattr(app.vera, "active_user_info_path", None)
_saved_info = getattr(app.vera, "active_user_info", None)

# Set up a signed-in profile saying Alex.
_made_tmp_profile = False
try:
    with open(_tmp_path, "w", encoding="utf-8") as _fh:
        _json.dump({"user_profile": {"name": "Alex"}}, _fh)
    _made_tmp_profile = True
    app._session_active_user["sess-prec"] = _tmp_stem

    # History says the user is Sam now.
    history_prec = [
        {"role": "user", "content": "Actually, my name is Sam."},
    ]
    reply_prec = app._identity_challenge_fastpath_reply(
        "What's my name?",
        session_id="sess-prec",
        history=history_prec,
    )
    ok(
        reply_prec and "Sam" in reply_prec and "Alex" not in reply_prec,
        "history > profile: 'Sam' from visible chat outranks profile 'Alex'",
        detail=repr(reply_prec),
    )
finally:
    if _made_tmp_profile:
        try:
            _os.remove(_tmp_path)
        except Exception:
            pass

# 6.b No grounded source - safe fallback.
_reset_session_state()
reply_no_ground = app._identity_challenge_fastpath_reply(
    "How do you know my name is Sam?",
    session_id="sess-noground",
    history=[],
)
ok(
    reply_no_ground
    and (
        "shouldn't guess" in reply_no_ground.lower()
        or "don't know for sure" in reply_no_ground.lower()
    ),
    "no grounded source -> safe natural fallback",
    detail=repr(reply_no_ground),
)

# Restore.
app.vera.active_user_info_path = _saved_path
app.vera.active_user_info = _saved_info


# =========================================================================
# PART 7 - Session-scoped active user helpers
# =========================================================================
section("PART 7 - Session-scoped active user helpers")

_reset_session_state()
# Empty / None session -> None across all three helpers.
ok(app._session_scoped_active_username(None) is None, "no session_id -> no username")
ok(app._session_scoped_active_user_info(None) is None, "no session_id -> no profile dict")
ok(app._session_scoped_active_user_name(None) is None, "no session_id -> no display name")

# Session_id with no per-session mapping -> None (even if process-global is set).
_saved_path = getattr(app.vera, "active_user_info_path", None)
_saved_info = getattr(app.vera, "active_user_info", None)
app.vera.active_user_info = _fake_nam

ok(
    app._session_scoped_active_username("sess-unset") is None,
    "session-scoped strict lookup ignores process-global active user",
)
ok(
    app._session_scoped_active_user_info("sess-unset") is None,
    "session-scoped profile ignores process-global active user",
)
ok(
    app._session_scoped_active_user_name("sess-unset") is None,
    "session-scoped display name ignores process-global active user",
)

app.vera.active_user_info_path = _saved_path
app.vera.active_user_info = _saved_info


# =========================================================================
# PART 8 - Name-disclosure regex coverage
# =========================================================================
section("PART 8 - Visible-chat name disclosure regex coverage")

_disclosure_cases = [
    ("My name is Alex.", "Alex"),
    ("Call me Alex.", "Alex"),
    ("You can call me Alex.", "Alex"),
    ("Hi! I'm Alex.", "Alex"),
    ("This is Alex speaking.", "Alex"),
    ("My name's Alex.", "Alex"),
]
for text, expected in _disclosure_cases:
    history = [{"role": "user", "content": text}]
    got = app._user_name_from_visible_chat(history)
    ok(
        got == expected,
        f"disclosure: {text!r} -> {expected!r}",
        detail=f"got {got!r}",
    )

# Negative: assistant-only mentions don't count.
ok(
    app._user_name_from_visible_chat(
        [{"role": "assistant", "content": "Sure, Nam."}]
    )
    is None,
    "assistant turn mentioning a name is NOT user-disclosure",
)
# Negative: ambient mention of name in user turn not formatted as disclosure.
ok(
    app._user_name_from_visible_chat(
        [{"role": "user", "content": "I was reading about Alex Hormozi today."}]
    )
    is None,
    "ambient user mention of a name is NOT a disclosure",
)


# =========================================================================
# PART 9 - Creator/persona questions (2026-06-12)
# =========================================================================
section("PART 9 - Creator/persona questions -> 'I was built by Nam.'")

_reset_session_state()

# 9.a Creator questions detect + answer naturally.
_CREATOR_QS = [
    "who designed you?",
    "who made you?",
    "who built you?",
    "who created you?",
    "who developed you?",
    "Who designed VERA?",
    "who is your creator?",
    "who's your developer?",
    "who actually built you?",
    "who really made this app?",
]
for q in _CREATOR_QS:
    ok(app._detect_creator_question(q), f"detect creator question: {q!r}")
    reply = app._creator_question_fastpath_reply(q)
    ok(reply == "I was built by Nam.", f"creator reply natural: {q!r}", detail=repr(reply))

# 9.b Spec exact mappings.
ok(
    app._creator_question_fastpath_reply("who designed you?") == "I was built by Nam.",
    "spec: 'who designed you?' -> 'I was built by Nam.'",
)
ok(
    app._creator_question_fastpath_reply("who made you?") == "I was built by Nam.",
    "spec: 'who made you?' -> 'I was built by Nam.'",
)

# 9.c Stiff README-style wording must NOT be used.
for q in _CREATOR_QS:
    reply = (app._creator_question_fastpath_reply(q) or "").lower()
    ok(
        "creator/developer" not in reply and "is the creator" not in reply
        and "is the developer" not in reply,
        f"creator reply avoids stiff README wording: {q!r}",
        detail=repr(reply),
    )

# 9.d Creator questions are NOT misread as user-identity challenges.
for q in _CREATOR_QS:
    matched, _claimed = app._detect_identity_challenge(q)
    ok(not matched, f"creator question not a user-identity challenge: {q!r}")

# 9.e Negatives - normal questions are not creator questions.
_CREATOR_NEGS = [
    "who is the president?",
    "who won the game?",
    "what's the weather?",
    "who am I?",
    "play feather by sabrina carpenter",
]
for q in _CREATOR_NEGS:
    ok(not app._detect_creator_question(q), f"non-creator left alone: {q!r}")


# =========================================================================
# PART 10 - User-identity unknown: natural wording (2026-06-12)
# =========================================================================
section("PART 10 - Identity-unknown natural wording")

_reset_session_state()

# 10.a Recognition-style yes/no probes -> inviting wording.
for q in ("do you know who I am?", "do you recognize me?", "do you remember me?"):
    matched, _claimed = app._detect_identity_challenge(q)
    ok(matched, f"recognition probe detected: {q!r}")
    reply = app._identity_challenge_fastpath_reply(q, session_id="sess-rec", history=[])
    ok(
        reply == "I'm not sure yet — you can tell me.",
        f"recognition reply inviting: {q!r}",
        detail=repr(reply),
    )

# 10.b Open identity question -> "I don't know for sure, so I shouldn't guess."
reply_whoami = app._identity_challenge_fastpath_reply(
    "who am I?", session_id="sess-whoami", history=[]
)
ok(
    reply_whoami == "I don't know for sure, so I shouldn't guess.",
    "spec: 'who am I?' -> \"I don't know for sure, so I shouldn't guess.\"",
    detail=repr(reply_whoami),
)

# 10.c spec: "do you know who I am?" -> "I'm not sure yet — you can tell me."
reply_dyk = app._identity_challenge_fastpath_reply(
    "do you know who I am?", session_id="sess-dyk", history=[]
)
ok(
    reply_dyk == "I'm not sure yet — you can tell me.",
    "spec: 'do you know who I am?' -> 'I'm not sure yet — you can tell me.'",
    detail=repr(reply_dyk),
)

# 10.d Style guard: unknown-identity replies avoid robotic policy wording.
for q in ("who am I?", "do you know who I am?", "what's my name?"):
    reply = (app._identity_challenge_fastpath_reply(q, session_id="sess-style", history=[]) or "").lower()
    ok(
        "i should not assume" not in reply and "demo context" not in reply,
        f"identity-unknown reply avoids robotic wording: {q!r}",
        detail=repr(reply),
    )

# 10.e Grounded path still works with the new code (history name wins).
reply_grounded = app._identity_challenge_fastpath_reply(
    "do you know who I am?",
    session_id="sess-grounded",
    history=[{"role": "user", "content": "My name is Alex."}],
)
ok(
    reply_grounded and "Alex" in reply_grounded,
    "grounded recognition probe still names Alex",
    detail=repr(reply_grounded),
)


# =========================================================================
# Summary
# =========================================================================
print(f"\n{YELLOW}-- summary --{RESET}")
print(f"  passed: {PASS}")
print(f"  failed: {FAIL}")
if FAIL:
    print(f"  failures: {', '.join(FAILED)}")
sys.exit(0 if FAIL == 0 else 1)
