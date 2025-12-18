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

let micOn = false;
let processing = false;

let micStream, audioCtx, analyser;
let mediaRecorder;

let currentChunks = [];
let silenceTimer;
let hasSpeech = false;

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

/* =========================
   UI
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
   MIC INIT
========================= */

async function initMic() {
  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new AudioContext({ sampleRate: 16000 });
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => currentChunks.push(e.data);
  mediaRecorder.start(); // 🔑 start ONCE
}

/* =========================
   SILENCE DETECTOR
========================= */

function detectSilence() {
  if (!micOn) return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

  if (rms > VOLUME_THRESHOLD) {
    hasSpeech = true;
    clearTimeout(silenceTimer);

    silenceTimer = setTimeout(() => {
      if (hasSpeech && !processing) {
        finalizeUtterance();
      }
    }, SILENCE_MS);
  }

  requestAnimationFrame(detectSilence);
}

/* =========================
   UTTERANCE FINALIZATION
========================= */

function finalizeUtterance() {
  if (currentChunks.length === 0) return;

  const chunks = currentChunks.slice();
  currentChunks = [];
  hasSpeech = false;

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

    const data = await res.json();

    addBubble(data.transcript, "user");
    addBubble(data.reply, "vera");

    audioEl.src = `${API_URL}${data.audio_url}`;
    audioEl.play();

    audioEl.onplay = () => setStatus("Speaking…", "speaking");
    audioEl.onended = () => {
      processing = false;
      if (micOn) {
        setStatus("Listening…", "recording");
      } else {
        setStatus("Idle", "idle");
      }
    };

  } catch {
    processing = false;
    setStatus("Server error", "offline");
  }
}

/* =========================
   MIC BUTTON
========================= */

recordBtn.onclick = async () => {
  await initMic();

  micOn = !micOn;
  recordBtn.setAttribute("aria-pressed", micOn);

  if (micOn) {
    setStatus("Listening…", "recording");
    detectSilence();
  } else {
    setStatus(processing ? "Thinking…" : "Idle", "idle");
  }
};
