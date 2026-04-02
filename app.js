/* =========================
   SESSION — VERA vs BMO (separate conversation memory on the server)
========================= */

const VERA_SESSION_STORAGE_KEY = "vera_session_id";
const BMO_SESSION_STORAGE_KEY = "bmo_session_id";

function getSessionId() {
  const bmo = document.body.classList.contains("bmo-open");
  const key = bmo ? BMO_SESSION_STORAGE_KEY : VERA_SESSION_STORAGE_KEY;
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

/**
 * Call when opening BMO: new backend session, empty log, voice input default, clear side panel.
 * Exposed for index.html `openBmoPage`.
 */
function resetBmoSessionAndUi() {
  const newId = crypto.randomUUID();
  localStorage.setItem(BMO_SESSION_STORAGE_KEY, newId);

  const convo = document.getElementById("bmo-conversation");
  if (convo) convo.replaceChildren();

  const textIn = document.getElementById("bmo-text-input");
  if (textIn) textIn.value = "";

  const voiceBar = document.getElementById("bmo-voice-bar");
  const keyboardBar = document.getElementById("bmo-keyboard-bar");
  const toggleBtn = document.getElementById("bmo-input-toggle");
  if (voiceBar) voiceBar.classList.remove("hidden");
  if (keyboardBar) keyboardBar.classList.add("hidden");
  if (toggleBtn) toggleBtn.textContent = "⌨️";

  const bmoAudio = document.getElementById("bmo-audio");
  if (bmoAudio) {
    bmoAudio.pause();
    bmoAudio.removeAttribute("src");
    bmoAudio.load?.();
  }

  document.getElementById("bmo-page")?.classList.remove("bmo-tts-mouth");
  document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-emotion");

  hideSidePanel();
}

window.resetBmoSessionAndUi = resetBmoSessionAndUi;

/* =========================
   GLOBAL STATE
========================= */

let micStream = null;
let audioCtx = null;
let analyser = null;
let mediaRecorder = null;

let interruptRecorder = null;
let interruptChunks = [];
let interruptRecording = false;

let audioChunks = [];
let hasSpoken = false;
let lastVoiceTime = 0;

let listening = false;
let processing = false;
let rafId = null;
let interruptSpeechFrames = 0;
let interruptSpeechStart = 0;
/** Ms of speechLike time accumulated from RAF deltas (gaps do not add). */
let interruptSpeechAccumMs = 0;
let lastInterruptDetectTime = 0;
let interruptLastSpeechLikeTime = 0;
/** Snapshot from detectInterrupt when interruptSpeech() fires (for server interrupt_debug). */
let lastInterruptProbe = null;
/** Last frame where speechLike was true (same as trigger frame when interrupt fires). */
let lastInterruptSpeechLikeSnapshot = null;
let pttRecording = false;
let inputMuted = false;
let suppressNextUtterance = false;

let audioStartedAt = 0;
let voiceUxTurn = null;
let textUxTurn = null;
// let interruptStart = 0;
let listeningMode = "continuous"; 
let waveState = "idle";   
let waveEnergy = 0;     

let requestInFlight = false; // 🔑 NEW

/** Start of a voice UX turn: t0 for perceived latency (end of user speech in the browser). */
function beginVoiceUxTurn() {
  voiceUxTurn = {
    speechEndAt: performance.now(),
    firstAudioLogged: false,
    mainReplyLogged: false
  };
}

/** First *any* audio in this turn (typically main `(main-reply)`). */
function logVoiceFirstAudio(kind) {
  if (!voiceUxTurn || voiceUxTurn.firstAudioLogged) return;
  const elapsedMs = performance.now() - voiceUxTurn.speechEndAt;
  voiceUxTurn.firstAudioLogged = true;
  console.log(`[UX][VOICE] SpeechEnd→FirstAudio=${(elapsedMs / 1000).toFixed(3)}s (${kind})`);
}

/**
 * Primary perceived voice metric: end of user speech → first main reply TTS playback.
 * (Not server `latency.total_s`, not `[UX][PIPE]` — those are diagnostics only.)
 */
function logVoiceMainReplyAudio() {
  if (!voiceUxTurn || voiceUxTurn.mainReplyLogged) return;
  const elapsedMs = performance.now() - voiceUxTurn.speechEndAt;
  voiceUxTurn.mainReplyLogged = true;
  console.log(`[UX][VOICE] SpeechEnd→MainReplyAudio=${(elapsedMs / 1000).toFixed(3)}s`);
}

/** Debug: seconds from speech end — use to see upload vs TTFB vs first chunk vs decode (server TOTAL is a different clock). */
function logVoicePipe(label) {
  if (!voiceUxTurn?.speechEndAt) return;
  const s = ((performance.now() - voiceUxTurn.speechEndAt) / 1000).toFixed(3);
  console.log(`[UX][VOICE][PIPE] ${label}  +${s}s from SpeechEnd`);
}

/** Set localStorage VERA_DEBUG_TRANSCRIPTS to "0" to silence [VOICE][TRANSCRIPT] logs. */
function voiceTranscriptDebugEnabled() {
  try {
    return localStorage.getItem("VERA_DEBUG_TRANSCRIPTS") !== "0";
  } catch {
    return true;
  }
}

/**
 * @param {"final"} phase — committed user line (bubble) from `/infer`.
 * @param {Record<string, unknown>} [meta] — e.g. { path: "main-ndjson" }
 */
function logVoiceTranscript(phase, text, meta = {}) {
  if (!voiceTranscriptDebugEnabled()) return;
  console.log("[VOICE][TRANSCRIPT]", { phase, ...meta, text: text ?? "" });
}

function beginTextUxTurn() {
  textUxTurn = {
    sendAt: performance.now(),
    firstAudioLogged: false,
    mainReplyLogged: false
  };
}

function logTextFirstAudio(kind) {
  if (!textUxTurn || textUxTurn.firstAudioLogged) return;
  const elapsedMs = performance.now() - textUxTurn.sendAt;
  textUxTurn.firstAudioLogged = true;
  console.log(`[UX][TEXT] Send→FirstAudio=${(elapsedMs / 1000).toFixed(3)}s (${kind})`);
}

function logTextMainReplyAudio() {
  if (!textUxTurn || textUxTurn.mainReplyLogged) return;
  const elapsedMs = performance.now() - textUxTurn.sendAt;
  textUxTurn.mainReplyLogged = true;
  console.log(`[UX][TEXT] Send→MainReplyAudio=${(elapsedMs / 1000).toFixed(3)}s`);
}

/** Server-side breakdown + optional client TTFB split — for attribution, not end-user perceived time (see SpeechEnd→MainReplyAudio). */
function logInferLatency(data, label, clientTtfbMs) {
  const L = data?.latency;
  if (!L || typeof L !== "object") return;
  const parts = [];
  if (L.short_circuit) parts.push(`short_circuit=${L.short_circuit}`);
  if (L.pre_asr_s != null) parts.push(`PreASR=${L.pre_asr_s}s`);
  if (L.asr_lock_s != null) parts.push(`ASR_lock=${L.asr_lock_s}s`);
  if (L.asr_transcribe_s != null) parts.push(`ASR_transcribe=${L.asr_transcribe_s}s`);
  if (L.bridge_s != null) parts.push(`Bridge=${L.bridge_s}s`);
  if (L.llm_s != null) parts.push(`LLM=${L.llm_s}s`);
  if (L.llm_first_token_s != null) parts.push(`LLM_first_token=${L.llm_first_token_s}s`);
  if (L.llm_first_sentence_ready_s != null)
    parts.push(`LLM_first_sentence_ready=${L.llm_first_sentence_ready_s}s`);
  if (L.post_llm_s != null) parts.push(`PostLLM=${L.post_llm_s}s`);
  if (L.tts_s != null) parts.push(`TTS=${L.tts_s}s`);
  if (L.tts_first_chunk_s != null) parts.push(`TTS_first_chunk=${L.tts_first_chunk_s}s`);
  if (L.first_tts_audio_ready_total_s != null)
    parts.push(`first_TTS_file_ready_total=${L.first_tts_audio_ready_total_s}s`);
  if (L.first_tts_audio_ready_after_pre_asr_s != null)
    parts.push(`first_TTS_file_ready_after_PreASR=${L.first_tts_audio_ready_after_pre_asr_s}s`);
  if (L.first_tts_audio_ready_after_asr_end_s != null)
    parts.push(`first_TTS_file_ready_after_ASR_end=${L.first_tts_audio_ready_after_asr_end_s}s`);
  if (L.total_s != null) parts.push(`TOTAL=${L.total_s}s`);
  if (L.sum_segments_s != null) parts.push(`Σ=${L.sum_segments_s}s`);
  if (L.drift_s != null) parts.push(`drift=${L.drift_s}s`);
  if (L.llm_internal_reported_s != null) parts.push(`llm_internal=${L.llm_internal_reported_s}s`);
  const line = parts.length ? parts.join(" | ") : JSON.stringify(L);
  console.log(`[UX][LATENCY][${label}] ${line}`, L);
  if (L.total_s != null && clientTtfbMs != null && Number.isFinite(clientTtfbMs)) {
    console.log(
      `[UX][LATENCY][split][${label}] backend total_s=${L.total_s} (server clock: infer start→end of full NDJSON stream on Python) | ` +
        `client_ttfb_ms=${Math.round(clientTtfbMs)} (browser: fetch() start→first response headers; includes body upload + Worker/proxy + network + server until it can stream)`
    );
    console.log(
      `[UX][LATENCY][hint] Backend work = ASR / LLM / TTS columns above (Python). ` +
        `Upload/proxy/internet vs backend: compare client_ttfb_ms to how “heavy” those segments are; TOTAL is not the same moment as TTFB (TOTAL waits for the whole stream to finish on the server).`
    );
  }
}

/* =========================
   CONFIG
========================= */

const VOLUME_THRESHOLD = 0.0078; // slightly lower so quieter speech starts more reliably
const SILENCE_MS = 950;     // silence before ending speech
const TRAILING_MS = 300;   // guaranteed tail
const MAX_WAIT_FOR_SPEECH_MS = 2000;
const MIN_AUDIO_BYTES = 1500;
const INTERRUPT_MIN_FRAMES = 1;

/**
 * End-of-utterance (continuous listen + interrupt capture): a frame only resets the
 * silence timer if RMS and ZCR both look like voiced speech. Room tone / fan / AC often
 * stays above VOLUME_THRESHOLD but has ZCR outside this band, so the clip can still end
 * after SILENCE_MS once the user stops talking.
 */
const LISTEN_END_ZCR_MIN = 0.022;
const LISTEN_END_ZCR_MAX = 0.19;

/* Interrupt while TTS plays: RMS / ZCR / crest heuristics + sustain/gap timing (no WASM VAD). */
/* Voiced-speech band for ZCR (zero-crossings / sample). Outside this → rustle/AC/fan/clicks. */
const INTERRUPT_ZCR_MIN = 0.028;
const INTERRUPT_ZCR_MAX = 0.165;
const MAX_SPEECH_RMS = 0.078;
const INTERRUPT_RMS = 0.0105;
/**
 * Min accumulated ms where speechLike is true (wall-clock gaps and quiet frames do not count).
 * Interrupt fires only on a speechLike frame after this threshold.
 */
const INTERRUPT_SUSTAIN_MS = 350;
/** Max ms without a speech-like frame before resetting the sustain counter. */
const INTERRUPT_GAP_RESET_MS = 110;
/** peak/RMS; impulsive handling noise is often very spiky vs sustained vowels. */
const INTERRUPT_MAX_CREST = 38;
const API_URL = "https://vera-api.vera-api-ned.workers.dev";

/** Request NDJSON streaming TTS from /infer and /text so the first /audio URL arrives as soon as it is synthesized. */
const STREAM_TTS = true;

function isNdjsonTtsResponse(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("ndjson") || ct.includes("x-ndjson");
}

/* =========================
   DOM — VERA vs BMO (prefix ids: vera-* / bmo-*)
========================= */

function appModePrefix() {
  return document.body.classList.contains("bmo-open") ? "bmo" : "vera";
}

function uiEl(suffix) {
  return document.getElementById(`${appModePrefix()}-${suffix}`);
}

function getAudioEl() {
  return document.getElementById(`${appModePrefix()}-audio`);
}

function getWaveCanvas() {
  return document.getElementById(`${appModePrefix()}-waveform`);
}

function getWaveCtx() {
  const c = getWaveCanvas();
  return c ? c.getContext("2d") : null;
}

const ttsByMode = {
  vera: { source: null, analyser: null },
  bmo: { source: null, analyser: null }
};

function getTtsAnalyser() {
  return ttsByMode[appModePrefix()]?.analyser ?? null;
}

["vera-audio", "bmo-audio"].forEach((id) => {
  const a = document.getElementById(id);
  if (a) a.crossOrigin = "anonymous";
});

let waveformData = null;
let frequencyData = null;    // Uint8Array for spectrum
let smoothedBars = null;     // smooth bar heights over time
let rippleRings = [];        // { radius, opacity } for ripple effect
let lastRippleTime = 0;
const RIPPLE_SPAWN_INTERVAL_MS = 120;
let waveformRaf = null;

function resizeWaveCanvas() {
  const canvas = getWaveCanvas();
  const waveCtx = getWaveCtx();
  if (!canvas || !waveCtx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  /* Hidden / not laid out yet: don't shrink buffer to 0 (avoids blurry upscale when shown). */
  if (rect.width < 4 || rect.height < 4) return;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  waveCtx.setTransform(1, 0, 0, 1, 0, 0);
  waveCtx.scale(dpr, dpr);
}

window.addEventListener("load", () => {
  resizeWaveCanvas();
});

window.addEventListener("resize", resizeWaveCanvas);

const serverStatusEl = document.getElementById("server-status");

const feedbackInput = document.getElementById("feedback-input");
const sendFeedbackBtn = document.getElementById("send-feedback");
const feedbackStatusEl = document.getElementById("feedback-status");

const IS_MOBILE = window.matchMedia("(max-width: 768px)").matches;

/* =========================
   SERVER HEALTH
========================= */

async function checkServer() {
  let state = "offline";

  try {
    // 🔥 NEW — check full server state
    const statusRes = await fetch(`${API_URL}/status`, {
      cache: "no-store"
    });

    if (statusRes.ok) {
      const data = await statusRes.json();
      state = data.state; // "ready" or "starting"
    } else {
      state = "offline";
    }
  } catch {
    state = "offline";
  }

  // =========================
  // KEEP YOUR OLD UI LOGIC
  // =========================

  const online = state === "ready";

  ["vera-record", "bmo-record"].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.disabled = !online;
    btn.style.opacity = online ? "1" : "0.5";
  });

  if (serverStatusEl) {
    serverStatusEl.textContent =
      state === "ready"
        ? "🟢 Server Online"
        : state === "starting"
        ? "🟡 Server Starting"
        : "🔴 Server Offline";

    serverStatusEl.className =
      `server-status ${
        state === "ready"
          ? "online"
          : state === "starting"
          ? "starting"
          : "offline"
      }`;
  }

  ["vera-server-status-inline", "bmo-server-status-inline"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent =
      state === "ready"
        ? "🟢 Online"
        : state === "starting"
        ? "🟡 Starting"
        : "🔴 Offline";

    el.className =
      `server-status ${
        state === "ready"
          ? "online"
          : state === "starting"
          ? "starting"
          : "offline"
      } mobile-only`;
  });

  return state; // 🔥 IMPORTANT
}

