/* =========================================================================
 *  voice/ttsQueue.js — main TTS playback / queue / cancellation layer.
 *
 *  Extracted from app.js during the stabilization-stage modularization
 *  pass (2026-05-27, Stage 5). Behavior is preserved EXACTLY:
 *    - same function signatures,
 *    - same console labels (`[UX][TTS]`, `tts_*`, `ndjson_*` debug tags),
 *    - same Web Audio playback semantics,
 *    - same race-close guards on `mainTtsPlaybackToken`,
 *    - same NDJSON line ordering (asr → meta → chunk → done),
 *    - same BMO mouth / face-mode coupling.
 *  No interruption / cancellation redesign. No per-turn TTS IDs. No
 *  chunking changes. No barge-in changes. No ASR / Work Mode / panel
 *  / checklist / music / news behavior changes.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  Load order — MUST come BEFORE app.js (after utils/* but before app.js):
 *      <script src="utils/ids.js?v=1"></script>
 *      <script src="utils/storage.js?v=1"></script>
 *      <script src="utils/logging.js?v=1"></script>
 *      <script src="voice/ttsQueue.js?v=1"></script>
 *      <script src="app.js?v=...."></script>
 *      <script src="debug/voiceDebug.js?v=1"></script>
 *
 *  Rationale: this module declares the runtime state (`mainTtsPlaybackToken`,
 *  `mainTtsPlaybackActive`, `activeMainTtsBufferSources`,
 *  `activeNdjsonBodyReader`) as top-level `let` bindings shared across
 *  classic scripts via the script-scoped LexicalEnvironment. Loading first
 *  means those bindings are fully initialized before any app.js function
 *  body can read or assign to them at call time, and avoids any
 *  Temporal-Dead-Zone risk for top-level code that future cleanup might
 *  add. debug/voiceDebug.js still loads AFTER app.js (Stage 4); its
 *  `resetVeraVoiceRuntimeState()` assigns to these `let` bindings, which
 *  is allowed because classic scripts share the same lexical environment.
 *
 *  Bare-identifier references in the moved functions
 *  (`getAudioEl`, `audioCtx`, `ensureMainAudioTtsGraph`,
 *  `connectBufferSourceToTtsGraph`, `wrapLastChunkForBmoMouth`,
 *  `startBmoTtsMouthAnimation`, `stopBmoTtsMouthAnimation`,
 *  `setBmoTtsFaceTrack`, `splitSentencesForTtsClient`,
 *  `fetchBmoTtsEmotionLabels`, `classifyBmoTtsSegmentHeuristic`,
 *  `boostBmoMoodsForUserDistress`, `alignBmoFaceModesToChunkCount`,
 *  `applyBmoSadFaceLexiconOverride`, `bmoMoodToFaceMode`,
 *  `bmoNewSegmentFromCumulativeReply`, `bmoAssistantSegmentRequiresSadFaceStrict`,
 *  `bmoAssistantSegmentSoftEmpathy`, `bmoUserTextIsDistressed`,
 *  `applyWorkModeTimerPayload`, `_recordInterruptTimingPoint`,
 *  `_logTtsCancelSourceTrace`, `_veraTtsCancelSource`,
 *  `_veraCurrentTtsDebugContext`, `_veraNewsPanelRenderInFlight`,
 *  `interruptRecording`, `isVeraInterruptDebugEnabled`,
 *  `logVeraInterruptDebug`, `logVoicePipe`, `API_URL`) all resolve at
 *  CALL TIME through the shared global lexical environment. None of
 *  them is read at module load time.
 *
 *  ─────────────────────────────────────────────────────────────────────
 *  API surface (exposed as bare identifiers AND as window.* aliases)
 *  ─────────────────────────────────────────────────────────────────────
 *    state          activeMainTtsBufferSources, mainTtsPlaybackActive,
 *                   mainTtsPlaybackToken, activeNdjsonBodyReader
 *    bookkeeping    registerMainTtsBufferSource()
 *    cancellation   cancelMainTtsPlayback(), stopAllMainTtsWebAudio()
 *    queueing       createTtsUrlQueue()
 *    playback       playTtsUrlSequenceGapless(),
 *                   playTtsUrlSequenceIncremental(),
 *                   runNdjsonTtsPlayback()
 *    accessors      isMainTtsPlaying(), getTtsDebugState()
 *
 *  Helpers / state intentionally LEFT in app.js (and why):
 *    isAssistantTtsPlaying   - used by many non-TTS sites; reads our
 *                              moved state through shared lexical env.
 *    playTtsFromApi          - sits between data and playback layer;
 *                              tied to mute / continuous-listening
 *                              short-circuits and the single-`<audio>`
 *                              vs sentence-chunk decision. Calls our
 *                              `playTtsUrlSequenceGapless` directly.
 *    resolveAudioUrls        - tiny data-shape helper; not playback.
 *    tryPeekApplyWorkModeTimerFromNdjsonClone - NDJSON peek for
 *                              work-mode timer; not TTS playback.
 *    activePipelineAbort, queuedAssistantTtsPlayback,
 *    attachPipelineAbortSignal, enqueueAssistantTtsPlayback,
 *    waitUntilAssistantTtsIdle, waitForAssistantPlaybackEnd,
 *    isMainTtsOrHtmlAudioPlaying, isServerPipelineBusy,
 *    isFlowModeKeyboardInterruptAllowed,
 *    interruptAssistantPipelineForTypedMessage
 *                            - pipeline-level orchestration / typed
 *                              barge-in glue; not the playback layer.
 * ========================================================================= */

