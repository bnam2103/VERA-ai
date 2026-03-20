/* =========================
   SESSION SETUP (PERSISTENT)
========================= */

let sessionId = localStorage.getItem("vera_session_id");
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem("vera_session_id", sessionId);
}

/* =========================
   GLOBAL STATE
========================= */

let micStream = null;
let audioCtx = null;
let analyser = null;
let mediaRecorder = null;

let ttsSource = null;
let ttsAnalyser = null;
let ttsData = null;

let interruptRecorder = null;
let interruptChunks = [];
let interruptRecording = false;

let audioChunks = [];
let hasSpoken = false;
let lastVoiceTime = 0;

let listening = false;
let processing = false;
let paused = false;
let rafId = null;
let fillerTimer = null;
let fillerPlayedThisTurn = false;
let interruptSpeechFrames = 0;
let interruptSpeechStart = 0;
let interruptLastSpeechLikeTime = 0;
let pttRecording = false;
let inputMuted = false;
let suppressNextUtterance = false;

let fillerPlaying = false;
let fillerStartedAt = 0;
let pendingMainAnswer = null;
let audioStartedAt = 0;
let voiceUxTurn = null;
// let interruptStart = 0;
let listeningMode = "continuous"; 
let waveState = "idle";   
let waveEnergy = 0;     

const FILLER_DELAY_MS = 5300;  // feels natural
const FILLER_GRACE_MS = 1000;  
const pttBtn = document.getElementById("ptt");

const FILLER_AUDIO_FILES = [
  "/static/fillers/moment.wav",
  "/static/fillers/one_second.wav",
  "/static/fillers/give_me_a_second.wav",
  "/static/fillers/one_moment.wav"
];
let requestInFlight = false; // 🔑 NEW

function beginVoiceUxTurn() {
  voiceUxTurn = {
    speechEndAt: performance.now(),
    firstAudioLogged: false,
    mainReplyLogged: false
  };
}

function logVoiceFirstAudio(kind) {
  if (!voiceUxTurn || voiceUxTurn.firstAudioLogged) return;
  const elapsedMs = performance.now() - voiceUxTurn.speechEndAt;
  voiceUxTurn.firstAudioLogged = true;
  console.log(`[UX][VOICE] SpeechEnd→FirstAudio=${(elapsedMs / 1000).toFixed(3)}s (${kind})`);
}

function logVoiceMainReplyAudio() {
  if (!voiceUxTurn || voiceUxTurn.mainReplyLogged) return;
  const elapsedMs = performance.now() - voiceUxTurn.speechEndAt;
  voiceUxTurn.mainReplyLogged = true;
  console.log(`[UX][VOICE] SpeechEnd→MainReplyAudio=${(elapsedMs / 1000).toFixed(3)}s`);
}

function startFillerTimer() {
  clearTimeout(fillerTimer);

  fillerPlaying = false;
  fillerStartedAt = 0;

  fillerTimer = setTimeout(() => {
    if (!requestInFlight) return;
    if (fillerPlaying) return;
    if (paused) return; 

    const filler =
      FILLER_AUDIO_FILES[Math.floor(Math.random() * FILLER_AUDIO_FILES.length)];

    fillerPlaying = true;
    fillerPlayedThisTurn = true;
    fillerStartedAt = performance.now();

    const fillerSrc = `${API_URL}${filler}`;
    resetAudioHandlers();
    audioEl.src = fillerSrc;
    audioEl.addEventListener(
      "play",
      () => {
        if (audioEl.src === fillerSrc) {
          logVoiceFirstAudio("filler");
        }
      },
      { once: true }
    );
    audioEl.play().catch(console.warn);

    audioEl.addEventListener(
      "ended",
      () => {
        if (audioEl.src !== fillerSrc) return; // 🔑 guard
        fillerPlaying = false;

        if (!requestInFlight && pendingMainAnswer) {
          setTimeout(() => {
            pendingMainAnswer?.();
            pendingMainAnswer = null;
          }, FILLER_GRACE_MS);
        }
      },
      { once: true }
    );
  }, FILLER_DELAY_MS);
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

const INTERRUPT_ZCR_MIN = 0.015;
const INTERRUPT_ZCR_MAX = 0.25; 
const MAX_SPEECH_RMS = 0.080;
const INTERRUPT_RMS = 0.0085;  // slightly lower so softer interruptions register
const INTERRUPT_SUSTAIN_MS = 500;
const INTERRUPT_GAP_RESET_MS = 140;
const API_URL = "https://vera-api.vera-api-ned.workers.dev";

let keepAliveInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;

  keepAliveInterval = setInterval(() => {
    fetch(`${API_URL}/status`, { cache: "no-store" }).catch(() => {});
  }, 25000); // every 25s
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}
/* =========================
   DOM
========================= */

