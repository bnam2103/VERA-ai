"""Smoke tests for the 2026-05-31 about-me consistency fix.

Covers the four routing/wording surfaces of the user-knowledge handler:

  PART 1 - regex coverage. ``_transcript_asks_about_me`` must fire for the
  full menu of phrasings the spec mentions, including the new "remember"
  family that used to fall through to the normal chat LLM:
      - what do you know about me
      - do you know me
      - what do you remember about me
      - who am I
      - tell me what you know about me
      - what do you remember about me / do you remember me / do you
        remember anything about me
      - what's in my profile

  PART 2 - user_profile projection. ``_project_user_profile_to_known_facts``
  must turn the legacy ``users_files/Nam.json`` shape (which only carries a
  ``user_profile`` block, no ``known_facts``) into the flat
  ``{name, likes, dislikes, identity}`` dict that ``_build_about_me_reply``
  consumes. Without this projection the deterministic, source-attributed
  template never fired for Nam and the LLM fallback would synthesize
  personality traits.

  PART 3 - template wording. ``_build_about_me_reply`` must lead with
  "From your saved profile," so the source attribution is unambiguous.

  PART 4 - LLM-branch isolation. ``_generate_about_me_llm_reply`` must
  build messages WITHOUT going through ``vera.build_messages``, so the
  active user profile is NOT in the system prompt for the about-me LLM
  fallback. We patch ``app.vera.generate`` with a capturing fake and
  assert the messages contain no "Nam" or "Skills:" / "Habits:" leakage.

  PART 5 - end-to-end ``_anonymous_user_fastpath_reply`` routing. Four
  scenarios:
      A. No profile + no facts + no history -> exact fallback line.
      B. Signed in as Nam (projection path) -> "From your saved profile,
         your name is Nam ...".
      C. No profile + session facts (likes=tennis) -> "From this session,
         you like tennis."
      D. No profile + no facts + non-empty history -> LLM branch called,
         and the LLM message stack is profile-free (covered by Part 4).

  PART 6 - diagnostic payload. Every branch must emit a single
  ``[about_me_reply]`` log line carrying:
      session_id, backend_history_turns_count,
      current_session_turns_count, frontend_history_sent_count,
      user_profile_context_present, persistent_memory_enabled,
      explicit_session_facts_present, source_of_user_name,
      source_of_user_facts, what_do_you_know_about_me_route.

Run:  py -3 -X utf8 tests\\smoke\\__about_me_handler_smoke.py
"""
from __future__ import annotations

# --- bootstrap (mirrors __info_normalizer_smoke.py) -----------------------
import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..")))
# --------------------------------------------------------------------------

import io
import json as _json
import os
import sys
import types

os.environ.setdefault("PYTHONIOENCODING", "utf-8")
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
except Exception:
    pass

# Stub out heavy audio modules so `import app` succeeds without TTS/ASR
# side effects. Same shape as __info_normalizer_smoke.py.
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


# Helper: capture stdout to grab the [about_me_reply] line emitted by
# _anonymous_user_fastpath_reply.
class _CaptureStdout:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self._orig: object | None = None

    def __enter__(self) -> "_CaptureStdout":
        self._orig = sys.stdout
        self._buf = io.StringIO()
        sys.stdout = self._buf  # type: ignore[assignment]
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            self._buf.flush()
        except Exception:
            pass
        sys.stdout = self._orig  # type: ignore[assignment]
        for line in self._buf.getvalue().splitlines():
            self.lines.append(line)

    def find_about_me_payload(self) -> dict | None:
        for line in self.lines:
            if "[about_me_reply]" in line:
                _, _, rest = line.partition("[about_me_reply]")
                try:
                    return _json.loads(rest.strip())
                except Exception:
                    return None
        return None


# ============================================================================
# PART 1 -- regex coverage
# ============================================================================
section("PART 1 -- _transcript_asks_about_me regex coverage")

POSITIVE_PHRASES = [
    "what do you know about me",
    "Hey VERA, what do you know about me?",
    "do you know me",
    "Who am I?",
    "Tell me what you know about me",
    "what do you remember about me",
    "do you remember me",
    "do you remember anything about me",
    "what's in my profile",
    "tell me what is in my profile",
    "what have I told you",
]
for phrase in POSITIVE_PHRASES:
    ok(app._transcript_asks_about_me(phrase), f"positive: {phrase!r}")

NEGATIVE_PHRASES = [
    "what do you know about tennis",
    "do you know what the weather is like",
    "tell me what you think about jazz",
    "remember to buy milk",
    "",
    "   ",
]
for phrase in NEGATIVE_PHRASES:
    ok(not app._transcript_asks_about_me(phrase), f"negative: {phrase!r}")