/* =========================
   MAIN-TTS RUNTIME STATE
========================= */

/** Sentence-chunk / streaming TTS uses BufferSource → destination; `<audio>` stays paused, so interrupt must track these. */
let activeMainTtsBufferSources = [];
/** True from first main TTS chunk until last chunk ends — gaps between BufferSources have 0 active sources but TTS is still "playing". */
let mainTtsPlaybackActive = false;
/** Incremented on interrupt so NDJSON read + incremental Web Audio loops exit and stop scheduling further chunks. */
let mainTtsPlaybackToken = 0;
/** Active NDJSON `res.body.getReader()`; cancelled on interrupt so the stream stops feeding the URL queue. */
let activeNdjsonBodyReader = null;

/* =========================
   BOOKKEEPING
========================= */

function registerMainTtsBufferSource(src, onEndedExtra) {
  activeMainTtsBufferSources.push(src);
  src.onended = () => {
    const i = activeMainTtsBufferSources.indexOf(src);
    if (i >= 0) activeMainTtsBufferSources.splice(i, 1);
    if (onEndedExtra) onEndedExtra();
  };
}

/* =========================
   CANCELLATION
========================= */

function stopAllMainTtsWebAudio() {
  const _dbgSourceCount = activeMainTtsBufferSources.length;
  let _dbgStopped = 0;
  let _dbgErrors = 0;
  /* PART 1 — t7: stopAllMainTtsWebAudio entered.
     PART 4 — tts_cancel_source_trace. */
  _recordInterruptTimingPoint("t7_stopAllMainTtsWebAudio_called", {
    extra: { sourceCount: _dbgSourceCount },
  });
  _logTtsCancelSourceTrace(
    "stopAllMainTtsWebAudio",
    _veraTtsCancelSource || ""
  );
  mainTtsPlaybackActive = false;
  const copy = activeMainTtsBufferSources.slice();
  activeMainTtsBufferSources = [];
  for (const src of copy) {
    try {
      src.onended = null;
      src.stop(0);
      _dbgStopped++;
    } catch (_) {
      /* already stopped */
      _dbgErrors++;
    }
  }
  if (document.body.classList.contains("bmo-open")) {
    stopBmoTtsMouthAnimation();
  }
  logVeraInterruptDebug({
    tag: "tts_stop_all_sources",
    now: Number(performance.now().toFixed(1)),
    sourceCount: _dbgSourceCount,
    stopped: _dbgStopped,
    errors: _dbgErrors,
  });
}

function cancelMainTtsPlayback() {
  const _dbgSource = _veraTtsCancelSource || "unknown";
  _veraTtsCancelSource = "";
  const _dbgOldToken = mainTtsPlaybackToken;
  const _dbgActiveSourcesBefore = activeMainTtsBufferSources.length;
  const _dbgMainTtsActiveBefore = mainTtsPlaybackActive;
  const _dbgReaderBefore = Boolean(activeNdjsonBodyReader);
  /* PART 1 — t6: cancelMainTtsPlayback entered.
     PART 4 — tts_cancel_source_trace. */
  _recordInterruptTimingPoint("t6_cancelMainTtsPlayback_called", {
    extra: { source: _dbgSource },
  });
  _logTtsCancelSourceTrace("cancelMainTtsPlayback", _dbgSource);
  logVeraInterruptDebug({
    tag: "tts_cancel_called",
    now: Number(performance.now().toFixed(1)),
    source: _dbgSource,
    oldMainTtsPlaybackToken: _dbgOldToken,
    newMainTtsPlaybackToken: _dbgOldToken + 1,
    activeSourcesBefore: _dbgActiveSourcesBefore,
    mainTtsPlaybackActiveBefore: _dbgMainTtsActiveBefore,
    activeReaderBefore: _dbgReaderBefore,
    interruptRecording,
    duringNewsRender: _veraNewsPanelRenderInFlight,
  });

  mainTtsPlaybackToken++;
  stopAllMainTtsWebAudio();
  const r = activeNdjsonBodyReader;
  activeNdjsonBodyReader = null;
  if (r) {
    try {
      r.cancel();
    } catch (_) {
      /* ignore */
    }
  }

  /* PART 1 — t10: active Web Audio buffer source count after cancel.
     stopAllMainTtsWebAudio empties the array synchronously, so this
     is normally 0 here. If a chunk's src.start() was called between
     mainTtsPlaybackToken++ and registerMainTtsBufferSource (race), the
     count could still be 0 here while an unregistered source plays. */
  if (activeMainTtsBufferSources.length === 0) {
    _recordInterruptTimingPoint("t10_audio_sources_zero", {
      extra: { source: _dbgSource },
    });
  }

  logVeraInterruptDebug({
    tag: "tts_cancel_after",
    now: Number(performance.now().toFixed(1)),
    source: _dbgSource,
    mainTtsPlaybackToken,
    mainTtsPlaybackActiveAfter: mainTtsPlaybackActive,
    activeSourcesAfter: activeMainTtsBufferSources.length,
    activeReaderAfter: Boolean(activeNdjsonBodyReader),
    interruptRecording,
  });
}

