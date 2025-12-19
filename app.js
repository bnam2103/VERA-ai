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

let listening = false;   // ASR active
let processing = false; // backend busy
let paused = false;     // 🔑 unified pause state
let rafId = null;

/* =========================
   CONFIG
========================= */

const SILENCE_MS = 1350;
const VOLUME_THRESHOLD = 0.006;
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
   SILENCE DETECTION
========================= */

function detectSilence() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);

  const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;
    clearTimeout(silenceTimer);

    silenceTimer = setTimeout(() => {
      if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
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
  detectSilence();

  if (paused) {
    setStatus("Paused — say “unpause” or press mic to continue", "paused");
  } else {
    setStatus("Listening…", "recording");
  }
}

/* =========================
   BACKEND UNPAUSE SYNC
========================= */

async function sendUnpauseCommand() {
  const formData = new FormData();
  formData.append("audio", new Blob([], { type: "audio/webm" }));
  formData.append("session_id", sessionId);
  formData.append("force_unpause", "1");

  try {
    await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });
  } catch {}
}

/* =========================
   MANUAL PAUSE
========================= */

function pauseAssistant() {
  paused = true;
  processing = false;

  audioEl.pause();
  audioEl.src = "";

  setStatus("Paused — say “unpause” or press mic to continue", "paused");

  listening = true;
  startListening();
}

/* =========================
   HANDLE UTTERANCE
========================= */

async function handleUtterance() {
  if (!hasSpoken || !listening) return;

  processing = true;
  setStatus("Thinking…", "thinking");

  const blob = new Blob(audioChunks, { type: "audio/webm" });
  if (blob.size < 1500) {
    processing = false;
    startListening();
    return;
  }

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

    if (data.command === "pause") {
      pauseAssistant();
      return;
    }

    if (data.command === "unpause") {
      paused = false;
      processing = false;
      setStatus("Listening…", "recording");
      startListening();
      return;
    }

    if (data.paused && !paused) {
      paused = true;
      processing = false;
      setStatus("Paused — say “unpause” or press mic to continue", "paused");
      startListening();
      return;
    }

    if (data.skip) {
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
    setStatus("Listening…", "recording");
    await sendUnpauseCommand();
    startListening();
    return;
  }

  pauseAssistant();
};

/* =========================
   FEEDBACK
========================= */

if (sendFeedbackBtn) {
  sendFeedbackBtn.onclick = async () => {
    const text = feedbackInput.value.trim();
    if (!text) return;

    feedbackStatusEl.textContent = "Sending…";

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