checkServer();
setInterval(checkServer, 30_000);
/* =========================
   UI HELPERS
========================= */

function setStatus(text, cls) {
  const statusEl = uiEl("status");
  if (!statusEl) return;
  if (cls === "thinking") {
    statusEl.innerHTML = `${text}<span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;
  } else {
    statusEl.textContent = text;
  }
  statusEl.className = `status ${cls}`;
}

function updateMuteInputButton() {
  const continuousMicReady = listeningMode === "continuous" && !!micStream;
  const label = !continuousMicReady
    ? "Start voice input"
    : inputMuted
    ? "Unmute input"
    : "Mute input";

  ["vera-record", "bmo-record"].forEach((id) => {
    const recordBtn = document.getElementById(id);
    if (!recordBtn) return;
    recordBtn.classList.toggle("muted", continuousMicReady && inputMuted);
    recordBtn.title = label;
    recordBtn.setAttribute("aria-label", label);
    recordBtn.setAttribute(
      "aria-pressed",
      continuousMicReady && inputMuted ? "true" : "false"
    );
  });
}

function showMutedStatusIfIdle() {
  if (listeningMode !== "continuous" || !inputMuted) return;
  if (processing || !getAudioEl()?.paused) return;

  waveState = "idle";
  setStatus("Input muted", "idle");
}

function setContinuousInputMuted(nextMuted) {
  inputMuted = nextMuted;
  micStream?.getAudioTracks().forEach((track) => {
    track.enabled = !inputMuted;
  });

  if (inputMuted) {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      suppressNextUtterance = true;
      mediaRecorder.stop();
    }

    /* Same as interrupt: stop <audio>, Web Audio chunk queue, and NDJSON TTS stream. */
    resetAudioHandlers();
    cancelMainTtsPlayback();
    const a = getAudioEl();
    if (a) {
      a.pause();
      a.currentTime = 0;
    }

    processing = false;
    listening = true;
    audioChunks = [];
    hasSpoken = false;
    lastVoiceTime = 0;
    showMutedStatusIfIdle();
  } else if (listeningMode === "continuous" && !requestInFlight && getAudioEl()?.paused) {
    listening = true;
    startListening();
  }

  updateMuteInputButton();
}

function dismissGuide() {
  const prefix = appModePrefix();
  const guideId = prefix === "bmo" ? "bmo-guide" : "vera-guide";
  const seenKey = prefix === "bmo" ? "bmo_seen_guide" : "vera_seen_guide";
  const guide = document.getElementById(guideId);
  if (!guide) return;

  guide.classList.remove("show");
  sessionStorage.setItem(seenKey, "true");

  window.setTimeout(() => {
    if (!guide.classList.contains("show")) {
      guide.classList.add("hidden");
    }
  }, 350);
}

function addBubble(text, who, meta) {
  const convoEl = uiEl("conversation");
  if (!convoEl) return;
  if (who === "user" && voiceTranscriptDebugEnabled()) {
    logVoiceTranscript("final", text, { ...meta, via: "addBubble" });
  }
  const row = document.createElement("div");
  row.className = `message-row ${who}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble ${who}`;
  bubble.textContent = text;

  row.appendChild(bubble);
  convoEl.appendChild(row);
  convoEl.scrollTop = convoEl.scrollHeight;
  return bubble;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hideSidePanel() {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;
  sidePaneEl.classList.remove("visible");
  document.body.classList.remove("news-panel-open");
  window.setTimeout(() => {
    if (!sidePaneEl.classList.contains("visible")) {
      sidePaneEl.hidden = true;
      sidePaneEl.innerHTML = "";
    }
  }, 840);
}

function renderNewsResultListMarkup(results) {
  if (!results.length) {
    return `<div class="side-pane-empty">No articles available for this search.</div>`;
  }

  return `
    <div class="news-result-list">
      ${results.map((item, index) => `
        <article class="news-result-card">
          <h4 class="news-result-title">${index + 1}. ${escapeHtml(item.title)}</h4>
          <p class="news-result-snippet">${escapeHtml(item.summary)}</p>
          <div class="news-result-meta">
            <span>${escapeHtml(item.source || "Unknown source")}</span>
            <span>${escapeHtml(item.published_display || "")}</span>
          </div>
          ${item.url ? `<a class="news-result-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open source</a>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderImageResultsMarkup(images) {
  if (!images.length) {
    return `<div class="side-pane-empty">No images available for this search.</div>`;
  }

  return `
    <div class="media-grid">
      ${images.map((item) => `
        <article class="media-card image-card">
          <a
            class="media-link"
            href="${escapeHtml(item.url || item.image_url)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              class="media-image"
              src="${escapeHtml(item.image_url || item.thumbnail_url || "")}"
              alt="${escapeHtml(item.title || "Search result image")}"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
          </a>
          <div class="media-card-body">
            <div class="media-card-title">${escapeHtml(item.title || "Image result")}</div>
            <div class="media-card-meta">${escapeHtml(item.source || "Unknown source")}</div>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function getVideoEmbedUrl(url) {
  if (!url) return "";

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const videoId = parsed.pathname.replaceAll("/", "");
      return videoId ? `https://www.youtube.com/embed/${videoId}` : "";
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
      const videoId = parsed.searchParams.get("v");
      return videoId ? `https://www.youtube.com/embed/${videoId}` : "";
    }
  } catch {
    return "";
  }

  return "";
}

function renderVideoResultsMarkup(videos) {
  if (!videos.length) {
    return `<div class="side-pane-empty">No videos available for this search.</div>`;
  }

  return `
    <div class="video-result-list">
      ${videos.map((item) => {
        const embedUrl = getVideoEmbedUrl(item.url);
        return `
          <article class="media-card video-card">
            ${embedUrl ? `
              <div class="video-embed-wrap">
                <iframe
                  class="video-embed"
                  src="${escapeHtml(embedUrl)}"
                  title="${escapeHtml(item.title)}"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen
                  loading="lazy"
                  referrerpolicy="strict-origin-when-cross-origin"
                ></iframe>
              </div>
            ` : item.thumbnail_url ? `
              <a
                class="media-link"
                href="${escapeHtml(item.url)}"
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  class="media-image"
                  src="${escapeHtml(item.thumbnail_url)}"
                  alt="${escapeHtml(item.title)}"
                  loading="lazy"
                  referrerpolicy="no-referrer"
                />
              </a>
            ` : ""}
            <div class="media-card-body">
              <div class="media-card-title">${escapeHtml(item.title)}</div>
              <div class="media-card-meta">
                <span>${escapeHtml(item.source || "Unknown source")}</span>
                <span>${escapeHtml(item.published_display || "")}</span>
              </div>
              ${item.summary ? `<p class="news-result-snippet">${escapeHtml(item.summary)}</p>` : ""}
              <a class="news-result-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open video</a>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function setActiveSidePaneTab(tabName) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  sidePaneEl.querySelectorAll(".side-pane-tab").forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  sidePaneEl.querySelectorAll(".side-pane-tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tabPanel === tabName);
  });
}

function renderMediaTabsPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;

  const results = Array.isArray(payload?.news_results)
    ? payload.news_results
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  const images = Array.isArray(payload?.images) ? payload.images : [];
  const videos = Array.isArray(payload?.videos) ? payload.videos : [];
  const defaultTab = payload?.default_tab || "news";

  sidePaneEl.hidden = false;
  document.body.classList.add("news-panel-open");

  sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "News Results")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(payload?.query || "Top headlines")}</div>
      </div>
      <div class="side-pane-controls">
        <div class="side-pane-tabs" role="tablist" aria-label="Search result tabs">
          <button class="side-pane-tab ${defaultTab === "news" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "news" ? "true" : "false"}" data-tab="news">News</button>
          <button class="side-pane-tab ${defaultTab === "images" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "images" ? "true" : "false"}" data-tab="images">Images</button>
          <button class="side-pane-tab ${defaultTab === "video" ? "active" : ""}" type="button" role="tab" aria-selected="${defaultTab === "video" ? "true" : "false"}" data-tab="video">Video</button>
        </div>
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "news" ? "active" : ""}" data-tab-panel="news">
      ${renderNewsResultListMarkup(results)}
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "images" ? "active" : ""}" data-tab-panel="images">
      ${renderImageResultsMarkup(images)}
    </div>
    <div class="side-pane-tab-panel ${defaultTab === "video" ? "active" : ""}" data-tab-panel="video">
      ${renderVideoResultsMarkup(videos)}
    </div>
  `;

  sidePaneEl.scrollTop = 0;

  requestAnimationFrame(() => {
    sidePaneEl.classList.add("visible");
  });
}

function renderFinanceChartPanel(payload) {
  const sidePaneEl = uiEl("side-pane");
  if (!sidePaneEl) return;
  const frameSrc = payload?.chart_url
    ? (payload.chart_url.startsWith("/") ? `${API_URL}${payload.chart_url}` : payload.chart_url)
    : "";

  sidePaneEl.hidden = false;
  document.body.classList.add("news-panel-open");

  sidePaneEl.innerHTML = `
    <div class="side-pane-header">
      <div class="side-pane-heading">
        <h3 class="side-pane-title">${escapeHtml(payload?.title || "Stock Chart")}</h3>
        <div class="side-pane-subtitle">${escapeHtml(payload?.query || payload?.symbol || "Quote lookup")}</div>
      </div>
      <div class="side-pane-controls">
        <button class="side-pane-close" type="button" aria-label="Close panel">×</button>
      </div>
    </div>
    <div class="finance-chart-panel">
      ${frameSrc ? `
        <div class="finance-chart-wrap">
          <iframe
            class="finance-chart-frame"
            src="${escapeHtml(frameSrc)}"
            title="${escapeHtml(payload?.symbol || payload?.query || "Stock chart")}"
            loading="lazy"
            referrerpolicy="strict-origin-when-cross-origin"
          ></iframe>
        </div>
      ` : `
        <div class="side-pane-empty">
          I couldn’t resolve a chart symbol for this quote yet.
          ${payload?.source_url ? `<a class="news-result-link" href="${escapeHtml(payload.source_url)}" target="_blank" rel="noopener noreferrer">Open finance source</a>` : ""}
        </div>
      `}
    </div>
  `;

  sidePaneEl.scrollTop = 0;

  requestAnimationFrame(() => {
    sidePaneEl.classList.add("visible");
  });
}

function onSidePaneClick(event) {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest(".side-pane-close")) {
    hideSidePanel();
    return;
  }

  if (target instanceof HTMLElement) {
    const tabButton = target.closest(".side-pane-tab");
    if (tabButton instanceof HTMLButtonElement) {
      setActiveSidePaneTab(tabButton.dataset.tab || "news");
    }
  }
}

["vera-side-pane", "bmo-side-pane"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", onSidePaneClick);
});

function applyActionPayload(data) {
  const payload = data?.action_payload;
  if (payload?.panel_type === "media_tabs" || payload?.panel_type === "news_results") {
    /* Large innerHTML (news + images + video embeds) can block the main thread; defer so BMO mouth RAF keeps up. */
    requestAnimationFrame(() => renderMediaTabsPanel(payload));
    return;
  }

  if (payload?.panel_type === "finance_chart") {
    renderFinanceChartPanel(payload);
    return;
  }

  hideSidePanel();
}

/** News/finance side panel + assistant bubble — call when main reply audio actually starts (not when LLM JSON/meta arrives). */
function applyAssistantReplyAndPanels(data) {
  if (!data) return;
  applyActionPayload(data);
  if (data.reply == null || data.reply === "") return;
  addBubble(data.reply, "vera");
}

function createNdjsonStreamingReplyState() {
  return { bubble: null, latest: "" };
}

/**
 * Grow one assistant bubble as each NDJSON chunk includes reply_so_far (sentence-cumulative text).
 */
function applyNdjsonStreamingReplySoFar(replySoFar, state) {
  if (replySoFar == null || replySoFar === "") return;
  state.latest = String(replySoFar);
  const convoEl = uiEl("conversation");
  if (!convoEl) return;
  const text = state.latest;
  if (state.bubble?.isConnected) {
    const cur = state.bubble.textContent || "";
    /* Done line can arrive before deferred first play; finalize may have filled the full reply — don't overwrite with a shorter cumulative partial. */
    if (text.length >= cur.length) {
      state.bubble.textContent = text;
    }
  } else {
    state.bubble = addBubble(text, "vera", { path: "ndjson-reply-so-far" });
  }
  convoEl.scrollTop = convoEl.scrollHeight;
}

/** After NDJSON done: sync bubble to final reply, or add bubble if no streaming partials. */
function finalizeNdjsonStreamingReply(ndjsonMeta, done, state) {
  if (!done?.reply) return;
  if (ndjsonMeta?.reply) return;
  if (state.bubble?.isConnected) {
    state.bubble.textContent = done.reply;
    return;
  }
  /* Must assign state.bubble so applyNdjsonStreamingReplySoFar doesn't add a second bubble if done arrives before first audio (defer path). */
  applyActionPayload({ ...ndjsonMeta, reply: done.reply });
  state.bubble = addBubble(done.reply, "vera", { path: "ndjson-final" });
}

function interruptSpeech() {
  if (!interruptRecording) return;
  const a = getAudioEl();
  const htmlPlaying = a && !a.paused;
  const webTtsPlaying =
    activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive;
  if (!htmlPlaying && !webTtsPlaying) return;

  setStatus("Listening… (interrupted)", "recording");
  resetAudioHandlers();

  cancelMainTtsPlayback();
  if (a) {
    a.pause();
    a.currentTime = 0;
  }

  listening = true;
  processing = false;
  waveState = "listening";
  interruptSpeechFrames = 0;
  interruptSpeechStart = 0;
  interruptSpeechAccumMs = 0;
  lastInterruptDetectTime = 0;
  interruptLastSpeechLikeTime = 0;
  lastInterruptSpeechLikeSnapshot = null;

  interruptLastVoiceTime = performance.now();
  requestAnimationFrame(detectInterruptSpeechEnd);
}

function detectInterrupt() {
  if (!analyser) {
    requestAnimationFrame(detectInterrupt);
    return;
  }

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  // RMS
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);

  // ZCR (voicing) + crest (reject single sharp transients from bumps/clicks)
  const zcr = computeZCR(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const crest = peak / (rms + 1e-8);

  const now = performance.now();

  // Only interrupt while main TTS is playing: single-file uses <audio>; chunked/streaming uses Web Audio BufferSources.
  const outAudio = getAudioEl();
  const htmlAudioPlaying = outAudio && !outAudio.paused;
  const webAudioMainTtsPlaying =
    activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive;
  if (
  listeningMode === "continuous" &&
  (htmlAudioPlaying || webAudioMainTtsPlaying)
) {
    // grace period to avoid clicks
    if (now - audioStartedAt > 200) {
      const dtRaw = lastInterruptDetectTime ? now - lastInterruptDetectTime : 0;
      const dt = Math.min(Math.max(dtRaw, 0), 80);
      lastInterruptDetectTime = now;

      const heuristicChecks = computeHeuristicInterruptChecks(rms, zcr, crest);
      const speechLike = heuristicChecks.passes;

      if (speechLike) {
        interruptSpeechAccumMs += dt;
        if (interruptSpeechFrames === 0) {
          interruptSpeechStart = now;
        }
        interruptSpeechFrames++;
        interruptLastSpeechLikeTime = now;
        lastInterruptSpeechLikeSnapshot = {
          rms,
          zcr,
          crest,
          heuristicChecks,
          at: now,
        };
      } else if (
        interruptLastSpeechLikeTime &&
        now - interruptLastSpeechLikeTime <= INTERRUPT_GAP_RESET_MS
      ) {
        // Allow tiny gaps so normal speech doesn't need a perfect uninterrupted stream (time here does not add to interruptSpeechAccumMs).
      } else {
        interruptSpeechFrames = 0;
        interruptSpeechStart = 0;
        interruptSpeechAccumMs = 0;
        interruptLastSpeechLikeTime = 0;
        lastInterruptSpeechLikeSnapshot = null;
      }

      if (
        speechLike &&
        interruptSpeechFrames >= INTERRUPT_MIN_FRAMES &&
        interruptSpeechAccumMs >= INTERRUPT_SUSTAIN_MS
      ) {
        const gate = "heuristic";
        const snap = lastInterruptSpeechLikeSnapshot;
        logInterruptTriggerReason({
          gate,
          triggerFrame: { rms, zcr, crest, speechLike },
          lastSpeechLike: snap,
          speechAccumMs: interruptSpeechAccumMs,
          wallMsSinceFirstSpeech: interruptSpeechStart
            ? now - interruptSpeechStart
            : 0,
          rafFrames: interruptSpeechFrames,
        });
        lastInterruptProbe = {
          atTrigger: { rms, zcr, crest, speechLike },
          lastSpeechLike: snap,
          interruptGate: gate,
          interruptReason: "heuristic",
          heuristicChecks: snap?.heuristicChecks ?? heuristicChecks,
          speechAccumMs: interruptSpeechAccumMs,
          wallMsSinceFirstSpeech: interruptSpeechStart
            ? now - interruptSpeechStart
            : 0,
          frames: interruptSpeechFrames,
        };
        interruptSpeech();
        interruptSpeechFrames = 0;
        interruptSpeechStart = 0;
        interruptSpeechAccumMs = 0;
        interruptLastSpeechLikeTime = 0;
        lastInterruptSpeechLikeSnapshot = null;
      }
    }
  } else {
    interruptSpeechFrames = 0;
    interruptSpeechStart = 0;
    interruptSpeechAccumMs = 0;
    lastInterruptDetectTime = 0;
    interruptLastSpeechLikeTime = 0;
    lastInterruptSpeechLikeSnapshot = null;
  }

  requestAnimationFrame(detectInterrupt);
}

function resetAudioHandlers() {
  const a = getAudioEl();
  if (a) {
    a.onplay = null;
    a.onended = null;
  }
}

let interruptLastVoiceTime = 0;

function detectInterruptSpeechEnd() {
  if (!interruptRecording || interruptRecorder?.state !== "recording") return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);

  const now = performance.now();

  if (listeningFrameIsSpeechLike(buf, rms)) {
    interruptLastVoiceTime = now;
  }

  if (
    interruptLastVoiceTime &&
    now - interruptLastVoiceTime > SILENCE_MS
  ) {
    interruptRecorder.stop(); // ✅ NOW stop
    interruptRecording = false;
    return;
  }

  requestAnimationFrame(detectInterruptSpeechEnd);
}

function computeZCR(buf) {
  let crossings = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] >= 0 && buf[i] < 0) ||
        (buf[i - 1] < 0 && buf[i] >= 0)) {
      crossings++;
    }
  }
  return crossings / buf.length;
}

/** RMS + ZCR voiced band — used so background noise alone does not stall end-of-speech. */
function listeningFrameIsSpeechLike(buf, rms) {
  if (rms <= VOLUME_THRESHOLD) return false;
  const zcr = computeZCR(buf);
  return zcr >= LISTEN_END_ZCR_MIN && zcr <= LISTEN_END_ZCR_MAX;
}

/** Per-threshold flags for interrupt (RMS/ZCR/crest); all must pass for a frame to count as speech-like. */
function computeHeuristicInterruptChecks(rms, zcr, crest) {
  const rmsAboveMin = rms > INTERRUPT_RMS;
  const rmsBelowMax = rms < MAX_SPEECH_RMS;
  const zcrInRange = zcr >= INTERRUPT_ZCR_MIN && zcr <= INTERRUPT_ZCR_MAX;
  const crestOk = crest <= INTERRUPT_MAX_CREST;
  return {
    rmsAboveMin,
    rmsBelowMax,
    zcrInRange,
    crestOk,
    passes:
      rmsAboveMin && rmsBelowMax && zcrInRange && crestOk,
  };
}

function logInterruptTriggerReason({
  gate,
  triggerFrame,
  lastSpeechLike,
  speechAccumMs,
  wallMsSinceFirstSpeech,
  rafFrames,
}) {
  const base = {
    gate,
    speechAccumMs: Number(speechAccumMs.toFixed(1)),
    wallMsSinceFirstSpeech: Number(wallMsSinceFirstSpeech.toFixed(1)),
    rafFrames,
    triggerKind: "speech_frame (accumulated speechLike time ≥ INTERRUPT_SUSTAIN_MS)",
    triggerFrame: {
      rms: Number(triggerFrame.rms.toFixed(5)),
      zcr: Number(triggerFrame.zcr.toFixed(5)),
      crest: Number(triggerFrame.crest.toFixed(4)),
      speechLike: triggerFrame.speechLike,
    },
  };
  const h =
    lastSpeechLike?.heuristicChecks ??
    computeHeuristicInterruptChecks(
      lastSpeechLike?.rms ?? triggerFrame.rms,
      lastSpeechLike?.zcr ?? triggerFrame.zcr,
      lastSpeechLike?.crest ?? triggerFrame.crest
    );
  const checks = [];
  if (h.rmsAboveMin) checks.push("rms_min");
  if (h.rmsBelowMax) checks.push("rms_max");
  if (h.zcrInRange) checks.push("zcr");
  if (h.crestOk) checks.push("crest");
  console.log(
    "[INTERRUPT] trigger — heuristic (RMS/ZCR/crest + sustain; all must pass on speech frames)",
    {
      ...base,
      lastSpeechLike: lastSpeechLike
        ? {
            rms: Number(lastSpeechLike.rms.toFixed(5)),
            zcr: Number(lastSpeechLike.zcr.toFixed(5)),
            crest: Number(lastSpeechLike.crest.toFixed(4)),
            heuristicChecks: checks.join("+"),
            flags: {
              rmsAboveMin: h.rmsAboveMin,
              rmsBelowMax: h.rmsBelowMax,
              zcrInRange: h.zcrInRange,
              crestOk: h.crestOk,
            },
          }
        : null,
    }
  );
}

function startInterruptCapture() {
  // 🔥 HARD FLUSH — stop and discard any previous capture
  if (interruptRecorder && interruptRecorder.state !== "inactive") {
    try {
      interruptRecorder.ondataavailable = null;
      interruptRecorder.onstop = null;
      interruptRecorder.stop();
    } catch {}
  }

  interruptRecorder = null;
  interruptRecording = false;
  interruptChunks = [];
  interruptSpeechFrames = 0;
  interruptSpeechStart = 0;
  interruptSpeechAccumMs = 0;
  lastInterruptDetectTime = 0;
  interruptLastSpeechLikeTime = 0;
  lastInterruptSpeechLikeSnapshot = null;

  // ---------- START FRESH RECORDER ----------
  interruptRecorder = new MediaRecorder(micStream);

  interruptRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      interruptChunks.push(e.data);
    }
  };

  interruptRecorder.onstop = () => {
    const blob = new Blob(interruptChunks, { type: "audio/webm" });

    interruptRecorder = null;
    interruptRecording = false;
    interruptChunks = [];

    handleInterruptUtterance(blob);
  };

  interruptRecorder.start();   // 🚀 clean segment start
  interruptRecording = true;
}

async function handleInterruptUtterance(blob) {
  if (blob.size < MIN_AUDIO_BYTES) {
    listening = true;
    return;
  }

  requestInFlight = true;
  processing = true;
  waveState = "idle";
  setStatus("Thinking", "thinking");

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", getSessionId());
  formData.append("client", appModePrefix());
  formData.append("mode", "interrupt"); // backend can branch if desired
  formData.append(
    "interrupt_debug",
    JSON.stringify({
      probe: lastInterruptProbe,
      thresholds: {
        INTERRUPT_RMS,
        INTERRUPT_ZCR_MIN,
        INTERRUPT_ZCR_MAX,
        INTERRUPT_SUSTAIN_MS,
        INTERRUPT_GAP_RESET_MS,
        INTERRUPT_MAX_CREST,
        MAX_SPEECH_RMS,
      },
    })
  );
  formData.append("stream_tts", STREAM_TTS ? "1" : "0");

  try {
    logVoicePipe("POST /infer starting (interrupt, upload in flight)");
    const inferFetchStart = performance.now();
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });
    const inferTtfbMs = performance.now() - inferFetchStart;
    logVoicePipe("POST /infer response headers (interrupt)");

    if (STREAM_TTS && res.ok && isNdjsonTtsResponse(res)) {
      requestInFlight = false;

      const runStream = async () => {
        let ndjsonMeta = null;
        const streamReplyState = createNdjsonStreamingReplyState();
        resetAudioHandlers();
        try {
          await runNdjsonTtsPlayback(res, {
            onMeta: (meta) => {
              ndjsonMeta = { ...ndjsonMeta, ...meta };
              if (meta.transcript) {
                addBubble(meta.transcript, "user", { path: "interrupt-ndjson" });
              }
            },
            onReplyProgress: (replySoFar) => {
              if (ndjsonMeta?.reply) return;
              applyNdjsonStreamingReplySoFar(replySoFar, streamReplyState);
            },
            onDone: (done) => {
              logInferLatency(done, "interrupt", inferTtfbMs);
              finalizeNdjsonStreamingReply(ndjsonMeta, done, streamReplyState);
            },
            onPlayStart: () => {
              logVoiceFirstAudio("main-reply");
              logVoiceMainReplyAudio();
              /* NDJSON: reply bubble comes from reply_so_far + finalizeNdjsonStreamingReply — not addBubble here (duplicate). */
              applyActionPayload(ndjsonMeta);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus("Speaking… (can only be interrupted once)", "speaking");
              processing = false;
            },
            onPlayEnd: () => {
              listening = true;
              if (inputMuted) {
                showMutedStatusIfIdle();
                return;
              }
              startListening();
            }
          });
        } catch (e) {
          console.warn(e);
        }
      };

      await runStream();
      return;
    }

    const data = await res.json();
    logInferLatency(data, "interrupt", inferTtfbMs);

    requestInFlight = false;

    /* =========================
       CONTROL FLOW (FIRST)
    ========================= */

    if (data.skip) {
      hideSidePanel();
      processing = false;
      listening = true;
      getAudioEl()?.pause();
      startListening();
      return;
    }

    if (data.client_action === "mute_input") {
      hideSidePanel();
      getAudioEl()?.pause();
      processing = false;
      listening = true;
      setContinuousInputMuted(true);
      return;
    }

    /* =========================
       NORMAL INTERRUPT REPLY
    ========================= */

    addBubble(data.transcript, "user", { path: "interrupt-json" });

    await playInterruptAnswer(data);

  } catch {
    hideSidePanel();
    requestInFlight = false;
    setStatus("Server error", "offline");
    listening = true;
  }
}

async function playInterruptAnswer(data) {
  const run = async () => {
    resetAudioHandlers();
    try {
      await playTtsFromApi(data, {
        onPlayStart: () => {
          logVoiceFirstAudio("main-reply");
          logVoiceMainReplyAudio();
          applyAssistantReplyAndPanels(data);
          waveState = "speaking";
          audioStartedAt = performance.now();
          setStatus("Speaking… (can only be interrupted once)", "speaking");
          processing = false;
        },
        onPlayEnd: () => {
          listening = true;
          if (inputMuted) {
            showMutedStatusIfIdle();
            return;
          }
          startListening();
        }
      });
    } catch (e) {
      console.warn(e);
    }
  };

  await run();
}
/* =========================
   MIC INIT
========================= */

/** Per-mode TTS <audio> through Web Audio (vera-audio / bmo-audio). */
async function ensureMainAudioTtsGraph() {
  const m = appModePrefix();
  const el = getAudioEl();
  if (!el || ttsByMode[m].source) return;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  const source = audioCtx.createMediaElementSource(el);
  source.connect(analyser);
  source.connect(audioCtx.destination);
  ttsByMode[m].source = source;
  ttsByMode[m].analyser = analyser;
}

/** Prefer `audio_urls` when present (sentence-chunked TTS); else single `audio_url`. */
function resolveAudioUrls(data) {
  if (Array.isArray(data.audio_urls) && data.audio_urls.length) return data.audio_urls;
  if (data.audio_url) return [data.audio_url];
  return [];
}

/** Sentence-chunk / streaming TTS uses BufferSource → destination; `<audio>` stays paused, so interrupt must track these. */
let activeMainTtsBufferSources = [];
/** True from first main TTS chunk until last chunk ends — gaps between BufferSources have 0 active sources but TTS is still "playing". */
let mainTtsPlaybackActive = false;
/** Incremented on interrupt so NDJSON read + incremental Web Audio loops exit and stop scheduling further chunks. */
let mainTtsPlaybackToken = 0;
/** Active NDJSON `res.body.getReader()`; cancelled on interrupt so the stream stops feeding the URL queue. */
let activeNdjsonBodyReader = null;

function registerMainTtsBufferSource(src, onEndedExtra) {
  activeMainTtsBufferSources.push(src);
  src.onended = () => {
    const i = activeMainTtsBufferSources.indexOf(src);
    if (i >= 0) activeMainTtsBufferSources.splice(i, 1);
    if (onEndedExtra) onEndedExtra();
  };
}

function stopAllMainTtsWebAudio() {
  mainTtsPlaybackActive = false;
  const copy = activeMainTtsBufferSources.slice();
  activeMainTtsBufferSources = [];
  for (const src of copy) {
    try {
      src.onended = null;
      src.stop(0);
    } catch (_) {
      /* already stopped */
    }
  }
  if (document.body.classList.contains("bmo-open")) {
    stopBmoTtsMouthAnimation();
  }
}

function cancelMainTtsPlayback() {
  mainTtsPlaybackToken++;
  stopAllMainTtsWebAudio();
  const r = activeNdjsonBodyReader;
  activeNdjsonBodyReader = null;
  if (r) {
    try {
      r.cancel();
    } catch (_) {
      /* ignore */
    }
  }
}

/** Same wiring as MediaElementSource → analyser + destination: chunked TTS must feed the TTS analyser or BMO mouth / VERA wave stay flat. */
function connectBufferSourceToTtsGraph(src) {
  const m = appModePrefix();
  const t = ttsByMode[m];
  if (t?.analyser) {
    src.connect(t.analyser);
  }
  src.connect(audioCtx.destination);
}

function wrapLastChunkForBmoMouth(onLastEnd) {
  if (!onLastEnd) return undefined;
  return () => {
    mainTtsPlaybackActive = false;
    if (document.body.classList.contains("bmo-open")) {
      stopBmoTtsMouthAnimation();
    }
    onLastEnd();
  };
}

/**
 * Schedule decoded buffers back-to-back on one AudioContext (minimal gaps vs chained <audio>).
 * Prefetches the next HTTP response while decoding/playing the current chunk.
 */
async function playTtsUrlSequenceGapless(
  baseUrl,
  relativeUrls,
  { onFirstStart, onLastEnd, sessionToken } = {}
) {
  if (!relativeUrls?.length) return;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  await ensureMainAudioTtsGraph();
  mainTtsPlaybackActive = true;
  getAudioEl()?.pause();
  let t = audioCtx.currentTime + 0.08;
  let firstDone = false;

  let nextPromise = fetch(`${baseUrl}${relativeUrls[0]}`).then((r) => {
    if (!r.ok) throw new Error(`TTS chunk 0 HTTP ${r.status}`);
    return r.arrayBuffer();
  });

  try {
  for (let i = 0; i < relativeUrls.length; i++) {
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const ab = await nextPromise;
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    nextPromise =
      i + 1 < relativeUrls.length
        ? fetch(`${baseUrl}${relativeUrls[i + 1]}`).then((r) => {
            if (!r.ok) throw new Error(`TTS chunk ${i + 1} HTTP ${r.status}`);
            return r.arrayBuffer();
          })
        : null;

    const audBuf = await audioCtx.decodeAudioData(ab.slice(0));
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audBuf;
    connectBufferSourceToTtsGraph(src);
    const startAt = Math.max(t, audioCtx.currentTime + 0.02);
    src.start(startAt);
    /* BMO mouth before onFirstStart: onPlayStart applies news side panel (heavy innerHTML); blocking first would let TTS chunks finish before RAF starts — generic headlines path is slower than “breaking news”. */
    if (document.body.classList.contains("bmo-open")) {
      void startBmoTtsMouthAnimation();
    }
    if (!firstDone && onFirstStart) {
      onFirstStart();
      firstDone = true;
    }
    const isLast = i === relativeUrls.length - 1;
    registerMainTtsBufferSource(
      src,
      isLast && onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : undefined
    );
    t = startAt + audBuf.duration;
  }
  } catch (e) {
    mainTtsPlaybackActive = false;
    throw e;
  }
}

/** Single <audio> for one file; Web Audio queue when multiple sentence chunks. */
async function playTtsFromApi(data, { onPlayStart, onPlayEnd } = {}) {
  const urls = resolveAudioUrls(data);
  if (!urls.length) return;

  if (urls.length > 1) {
    console.log(
      `[UX][TTS] ${urls.length} segments — one /text or /infer response; next: ${urls.length} GETs to /audio/...`,
      urls
    );
  }

  const sessionToken = mainTtsPlaybackToken;
  const runPlayStart = () => {
    if (onPlayStart) onPlayStart();
  };

  if (urls.length === 1) {
    const el = getAudioEl();
    if (!el) return;
    el.src = `${API_URL}${urls[0]}`;
    await ensureMainAudioTtsGraph();
    el.addEventListener(
      "play",
      () => {
        mainTtsPlaybackActive = true;
        if (document.body.classList.contains("bmo-open")) {
          void startBmoTtsMouthAnimation();
        }
        runPlayStart();
      },
      { once: true }
    );
    el.addEventListener(
      "ended",
      () => {
        mainTtsPlaybackActive = false;
        if (onPlayEnd) onPlayEnd();
      },
      { once: true }
    );
    await el.play();
    return;
  }

  await playTtsUrlSequenceGapless(API_URL, urls, {
    onFirstStart: runPlayStart,
    onLastEnd: onPlayEnd,
    sessionToken
  });
}

function createTtsUrlQueue() {
  const q = [];
  const waiters = [];
  let ended = false;
  return {
    push(url) {
      q.push(url);
      const w = waiters.shift();
      if (w) w();
    },
    end() {
      ended = true;
      waiters.splice(0).forEach((w) => w());
    },
    async next() {
      for (;;) {
        if (q.length) return q.shift();
        if (ended) return null;
        await new Promise((r) => waiters.push(r));
      }
    }
  };
}

/** Gapless Web Audio playback when URLs arrive incrementally (streaming NDJSON chunks). */
async function playTtsUrlSequenceIncremental(
  baseUrl,
  nextRelFn,
  { onBeforeFirstPlay, onFirstStart, onLastEnd, sessionToken } = {}
) {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  await ensureMainAudioTtsGraph();
  let t = audioCtx.currentTime + 0.08;
  let firstDone = false;

  let curRel = await nextRelFn();
  if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
    mainTtsPlaybackActive = false;
    return;
  }
  if (!curRel) return;
  mainTtsPlaybackActive = true;
  getAudioEl()?.pause();
  let nextPromise = fetch(`${baseUrl}${curRel}`).then((r) => {
    if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);
    return r.arrayBuffer();
  });

  try {
  for (;;) {
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const ab = await nextPromise;
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const nextRel = await nextRelFn();
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    nextPromise = nextRel
      ? fetch(`${baseUrl}${nextRel}`).then((r) => {
          if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);
          return r.arrayBuffer();
        })
      : null;

    const audBuf = await audioCtx.decodeAudioData(ab.slice(0));
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    if (!firstDone && onBeforeFirstPlay) {
      onBeforeFirstPlay();
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audBuf;
    connectBufferSourceToTtsGraph(src);
    const startAt = Math.max(t, audioCtx.currentTime + 0.02);
    src.start(startAt);
    /* Same order as gapless: mouth before onPlayStart so heavy news panel does not block first tick. */
    if (document.body.classList.contains("bmo-open")) {
      void startBmoTtsMouthAnimation();
    }
    if (!firstDone && onFirstStart) {
      onFirstStart();
      firstDone = true;
    }
    const isLast = !nextRel;
    registerMainTtsBufferSource(
      src,
      isLast && onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : undefined
    );
    t = startAt + audBuf.duration;
    if (!nextRel) break;
  }
  } catch (e) {
    mainTtsPlaybackActive = false;
    throw e;
  }
}

/**
 * Consume application/x-ndjson: meta → chunk → … → done. Prefetches the next URL while decoding/playing.
 * Within each parsed batch, enqueue chunk URLs before onMeta so GET /audio/ can start while bubbles render.
 * First-sentence assistant text is applied in onBeforeFirstPlay (after decode, before src.start) so it aligns with audio.
 */
async function runNdjsonTtsPlayback(res, { onMeta, onDone, onPlayStart, onPlayEnd, onReplyProgress }) {
  const reader = res.body.getReader();
  activeNdjsonBodyReader = reader;
  const sessionToken = mainTtsPlaybackToken;
  const decoder = new TextDecoder();
  let buf = "";
  const queue = createTtsUrlQueue();
  let loggedFirstChunk = false;
  /** First-sentence text is deferred until first audio buffer is decoded (sync with playback start). */
  let pendingFirstReplySoFar = null;
  let deferFirstReply = true;
  /** Latest reply_so_far already applied via onReplyProgress (avoids onBeforeFirstPlay overwriting with shorter pending). */
  let lastEmittedReplySoFar = null;

  async function readAll() {
    try {
      while (true) {
        if (mainTtsPlaybackToken !== sessionToken) {
          queue.end();
          return;
        }
        let readResult;
        try {
          readResult = await reader.read();
        } catch {
          queue.end();
          return;
        }
        const { value, done: rdone } = readResult;
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        const objs = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            objs.push(JSON.parse(line));
          } catch (e) {
            console.warn("[TTS][NDJSON] skip line", e);
          }
        }
        for (const obj of objs) {
          if (obj.type === "chunk" && obj.url) {
            if (mainTtsPlaybackToken !== sessionToken) {
              queue.end();
              return;
            }
            if (!loggedFirstChunk) {
              loggedFirstChunk = true;
              logVoicePipe("NDJSON first chunk URL queued (GET /audio/... next)");
            }
            queue.push(obj.url);
            if (obj.reply_so_far != null && onReplyProgress) {
              if (deferFirstReply) {
                pendingFirstReplySoFar = String(obj.reply_so_far);
                deferFirstReply = false;
              } else {
                onReplyProgress(obj.reply_so_far);
                lastEmittedReplySoFar = String(obj.reply_so_far);
              }
            }
          }
        }
        for (const obj of objs) {
          if (obj.type === "meta") {
            onMeta(obj);
            logVoicePipe("NDJSON meta line (UI can attach transcript)");
          } else if (obj.type === "done") {
            if (onDone) onDone(obj);
            queue.end();
          }
        }
      }
    } finally {
      queue.end();
      if (activeNdjsonBodyReader === reader) activeNdjsonBodyReader = null;
    }
  }

  const readTask = readAll();
  try {
    await Promise.all([
      playTtsUrlSequenceIncremental(API_URL, () => queue.next(), {
        onBeforeFirstPlay: () => {
          if (pendingFirstReplySoFar != null && onReplyProgress) {
            const pending = pendingFirstReplySoFar;
            pendingFirstReplySoFar = null;
            const alreadyAhead =
              lastEmittedReplySoFar != null &&
              lastEmittedReplySoFar.length >= pending.length;
            if (!alreadyAhead) {
              onReplyProgress(pending);
              lastEmittedReplySoFar = pending;
            }
          }
        },
        onFirstStart: onPlayStart,
        onLastEnd: onPlayEnd,
        sessionToken
      }),
      readTask
    ]);
  } finally {
    if (activeNdjsonBodyReader === reader) activeNdjsonBodyReader = null;
  }
}

async function initMic() {
  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  resizeWaveCanvas();

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);

  await ensureMainAudioTtsGraph();

  detectInterrupt();
  startWaveAnimation();
  updateMuteInputButton();
}
/* =========================
   WAVE ANIMATION
   - Frequency-band bars (FFT): bass → treble, amplitude per band
   - Ripple effect: concentric circles that pulse outward with amplitude
========================= */

const BARS = 48;  // frequency bands (bass on sides, treble toward center for symmetry)
const RIPPLE_EXPAND_SPEED = 2.2;
const RIPPLE_FADE_SPEED = 0.018;
const RIPPLE_SPAWN_THRESHOLD = 0.12;  // min avg magnitude to spawn ripple

function freqDataToBands(analyserRef, freqBuf, barValues) {
  if (!analyserRef || !freqBuf) return;
  analyserRef.getByteFrequencyData(freqBuf);
  const binCount = freqBuf.length;
  // Log-like band mapping: more resolution in bass/low-mids (where voice lives)
  for (let i = 0; i < BARS; i++) {
    const fracStart = Math.pow(i / BARS, 1.4);
    const fracEnd = Math.pow((i + 1) / BARS, 1.4);
    const binStart = Math.floor(fracStart * binCount);
    const binEnd = Math.min(Math.ceil(fracEnd * binCount), binCount);
    let sum = 0;
    let n = 0;
    for (let b = binStart; b < binEnd; b++) {
      sum += freqBuf[b];
      n++;
    }
    barValues[i] = n > 0 ? sum / n / 255 : 0;
  }
}

function startWaveAnimation() {
  if (waveformRaf) return;

  function draw() {
    waveformRaf = requestAnimationFrame(draw);

    const canvas = getWaveCanvas();
    const waveCtx = getWaveCtx();
    if (!canvas || !waveCtx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    waveCtx.clearRect(0, 0, width, height);

    const bmoOpen = document.body.classList.contains("bmo-open");
    /* BMO: waveform only while user is speaking (listening); TTS uses SVG mouth */
    if (bmoOpen && waveState === "speaking") {
      return;
    }

    const ttsA = getTtsAnalyser();
    let activeAnalyser = null;
    if (waveState === "listening" && analyser) activeAnalyser = analyser;
    if (waveState === "speaking" && ttsA) activeAnalyser = ttsA;

    if (!frequencyData || !activeAnalyser || frequencyData.length !== activeAnalyser.frequencyBinCount) {
      if (activeAnalyser) {
        frequencyData = new Uint8Array(activeAnalyser.frequencyBinCount);
        smoothedBars = new Float32Array(BARS);
      }
    }

    const targetEnergy = waveState === "speaking" ? 0.9 : waveState === "listening" ? 0.8 : 0;
    waveEnergy += (targetEnergy - waveEnergy) * 0.06;

    const barValues = new Float32Array(BARS);
    if (activeAnalyser && frequencyData) {
      freqDataToBands(activeAnalyser, frequencyData, barValues);
    }

    const barSpacing = width / BARS;
    const barWidth = barSpacing * 0.4;
    let avgMagnitude = 0;

    for (let i = 0; i < BARS; i++) {
      const v = barValues[i];
      avgMagnitude += v;
      const smooth = 0.25;
      if (smoothedBars) smoothedBars[i] = smoothedBars[i] * (1 - smooth) + v * smooth;
    }
    avgMagnitude /= BARS;

    const now = performance.now();
    if (waveEnergy > 0.3 && avgMagnitude > RIPPLE_SPAWN_THRESHOLD && now - lastRippleTime > RIPPLE_SPAWN_INTERVAL_MS) {
      rippleRings.push({ radius: 0, opacity: 0.5 + avgMagnitude * 0.4 });
      lastRippleTime = now;
    }

    for (let r = rippleRings.length - 1; r >= 0; r--) {
      const ring = rippleRings[r];
      ring.radius += RIPPLE_EXPAND_SPEED;
      ring.opacity -= RIPPLE_FADE_SPEED;
      if (ring.opacity <= 0) {
        rippleRings.splice(r, 1);
        continue;
      }
      const rippleAlpha = bmoOpen ? ring.opacity * 0.42 : ring.opacity * 0.35;
      const rr = bmoOpen ? 8 : 255;
      const rg = bmoOpen ? 72 : 255;
      const rb = bmoOpen ? 46 : 255;
      waveCtx.strokeStyle = `rgba(${rr},${rg},${rb},${rippleAlpha})`;
      waveCtx.lineWidth = 1.5;
      waveCtx.beginPath();
      waveCtx.arc(centerX, centerY, ring.radius, 0, Math.PI * 2);
      waveCtx.stroke();
    }

    const boost = waveState === "speaking" ? 2.8 : waveState === "listening" ? 2.8 : 0;
    const minimumBarScale = waveState === "listening" ? 0.05 : 0.03;
    const mid = BARS / 2;
    if (bmoOpen) {
      waveCtx.fillStyle = "rgba(10, 68, 42, 0.98)";
      /* Lighter shadow than VERA: mint bar + heavy blur reads as muddy / soft. */
      waveCtx.shadowBlur = 3;
      waveCtx.shadowColor = "rgba(4, 42, 26, 0.35)";
    } else {
      waveCtx.fillStyle = "rgba(255,255,255,0.95)";
      waveCtx.shadowBlur = 14;
      waveCtx.shadowColor = "rgba(255,255,255,0.7)";
    }

    for (let i = 0; i < BARS; i++) {
      const raw = (smoothedBars && waveEnergy > 0) ? smoothedBars[i] : barValues[i];
      const distance = Math.abs(i - mid) / mid;
      const envelope = Math.pow(1 - distance, 2.0);
      const barHeight =
        Math.max(minimumBarScale, raw) * height * boost * envelope * waveEnergy;

      const x = i * barSpacing + (barSpacing - barWidth) / 2;
      waveCtx.beginPath();
      waveCtx.roundRect(x, centerY - barHeight, barWidth, barHeight * 2, barWidth / 2);
      waveCtx.fill();
    }
  }

  draw();
}

/* =========================
   BMO — TTS drives SVG mouth (same shaping as intro in index.html)
========================= */

/**
 * BMO TTS mouth: idle (stroke) / surprised (O) / happy (open).
 *
 * What drives it:
 * - **Instant level** ≈ waveform RMS + a little **FFT peak** (tallest bin in the voice band).
 *   We deliberately use almost no **band average**: that stays high for all vowels and was
 *   keeping you stuck on "happy".
 * - **Happy** when **loudness spikes above a slow baseline** (syllable edges), not when level
 *   sits flat high — flat TTS used to keep `instant ≈ peakHold` forever → stuck on happy.
 * - **Surprised** during steady voiced segments (baseline catches up, “excess” drops).
 * - **Idle** when instant + speech body are low (tiny pauses).
 */
const BMO_TTS_MOUTH_ENERGY_GAIN = 4.35;
/** Voice-ish bins for ~48 kHz / 2048 FFT: bin ~4 → ~94 Hz, cap ~3 kHz. */
const BMO_TTS_FREQ_BIN_START = 4;
const BMO_TTS_FREQ_BIN_END = 128;
/** Slow baseline under instant; higher = baseline lags more → more happy vs mostly surprised. */
const BMO_TTS_BASELINE_EMA = 0.946;
/** Decay on the spike memory of (instant − baseline); lower = snappier surprised between hits. */
const BMO_TTS_EXCESS_PEAK_DECAY = 0.73;
/** Excess must be this close to its decaying peak to count as a hit (higher = shorter happy). */
const BMO_TTS_EXCESS_NEAR_PEAK_FRAC = 0.75;
/** Minimum “bump” above baseline to open happy (noise gate on spikes). */
const BMO_TTS_MIN_EXCESS_HAPPY = 0.022;
/** Slow envelope mix: speech present vs gap (surprised vs idle). */
const BMO_TTS_SPEECH_BODY_EMA = 0.86;

const bmoPageForTts = document.getElementById("bmo-page");

let bmoTtsMouthRaf = null;
let bmoTtsMouthTime = null;
let bmoTtsMouthFreq = null;
let bmoTtsBaseline = 0;
let bmoTtsExcessPeak = 0;
let bmoTtsSpeechBody = 0;
let bmoTtsEmotion = "idle";

function bmoComputeTtsInstant01(ttsA, timeBuf, freqBuf) {
  ttsA.getByteTimeDomainData(timeBuf);
  let rms = 0;
  for (let i = 0; i < timeBuf.length; i++) {
    const v = (timeBuf[i] - 128) / 128;
    rms += v * v;
  }
  rms = Math.sqrt(rms / timeBuf.length);
  const rms01 = Math.min(1, rms * BMO_TTS_MOUTH_ENERGY_GAIN);

  ttsA.getByteFrequencyData(freqBuf);
  const i0 = Math.min(BMO_TTS_FREQ_BIN_START, freqBuf.length);
  const i1 = Math.min(BMO_TTS_FREQ_BIN_END, freqBuf.length);
  let peak = 0;
  for (let i = i0; i < i1; i++) {
    const b = freqBuf[i];
    if (b > peak) peak = b;
  }
  const bandPeak = peak / 255;

  /* RMS + FFT peak: tiny bit more peak helps happy fire on spectral hits without flattening prosody. */
  return Math.min(1, rms01 * 0.9 + bandPeak * 0.3);
}

/**
 * nearPeak: true when loudness is spiking above the slow baseline (not sustained flat).
 * speechBody: slow level for "still talking" vs tiny gaps → surprised vs idle.
 */
function bmoStepTtsEmotion(nearPeak, speechBody, instant, prev) {
  const idleCut = 0.052;
  const idleCutHyst = 0.062;

  if (prev === "happy") {
    if (speechBody < idleCut && instant < 0.06) return "idle";
    if (!nearPeak) return "surprised";
    return "happy";
  }
  if (prev === "surprised") {
    if (speechBody < idleCut && instant < 0.055) return "idle";
    if (nearPeak) return "happy";
    return "surprised";
  }
  if (speechBody > idleCutHyst || instant > 0.085) return "surprised";
  if (nearPeak) return "happy";
  return "idle";
}

function stopBmoTtsMouthAnimation() {
  if (bmoTtsMouthRaf) {
    cancelAnimationFrame(bmoTtsMouthRaf);
    bmoTtsMouthRaf = null;
  }
  bmoPageForTts?.classList.remove("bmo-tts-mouth");
  document.getElementById("bmo-smile-svg")?.removeAttribute("data-bmo-tts-emotion");
  bmoTtsBaseline = 0;
  bmoTtsExcessPeak = 0;
  bmoTtsSpeechBody = 0;
  bmoTtsEmotion = "idle";
}

function tickBmoTtsMouth() {
  if (!bmoPageForTts?.classList.contains("bmo-tts-mouth")) {
    stopBmoTtsMouthAnimation();
    return;
  }
  if (!document.body.classList.contains("bmo-open")) {
    stopBmoTtsMouthAnimation();
    return;
  }
  const smileSvg = document.getElementById("bmo-smile-svg");
  const ttsA = ttsByMode.bmo.analyser;
  const bmoOut = document.getElementById("bmo-audio");
  if (!smileSvg || !ttsA) {
    stopBmoTtsMouthAnimation();
    return;
  }
  const webAudioTtsPlaying = activeMainTtsBufferSources.length > 0;
  if (
    !bmoOut ||
    (!webAudioTtsPlaying &&
      !mainTtsPlaybackActive &&
      (bmoOut.paused || bmoOut.ended))
  ) {
    stopBmoTtsMouthAnimation();
    return;
  }
  if (!bmoTtsMouthTime || bmoTtsMouthTime.length !== ttsA.fftSize) {
    bmoTtsMouthTime = new Uint8Array(ttsA.fftSize);
  }
  if (!bmoTtsMouthFreq || bmoTtsMouthFreq.length !== ttsA.frequencyBinCount) {
    bmoTtsMouthFreq = new Uint8Array(ttsA.frequencyBinCount);
  }

  const instant = bmoComputeTtsInstant01(ttsA, bmoTtsMouthTime, bmoTtsMouthFreq);
  bmoTtsBaseline =
    bmoTtsBaseline * BMO_TTS_BASELINE_EMA + instant * (1 - BMO_TTS_BASELINE_EMA);
  const excess = Math.max(0, instant - bmoTtsBaseline);
  bmoTtsExcessPeak = Math.max(excess, bmoTtsExcessPeak * BMO_TTS_EXCESS_PEAK_DECAY);
  const nearPeak =
    excess >= bmoTtsExcessPeak * BMO_TTS_EXCESS_NEAR_PEAK_FRAC &&
    excess >= BMO_TTS_MIN_EXCESS_HAPPY;
  bmoTtsSpeechBody =
    bmoTtsSpeechBody * BMO_TTS_SPEECH_BODY_EMA + instant * (1 - BMO_TTS_SPEECH_BODY_EMA);
  bmoTtsEmotion = bmoStepTtsEmotion(nearPeak, bmoTtsSpeechBody, instant, bmoTtsEmotion);
  smileSvg.setAttribute("data-bmo-tts-emotion", bmoTtsEmotion);

  bmoTtsMouthRaf = requestAnimationFrame(tickBmoTtsMouth);
}

async function startBmoTtsMouthAnimation() {
  if (!document.body.classList.contains("bmo-open") || !bmoPageForTts) return;
  try {
    await ensureMainAudioTtsGraph();
  } catch (e) {
    console.warn("BMO TTS graph", e);
    return;
  }
  if (!ttsByMode.bmo.analyser) return;
  bmoPageForTts.classList.add("bmo-tts-mouth");
  document.getElementById("bmo-smile-svg")?.setAttribute("data-bmo-tts-emotion", "idle");
  bmoTtsBaseline = 0;
  bmoTtsExcessPeak = 0;
  bmoTtsSpeechBody = 0;
  bmoTtsEmotion = "idle";
  if (bmoTtsMouthRaf) return;
  bmoTtsMouthRaf = requestAnimationFrame(tickBmoTtsMouth);
}

document.getElementById("bmo-audio")?.addEventListener("playing", () => {
  void startBmoTtsMouthAnimation();
});
document.getElementById("bmo-audio")?.addEventListener("pause", () => {
  /* Chunked TTS keeps <audio> paused while BufferSources play; do not kill the mouth on that pause. */
  if (activeMainTtsBufferSources.length > 0 || mainTtsPlaybackActive) return;
  stopBmoTtsMouthAnimation();
});
document.getElementById("bmo-audio")?.addEventListener("ended", () => {
  stopBmoTtsMouthAnimation();
});

/* =========================
   SPEECH DETECTION
========================= */

function detectSpeech() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);

  const now = performance.now();

  if (listeningFrameIsSpeechLike(buf, rms)) {
    hasSpoken = true;
    lastVoiceTime = now;
  }

  if (
    hasSpoken &&
    now - lastVoiceTime > SILENCE_MS + TRAILING_MS &&
    (getAudioEl()?.paused ?? true) // 🔑 only stop when not speaking
  ) {
    beginVoiceUxTurn();
    mediaRecorder.stop();
    return;
  }

  rafId = requestAnimationFrame(detectSpeech);
}

/* =========================
   START LISTENING
========================= */

function startListening() {
  if (!listening || processing) return;
  if (listeningMode === "continuous" && inputMuted) {
    showMutedStatusIfIdle();
    updateMuteInputButton();
    return;
  }
  waveState = "listening";
  audioChunks = [];
  hasSpoken = false;
  lastVoiceTime = 0;

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  mediaRecorder.onstop = handleUtterance;

  mediaRecorder.start();
  detectSpeech();

  setTimeout(() => {
    if (!hasSpoken && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, MAX_WAIT_FOR_SPEECH_MS);

  updateMuteInputButton();
  setStatus("Listening…", "recording");
}

/* =========================
   HANDLE UTTERANCE
========================= */

async function handleUtterance() {
  if (suppressNextUtterance) {
    suppressNextUtterance = false;
    processing = false;
    audioChunks = [];
    hasSpoken = false;
    voiceUxTurn = null;
    showMutedStatusIfIdle();
    return;
  }

  if (listeningMode === "continuous" && inputMuted) {
    processing = false;
    audioChunks = [];
    hasSpoken = false;
    voiceUxTurn = null;
    showMutedStatusIfIdle();
    return;
  }

  if (listeningMode === "continuous" && !hasSpoken) {
    processing = false;
    voiceUxTurn = null;
    startListening();
    return;
  }

  const blob = new Blob(audioChunks, { type: "audio/webm" });

  if (blob.size < MIN_AUDIO_BYTES) {
    processing = false;
    voiceUxTurn = null;

    if (listeningMode === "continuous") {
      startListening();
    }

    return;
  }
  requestInFlight = true;
  processing = true;
  waveState = "idle";

  setStatus("Thinking", "thinking");

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", getSessionId());
  formData.append("client", appModePrefix());

  // 🔑 ADD THIS
  if (listeningMode === "ptt") {
    formData.append("mode", "ptt");
  }
  formData.append("stream_tts", STREAM_TTS ? "1" : "0");

  try {
    logVoicePipe("POST /infer starting (main, upload in flight)");
    const inferFetchStart = performance.now();
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });
    const inferTtfbMs = performance.now() - inferFetchStart;
    logVoicePipe("POST /infer response headers (main — TTFB)");

    if (STREAM_TTS && res.ok && isNdjsonTtsResponse(res)) {
      requestInFlight = false;

      let ndjsonMeta = null;
      const streamReplyState = createNdjsonStreamingReplyState();
      void (async () => {
        try {
          console.log("[UX][TTS] NDJSON streaming (main)");
          resetAudioHandlers();
          await runNdjsonTtsPlayback(res, {
            onMeta: (meta) => {
              ndjsonMeta = { ...ndjsonMeta, ...meta };
              if (meta.transcript) {
                addBubble(meta.transcript, "user", { path: "main-ndjson" });
                if (!document.body.classList.contains("chat-started")) {
                  document.body.classList.add("chat-started");
                  dismissGuide();
                }
              }
            },
            onReplyProgress: (replySoFar) => {
              if (ndjsonMeta?.reply) return;
              applyNdjsonStreamingReplySoFar(replySoFar, streamReplyState);
            },
            onDone: (done) => {
              logInferLatency(done, "main", inferTtfbMs);
              finalizeNdjsonStreamingReply(ndjsonMeta, done, streamReplyState);
            },
            onPlayStart: () => {
              logVoiceFirstAudio("main-reply");
              logVoiceMainReplyAudio();
              /* NDJSON: assistant bubble already from streaming + finalize — only side panels here. */
              applyActionPayload(ndjsonMeta);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus("Speaking… (Interruptible)", "speaking");
              startInterruptCapture();
            },
            onPlayEnd: () => {
              waveState = "listening";
              processing = false;

              if (listeningMode === "continuous") {
                listening = true;
                if (inputMuted) {
                  showMutedStatusIfIdle();
                  return;
                }
                startListening();
              }
            }
          });
        } catch (e) {
          console.warn(e);
        }
      })();
      return;
    }

    const data = await res.json();
    logInferLatency(data, "main", inferTtfbMs);
    requestInFlight = false;

    // 🔑 HANDLE CONTROL FLOW FIRST (NO AUDIO YET)
    if (data.skip) {
      hideSidePanel();
      processing = false;
      getAudioEl()?.pause();

      if (listeningMode === "ptt") {
        setStatus("No voice detected", "idle");
      } else if (listeningMode === "continuous") {
        startListening();
      }

      return;
    }

    if (data.client_action === "mute_input") {
      hideSidePanel();
      voiceUxTurn = null;
      getAudioEl()?.pause();
      processing = false;
      setContinuousInputMuted(true);
      return;
    }

    addBubble(data.transcript, "user", { path: "main-json" });
    if (!document.body.classList.contains("chat-started")) {
      document.body.classList.add("chat-started");
      dismissGuide();
    }
    const playMainAnswer = () => {
      resetAudioHandlers();
      void (async () => {
        try {
          await playTtsFromApi(data, {
            onPlayStart: () => {
              logVoiceFirstAudio("main-reply");
              logVoiceMainReplyAudio();
              applyAssistantReplyAndPanels(data);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus("Speaking… (Interruptible)", "speaking");
              startInterruptCapture();
            },
            onPlayEnd: () => {
              waveState = "listening";
              processing = false;

              if (listeningMode === "continuous") {
                listening = true;
                if (inputMuted) {
                  showMutedStatusIfIdle();
                  return;
                }
                startListening();
              }
            }
          });
        } catch (e) {
          console.warn(e);
        }
      })();
    };

    playMainAnswer();

  } catch {
    hideSidePanel();
    processing = false;
    requestInFlight = false;
    setStatus("Server error", "offline");
  }
}

/* =========================
   TEXT INPUT PIPELINE
========================= */
async function sendTextMessage() {
  const textInput = uiEl("text-input");
  const statusLine = uiEl("status");
  const text = textInput?.value.trim() ?? "";

  // 🔑 recover from offline
  if (statusLine?.classList.contains("offline")) {
    requestInFlight = false;
    processing = false;
    listening = false;
    setStatus("Ready", "idle");
  }

  if (!text || requestInFlight) return;
  if (textInput) textInput.value = "";

  beginTextUxTurn();
  listening = false;
  processing = true;
  requestInFlight = true;
  waveState = "idle";

  setStatus("Thinking", "thinking");

  addBubble(text, "user", { path: "typed-text" });
  if (!document.body.classList.contains("chat-started")) {
    document.body.classList.add("chat-started");
    dismissGuide();
  }
  try {
    const textFetchStart = performance.now();
    const res = await fetch(`${API_URL}/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        session_id: getSessionId(),
        client: appModePrefix(),
        stream_tts: STREAM_TTS
      })
    });
    const textTtfbMs = performance.now() - textFetchStart;

    if (STREAM_TTS && res.ok && isNdjsonTtsResponse(res)) {
      requestInFlight = false;

      let ndjsonMeta = null;
      const streamReplyState = createNdjsonStreamingReplyState();
      void (async () => {
        try {
          console.log("[UX][TTS] NDJSON streaming (text)");
          resetAudioHandlers();
          await runNdjsonTtsPlayback(res, {
            onMeta: (meta) => {
              ndjsonMeta = { ...ndjsonMeta, ...meta };
            },
            onReplyProgress: (replySoFar) => {
              if (ndjsonMeta?.reply) return;
              applyNdjsonStreamingReplySoFar(replySoFar, streamReplyState);
            },
            onDone: (done) => {
              logInferLatency(done, "text", textTtfbMs);
              finalizeNdjsonStreamingReply(ndjsonMeta, done, streamReplyState);
            },
            onPlayStart: () => {
              logTextFirstAudio("main-reply");
              logTextMainReplyAudio();
              applyActionPayload(ndjsonMeta);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus("Speaking…", "speaking");
            },
            onPlayEnd: () => {
              waveState = "listening";
              processing = false;
              listening = true;
              if (inputMuted) {
                showMutedStatusIfIdle();
                return;
              }
              startListening();
            }
          });
        } catch (e) {
          console.warn(e);
        }
      })();
      return;
    }

    const data = await res.json();
    logInferLatency(data, "text", textTtfbMs);

    requestInFlight = false;

    const playReply = () => {
      resetAudioHandlers();
      void (async () => {
        try {
          await playTtsFromApi(data, {
            onPlayStart: () => {
              logTextFirstAudio("main-reply");
              logTextMainReplyAudio();
              applyAssistantReplyAndPanels(data);
              waveState = "speaking";
              audioStartedAt = performance.now();
              setStatus("Speaking…", "speaking");
            },
            onPlayEnd: () => {
              waveState = "listening";
              processing = false;
              listening = true;
              if (inputMuted) {
                showMutedStatusIfIdle();
                return;
              }
              startListening();
            }
          });
        } catch (e) {
          console.warn(e);
        }
      })();
    };

    playReply();

  } catch (err) {
    console.error(err);
    hideSidePanel();
    requestInFlight = false;
    processing = false;
    textUxTurn = null;
    setStatus("Server error", "offline");
  }
}