/* =========================
   QUEUE PRIMITIVE
========================= */

function createTtsUrlQueue() {
  const q = [];
  const waiters = [];
  let ended = false;
  return {
    push(url) {
      q.push(url);
      const w = waiters.shift();
      if (w) w();
    },
    end() {
      ended = true;
      waiters.splice(0).forEach((w) => w());
    },
    async next() {
      for (;;) {
        if (q.length) return q.shift();
        if (ended) return null;
        await new Promise((r) => waiters.push(r));
      }
    }
  };
}

/* =========================
   PLAYBACK
========================= */

/**
 * Schedule decoded buffers back-to-back on one AudioContext (minimal gaps vs chained <audio>).
 * Prefetches the next HTTP response while decoding/playing the current chunk.
 */
async function playTtsUrlSequenceGapless(
  baseUrl,
  relativeUrls,
  { onFirstStart, onLastEnd, sessionToken, segmentFaceModes } = {}
) {
  if (!relativeUrls?.length) return;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  await ensureMainAudioTtsGraph();
  mainTtsPlaybackActive = true;
  getAudioEl()?.pause();
  let t = audioCtx.currentTime + 0.08;
  let firstDone = false;

  let nextPromise = fetch(`${baseUrl}${relativeUrls[0]}`).then((r) => {
    if (!r.ok) throw new Error(`TTS chunk 0 HTTP ${r.status}`);
    return r.arrayBuffer();
  });

  try {
  for (let i = 0; i < relativeUrls.length; i++) {
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const ab = await nextPromise;
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    nextPromise =
      i + 1 < relativeUrls.length
        ? fetch(`${baseUrl}${relativeUrls[i + 1]}`).then((r) => {
            if (!r.ok) throw new Error(`TTS chunk ${i + 1} HTTP ${r.status}`);
            return r.arrayBuffer();
          })
        : null;

    const audBuf = await audioCtx.decodeAudioData(ab.slice(0));
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      mainTtsPlaybackActive = false;
      return;
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audBuf;
    connectBufferSourceToTtsGraph(src);
    const startAt = Math.max(t, audioCtx.currentTime + 0.02);
    if (document.body.classList.contains("bmo-open")) {
      const face =
        segmentFaceModes != null && segmentFaceModes.length
          ? segmentFaceModes[Math.min(i, segmentFaceModes.length - 1)]
          : "happy";
      setBmoTtsFaceTrack(face);
    }
    /* RACE CLOSE (1/2): Re-check token immediately before src.start.
       A cancelMainTtsPlayback() invocation in the await window above
       could have bumped mainTtsPlaybackToken. Without this guard, the
       buffer would still be started and (because we haven't yet called
       registerMainTtsBufferSource) NOT tracked in activeMainTtsBufferSources,
       so stopAllMainTtsWebAudio() could not reach it and the user would
       keep hearing this chunk to its natural end. */
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      try { src.disconnect(); } catch (_) {}
      mainTtsPlaybackActive = false;
      logVeraInterruptDebug({
        tag: "tts_race_close",
        path: "playTtsUrlSequenceGapless",
        stage: "before_src_start",
        chunkIndex: i,
        sessionToken,
        currentMainTtsPlaybackToken: mainTtsPlaybackToken,
        note: "cancel happened in fetch/decode await; buffer never started",
      });
      return;
    }
    src.start(startAt);
    /* RACE CLOSE (2/2): Re-check token immediately after src.start and
       before registration. If cancel arrived between src.start and
       registerMainTtsBufferSource, stop and disconnect the source so
       it does not keep producing audio while untracked. */
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      try { src.stop(0); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
      mainTtsPlaybackActive = false;
      logVeraInterruptDebug({
        tag: "tts_race_close",
        path: "playTtsUrlSequenceGapless",
        stage: "after_src_start",
        chunkIndex: i,
        sessionToken,
        currentMainTtsPlaybackToken: mainTtsPlaybackToken,
        note: "cancel raced src.start; source stopped before registration",
      });
      return;
    }
    /* BMO mouth before onFirstStart: onPlayStart applies news side panel (heavy innerHTML); blocking first would let TTS chunks finish before RAF starts — generic headlines path is slower than “breaking news”. */
    if (document.body.classList.contains("bmo-open")) {
      void startBmoTtsMouthAnimation();
    }
    if (!firstDone && onFirstStart) {
      onFirstStart();
      firstDone = true;
    }
    const isLast = i === relativeUrls.length - 1;
    registerMainTtsBufferSource(
      src,
      isLast && onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : undefined
    );
    t = startAt + audBuf.duration;
  }
  } catch (e) {
    mainTtsPlaybackActive = false;
    throw e;
  }
}