const recordBtn = document.getElementById("record");
const statusEl = document.getElementById("status");
const convoEl = document.getElementById("conversation");
const sidePaneEl = document.getElementById("side-pane");
const muteInputBtn = document.getElementById("mute-input");
const inputToggleBtn = document.getElementById("input-toggle");
const voiceBarEl = document.getElementById("voice-bar");
const audioEl = document.getElementById("audio");
audioEl.crossOrigin = "anonymous";
const canvas = document.getElementById("waveform");
const waveCtx = canvas?.getContext("2d");

let waveformData = null;
let frequencyData = null;    // Uint8Array for spectrum
let smoothedBars = null;     // smooth bar heights over time
let rippleRings = [];        // { radius, opacity } for ripple effect
let lastRippleTime = 0;
const RIPPLE_SPAWN_INTERVAL_MS = 120;
let waveformRaf = null;

function resizeWaveCanvas() {
  if (!canvas || !waveCtx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  // 🔥 RESET TRANSFORM FIRST
  waveCtx.setTransform(1, 0, 0, 1, 0, 0);

  // 🔥 THEN SCALE
  waveCtx.scale(dpr, dpr);
}

window.addEventListener("load", () => {
  resizeWaveCanvas();
});

window.addEventListener("resize", resizeWaveCanvas);

const serverStatusEl = document.getElementById("server-status");
const serverStatusInlineEl = document.getElementById("server-status-inline");

const feedbackInput = document.getElementById("feedback-input");
const sendFeedbackBtn = document.getElementById("send-feedback");
const feedbackStatusEl = document.getElementById("feedback-status");

const textInput = document.getElementById("text-input");
const sendTextBtn = document.getElementById("send-text");
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

  recordBtn.disabled = !online;
  recordBtn.style.opacity = online ? "1" : "0.5";

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

  if (serverStatusInlineEl) {
    serverStatusInlineEl.textContent =
      state === "ready"
        ? "🟢 Online"
        : state === "starting"
        ? "🟡 Starting"
        : "🔴 Offline";

    serverStatusInlineEl.className =
      `server-status ${
        state === "ready"
          ? "online"
          : state === "starting"
          ? "starting"
          : "offline"
      } mobile-only`;
  }

  return state; // 🔥 IMPORTANT
}

checkServer();
setInterval(checkServer, 15_000);
startKeepAlive();
/* =========================
   UI HELPERS
========================= */

