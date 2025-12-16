/* ============================
   GLOBAL STATE
============================ */

let mediaRecorder;
let audioChunks = [];
let micStream = null;
let analyser, audioCtx;
let silenceTimer;
let hasSpoken = false;

const SILENCE_MS = 1350;
const VOLUME_THRESHOLD = 0.004;

// ✅ Stable Cloudflare Worker URL
const API_URL = "https://vera-api.vera-api-ned.workers.dev";

/* ============================
   DOM ELEMENTS
============================ */

const appEl = document.getElementById("app");
const recordBtn = document.getElementById("record");
const statusEl = document.getElementById("status");
const serverStatusEl = document.getElementById("server-status");
const transcriptEl = document.getElementById("transcript");
const replyEl = document.getElementById("reply");
const audioEl = document.getElementById("audio");

/* ============================
   UI STATE HANDLER
============================ */

function setStatus(text, state) {
  statusEl.innerText = text;
  statusEl.className = `status ${state}`;
  appEl.className = `app ${state}`;
}

/* ============================
   SERVER HEALTH CHECK
============================ */

async function checkServer() {
  try {
    const res = await fetch(`${API_URL}/health`, {
      method: "GET",
      cache: "no-store"
    });

    if (res.ok) {
      serverStatusEl.innerText = "🟢 VERA Online";
      serverStatusEl.className = "status online";
      return;
    }
  } catch (_) {}

  serverStatusEl.innerText = "🔴 VERA Offline";
  serverStatusEl.className = "status offline";
}

checkServer();
setInterval(checkServer, 15_000);

/* ============================
   MICROPHONE INITIALIZATION
============================ */

async function initMic() {
  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new AudioContext();
  await audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  console.log("🎙️ Mic initialized");
}

/* ============================
   SILENCE DETECTION
============================ */

function detectSilence() {
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  const rms = Math.sqrt(
    buffer.reduce((s, v) => s + v * v, 0) / buffer.length
  );

  if (rms > VOLUME_THRESHOLD) {
    hasSpoken = true;
    clearTimeout(silenceTimer);

    silenceTimer = setTimeout(() => {
      if (mediaRecorder?.state === "recording") {
        setStatus("Recording done", "idle");
        mediaRecorder.stop();
      }
    }, SILENCE_MS);
  }

  if (mediaRecorder?.state === "recording") {
    requestAnimationFrame(detectSilence);
  }
}

/* ============================
   RECORD BUTTON HANDLER
============================ */

recordBtn.onclick = async () => {
  await initMic();

  audioChunks = [];
  hasSpoken = false;
  clearTimeout(silenceTimer);

  setStatus("Recording…", "recording");

  mediaRecorder = new MediaRecorder(micStream, {
    mimeType: "audio/webm"
  });

  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    if (!hasSpoken) {
      setStatus("Idle", "idle");
      return;
    }

    setStatus("Thinking…", "thinking");

    try {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const formData = new FormData();
      formData.append("audio", blob, "input.webm");

      const res = await fetch(`${API_URL}/infer`, {
        method: "POST",
        body: formData
      });

      if (!res.ok) throw new Error("Inference failed");

      const data = await res.json();

      transcriptEl.innerText = data.transcript;
      replyEl.innerText = data.reply;

      audioEl.src = `${API_URL}${data.audio_url}`;

      audioEl.onplay = () => {
        setStatus("Speaking…", "speaking");
      };

      audioEl.onended = () => {
        setStatus("Idle", "idle");
      };

      audioEl.play();
    } catch (err) {
      console.error(err);
      setStatus("Server not reachable", "offline");
    }
  };

  mediaRecorder.start();
  detectSilence();
};
