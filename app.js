let mediaRecorder;
let audioChunks = [];
let micStream = null;
let analyser, audioCtx;
let silenceTimer;
let hasSpoken = false;

const SILENCE_MS = 1350;
const VOLUME_THRESHOLD = 0.004;

// 🔑 Quick Tunnel URL (CHANGE when tunnel changes)
const API_URL = "https://vera-api-ned.workers.dev";


const recordBtn = document.getElementById("record");
const statusEl = document.getElementById("status");
const serverStatusEl = document.getElementById("server-status");

/* -------------------- SERVER STATUS (NON-BLOCKING) -------------------- */

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
  } catch (err) {
    // Silent fail
  }

  serverStatusEl.innerText = "🔴 VERA Offline (start tunnel)";
  serverStatusEl.className = "status offline";
}

// Check on load + every 15s
checkServer();
setInterval(checkServer, 15_000);

/* -------------------- MIC INIT -------------------- */

async function initMic() {
  if (micStream) return;

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  audioCtx = new AudioContext();
  await audioCtx.resume(); // required in Chrome

  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  console.log("🎙️ Mic initialized");
}

/* -------------------- SILENCE DETECTION -------------------- */

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
        statusEl.innerText = "Recording done";
        statusEl.className = "status idle";
        mediaRecorder.stop();
      }
    }, SILENCE_MS);
  }

  if (mediaRecorder?.state === "recording") {
    requestAnimationFrame(detectSilence);
  }
}

/* -------------------- RECORD BUTTON -------------------- */

recordBtn.onclick = async () => {
  await initMic();

  audioChunks = [];
  hasSpoken = false;
  clearTimeout(silenceTimer);

  statusEl.innerText = "Recording…";
  statusEl.className = "status recording";

  mediaRecorder = new MediaRecorder(micStream, {
    mimeType: "audio/webm"
  });

  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    if (!hasSpoken) {
      statusEl.innerText = "Idle";
      statusEl.className = "status idle";
      return;
    }

    statusEl.innerText = "Thinking…";
    statusEl.className = "status thinking";

    try {
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const formData = new FormData();
      formData.append("audio", blob, "input.webm");

      const res = await fetch(`${API_URL}/infer`, {
        method: "POST",
        body: formData
      });

      if (!res.ok) {
        throw new Error("Inference failed");
      }

      const data = await res.json();

      document.getElementById("transcript").innerText = data.transcript;
      document.getElementById("reply").innerText = data.reply;

      const audio = document.getElementById("audio");
      audio.src = `${API_URL}${data.audio_url}`;

      audio.onplay = () => {
        statusEl.innerText = "Speaking…";
        statusEl.className = "status speaking";
      };

      audio.onended = () => {
        statusEl.innerText = "Idle";
        statusEl.className = "status idle";
      };

      audio.play();
    } catch (err) {
      console.error(err);
      statusEl.innerText = "❌ Server not reachable";
      statusEl.className = "status offline";
    }
  };

  mediaRecorder.start();
  detectSilence();
};
