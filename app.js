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

    const filler =
      FILLER_AUDIO_FILES[Math.floor(Math.random() * FILLER_AUDIO_FILES.length)];

    fillerPlaying = true;
    fillerPlayedThisTurn = true;
    fillerStartedAt = performance.now();

    const fillerSrc = `${API_URL}${filler}`;
    resetAudioHandlers();
    const fillerAudio = getAudioEl();
    if (fillerAudio) fillerAudio.src = fillerSrc;
    fillerAudio?.addEventListener(
      "play",
      () => {
        if (fillerAudio?.src === fillerSrc) {
          logVoiceFirstAudio("filler");
        }
      },
      { once: true }
    );
    void (async () => {
      try {
        await ensureMainAudioTtsGraph();
        await getAudioEl()?.play();
      } catch (e) {
        console.warn(e);
      }
    })();

    fillerAudio?.addEventListener(
      "ended",
      () => {
        if (fillerAudio?.src !== fillerSrc) return; // 🔑 guard
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
setInterval(checkServer, 15_000);
startKeepAlive();
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

function addBubble(text, who) {
  const convoEl = uiEl("conversation");
  if (!convoEl) return;
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
    renderMediaTabsPanel(payload);
    return;
  }

  if (payload?.panel_type === "finance_chart") {
    renderFinanceChartPanel(payload);
    return;
  }

  hideSidePanel();
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
        `${API_URL}/thinking_allowed?session_id=${getSessionId()}`,
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
  const a = getAudioEl();
  if (!a || a.paused || !interruptRecording) return;
  setStatus("Listening… (interrupted)", "recording");
  resetAudioHandlers();

  a.pause();
  a.currentTime = 0;

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
  const outAudio = getAudioEl();
  if (
  listeningMode === "continuous" &&
  outAudio &&
  !outAudio.paused &&
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
  formData.append("session_id", getSessionId());
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

    /* =========================
       NORMAL INTERRUPT REPLY
    ========================= */

    addBubble(data.transcript, "user");

    await playInterruptAnswer(data);

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

async function playInterruptAnswer(data) {
  applyActionPayload(data);
  addBubble(data.reply, "vera");
  resetAudioHandlers();
  const replyAudio = getAudioEl();
  if (replyAudio) replyAudio.src = `${API_URL}${data.audio_url}`;
  await ensureMainAudioTtsGraph();
  getAudioEl()?.play().catch(console.warn);

  if (replyAudio) {
    replyAudio.onplay = () => {
    logVoiceFirstAudio("main-reply");
    logVoiceMainReplyAudio();
    waveState = "speaking";
    audioStartedAt = performance.now();
    setStatus("Speaking… (can only be interrupted once)", "speaking");
    processing = false;
  };

    replyAudio.onended = () => {
    listening = true;
    if (inputMuted) {
      showMutedStatusIfIdle();
      return;
    }
    startListening();
  };
  }
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
  if (!bmoOut || bmoOut.paused || bmoOut.ended) {
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

  if (rms > VOLUME_THRESHOLD) {
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
  waitForFillerAuthorization();
  processing = true;
  fillerPlayedThisTurn = false;
  waveState = "idle";

  setStatus("Thinking", "thinking");

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", getSessionId());

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
      const mainAudio = getAudioEl();
      if (mainAudio) mainAudio.src = `${API_URL}${data.audio_url}`;
      void (async () => {
        await ensureMainAudioTtsGraph();
        try {
          await getAudioEl()?.play();
        } catch (e) {
          console.warn(e);
        }
      })();

      if (mainAudio) {
        mainAudio.onplay = () => {
        logVoiceFirstAudio("main-reply");
        logVoiceMainReplyAudio();
        waveState = "speaking";
        audioStartedAt = performance.now();
        setStatus("Speaking… (Interruptible)", "speaking");
        startInterruptCapture();
      };

        mainAudio.onended = () => {
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
      }
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
async function sendTextMessage() {
  const textInput = uiEl("text-input");
  const statusLine = uiEl("status");
  const text = textInput?.value.trim() ?? "";

  // 🔑 recover from offline
  if (statusLine?.classList.contains("offline")) {
    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);
    processing = false;
    listening = false;
    setStatus("Ready", "idle");
  }

  if (!text || requestInFlight) return;
  if (textInput) textInput.value = "";

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
        session_id: getSessionId()
      })
    });

    const data = await res.json();

    requestInFlight = false;
    stopWaitingForFillerAuthorization();
    clearTimeout(fillerTimer);

    applyActionPayload(data);
    const playReply = () => {
      addBubble(data.reply, "vera");

      const ta = getAudioEl();
      if (data.audio_url && ta) {
        ta.src = `${API_URL}${data.audio_url}`;
        void (async () => {
          await ensureMainAudioTtsGraph();
          try {
            await getAudioEl()?.play();
          } catch (e) {
            console.warn(e);
          }
        })();
      }

      if (ta) {
        ta.onplay = () => {
        logVoiceFirstAudio("text-reply");
        waveState = "speaking";
        audioStartedAt = performance.now();
        setStatus("Speaking…", "speaking");
      };

        ta.onended = () => {
        waveState = "listening";
        processing = false;
        listening = true;
        if (inputMuted) {
          showMutedStatusIfIdle();
          return;
        }
        startListening();
      };
      }
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

window.addEventListener("beforeunload", () => {
  stopKeepAlive();
});