function setStatus(text, cls) {
  if (cls === "thinking") {
    statusEl.innerHTML = `${text}<span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;
  } else {
    statusEl.textContent = text;
  }
  statusEl.className = `status ${cls}`;
}

function updateMuteInputButton() {
  if (!muteInputBtn) return;

  const voiceModeVisible = !voiceBarEl?.classList.contains("hidden");
  const shouldShow = listeningMode === "continuous" && !!micStream && voiceModeVisible;
  const label = inputMuted ? "Unmute input" : "Mute input";
  const visibleText = inputMuted ? "Unmute" : "Mute";

  muteInputBtn.classList.toggle("hidden", !shouldShow);
  muteInputBtn.classList.toggle("muted", inputMuted);
  muteInputBtn.textContent = visibleText;
  muteInputBtn.title = label;
  muteInputBtn.setAttribute("aria-label", label);
  muteInputBtn.setAttribute("aria-pressed", inputMuted ? "true" : "false");
}

function showMutedStatusIfIdle() {
  if (listeningMode !== "continuous" || !inputMuted) return;
  if (processing || !audioEl.paused) return;

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

    processing = false;
    listening = true;
    audioChunks = [];
    hasSpoken = false;
    lastVoiceTime = 0;
    showMutedStatusIfIdle();
  } else if (listeningMode === "continuous") {
    if (paused) {
      setStatus("Paused — say “unpause” or press mic", "paused");
    } else if (!requestInFlight && audioEl.paused) {
      listening = true;
      startListening();
    }
  }

  updateMuteInputButton();
}

function dismissGuide() {
  const guide = document.getElementById("vera-guide");
  if (!guide) return;

  guide.classList.remove("show");
  sessionStorage.setItem("vera_seen_guide", "true");

  window.setTimeout(() => {
    if (!guide.classList.contains("show")) {
      guide.classList.add("hidden");
    }
  }, 350);
}

function addBubble(text, who) {
  const row = document.createElement("div");
  row.className = `message-row ${who}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble ${who}`;
  bubble.textContent = text;

  row.appendChild(bubble);
  convoEl.appendChild(row);
  convoEl.scrollTop = convoEl.scrollHeight;
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

sidePaneEl?.addEventListener("click", (event) => {
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
});

function applyActionPayload(data) {
  const payload = data?.action_payload;
  if (payload?.panel_type === "media_tabs" || payload?.panel_type === "news_results") {
    renderMediaTabsPanel(payload);
    return;
  }

  if (payload?.panel_type === "finance_chart") {
    renderFinanceChartPanel(payload);
    return;
  }

  hideSidePanel();
}

async function sendCommand(action) {
  const formData = new FormData();
  formData.append("session_id", sessionId);
  formData.append("action", action);

  await fetch(`${API_URL}/command`, {
    method: "POST",
    body: formData
  });
}

async function sendUnpauseCommand() {
  const formData = new FormData();

  // send a tiny silent blob (backend already ignores noise safely)
  const silentBlob = new Blob([new Uint8Array(2000)], { type: "audio/webm" });

  formData.append("audio", silentBlob);
  formData.append("session_id", sessionId);

  await fetch(`${API_URL}/infer`, {
    method: "POST",
    body: formData
  });
}

let fillerAuthInterval = null;

function stopWaitingForFillerAuthorization() {
  if (fillerAuthInterval) {
    clearInterval(fillerAuthInterval);
    fillerAuthInterval = null;
  }
}

function waitForFillerAuthorization() {
  if (fillerAuthInterval) return;

  fillerAuthInterval = setInterval(async () => {
    if (!requestInFlight) {
      stopWaitingForFillerAuthorization();
      return;
    }

    try {
      const res = await fetch(
        `${API_URL}/thinking_allowed?session_id=${sessionId}`,
        { cache: "no-store" }
      );
      const data = await res.json();

      if (data.allow_filler) {
        stopWaitingForFillerAuthorization();
        startFillerTimer();
      }
    } catch {
      stopWaitingForFillerAuthorization();
    }
  }, 150);
}

function interruptSpeech() {
  if (audioEl.paused || !interruptRecording) return;
  setStatus("Listening… (interrupted)", "recording");
  resetAudioHandlers();

  audioEl.pause();
  audioEl.currentTime = 0;

  clearTimeout(fillerTimer);
  stopWaitingForFillerAuthorization();
  fillerPlaying = false;
  pendingMainAnswer = null;

  listening = true;
  processing = false;
  waveState = "listening";
  interruptSpeechFrames = 0;
  interruptSpeechStart = 0;
  interruptLastSpeechLikeTime = 0;
  
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

  // ZCR
  const zcr = computeZCR(buf);

  const now = performance.now();

  // Only interrupt while VERA is speaking (not filler)
  if (
  listeningMode === "continuous" &&
  !audioEl.paused &&
  !fillerPlaying 
) {
    // grace period to avoid clicks
    if (now - audioStartedAt > 200) {

      const speechLike =
        rms > INTERRUPT_RMS &&
        rms < MAX_SPEECH_RMS;
        // zcr > INTERRUPT_ZCR_MIN &&
        // zcr < INTERRUPT_ZCR_MAX;

      if (speechLike) {
        if (interruptSpeechFrames === 0) {
          interruptSpeechStart = now;
        }
        interruptSpeechFrames++;
        interruptLastSpeechLikeTime = now;
      } else if (
        interruptLastSpeechLikeTime &&
        now - interruptLastSpeechLikeTime <= INTERRUPT_GAP_RESET_MS
      ) {
        // Allow tiny gaps so normal speech doesn't need a perfect uninterrupted stream.
      } else {
        interruptSpeechFrames = 0;
        interruptSpeechStart = 0;
        interruptLastSpeechLikeTime = 0;
      }

      if (
        interruptSpeechFrames >= INTERRUPT_MIN_FRAMES &&
        interruptSpeechStart &&
        now - interruptSpeechStart >= INTERRUPT_SUSTAIN_MS
      ) {
        interruptSpeech();
        interruptSpeechFrames = 0;
        interruptSpeechStart = 0;
        interruptLastSpeechLikeTime = 0;
      }
    }
  } else {
    interruptSpeechFrames = 0;
    interruptSpeechStart = 0;
    interruptLastSpeechLikeTime = 0;
  }

  if (Math.random() < 0.02) {
    console.log(
      "rms:",
      rms.toFixed(4),
      "zcr:",
      zcr.toFixed(3),
      "frames:",
      interruptSpeechFrames
    );
  }

  requestAnimationFrame(detectInterrupt);
}

function resetAudioHandlers() {
  audioEl.onplay = null;
  audioEl.onended = null;
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

  if (rms > VOLUME_THRESHOLD) {
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
  interruptLastSpeechLikeTime = 0;

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
  pendingMainAnswer = null; 
  if (blob.size < MIN_AUDIO_BYTES) {
    listening = true;
    return;
  }

  requestInFlight = true;
  waitForFillerAuthorization();
  processing = true;
  fillerPlayedThisTurn = false;
  waveState = "idle";
  setStatus("Thinking", "thinking");

  // ✅ start filler exactly like normal flow

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", sessionId);
  formData.append("mode", "interrupt"); // backend can branch if desired

  try {
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });

    const data = await res.json();

    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);
    fillerPlaying = false;

    /* =========================
       CONTROL FLOW (FIRST)
    ========================= */

    if (data.skip) {
      hideSidePanel();
      processing = false;
      listening = true;
      startListening();
      return;
    }

    if (listeningMode === "continuous" && data.command === "pause") {
      hideSidePanel();
      paused = true;
      processing = false;
      setStatus("Paused — say “unpause” or press mic", "paused");
      listening = true;
      startListening();
      return;
    }

    if (listeningMode === "continuous" && data.command === "unpause") {
      hideSidePanel();
      paused = false;
      processing = false;
      setStatus("Listening…", "recording");
      listening = true;
      startListening();
      return;
    }

    if (listeningMode === "continuous" && data.paused) {
      hideSidePanel();
      paused = true;
      processing = false;
      setStatus("Paused — say “unpause” or press mic", "paused");
      listening = true;
      startListening();
      return;
    }

    paused = false;

    /* =========================
       NORMAL INTERRUPT REPLY
    ========================= */

    addBubble(data.transcript, "user");

    playInterruptAnswer(data);

  } catch {
    hideSidePanel();
    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);
    fillerPlaying = false;
    setStatus("Server error", "offline");
    listening = true;
  }
}

function playInterruptAnswer(data) {
  applyActionPayload(data);
  addBubble(data.reply, "vera");
  resetAudioHandlers();
  audioEl.src = `${API_URL}${data.audio_url}`;
  audioEl.play();

  audioEl.onplay = () => {
    logVoiceFirstAudio("main-reply");
    logVoiceMainReplyAudio();
    waveState = "speaking";
    audioStartedAt = performance.now();
    setStatus("Speaking… (can only be interrupted once)", "speaking");
    processing = false;
  };

  audioEl.onended = () => {
    listening = true;
    if (inputMuted) {
      showMutedStatusIfIdle();
      return;
    }
    startListening();
  };
}
/* =========================
   MIC INIT
========================= */

async function initMic() {
  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  });

  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.resume();
  resizeWaveCanvas();

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);

  // 🔥 NEW — analyze VERA speaking audio
  ttsAnalyser = audioCtx.createAnalyser();
  ttsAnalyser.fftSize = 2048;

  ttsSource = audioCtx.createMediaElementSource(audioEl);

  ttsSource.connect(ttsAnalyser);      // for waveform
  ttsSource.connect(audioCtx.destination); // for sound output

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
  if (!canvas || !waveCtx || waveformRaf) return;

  function draw() {
    waveformRaf = requestAnimationFrame(draw);

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const centerX = width / 2;
    const centerY = height / 2;

    waveCtx.clearRect(0, 0, width, height);

    let activeAnalyser = null;
    if (waveState === "listening" && analyser) activeAnalyser = analyser;
    if (waveState === "speaking" && ttsAnalyser) activeAnalyser = ttsAnalyser;

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
      waveCtx.strokeStyle = `rgba(255,255,255,${ring.opacity * 0.35})`;
      waveCtx.lineWidth = 1.5;
      waveCtx.beginPath();
      waveCtx.arc(centerX, centerY, ring.radius, 0, Math.PI * 2);
      waveCtx.stroke();
    }

    const boost = waveState === "speaking" ? 2.8 : waveState === "listening" ? 2.8 : 0;
    const mid = BARS / 2;
    waveCtx.fillStyle = "rgba(255,255,255,0.95)";
    waveCtx.shadowBlur = 14;
    waveCtx.shadowColor = "rgba(255,255,255,0.7)";

    for (let i = 0; i < BARS; i++) {
      const raw = (smoothedBars && waveEnergy > 0) ? smoothedBars[i] : barValues[i];
      const distance = Math.abs(i - mid) / mid;
      const envelope = Math.pow(1 - distance, 2.0);
      const barHeight = Math.max(0.03, raw) * height * boost * envelope * waveEnergy;

      const x = i * barSpacing + (barSpacing - barWidth) / 2;
      waveCtx.beginPath();
      waveCtx.roundRect(x, centerY - barHeight, barWidth, barHeight * 2, barWidth / 2);
      waveCtx.fill();
    }
  }

  draw();
}
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

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;
    lastVoiceTime = now;
  }

  if (
    hasSpoken &&
    now - lastVoiceTime > SILENCE_MS + TRAILING_MS &&
    audioEl.paused // 🔑 only stop when not speaking
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

  setStatus(
    paused ? "Paused — say “unpause” or press mic" : "Listening…",
    paused ? "paused" : "recording"
  );
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
  waitForFillerAuthorization();
  processing = true;
  fillerPlayedThisTurn = false;
  waveState = "idle";

  setStatus("Thinking", "thinking");

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", sessionId);

  // 🔑 ADD THIS
  if (listeningMode === "ptt") {
    formData.append("mode", "ptt");
  }

  try {
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });

    const data = await res.json();
    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);

    // 🔑 HANDLE CONTROL FLOW FIRST (NO AUDIO YET)
    if (data.skip) {
      hideSidePanel();
      processing = false;

      if (listeningMode === "ptt") {
        setStatus("No voice detected", "idle");
      } else if (listeningMode === "continuous") {
        startListening();
      }

      return;
    }

    if (listeningMode === "continuous" && data.command === "pause") {
      hideSidePanel();
      paused = true;
      processing = false;
      setStatus("Paused — say “unpause” or press mic", "paused");
      listening = true;
      startListening();
      return;
    }

    if (listeningMode === "continuous" && data.command === "unpause") {
      hideSidePanel();
      paused = false;
      processing = false;
      setStatus("Listening…", "recording");
      listening = true;
      startListening();
      return;
    }

    if (listeningMode === "continuous" && data.paused) {
      hideSidePanel();
      paused = true;
      processing = false;
      setStatus("Paused — say “unpause” or press mic", "paused");
      listening = true;
      startListening();
      return;
    }

    paused = false;
    applyActionPayload(data);

    addBubble(data.transcript, "user");
    if (!document.body.classList.contains("chat-started")) {
      document.body.classList.add("chat-started");
      dismissGuide();
    }
    const playMainAnswer = () => {
      if (fillerPlayedThisTurn) {
        setTimeout(() => {
          addBubble(data.reply, "vera");
        }, FILLER_GRACE_MS);
      } else {
        addBubble(data.reply, "vera");
      }
      resetAudioHandlers();
      audioEl.src = `${API_URL}${data.audio_url}`;
      audioEl.play();

      audioEl.onplay = () => {
        logVoiceFirstAudio("main-reply");
        logVoiceMainReplyAudio();
        waveState = "speaking";
        audioStartedAt = performance.now();
        setStatus("Speaking… (Interruptible)", "speaking");
        startInterruptCapture();
      };

      audioEl.onended = () => {
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
      };
    };

    if (fillerPlaying) {
      // Store callback until filler ends
      pendingMainAnswer = playMainAnswer;
    } else {
      playMainAnswer();
    }

  } catch {
    hideSidePanel();
    processing = false;
    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);
    setStatus("Server error", "offline");
  }
}

/* =========================
   TEXT INPUT PIPELINE
========================= */
function micIsReady() {
  return !!micStream;
}

async function sendTextMessage() {
  const text = textInput.value.trim();

  // 🔑 EARLY GUARD — before requestInFlight / thinking
  if (/pause/i.test(text) && !micIsReady()) {
    addBubble(text, "user");
    setStatus("Can’t pause — microphone isn’t active", "idle");

    // HARD RESET
    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);
    processing = false;
    paused = false;
    listening = false;

    textInput.value = "";
    return;
  }

  // 🔑 recover from offline
  if (statusEl.classList.contains("offline")) {
    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);
    processing = false;
    paused = false;
    listening = false;
    setStatus("Ready", "idle");
  }

  if (!text || requestInFlight) return;
  textInput.value = "";

  listening = false;
  processing = true;
  requestInFlight = true;
  setStatus("Thinking", "thinking");
  waitForFillerAuthorization();
  fillerPlaying = false;
  pendingMainAnswer = null;

  addBubble(text, "user");
  if (!document.body.classList.contains("chat-started")) {
    document.body.classList.add("chat-started");
    dismissGuide();
  }
  try {
    const res = await fetch(`${API_URL}/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        session_id: sessionId
      })
    });

    const data = await res.json();

    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);

    if (data.command === "pause") {
      hideSidePanel();
      processing = false;
      requestInFlight = false;

      if (!micIsReady()) {
        // 🔑 graceful rejection
        setStatus("Can’t pause — microphone isn’t active", "idle");
        paused = false;
        listening = false;
        return;
      }

      paused = true;
      setStatus("Paused — say “unpause” or press mic", "paused");

      listening = true;
      startListening();
      return;
    }

    if (listeningMode === "continuous" && data.command === "unpause") {
      hideSidePanel();
      paused = false;
      processing = false;

      setStatus("Listening…", "recording");

      listening = true;
      startListening();
      return;
    }

    if (data.paused) {
      hideSidePanel();
      paused = true;
      processing = false;

      setStatus("Paused — say “unpause” or press mic", "paused");

      listening = true;
      startListening();
      return;
    }
    applyActionPayload(data);
    const playReply = () => {
      addBubble(data.reply, "vera");

      if (data.audio_url) {
        audioEl.src = `${API_URL}${data.audio_url}`;
        audioEl.play();
      }

      audioEl.onplay = () => {
        logVoiceFirstAudio("text-reply");
        waveState = "speaking";
        audioStartedAt = performance.now();
        setStatus("Speaking…", "speaking");
      };

      audioEl.onended = () => {
        waveState = "listening";
        processing = false;
        listening = true;
        if (inputMuted) {
          showMutedStatusIfIdle();
          return;
        }
        startListening();
      };
    };

    playReply();

  } catch (err) {
    console.error(err);
    hideSidePanel();
    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);
    fillerPlaying = false;
    processing = false;
    setStatus("Server error", "offline");
  }
}