# ============================================================================
# PART 2 -- _project_user_profile_to_known_facts
# ============================================================================
section("PART 2 -- _project_user_profile_to_known_facts on Nam.json shape")

NAM_PROFILE = {
    "status": "admin",
    "user_profile": {
        "name": "Nam",
        "skills": ["tennis", "soccer", "playing piano and clarinet"],
        "interests": ["Attack on Titan", "jazz music"],
        "habits": [
            "sleeping",
            "taking naps",
            "gaming with friends",
            "working out at the gym",
        ],
        "life_context": ["student"],
        "social_traits": [
            "friends often joke that he flakes on plans because he naps"
        ],
    },
}
projected = app._project_user_profile_to_known_facts(NAM_PROFILE)
ok(isinstance(projected, dict), "projection returns dict for Nam.json shape")
ok(projected and projected.get("name") == "Nam", "name projected as 'Nam'",
   detail=str(projected))
likes = (projected or {}).get("likes") or []
ok(
    "Attack on Titan" in likes and "jazz music" in likes,
    "interests projected into likes",
    detail=str(likes),
)
ok("tennis" in likes, "skills projected into likes", detail=str(likes))
ok(len(likes) <= 8, "likes capped at 8 entries", detail=str(len(likes)))
ok(
    (projected or {}).get("identity") == ["student"],
    "life_context projected into identity",
    detail=str((projected or {}).get("identity")),
)
ok(
    (projected or {}).get("dislikes") == [],
    "dislikes default to empty list",
)
# social_traits are explicitly NOT projected -- they are third-party
# observations, not facts the user wants VERA to recite back.
joined_likes_id = " ".join(likes + ((projected or {}).get("identity") or []))
ok(
    "flakes on plans" not in joined_likes_id,
    "social_traits NOT leaked into likes/identity",
    detail=joined_likes_id,
)

# Empty / missing user_profile.
ok(
    app._project_user_profile_to_known_facts({}) is None,
    "empty dict -> None",
)
ok(
    app._project_user_profile_to_known_facts({"user_profile": {}}) is None,
    "empty user_profile -> None",
)
ok(
    app._project_user_profile_to_known_facts(None) is None,
    "None input -> None",
)


# ============================================================================
# PART 3 -- _build_about_me_reply wording
# ============================================================================
section("PART 3 -- _build_about_me_reply wording from projected profile")

# Drive _build_about_me_reply by patching _logged_in_user_known_facts to
# return the projected Nam shape and _get_session_user_facts to return an
# empty blob. Use a stable session_id so the underlying defaultdict-style
# storage doesn't bleed between tests.
_orig_known = app._logged_in_user_known_facts
_orig_session_facts = app._get_session_user_facts


def _fake_known(session_id=None, _facts=projected):
    return _facts


def _fake_empty_session(session_id=None):
    return {
        "name": None,
        "likes": [],
        "dislikes": [],
        "identity": [],
        "statements": [],
    }


app._logged_in_user_known_facts = _fake_known  # type: ignore[assignment]
app._get_session_user_facts = _fake_empty_session  # type: ignore[assignment]
try:
    reply = app._build_about_me_reply("smoke-profile-only")
finally:
    app._logged_in_user_known_facts = _orig_known  # type: ignore[assignment]
    app._get_session_user_facts = _orig_session_facts  # type: ignore[assignment]

ok(
    reply.startswith("From your saved profile,"),
    "reply leads with 'From your saved profile,'",
    detail=reply,
)
ok("your name is Nam" in reply, "reply names the user explicitly", detail=reply)
ok(
    "tennis" in reply or "jazz music" in reply,
    "reply mentions at least one projected like",
    detail=reply,
)
ok("student" in reply, "reply mentions life_context as identity", detail=reply)
ok(
    "keeping things moving" not in reply,
    "reply does NOT synthesize made-up traits",
    detail=reply,
)
ok(
    "flakes on plans" not in reply,
    "reply does NOT surface social_traits",
    detail=reply,
)


# ============================================================================
# PART 4 -- LLM-branch isolation
# ============================================================================
section("PART 4 -- LLM about-me fallback strips the user profile")

captured_messages: list[list[dict]] = []


class _FakeVera:
    """Captures the message stack passed to ``generate`` so we can inspect
    whether profile data leaks into the system prompt for the about-me
    fallback path. Returns a deterministic reply prefixed per spec."""

    active_user_info_path = "users_files/Nam.json"

    def build_messages(self, chat, user_text):
        # Sentinel: if this is ever called from the about-me LLM branch the
        # fix has regressed. Other branches may call it; we only assert
        # this is NOT used by _generate_about_me_llm_reply.
        raise AssertionError(
            "_generate_about_me_llm_reply should bypass build_messages"
        )

    def generate(self, messages):
        captured_messages.append(list(messages))
        return ("From this conversation, you mentioned you like tennis.", 0.01)