/** Gapless Web Audio playback when URLs arrive incrementally (streaming NDJSON chunks). */
async function playTtsUrlSequenceIncremental(
  baseUrl,
  nextRelFn,
  {
    onBeforeFirstPlay,
    onFirstStart,
    onLastEnd,
    sessionToken,
    segmentFaceModes,
    /** NDJSON fills this array after playback starts — call each chunk instead of freezing `segmentFaceModes`. */
    getSegmentFaceModes
  } = {}
) {
  const currentFaceModes = () =>
    typeof getSegmentFaceModes === "function" ? getSegmentFaceModes() : segmentFaceModes;
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: 16000 });
  }
  await audioCtx.resume();
  await ensureMainAudioTtsGraph();
  let t = audioCtx.currentTime + 0.08;
  let firstDone = false;
  /* DEBUG: declared early so the checkpoint helper below can reference
     it without hitting the let TDZ (the helper is invoked before the
     first URL fetch). */
  let chunkPlayIndex = 0;

  /* DEBUG helper local to this loop — emits a structured checkpoint
     log without affecting control flow. Tied to the active NDJSON
     debug context so chunks can be correlated with news vs normal. */
  const _dbgCheckpoint = (checkpointName, extra) => {
    if (!isVeraInterruptDebugEnabled()) return;
    const mismatch = sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken;
    logVeraInterruptDebug({
      tag: "tts_playback_checkpoint",
      checkpointName,
      chunkIndex: chunkPlayIndex,
      sessionToken,
      currentMainTtsPlaybackToken: mainTtsPlaybackToken,
      tokenMismatch: mismatch,
      mainTtsPlaybackActive,
      activeSourcesCount: activeMainTtsBufferSources.length,
      activeNdjsonBodyReaderPresent: Boolean(activeNdjsonBodyReader),
      newsMeta: Boolean(_veraCurrentTtsDebugContext?.actionType === "news"),
      actionType: _veraCurrentTtsDebugContext?.actionType ?? null,
      duringNewsRender: _veraNewsPanelRenderInFlight,
      ...(extra || {})
    });
  };

  _dbgCheckpoint("before_await_first_url");
  let curRel = await nextRelFn();
  _dbgCheckpoint("after_await_first_url", { curRel: curRel || null });
  if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
    _dbgCheckpoint("exit_token_mismatch", { stage: "first_url" });
    mainTtsPlaybackActive = false;
    return;
  }
  /* NDJSON can call queue.end() before any chunk URL (e.g. done-before-chunk or empty TTS). Without this,
     onPlayEnd / resumeAfterAssistantReplyPlayback never runs → processing stays true and listening never renews. */
  if (!curRel) {
    _dbgCheckpoint("exit_no_first_url");
    const endFn = onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : null;
    if (endFn) endFn();
    else mainTtsPlaybackActive = false;
    return;
  }
  mainTtsPlaybackActive = true;
  _dbgCheckpoint("main_tts_active_flipped_true");
  getAudioEl()?.pause();
  let nextPromise = fetch(`${baseUrl}${curRel}`).then((r) => {
    if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);
    return r.arrayBuffer();
  });

  try {
  for (;;) {
    _dbgCheckpoint("loop_top_token_check");
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      _dbgCheckpoint("exit_token_mismatch", { stage: "loop_top" });
      mainTtsPlaybackActive = false;
      return;
    }
    _dbgCheckpoint("before_await_next_promise");
    const ab = await nextPromise;
    _dbgCheckpoint("after_await_next_promise", { chunkBytes: ab?.byteLength ?? null });
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      _dbgCheckpoint("exit_token_mismatch", { stage: "after_fetch" });
      mainTtsPlaybackActive = false;
      return;
    }
    _dbgCheckpoint("before_await_next_url");
    const nextRel = await nextRelFn();
    _dbgCheckpoint("after_await_next_url", { nextRel: nextRel || null });
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      _dbgCheckpoint("exit_token_mismatch", { stage: "after_next_url" });
      mainTtsPlaybackActive = false;
      return;
    }
    nextPromise = nextRel
      ? fetch(`${baseUrl}${nextRel}`).then((r) => {
          if (!r.ok) throw new Error(`TTS HTTP ${r.status}`);
          return r.arrayBuffer();
        })
      : null;

    _dbgCheckpoint("before_decode_audio_data");
    const audBuf = await audioCtx.decodeAudioData(ab.slice(0));
    _dbgCheckpoint("after_decode_audio_data", { audBufDurationS: audBuf?.duration ?? null });
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      _dbgCheckpoint("exit_token_mismatch", { stage: "after_decode" });
      mainTtsPlaybackActive = false;
      return;
    }
    if (!firstDone && onBeforeFirstPlay) {
      onBeforeFirstPlay();
    }
    const src = audioCtx.createBufferSource();
    src.buffer = audBuf;
    connectBufferSourceToTtsGraph(src);
    const startAt = Math.max(t, audioCtx.currentTime + 0.02);
    if (document.body.classList.contains("bmo-open")) {
      const modesList = currentFaceModes();
      const face =
        modesList != null && modesList.length
          ? modesList[Math.min(chunkPlayIndex, modesList.length - 1)]
          : "happy";
      setBmoTtsFaceTrack(face);
    }
    _dbgCheckpoint("before_src_start", {
      startAt: Number(Number(startAt).toFixed(3)),
      audioCtxCurrentTime: Number(Number(audioCtx.currentTime).toFixed(3))
    });
    /* DEBUG: independent "right before src.start" log so we can spot
       chunks that get started after cancellation. Not gated by the
       checkpoint helper since the user spec calls this out explicitly. */
    if (isVeraInterruptDebugEnabled()) {
      const _mismatch = sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken;
      logVeraInterruptDebug({
        tag: "tts_before_src_start",
        chunkIndex: chunkPlayIndex,
        sessionToken,
        currentMainTtsPlaybackToken: mainTtsPlaybackToken,
        tokenMismatch: _mismatch,
        newsMeta: Boolean(_veraCurrentTtsDebugContext?.actionType === "news"),
      });
    }
    /* RACE CLOSE (1/2): Re-check token immediately before src.start.
       The await for fetch+decode above can yield long enough for
       cancelMainTtsPlayback() to bump mainTtsPlaybackToken. Without
       this guard, the buffer would start playing untracked (because
       registerMainTtsBufferSource has not run yet), and the user
       would keep hearing the rest of this chunk past the cancel. */
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      try { src.disconnect(); } catch (_) {}
      _dbgCheckpoint("race_close_before_src_start", {
        startAt: Number(Number(startAt).toFixed(3)),
      });
      logVeraInterruptDebug({
        tag: "tts_race_close",
        path: "playTtsUrlSequenceIncremental",
        stage: "before_src_start",
        chunkIndex: chunkPlayIndex,
        sessionToken,
        currentMainTtsPlaybackToken: mainTtsPlaybackToken,
        note: "cancel happened in fetch/decode await; buffer never started",
      });
      mainTtsPlaybackActive = false;
      return;
    }
    src.start(startAt);
    _dbgCheckpoint("after_src_start");
    /* RACE CLOSE (2/2): Re-check token immediately after src.start and
       before registration. If cancel arrived between src.start and
       registerMainTtsBufferSource, stop and disconnect the source so
       it does not keep producing audio while untracked. */
    if (sessionToken !== undefined && mainTtsPlaybackToken !== sessionToken) {
      try { src.stop(0); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
      _dbgCheckpoint("race_close_after_src_start", {
        startAt: Number(Number(startAt).toFixed(3)),
      });
      logVeraInterruptDebug({
        tag: "tts_race_close",
        path: "playTtsUrlSequenceIncremental",
        stage: "after_src_start",
        chunkIndex: chunkPlayIndex,
        sessionToken,
        currentMainTtsPlaybackToken: mainTtsPlaybackToken,
        note: "cancel raced src.start; source stopped before registration",
      });
      mainTtsPlaybackActive = false;
      return;
    }
    chunkPlayIndex++;
    /* Same order as gapless: mouth before onPlayStart so heavy news panel does not block first tick. */
    if (document.body.classList.contains("bmo-open")) {
      void startBmoTtsMouthAnimation();
    }
    if (!firstDone && onFirstStart) {
      onFirstStart();
      firstDone = true;
    }
    const isLast = !nextRel;
    registerMainTtsBufferSource(
      src,
      isLast && onLastEnd ? wrapLastChunkForBmoMouth(onLastEnd) : undefined
    );
    _dbgCheckpoint("after_register_source", { isLast });
    t = startAt + audBuf.duration;
    if (!nextRel) break;
  }
  } catch (e) {
    _dbgCheckpoint("loop_exception", { error: String(e?.message || e || "").slice(0, 200) });
    mainTtsPlaybackActive = false;
    throw e;
  }
}

