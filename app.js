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

let audioChunks = [];
let silenceTimer = null;
let hasSpoken = false;

let listening = false;
let processing = false;
let paused = false;
let rafId = null;

/* =========================
   CONFIG
========================= */

const SILENCE_MS = 1350;
const MAX_WAIT_FOR_SPEECH_MS = 2000;
const VOLUME_THRESHOLD = 0.006;
const MIN_AUDIO_BYTES = 1500;

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


const feedbackInput = document.getElementById("feedback-input");
const sendFeedbackBtn = document.getElementById("send-feedback");
const feedbackStatusEl = document.getElementById("feedback-status");
/* =========================
   SERVER HEALTH
========================= */

async function checkServer() {
  let online = false;
  try {
    const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
    online = res.ok;
  } catch {}

  recordBtn.disabled = !online;
  recordBtn.style.opacity = online ? "1" : "0.5";

  if (serverStatusEl) {
    serverStatusEl.textContent = online ? "🟢 Server Online" : "🔴 Server Offline";
    serverStatusEl.className = `server-status ${online ? "online" : "offline"}`;
  }

  if (serverStatusInlineEl) {
    serverStatusInlineEl.textContent = online ? "🟢 Online" : "🔴 Offline";
    serverStatusInlineEl.className =
      `server-status ${online ? "online" : "offline"} mobile-only`;
  }
}

checkServer();
setInterval(checkServer, 15_000);

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
   MIC INIT (ONCE)
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

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);
}

/* =========================
   SILENCE / SPEECH DETECTION
========================= */

function detectSilence() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;

    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      mediaRecorder.stop();
    }, SILENCE_MS);
  }

  rafId = requestAnimationFrame(detectSilence);
}

/* =========================
   START LISTENING
========================= */

function startListening() {
  if (!listening || processing) return;

  audioChunks = [];
  hasSpoken = false;

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  mediaRecorder.onstop = handleUtterance;

  mediaRecorder.start();

  // auto-stop if user never speaks
  silenceTimer = setTimeout(() => {
    if (!hasSpoken && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, MAX_WAIT_FOR_SPEECH_MS);

  detectSilence();

  setStatus(
    paused
      ? "Paused — say “unpause” or press mic"
      : "Listening…",
    paused ? "paused" : "recording"
  );
}

/* =========================
   HANDLE UTTERANCE
========================= */

async function handleUtterance() {
  // 🔑 HARD DROP: no speech detected
  if (!hasSpoken || !listening) {
    processing = false;
    startListening();
    return;
  }

  const blob = new Blob(audioChunks, { type: "audio/webm" });

  // 🔑 HARD DROP: too small
  if (blob.size < MIN_AUDIO_BYTES) {
    processing = false;
    startListening();
    return;
  }

  processing = true;
  setStatus("Thinking…", "thinking");

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

    if (data.skip) {
      processing = false;
      startListening();
      return;
    }

    if (data.command === "pause") {
      paused = true;
      processing = false;
      startListening();
      return;
    }

    if (data.command === "unpause") {
      paused = false;
      processing = false;
      startListening();
      return;
    }

    if (data.paused) {
      paused = true;
      processing = false;
      startListening();
      return;
    }

    paused = false;

    addBubble(data.transcript, "user");
    addBubble(data.reply, "vera");

    if (data.audio_url) {
      audioEl.src = `${API_URL}${data.audio_url}`;
      audioEl.play();

      audioEl.onplay = () => setStatus("Speaking…", "speaking");
      audioEl.onended = () => {
        processing = false;
        startListening();
      };
    } else {
      processing = false;
      startListening();
    }
  } catch {
    processing = false;
    setStatus("Server error", "offline");
  }
}

/* =========================
   MIC BUTTON
========================= */

recordBtn.onclick = async () => {
  if (!listening) {
    await initMic();
    listening = true;
    paused = false;
    startListening();
    return;
  }

  if (paused) {
    paused = false;
    processing = false;
    startListening();
    return;
  }

  paused = true;
  processing = false;
  startListening();
};

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