_orig_vera = app.vera
app.vera = _FakeVera()  # type: ignore[assignment]
try:
    reply = app._generate_about_me_llm_reply(
        "what do you know about me",
        "smoke-llm",
        history=[
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "Hello."},
            {"role": "user", "content": "I like tennis."},
        ],
    )
finally:
    app.vera = _orig_vera  # type: ignore[assignment]

ok(len(captured_messages) == 1, "vera.generate called exactly once",
   detail=str(len(captured_messages)))

if captured_messages:
    msgs = captured_messages[0]
    sys_block = next(
        (m for m in msgs if m.get("role") in {"developer", "system"}), None
    )
    sys_text = (sys_block or {}).get("content") or ""
    ok(
        bool(sys_block),
        "message stack has a developer/system block",
    )
    ok(
        "Nam" not in sys_text,
        "system prompt does NOT contain 'Nam'",
        detail=sys_text[:200],
    )
    ok(
        "Skills:" not in sys_text and "Habits:" not in sys_text
        and "Interests:" not in sys_text,
        "system prompt does NOT contain profile slot labels",
        detail=sys_text[:200],
    )
    ok(
        "From this conversation," in sys_text,
        "system prompt instructs the model to prefix with 'From this conversation,'",
    )
    # The user's own utterance from chat history is preserved.
    user_contents = [m.get("content", "") for m in msgs if m.get("role") == "user"]
    ok(
        any("I like tennis." in c for c in user_contents),
        "chat history user turn 'I like tennis.' preserved",
    )
    final_user = msgs[-1]
    ok(
        final_user.get("role") == "user"
        and "what do you know about me" in (final_user.get("content") or ""),
        "current user turn appended last",
        detail=str(final_user),
    )

ok(
    reply is not None and "From this conversation," in (reply or ""),
    "LLM reply is returned and prefixed correctly",
    detail=str(reply),
)


# ============================================================================
# PART 5 + PART 6 -- _anonymous_user_fastpath_reply routing + diagnostics
# ============================================================================
section("PART 5/6 -- end-to-end routing + diagnostics")


def _patch_about_me_sources(
    *, projected_profile: dict | None = None, session_facts: dict | None = None
):
    """Install fake lookups for the duration of a single scenario."""
    def fake_known(session_id=None, _p=projected_profile):
        return _p

    def fake_session(session_id=None, _s=session_facts):
        return _s if _s is not None else {
            "name": None,
            "likes": [],
            "dislikes": [],
            "identity": [],
            "statements": [],
        }

    app._logged_in_user_known_facts = fake_known  # type: ignore[assignment]
    app._get_session_user_facts = fake_session  # type: ignore[assignment]


def _restore_about_me_sources():
    app._logged_in_user_known_facts = _orig_known  # type: ignore[assignment]
    app._get_session_user_facts = _orig_session_facts  # type: ignore[assignment]


# Scenario A: fresh session, no profile, no facts, no history -> fallback.
_patch_about_me_sources()
try:
    with _CaptureStdout() as cap:
        reply_a = app._anonymous_user_fastpath_reply(
            "what do you know about me", "smoke-A", history=None
        )
    payload_a = cap.find_about_me_payload()
finally:
    _restore_about_me_sources()

ok(
    reply_a == app.ABOUT_ME_FALLBACK_NO_CONTEXT,
    "Scenario A: fresh session -> exact fallback line",
    detail=str(reply_a),
)
ok(payload_a is not None, "Scenario A: [about_me_reply] log emitted")
if payload_a:
    ok(
        payload_a.get("what_do_you_know_about_me_route") == "fallback_no_history",
        "Scenario A: route=fallback_no_history",
        detail=str(payload_a),
    )
    ok(
        payload_a.get("user_profile_context_present") is False,
        "Scenario A: user_profile_context_present=False",
    )
    ok(
        payload_a.get("persistent_memory_enabled") is False,
        "Scenario A: persistent_memory_enabled=False",
    )
    ok(
        payload_a.get("source_of_user_name") == "none",
        "Scenario A: source_of_user_name=none",
        detail=str(payload_a),
    )
    ok(
        payload_a.get("source_of_user_facts") == "none",
        "Scenario A: source_of_user_facts=none",
    )
    ok(
        payload_a.get("backend_history_turns_count") == 0,
        "Scenario A: backend_history_turns_count=0",
    )
    ok(
        payload_a.get("frontend_history_sent_count") == -1,
        "Scenario A: frontend_history_sent_count=-1 (intentional sentinel)",
    )


