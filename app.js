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
let fillerStartedAt = null;

/* =========================
   CONFIG
========================= */

const VOLUME_THRESHOLD = 0.005; // was 0.009
const SILENCE_MS = 1050;     // silence before ending speech
const TRAILING_MS = 300;   // guaranteed tail
const MAX_WAIT_FOR_SPEECH_MS = 2000;
const MIN_AUDIO_BYTES = 1500;
const THINKING_FILLERS = [ "Let me see", "Let me think…", ];
const API_URL = "https://vera-api.vera-api-ned.workers.dev";
const ENABLE_THINKING_FILLER = false;

/* =========================
   THINKING FILLER
========================= */

const fillerClips = [
  new Audio("think.wav"),
  new Audio("see.wav")
];

for (const a of fillerClips) {
  a.preload = "auto";
  a.volume = 0.85;
}

let activeFiller = null;
let fillerAudio = null;

// function playThinkingFiller() {
//   if (fillerAudio) return;

//   const clip =
//     fillerClips[Math.floor(Math.random() * fillerClips.length)];

//   console.log("[FILLER] playing local clip");

//   clip.currentTime = 0;
//   fillerAudio = clip;

//   clip.onended = () => {
//     fillerAudio = null;
//   };

//   clip.onerror = () => {
//     console.warn("[FILLER] clip error");
//     fillerAudio = null;
//   };

//   clip.play().catch(err => {
//     console.warn("[FILLER] play failed:", err.name);
//     fillerAudio = null;
//   });
// }

// function stopThinkingFiller() {
//   if (!fillerAudio) return;

//   const cleanup = () => {
//     fillerAudio.pause();
//     fillerAudio.src = "";
//     fillerAudio = null;
//     fillerStartedAt = null;
//   };

//   cleanup();
// }
function playThinkingFiller() {
  return;
}

function stopThinkingFiller() {
  return;
}

function analyzeTranscriptComplexity(text) {
  const lower = text.toLowerCase().trim();
  const wordCount = lower.split(/\s+/).length;

  let score = 0;
  const reasons = [];

  // 1️⃣ Explicit length requests (strong signal)
  if (
    /\b(in|about|around|roughly|at\s+least|no\s+more\s+than|under|over)\s+\d+\s+(word|words|paragraph|paragraphs)\b/i
      .test(lower)
  ) {
    score += 2;
    reasons.push("explicit length request");
  }

  // 2️⃣ Open-ended explanation verbs
  if (
    /\b(explain|describe|tell me about|walk me through|analyze|summarize)\b/.test(lower)
  ) {
    score += 2;
    reasons.push("open-ended explanation");
  }

  // 3️⃣ Depth modifiers
  if (
    /\b(detailed|in depth|deep dive|thorough|comprehensive)\b/.test(lower)
  ) {
    score += 2;
    reasons.push("depth modifier");
  }

  // 4️⃣ Large / complex topics
  if (
    /\b(war|history|system|architecture|model|theory)\b/.test(lower)
  ) {
    score += 1;
    reasons.push("large topic");
  }

  // 5️⃣ Long question itself (weak but useful)
  if (wordCount > 18) {
    score += 3;
    reasons.push("long prompt");
  }

  return {
    wordCount,
    score,
    reasons,
    shouldUseFiller: score >= 3
  };
}

function yieldToBrowser(ms = 80) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function logPause(source) {
  console.log(`[PAUSE] ${source}:`, paused);
}
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
    now - lastVoiceTime > SILENCE_MS + TRAILING_MS
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

  processing = true;
  setStatus("Thinking…", "thinking");

  try {
    /* =========================
       STEP 1: ASR ONLY
    ========================= */

    const formData = new FormData();
    formData.append("audio", blob);
    formData.append("session_id", sessionId);

    const res1 = await fetch(`${API_URL}/infer`, {
      method: "POST",
      body: formData
    });

    const data1 = await res1.json();

    if (data1.skip) {
      processing = false;
      startListening();
      return;
    }


    if (data1.paused) {
      paused = true;
      logPause("infer");
      processing = false;
      setStatus("Paused — say “unpause” or press mic", "paused");
      startListening();
      return;
    }

    const transcript = data1.transcript;

    /* =========================
      STEP 2: ANALYZE COMPLEXITY (EARLY)
    ========================= */

    const analysis = analyzeTranscriptComplexity(transcript);
    console.log("[FILLER_ANALYSIS]", analysis);

    /* =========================
      STEP 3: START FILLER BEFORE LLM
    ========================= */

    if (ENABLE_THINKING_FILLER && analysis.shouldUseFiller) {
      playThinkingFiller();
    }

    /* =========================
      STEP 4: UI + LLM
    ========================= */

    

    const formData2 = new FormData();
    formData2.append("session_id", sessionId);
    formData2.append("transcript", transcript);

    const res2 = await fetch(`${API_URL}/continue`, {
      method: "POST",
      body: formData2
    });

    const data2 = await res2.json();

    /* =========================
      STEP 5: STOP FILLER (ONCE)
    ========================= */

    stopThinkingFiller();

    /* =========================
      STEP 6: HANDLE RESPONSE
    ========================= */

    if (data2.command) {
      if (data2.command === "pause") {
        paused = true;
        logPause("continue"); // 🔑 HERE
      }

      if (data2.command === "unpause") {
        paused = false;
        logPause("continue"); // 🔑 HERE
      }

      setStatus(
        paused
          ? "Paused — say “unpause” or press mic"
          : "Listening…",
        paused ? "paused" : "recording"
      );

      processing = false;
      startListening();
      return;
    }
    addBubble(transcript, "user");
    addBubble(data2.reply, "vera");

    audioEl.src = `${API_URL}${data2.audio_url}`;
    audioEl.play();

    audioEl.onplay = () => {
      setStatus("Speaking…", "speaking");
    };

    audioEl.onended = () => {
      setTimeout(() => {
        processing = false;
        startListening();
      }, 250);
    };
  } catch (err) { 
    console.error(err); 
    stopThinkingFiller(); 
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

  // Request pause/unpause
  if (paused) {
    await sendCommand("unpause");
  } else {
    await sendCommand("pause");
  }

  // 🔑 Force backend → frontend state sync
  await sendUnpauseCommand();

  processing = false;
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
