# Chunked / streaming TTS + playback queue (implementation plan)

This doc sketches how to get **earlier first audio** and **smooth playback** on top of your current stack (`app.py` + `TTS.py` + `app.js`).

## What you have today

| Stage | Behavior |
|--------|----------|
| **LLM** | `process_user_input` returns the **full** reply string before TTS starts. |
| **TTS** | `speak_to_file` in `TTS.py` already calls `chunk_text()` and synthesizes **multiple** internal chunks, then **concatenates** them into **one** WAV (`synthesize_reply_audio` → single `audio_url`). |
| **Client** | One `<audio>` `src` → one GET → play. |

So **sentence gaps from “chunked TTS over the internet” are not your current issue** — the browser receives **one** file. Latency is roughly **LLM (full) + TTS (all internal chunks)** in series on the server.

To beat that, you need **overlap**: start TTS (and playback) **before** the full LLM reply exists.

---

## Target architecture (3 layers)

### 1. Streaming LLM (server)

- Use **streaming token generation** from your model wrapper (wherever `run_general_llm` / `vera.generate` lives).
- Buffer tokens into **segments** safe for TTS (e.g. split on `. ! ?` or every N words), with a **minimum first segment** (e.g. one clause or ≥ 40 chars) so the first TTS job isn’t tiny.

### 2. Chunked TTS API (server)

Options (pick one):

**A. HTTP + NDJSON or SSE** (good for demos)

- `POST /tts_stream` or extend `/infer` with `Accept: text/event-stream`.
- Events like: `{ "type": "chunk", "url": "/audio/.../part_0.wav", "index": 0 }` as each file is ready.
- Or send **base64 audio** in JSON for tiny chunks (easier, larger payloads).

**B. WebSocket** (best if many small chunks)

- Server pushes `{ index, format, bytes }` or URLs.

**C. Multiple URLs in one JSON** (simplest first step, no true streaming LLM yet)

- LLM still full-string; server runs `chunk_text`, `speak_to_file` **per** chunk to separate files, returns `{ "audio_urls": [ "/audio/.../p0.wav", ... ] }`.
- Client queues them — **improves nothing for time-to-first-byte** vs today unless you also **pipeline** LLM chunks.

Each chunk should reuse your existing **`speak_to_file`** (or a thin wrapper) so normalization stays centralized.

### 3. Client playback queue (browser)

**Goal:** avoid silence between chunks.

| Technique | Role |
|-----------|------|
| **Lookahead** | Always have **at least 1** next chunk **fully loaded** before the current one ends (ideally **2**). If synthesis + network is slower than playback, you’ll still stall — buffering fixes **jitter**, not **throughput**. |
| **Single pipeline** | Prefer **one `AudioContext`** + `decodeAudioData` + **scheduled** `start()` at exact times (gapless scheduling). Chaining multiple `<audio>` elements works but often adds **small gaps** at boundaries. |
| **Prefetch** | `fetch` chunk `i+1` while playing `i`; don’t set `src` only when `i` ends. |

**Sketch (conceptual):**

```javascript
// Pseudocode — not wired to your app yet
const queue = [];       // URLs or ArrayBuffers ready to play
const MIN_BUFFERED = 2; // tune: 1 = minimal, 2+ = smoother on bad Wi‑Fi

async function ensurePrefetch() {
  while (queue.length < MIN_BUFFERED && moreChunksComingFromServer) {
    await fetchNextChunkFromStreamOrPoll();
  }
}

async function playLoop(ctx) {
  let t = ctx.currentTime + 0.05; // small safety delay
  while (true) {
    await ensurePrefetch();
    const buf = queue.shift();
    if (!buf) break;
    const audioBuf = await ctx.decodeAudioData(buf.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    const startAt = Math.max(t, ctx.currentTime + 0.02);
    src.start(startAt);
    t = startAt + audioBuf.duration;
  }
}
```

Use **crossfade ~20–50 ms** between buffers only if you still hear clicks (optional).

---

## Phased rollout (recommended)

1. **Phase A — Multi-URL, full LLM**  
   - Server: after full reply, split with `chunk_text`, synthesize **N** WAVs, return `audio_urls[]`.  
   - Client: queue + prefetch **only**.  
   - *Validates* queue logic **without** streaming LLM.

2. **Phase B — Streaming LLM + queue**  
   - Emit first text segment → TTS → push first URL → client starts play while LLM continues.  
   - *This* is where **time-to-first-audio** drops.

3. **Phase C — Web Audio scheduling**  
   - Replace chained `<audio>` if gaps remain.

---

## Internet / “pauses every sentence”

- **Pauses** appear when the **next chunk isn’t ready** before the **current** chunk ends — same on LAN if TTS is slow.
- **Mitigation:** deeper buffer (`MIN_BUFFERED`), **larger chunks** (fewer HTTP round-trips), **same region** as API, and **don’t** start playing chunk 1 until chunk 2 is **at least requested** (optional policy).

---

## Files you’d touch later

| Area | Files (typical) |
|------|------------------|
| LLM streaming | `LLM.py` / `CHAT2.py` / wherever `generate` is |
| TTS per chunk | `TTS.py` (`speak_to_file`), `app.py` (`synthesize_reply_audio` or new route) |
| Client queue | `app.js` (`playMainAnswer`, `playReply`, `ensureMainAudioTtsGraph`) |

---

## Quick reference: your `TTS.py` already chunks

`speak_to_file` uses `chunk_text` then concatenates — good for **quality** and **memory**, but **not** for **parallel** LLM+TTS until you **split the pipeline** across the network as above.

## Sentence-level TTS (implemented)

Set **`VERA_TTS_SENTENCE_CHUNKS=1`** when starting the API. The server splits the reply with `split_sentences_for_tts()` (`.?!` and newlines), writes **one WAV/MP3 per sentence**, and returns **`audio_urls`** plus **`audio_url`** (first chunk). The client uses **`playTtsUrlSequenceGapless`**: prefetch next chunk while decoding the current one, then schedules **AudioBufferSource** nodes back-to-back on one **AudioContext** (smoother than chaining `<audio>`). Default is **off** (`0`) so older frontends that only read `audio_url` are not stuck with the first sentence only.