/**
 * Consume application/x-ndjson: asr (optional) → meta → chunk → … → done. Prefetches the next URL while decoding/playing.
 * Each parsed line batch must be handled in stream order: meta before chunks, or the user transcript bubble
 * can appear after the assistant (same bug for main infer and interrupt NDJSON).
 * First-sentence assistant text is applied in onBeforeFirstPlay (after decode, before src.start) so it aligns with audio.
 */
async function runNdjsonTtsPlayback(
  res,
  { onMeta, onDone, onPlayStart, onPlayEnd, onReplyProgress, skipAudio, suppressReplyProgress }
) {
  const reader = res.body.getReader();
  activeNdjsonBodyReader = reader;
  const sessionToken = mainTtsPlaybackToken;
  /* DEBUG: per-NDJSON correlation context. Populated on first meta line. */
  _veraCurrentTtsDebugContext = {
    sessionToken,
    actionType: null,
    sessionIdFromMeta: null,
    transcriptPreview: null,
    chunksEnqueued: 0,
    metaSeen: false,
    doneSeen: false,
  };
  logVeraInterruptDebug({
    tag: "ndjson_playback_start",
    now: Number(performance.now().toFixed(1)),
    sessionToken,
    mainTtsPlaybackToken,
    skipAudio: Boolean(skipAudio),
  });
  const decoder = new TextDecoder();
  let buf = "";
  const queue = createTtsUrlQueue();
  let loggedFirstChunk = false;
  /** User bubble from transcript: once from early `asr` line or from `meta` (older servers). */
  let userTranscriptBubbleSeen = false;
  function wrapOnMeta(meta) {
    if (!onMeta || !meta) return;
    const m = { ...meta };
    if (m.transcript) {
      if (userTranscriptBubbleSeen) {
        delete m.transcript;
      } else {
        userTranscriptBubbleSeen = true;
      }
    }
    onMeta(m);
  }
  /** First-sentence text is deferred until first audio buffer is decoded (sync with playback start). */
  let pendingFirstReplySoFar = null;
  let deferFirstReply = true;
  /** Latest reply_so_far already applied via onReplyProgress (avoids onBeforeFirstPlay overwriting with shorter pending). */
  let lastEmittedReplySoFar = null;
  /** BMO: per-chunk face stack (happy vs sad); built from meta (full reply) or per chunk (LLM streaming + heuristic). */
  let ndjsonBmoFaceModes = null;
  let ndjsonBmoStreamingTts = false;
  let ndjsonBmoLastUserText = "";
  let ndjsonBmoCumulativeForSeg = "";

  async function readAll() {
    try {
      while (true) {
        if (mainTtsPlaybackToken !== sessionToken) {
          queue.end();
          return;
        }
        let readResult;
        try {
          readResult = await reader.read();
        } catch {
          queue.end();
          return;
        }
        const { value, done: rdone } = readResult;
        if (rdone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        const objs = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            objs.push(JSON.parse(line));
          } catch (e) {
            console.warn("[TTS][NDJSON] skip line", e);
          }
        }
        for (const obj of objs) {
          if (obj.type === "asr" && obj.transcript != null) {
            wrapOnMeta({ transcript: String(obj.transcript) });
            logVoicePipe("NDJSON asr line (user transcript early)");
          } else if (obj.type === "meta") {
            /* DEBUG: stamp the per-stream correlation context so chunk
               checkpoints and cancel logs can identify news vs normal. */
            if (_veraCurrentTtsDebugContext && _veraCurrentTtsDebugContext.sessionToken === sessionToken) {
              _veraCurrentTtsDebugContext.metaSeen = true;
              _veraCurrentTtsDebugContext.actionType = obj.action_type || null;
              _veraCurrentTtsDebugContext.sessionIdFromMeta = obj.session_id || null;
              _veraCurrentTtsDebugContext.transcriptPreview = obj.transcript
                ? String(obj.transcript).slice(0, 80)
                : null;
              logVeraInterruptDebug({
                tag: "ndjson_meta_seen",
                now: Number(performance.now().toFixed(1)),
                sessionToken,
                actionType: _veraCurrentTtsDebugContext.actionType,
                ttsSegmentCount: obj.tts_segment_count ?? null,
                llmStreaming: Boolean(obj.llm_streaming),
                hasActionPayload: Boolean(obj.action_payload),
                actionPayloadPanelType: obj.action_payload?.panel_type || null,
              });
            }
            wrapOnMeta(obj);
            logVoicePipe("NDJSON meta line (UI can attach transcript)");
            if (document.body.classList.contains("bmo-open")) {
              ndjsonBmoStreamingTts = Boolean(obj.llm_streaming);
              ndjsonBmoLastUserText = String(obj.transcript || obj.user_text || "");
              const reply = String(obj.reply || "").trim();
              if (reply && !ndjsonBmoStreamingTts) {
                ndjsonBmoCumulativeForSeg = "";
                try {
                  const sentences = splitSentencesForTtsClient(reply);
                  const n = Math.max(1, Number(obj.tts_segment_count) || sentences.length);
                  let labels;
                  const ut = ndjsonBmoLastUserText;
                  try {
                    labels = await fetchBmoTtsEmotionLabels(ut, sentences);
                    labels = boostBmoMoodsForUserDistress(ut, sentences, labels);
                  } catch (e) {
                    console.warn("[BMO][TTS] NDJSON meta emotion route", e);
                    labels = sentences.map((s) => classifyBmoTtsSegmentHeuristic(s));
                    labels = boostBmoMoodsForUserDistress(ut, sentences, labels);
                  }
                  let modes = sentences.map((_, i) => bmoMoodToFaceMode(labels[i]));
                  modes = alignBmoFaceModesToChunkCount(modes, n);
                  ndjsonBmoFaceModes = applyBmoSadFaceLexiconOverride(sentences, modes, ut);
                } catch (e) {
                  console.warn("[BMO][TTS] NDJSON meta face modes", e);
                  ndjsonBmoFaceModes = null;
                }
              } else if (ndjsonBmoStreamingTts) {
                ndjsonBmoFaceModes = [];
                ndjsonBmoCumulativeForSeg = "";
              } else {
                ndjsonBmoFaceModes = null;
              }
            }
          } else if (obj.type === "chunk" && obj.url) {
            if (mainTtsPlaybackToken !== sessionToken) {
              queue.end();
              return;
            }
            if (!loggedFirstChunk) {
              loggedFirstChunk = true;
              logVoicePipe("NDJSON first chunk URL queued (GET /audio/... next)");
            }
            if (
              document.body.classList.contains("bmo-open") &&
              ndjsonBmoStreamingTts &&
              Array.isArray(ndjsonBmoFaceModes)
            ) {
              const cur = String(obj.reply_so_far || "").trim();
              const delta = bmoNewSegmentFromCumulativeReply(ndjsonBmoCumulativeForSeg, cur);
              ndjsonBmoCumulativeForSeg = cur;
              const segFor = (delta || cur).trim();
              let mood = classifyBmoTtsSegmentHeuristic(segFor);
              // Strict lexicon override stays unconditional; soft empathy requires
              // distressed user_text so casual replies don't flip to sad.
              if (bmoAssistantSegmentRequiresSadFaceStrict(segFor)) {
                mood = "sad";
              } else if (
                bmoUserTextIsDistressed(ndjsonBmoLastUserText) &&
                bmoAssistantSegmentSoftEmpathy(segFor)
              ) {
                mood = "sad";
              }
              ndjsonBmoFaceModes.push(bmoMoodToFaceMode(mood));
            }
            queue.push(obj.url);
            /* DEBUG: increment chunk-enqueued counter on the correlation
               context — used later to confirm whether late chunks are
               still arriving from the server after cancellation. */
            if (_veraCurrentTtsDebugContext && _veraCurrentTtsDebugContext.sessionToken === sessionToken) {
              _veraCurrentTtsDebugContext.chunksEnqueued += 1;
              logVeraInterruptDebug(
                {
                  tag: "ndjson_chunk_enqueued",
                  now: Number(performance.now().toFixed(1)),
                  sessionToken,
                  currentMainTtsPlaybackToken: mainTtsPlaybackToken,
                  tokenMismatch: sessionToken !== mainTtsPlaybackToken,
                  chunkIndex: obj.index ?? null,
                  chunksEnqueuedSoFar: _veraCurrentTtsDebugContext.chunksEnqueued,
                  actionType: _veraCurrentTtsDebugContext.actionType,
                },
                { throttleKey: `ndjson_chunk_enqueued_${sessionToken}`, throttleMs: 0 }
              );
            }
            if (obj.reply_so_far != null && onReplyProgress && !suppressReplyProgress) {
              if (deferFirstReply) {
                pendingFirstReplySoFar = String(obj.reply_so_far);
                deferFirstReply = false;
              } else {
                onReplyProgress(obj.reply_so_far);
                lastEmittedReplySoFar = String(obj.reply_so_far);
              }
            }
          } else if (obj.type === "done") {
            if (_veraCurrentTtsDebugContext && _veraCurrentTtsDebugContext.sessionToken === sessionToken) {
              _veraCurrentTtsDebugContext.doneSeen = true;
              logVeraInterruptDebug({
                tag: "ndjson_done_seen",
                now: Number(performance.now().toFixed(1)),
                sessionToken,
                currentMainTtsPlaybackToken: mainTtsPlaybackToken,
                tokenMismatch: sessionToken !== mainTtsPlaybackToken,
                chunksEnqueued: _veraCurrentTtsDebugContext.chunksEnqueued,
                actionType: _veraCurrentTtsDebugContext.actionType,
              });
            }
            if (onDone) onDone(obj);
            queue.end();
          }
        }
      }
    } finally {
      queue.end();
      if (activeNdjsonBodyReader === reader) activeNdjsonBodyReader = null;
      /* DEBUG: emit readTask exit signature so we can correlate with
         tts_cancel logs and confirm whether the body reader was
         cancelled, returned EOF naturally, or threw. */
      logVeraInterruptDebug({
        tag: "ndjson_read_task_exit",
        now: Number(performance.now().toFixed(1)),
        sessionToken,
        currentMainTtsPlaybackToken: mainTtsPlaybackToken,
        tokenMismatch: sessionToken !== mainTtsPlaybackToken,
        chunksEnqueued: _veraCurrentTtsDebugContext?.chunksEnqueued ?? null,
        doneSeen: _veraCurrentTtsDebugContext?.doneSeen ?? null,
        actionType: _veraCurrentTtsDebugContext?.actionType ?? null,
      });
    }
  }

  const readTask = readAll();
  const applyPendingFirstReply = () => {
    if (pendingFirstReplySoFar != null && onReplyProgress) {
      const pending = pendingFirstReplySoFar;
      pendingFirstReplySoFar = null;
      const alreadyAhead =
        lastEmittedReplySoFar != null && lastEmittedReplySoFar.length >= pending.length;
      if (!alreadyAhead) {
        onReplyProgress(pending);
        lastEmittedReplySoFar = pending;
      }
    }
  };
  try {
    if (skipAudio) {
      await readTask;
      if (!suppressReplyProgress) applyPendingFirstReply();
      if (typeof onPlayStart === "function") onPlayStart();
      if (typeof onPlayEnd === "function") onPlayEnd();
      return;
    }
    await Promise.all([
      playTtsUrlSequenceIncremental(API_URL, () => queue.next(), {
        onBeforeFirstPlay: applyPendingFirstReply,
        onFirstStart: onPlayStart,
        onLastEnd: onPlayEnd,
        sessionToken,
        getSegmentFaceModes: () => ndjsonBmoFaceModes
      }),
      readTask
    ]);
  } finally {
    if (activeNdjsonBodyReader === reader) activeNdjsonBodyReader = null;
    /* DEBUG: clear the per-NDJSON correlation context so a new playback
       cycle gets a fresh slate. Snapshot the final state first for
       attribution. */
    if (_veraCurrentTtsDebugContext && _veraCurrentTtsDebugContext.sessionToken === sessionToken) {
      logVeraInterruptDebug({
        tag: "ndjson_playback_end",
        now: Number(performance.now().toFixed(1)),
        sessionToken,
        currentMainTtsPlaybackToken: mainTtsPlaybackToken,
        tokenMismatch: sessionToken !== mainTtsPlaybackToken,
        chunksEnqueued: _veraCurrentTtsDebugContext.chunksEnqueued,
        metaSeen: _veraCurrentTtsDebugContext.metaSeen,
        doneSeen: _veraCurrentTtsDebugContext.doneSeen,
        actionType: _veraCurrentTtsDebugContext.actionType,
      });
      _veraCurrentTtsDebugContext = null;
    }
  }
}