/* =========================
   MIC BUTTON
========================= */
async function onPttClick() {
  if (requestInFlight) return;

  if (!pttRecording) {
    listeningMode = "ptt";
    updateMuteInputButton();
    pttRecording = true;

    await initMic();
    micStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });

    listening = true;
    processing = false;
    waveState = "listening";

    audioChunks = [];
    hasSpoken = false;
    lastVoiceTime = 0;

    mediaRecorder = new MediaRecorder(micStream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = handleUtterance;

    mediaRecorder.start();

    setStatus("Listening (PTT)", "recording");
    return;
  }

  if (pttRecording) {
    pttRecording = false;
    listening = false;
    waveState = "idle";
    if (mediaRecorder && mediaRecorder.state === "recording") {
      beginVoiceUxTurn();
      mediaRecorder.stop();
    }
  }
}

["vera-ptt", "bmo-ptt"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", onPttClick);
});

async function onRecordClick() {
  listeningMode = "continuous";
  updateMuteInputButton();

  if (!listening) {
    inputMuted = false;
    await initMic();
    micStream?.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    listening = true;
    updateMuteInputButton();
    startListening();
    return;
  }

  if (listeningMode !== "continuous" || !micStream) return;
  setContinuousInputMuted(!inputMuted);
}

["vera-record", "bmo-record"].forEach((id) => {
  document.getElementById(id)?.addEventListener("click", onRecordClick);
});

updateMuteInputButton();

if (!IS_MOBILE) {
  ["vera", "bmo"].forEach((prefix) => {
    const sendTextBtn = document.getElementById(`${prefix}-send-text`);
    const textInput = document.getElementById(`${prefix}-text-input`);
    sendTextBtn?.addEventListener("click", sendTextMessage);
    textInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        sendTextMessage();
      }
    });
  });
}

/* =========================
   FEEDBACK
========================= */

if (sendFeedbackBtn) {
  sendFeedbackBtn.onclick = async () => {
    const text = feedbackInput.value.trim();
    if (!text) return;

    feedbackStatusEl.textContent = "Sending…";
    feedbackStatusEl.style.color = "";

    try {
      const res = await fetch(`${API_URL}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: getSessionId(),
          feedback: text,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString()
        })
      });

      if (!res.ok) throw new Error();

      feedbackInput.value = "";
      feedbackStatusEl.textContent = "Thank you for your feedback!";
      feedbackStatusEl.style.color = "#5cffb1";
    } catch {
      feedbackStatusEl.textContent = "Failed to send feedback.";
      feedbackStatusEl.style.color = "#ff6b6b";
    }
  };
}