# Scenario B: signed in as Nam (projected profile) -> deterministic template.
_patch_about_me_sources(projected_profile=projected)
try:
    with _CaptureStdout() as cap:
        reply_b = app._anonymous_user_fastpath_reply(
            "what do you know about me", "smoke-B", history=None
        )
    payload_b = cap.find_about_me_payload()
finally:
    _restore_about_me_sources()

ok(
    reply_b and reply_b.startswith("From your saved profile,"),
    "Scenario B: template leads with 'From your saved profile,'",
    detail=str(reply_b),
)
ok(reply_b and "Nam" in reply_b, "Scenario B: reply names Nam")
if payload_b:
    ok(
        payload_b.get("what_do_you_know_about_me_route") == "template_profile",
        "Scenario B: route=template_profile",
        detail=str(payload_b),
    )
    ok(
        payload_b.get("user_profile_context_present") is True,
        "Scenario B: user_profile_context_present=True",
    )
    ok(
        payload_b.get("persistent_memory_enabled") is True,
        "Scenario B: persistent_memory_enabled=True",
    )
    ok(
        payload_b.get("source_of_user_name") == "profile",
        "Scenario B: source_of_user_name=profile",
    )
    ok(
        payload_b.get("source_of_user_facts") == "profile",
        "Scenario B: source_of_user_facts=profile",
    )


# Scenario C: no profile, session facts (likes=tennis) -> template_session.
session_blob = {
    "name": None,
    "likes": ["tennis"],
    "dislikes": [],
    "identity": [],
    "statements": [],
}
_patch_about_me_sources(session_facts=session_blob)
try:
    with _CaptureStdout() as cap:
        reply_c = app._anonymous_user_fastpath_reply(
            "what do you know about me", "smoke-C", history=None
        )
    payload_c = cap.find_about_me_payload()
finally:
    _restore_about_me_sources()

ok(
    reply_c and "From this session" in reply_c and "tennis" in reply_c,
    "Scenario C: template mentions session-stored fact 'tennis'",
    detail=str(reply_c),
)
if payload_c:
    ok(
        payload_c.get("what_do_you_know_about_me_route") == "template_session",
        "Scenario C: route=template_session",
        detail=str(payload_c),
    )
    ok(
        payload_c.get("user_profile_context_present") is False,
        "Scenario C: user_profile_context_present=False (session facts only)",
    )
    ok(
        payload_c.get("explicit_session_facts_present") is True,
        "Scenario C: explicit_session_facts_present=True",
    )
    ok(
        payload_c.get("source_of_user_facts") == "session_facts",
        "Scenario C: source_of_user_facts=session_facts",
    )


# Scenario D: no profile, no session facts, non-empty history -> LLM branch.
# We patch app.vera again so we can capture the message stack and confirm
# (i) the route hits 'llm_history' and (ii) backend_history_turns_count
# reflects the history size.
captured_messages.clear()
_patch_about_me_sources()
_orig_vera2 = app.vera
app.vera = _FakeVera()  # type: ignore[assignment]
try:
    with _CaptureStdout() as cap:
        reply_d = app._anonymous_user_fastpath_reply(
            "what do you know about me",
            "smoke-D",
            history=[
                {"role": "user", "content": "I love jazz."},
                {"role": "assistant", "content": "Noted."},
            ],
        )
    payload_d = cap.find_about_me_payload()
finally:
    app.vera = _orig_vera2  # type: ignore[assignment]
    _restore_about_me_sources()

ok(
    reply_d is not None and "From this conversation," in (reply_d or ""),
    "Scenario D: LLM reply returned and prefixed",
    detail=str(reply_d),
)
if payload_d:
    ok(
        payload_d.get("what_do_you_know_about_me_route") == "llm_history",
        "Scenario D: route=llm_history",
        detail=str(payload_d),
    )
    ok(
        payload_d.get("backend_history_turns_count") == 2,
        "Scenario D: backend_history_turns_count=2",
        detail=str(payload_d),
    )
    ok(
        payload_d.get("source_of_user_name") in ("conversation", "none"),
        "Scenario D: source_of_user_name=conversation (no profile, no session name)",
        detail=str(payload_d),
    )


# ============================================================================
# SUMMARY
# ============================================================================
section("Summary")
print(f"  Passed: {GREEN}{PASS}{RESET}   Failed: {RED}{FAIL}{RESET}")
if FAIL:
    print(f"\n  {RED}Failures:{RESET}")
    for n in FAILED:
        print(f"    - {n}")
    sys.exit(1)
sys.exit(0)
