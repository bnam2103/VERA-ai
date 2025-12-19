/* =========================
   SESSION
========================= */

let sessionId = localStorage.getItem("vera_session_id");
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem("vera_session_id", sessionId);
}

/* =========================
   STATE MACHINE
========================= */

let listening = false;
let processing = false;

let mediaRecorder;
let audioChunks = [];
let micStream, audioCtx, analyser;
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
}

/* =========================
   SILENCE LOOP
========================= */

function detectSilence() {
  if (!listening) return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(finalizeUtterance, SILENCE_MS);
  }

  requestAnimationFrame(detectSilence);
}

/* =========================
   RECORDING
========================= */

function startRecording() {
  audioChunks = [];
  hasSpoken = false;

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  mediaRecorder.start();

  detectSilence();
}

function finalizeUtterance() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  mediaRecorder.stop();
}

mediaRecorder?.addEventListener?.("stop", sendUtterance);

async function sendUtterance() {
  if (!hasSpoken) return;

  processing = true;
  setStatus("Thinking…", "thinking");

  const blob = new Blob(audioChunks, { type: "audio/webm" });
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
      if (listening) {
        setStatus("Listening…", "recording");
        startRecording();
      } else {
        setStatus("Idle", "idle");
      }
    };

  } catch {
    setStatus("Server error", "offline");
    processing = false;
  }
}

/* =========================
   MIC BUTTON
========================= */

recordBtn.onclick = async () => {
  await initMic();

  listening = !listening;
  recordBtn.setAttribute("aria-pressed", listening);

  if (listening) {
    setStatus("Listening…", "recording");
    startRecording();
  } else {
    setStatus(processing ? "Thinking…" : "Idle", "idle");
    mediaRecorder?.stop();
  }
};
