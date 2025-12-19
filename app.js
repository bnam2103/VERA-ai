/* =========================
   CONFIG
========================= */

const API_URL = "https://vera-api.vera-api-ned.workers.dev";
const SILENCE_MS = 1800;
const VOLUME_THRESHOLD = 0.004;

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
let serverOnline = false;

let micStream = null;
let audioCtx = null;
let analyser = null;
let mediaRecorder = null;

let audioChunks = [];
let silenceTimer = null;
let hasSpoken = false;

/* =========================
   DOM
========================= */

const recordBtn = document.getElementById("record");
const statusEl = document.getElementById("status");
const convoEl = document.getElementById("conversation");
const audioEl = document.getElementById("audio");

/* =========================
   UI HELPERS
========================= */

function setStatus(text, cls = "idle") {
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
   SERVER HEALTH
========================= */

async function checkServer() {
  try {
    const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
    if (!res.ok) throw new Error();

    serverOnline = true;
    recordBtn.disabled = false;
    setStatus("VERA Online", "online");
    return true;
  } catch {
    serverOnline = false;
    recordBtn.disabled = true;
    setStatus("VERA Offline", "offline");
    return false;
  }
}

checkServer();
setInterval(checkServer, 30000);

/* =========================
   MIC INIT
========================= */

async function initMic() {
  if (micStream) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setStatus("Microphone blocked", "offline");
    throw new Error("Mic permission denied");
  }

  audioCtx = new AudioContext({ sampleRate: 16000 });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);
}

/* =========================
   SILENCE DETECTION
========================= */

function detectSilence() {
  if (!listening || !analyser) return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const rms =
    Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(stopRecording, SILENCE_MS);
  }

  requestAnimationFrame(detectSilence);
}

/* =========================
   RECORDING
========================= */

function startRecording() {
  if (!micStream) return;

  audioCh
