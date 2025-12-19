/* =========================
   SESSION
========================= */

let sessionId = localStorage.getItem("vera_session_id");
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem("vera_session_id", sessionId);
}

/* =========================
   STATE
========================= */

let listening = false;
let processing = false;

let micStream, audioCtx, analyser;
let mediaRecorder;

let buffer = [];
let silenceTimer;
let hasSpoken = false;

const SILENCE_MS = 1800;
const VOLUME_THRESHOLD = 0.004;
const API_URL = "https://vera-api.vera-api-ned.workers.dev";

/* =========================
   DOM
========================= */

const recordBtn = document.getElementById("record");
const statusEl = document.getElementById("status");
const convoEl = document.getElementById("conversation");
const audioEl = document.getElementById("audio");

const serverStatusEl = document.getElementById("server-status");
const serverStatusInlineEl = document.getElementById("server-status-inline");

/* =========================
   UI HELPERS
========================= */

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

function addBubble(text, who) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  convoEl.appendChild(div);
  convoEl.scrollTop = convoEl.scrollHeight;
}

/* =========================
   SERVER HEALTH CHECK
========================= */

async function checkServer() {
  try {
    const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
    if (!res.ok) throw new Error();

    if (serverStatusEl) {
      serverStatusEl.textContent = "🟢 Server Online";
      serverStatusEl.className = "server-status online";
    }

    if (serverStatusInlineEl) {
      serverStatusInlineEl.textContent = "🟢 Online";
      serverStatusInlineEl.className =
        "server-status online mobile-only";
    }

    recordBtn.disabled = false;
    recordBtn.style.opacity = "1";

  } catch {
    if (serverStatusEl) {
      serverStatusEl.textContent = "🔴 Server Offline";
      serverStatusEl.className = "server-status offline";
    }

    if (serverStatusInlineEl) {
      serverStatusInlineEl.textContent = "🔴 Offline";
      serverStatusInlineEl.className =
        "server-status offline mobile-only";
    }

    recordBtn.disabled = true;
    recordBtn.style.opacity = "0.5";
  }
}

// run on load + every 15s
checkServer();
setInterval(checkServer, 15_000);

/* =========================
   MIC INIT
========================= */

async function initMic() {
  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new AudioContext({ sampleRate: 16000 });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);

  // 🔑 ONE continuous recorder
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => buffer.push(e.data);
  mediaRecorder.start(250); // slice every 250ms
}

/* =========================
   SILENCE DETECTION LOOP
========================= */

function detectSilence() {
  if (!listening) return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const rms = Math.sqrt(
    buf.reduce((s, v) => s + v * v, 0) / buf.length
  );

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;
    clearTimeout(silenceTimer);

    silenceTimer = setTimeout(() => {
      if (hasSpoken && !processing) {
        finalizeUtterance();
      }
    }, SILENCE_MS);
  }

  requestAnimationFrame(detectSilence);
}

/* =========================
   FINALIZE UTTERANCE
========================= */

function finalizeUtterance() {
  if (buffer.length === 0) return;

  const chunks = buffer.slice();
  buffer = [];
  hasSpoken = false;

  sendUtterance(chunks);
}

/* =========================
   SEND TO BACKEND
========================= */

async function sendUtterance(chunks) {
  processing = true;
  setStatus("Thinking…", "thinking");

  const blob = new Blob(chunks, { type: "audio/webm" });
  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", sessionId);

  try {
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });

    if (!res.ok) throw new Error();

    const data = await res.json();

    addBubble(data.transcript, "user");
    addBubble(data.reply, "vera");

    audioEl.src = `${API_URL}${data.audio_url}`;
    audioEl.play();

    audioEl.onplay = () => setStatus("Speaking…", "speaking");
    audioEl.onended = () => {
      processing = false;
      setStatus(listening ? "Listening…" : "Idle", "idle");
    };

  } catch {
    processing = false;
    setStatus("Server error", "offline");
  }
}

/* =========================
   MIC BUTTON (TOGGLE)
========================= */

recordBtn.onclick = async () => {
  await initMic();

  listening = !listening;
  recordBtn.setAttribute("aria-pressed", listening);

  if (listening) {
    setStatus("Listening…", "recording");
    detectSilence();
  } else {
    setStatus(processing ? "Thinking…" : "Idle", "idle");
  }
};