/* =========================
   READ-ONLY ACCESSORS  (new, additive — Stage 5)

   These are the small extra surface the user spec requested. They do
   NOT replace any existing in-app `isAssistantTtsPlaying` /
   `isMainTtsOrHtmlAudioPlaying` checks; they sit alongside, exposing
   the same internal state as a stable named API so future stages can
   migrate call sites incrementally.
========================= */

function isMainTtsPlaying() {
  return Boolean(mainTtsPlaybackActive || activeMainTtsBufferSources.length > 0);
}

function getTtsDebugState() {
  return {
    mainTtsPlaybackActive,
    mainTtsPlaybackToken,
    activeMainTtsBufferSourcesCount: activeMainTtsBufferSources.length,
    activeNdjsonBodyReaderPresent: Boolean(activeNdjsonBodyReader),
  };
}

/* =========================================================================
 *  WINDOW ALIASES
 *  Mirror of the pattern used by utils/ids.js + utils/storage.js +
 *  utils/logging.js + debug/voiceDebug.js. Pre-extraction `app.js` did
 *  NOT attach these helpers to `window` — they were only ever called
 *  through bare identifiers. We add the aliases here as belt-and-braces
 *  insurance for DevTools snippets and `typeof window.X` callers; the
 *  bare identifiers continue to be the primary calling convention.
 * ========================================================================= */
try {
  if (typeof window !== "undefined") {
    window.cancelMainTtsPlayback = cancelMainTtsPlayback;
    window.stopAllMainTtsWebAudio = stopAllMainTtsWebAudio;
    window.runNdjsonTtsPlayback = runNdjsonTtsPlayback;
    window.playTtsUrlSequenceIncremental = playTtsUrlSequenceIncremental;
    window.playTtsUrlSequenceGapless = playTtsUrlSequenceGapless;
    window.isMainTtsPlaying = isMainTtsPlaying;
    window.getTtsDebugState = getTtsDebugState;
  }
} catch (_) {}
