let mediaRecorder;
let audioChunks = [];
let micStream = null;
let analyser, audioCtx;
let silenceTimer;
let hasSpoken = false;

const SILENCE_MS = 1350;
const VOLUME_THRESHOLD = 0.004;
const API_URL = "https://vera-api.vera-api-ned.workers.dev";

const recordBtn = document.getElementById("record");
const statusEl = document.getElementById("status");
const convoEl = document.getElementById("conversation");
const audioEl = document.getElementById("audio");
const serverStatusEl = document.getElementById("server-status");

/* =========================
   SERVER HEALTH
========================= */

async function checkServer() {
  try {
    const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
    if (res.ok) {
      serverStatusEl.textContent = "🟢 Server Online";
      serverStatusEl.className = "server-status online";
      return;
    }
  } catch (_) {}

  serverStatusEl.textContent = "🔴 Server Offline";
  serverStatusEl.className = "server-status offline";
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
   MIC SETUP
========================= */

async function initMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioCtx = new AudioContext();
  await audioCtx.resume();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
}

/* =========================
   SILENCE DETECTION
========================= */

function detectSilence() {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  const rms = Math.sqrt(buf.reduce((s,v)=>s+v*v,0)/buf.length);

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
      }
    }, SILENCE_MS);
  }

  if (mediaRecorder.state === "recording") {
    requestAnimationFrame(detectSilence);
  }
}

/* =========================
   RECORD BUTTON
========================= */

recordBtn.onclick = async () => {
  await initMic();
  audioChunks = [];
  hasSpoken = false;
  setStatus("Recording…", "recording");

  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = e => audioChunks.push(e.data);

  mediaRecorder.onstop = async () => {
    if (!hasSpoken) {
      setStatus("Idle", "idle");
      return;
    }

    setStatus("Thinking…", "thinking");

    const blob = new Blob(audioChunks, { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", blob);

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
    audioEl.onended = () => setStatus("Idle", "idle");
  };

  mediaRecorder.start();
  detectSilence();
};
