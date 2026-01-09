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
let hasSpoken = false;
let lastVoiceTime = 0;

let listening = false;
let processing = false;
let paused = false;
let rafId = null;
let fillerTimer = null;
let fillerPlayedThisTurn = false;
let interruptSpeechFrames = 0;

let fillerPlaying = false;
let fillerStartedAt = 0;
let pendingMainAnswer = null;
let audioStartedAt = 0;
// let interruptStart = 0;


const FILLER_DELAY_MS = 5300;  // feels natural
const FILLER_GRACE_MS = 1000;  

const FILLER_AUDIO_FILES = [
  "/static/fillers/moment.wav",
  "/static/fillers/one_second.wav",
  "/static/fillers/give_me_a_second.wav",
  "/static/fillers/one_moment.wav"
];
let requestInFlight = false; // 🔑 NEW

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

    audioEl.onended = () => {
    fillerPlaying = false;

    if (!requestInFlight && pendingMainAnswer) {
      setTimeout(() => {
        pendingMainAnswer?.();
        pendingMainAnswer = null;
      }, FILLER_GRACE_MS);
    }
  };

    audioEl.src = `${API_URL}${filler}`;
    audioEl.play().catch(console.warn);
  }, FILLER_DELAY_MS);
}

/* =========================
   CONFIG
========================= */

const VOLUME_THRESHOLD = 0.009; // TUNER
const SILENCE_MS = 1050;     // silence before ending speech
const TRAILING_MS = 300;   // guaranteed tail
const MAX_WAIT_FOR_SPEECH_MS = 2000;
const MIN_AUDIO_BYTES = 1500;
const INTERRUPT_MIN_FRAMES = 6; 

const INTERRUPT_ZCR_MIN = 0.02;
const INTERRUPT_ZCR_MAX = 0.15;

const INTERRUPT_RMS = 0.050;   // higher than normal speech start
// const INTERRUPT_MS = 140;    
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
    serverStatusEl.textContent = online
      ? "🟢 Server Online"
      : "🔴 Server Offline";
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
  const row = document.createElement("div");
  row.className = `message-row ${who}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble ${who}`;
  bubble.textContent = text;

  row.appendChild(bubble);
  convoEl.appendChild(row);
  convoEl.scrollTop = convoEl.scrollHeight;
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

function interruptSpeech() {
  if (audioEl.paused) return;

  interruptStart = 0;

  audioEl.pause();
  audioEl.currentTime = 0;

  fillerPlaying = false;
  pendingMainAnswer = null;
  clearTimeout(fillerTimer);

  processing = false;
  listening = true; // 🔑 ADD THIS
  setStatus("Listening…", "recording");

  startListening(); // 🔑 FORCE restart
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
  if (!audioEl.paused && !fillerPlaying && !paused) {
    // grace period to avoid clicks
    if (now - audioStartedAt > 200) {

      const speechLike =
        rms > INTERRUPT_RMS &&
        zcr > INTERRUPT_ZCR_MIN &&
        zcr < INTERRUPT_ZCR_MAX;

      if (speechLike) {
        interruptSpeechFrames++;
      } else {
        interruptSpeechFrames = 0;
      }

      if (interruptSpeechFrames >= INTERRUPT_MIN_FRAMES) {
        interruptSpeech();
        interruptSpeechFrames = 0;
      }
    }
  } else {
    interruptSpeechFrames = 0;
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

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;

  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  detectInterrupt();

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

  audioChunks = [];
  hasSpoken = false;
  lastVoiceTime = 0;

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
  mediaRecorder.onstop = handleUtterance;

  mediaRecorder.start();

  setTimeout(() => {
    if (!hasSpoken && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  }, MAX_WAIT_FOR_SPEECH_MS);

  detectSpeech();

  setStatus(
    paused ? "Paused — say “unpause” or press mic" : "Listening…",
    paused ? "paused" : "recording"
  );
}

/* =========================
   HANDLE UTTERANCE
========================= */

async function handleUtterance() {
  if (!hasSpoken || !listening) {
    processing = false;
    startListening();
    return;
  }

  const blob = new Blob(audioChunks, { type: "audio/webm" });

  if (blob.size < MIN_AUDIO_BYTES) {
    processing = false;
    startListening();
    return;
  }
  requestInFlight = true;
  processing = true;
  fillerPlayedThisTurn = false;
  setStatus("Thinking…", "thinking");

  startFillerTimer(); // 🔑 START IMMEDIATELY

  const formData = new FormData();
  formData.append("audio", blob);
  formData.append("session_id", sessionId);

  try {
    const res = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });

    const data = await res.json();
    requestInFlight = false;
    clearTimeout(fillerTimer);

    // 🔑 HANDLE CONTROL FLOW FIRST (NO AUDIO YET)
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

    const playMainAnswer = () => {
      if (fillerPlayedThisTurn) {
        setTimeout(() => {
          addBubble(data.reply, "vera");
        }, FILLER_GRACE_MS);
      } else {
        addBubble(data.reply, "vera");
      }
      audioEl.src = `${API_URL}${data.audio_url}`;
      audioEl.play();

      audioEl.onplay = () => {
        audioStartedAt = performance.now();
        setStatus("Speaking… (You can interrupt by talking over it!)", "speaking");
      };

      audioEl.onended = () => {
        processing = false;
        startListening();
      };
    };

    if (fillerPlaying) {
      // Store callback until filler ends
      pendingMainAnswer = playMainAnswer;
    } else {
      playMainAnswer();
    }

  } catch {
    processing = false;
    requestInFlight = false;
    clearTimeout(fillerTimer);
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
  await sendCommand("unpause");
} else {
  paused = true;
  await sendCommand("pause");
}

processing = false;
startListening();
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