/* =========================
   MIC BUTTON
========================= */
if (pttBtn) {
  pttBtn.onclick = async () => {
    // prevent double firing while request is running
    if (requestInFlight) return;

    // ---------- START PTT ----------
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
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.onstop = handleUtterance;

      mediaRecorder.start();

      setStatus("Listening (PTT)", "recording");
      return;
    }

    // ---------- STOP PTT ----------
    if (pttRecording) {
      pttRecording = false;
      listening = false;
      waveState = "idle"; 
      if (mediaRecorder && mediaRecorder.state === "recording") {
        beginVoiceUxTurn();
        mediaRecorder.stop(); // triggers handleUtterance()
      }
    }
  };
}

recordBtn.onclick = async () => {
  listeningMode = "continuous";   // 🔑 CRITICAL FIX
  micStream?.getAudioTracks().forEach((track) => {
    track.enabled = !inputMuted;
  });
  updateMuteInputButton();

  if (!listening) {
    await initMic();
    micStream?.getAudioTracks().forEach((track) => {
      track.enabled = !inputMuted;
    });
    listening = true;
    paused = false;
    startListening();
    return;
  }

  if (paused) {
  paused = false;
  await sendCommand("unpause");
} else {
  paused = true;
  await sendCommand("pause");
}

processing = false;
startListening();
}

if (muteInputBtn) {
  muteInputBtn.onclick = () => {
    if (listeningMode !== "continuous" || !micStream) return;
    setContinuousInputMuted(!inputMuted);
  };
}

if (inputToggleBtn) {
  inputToggleBtn.addEventListener("click", () => {
    window.setTimeout(updateMuteInputButton, 0);
  });
}

updateMuteInputButton();

if (!IS_MOBILE && sendTextBtn && textInput) {
  sendTextBtn.onclick = sendTextMessage;

  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      sendTextMessage();
    }
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
          session_id: sessionId,
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

window.addEventListener("beforeunload", () => {
  stopKeepAlive();
});
