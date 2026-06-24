/**
 * Multi-action music sequencing — ordered execution + provider exclusivity barriers.
 * Loaded after app.js (uses window.__veraGetGlobalPlaybackState and provider helpers).
 */
(function () {
  const MUSIC_PLAY_OPS = new Set([
    "play_track",
    "play_builtin",
    "play_album",
    "play_playlist_scoped",
    "play_playlist_by_name",
  ]);

  const MUSIC_TRANSPORT_OPS = new Set(["skip_next", "skip_previous", "pause", "resume"]);

  const DEFAULT_BARRIER_TIMEOUT_MS = 5000;
  const DEFAULT_BARRIER_POLL_MS = 250;
  const BARRIER_SETTLE_FALLBACK_MS = 700;

  function readPlaybackState() {
    try {
      if (typeof window.__veraGetGlobalPlaybackState === "function") {
        return window.__veraGetGlobalPlaybackState();
      }
    } catch (_) {
      /* ignore */
    }
    return {
      activeSource: "none",
      isPlaying: false,
      trackTitle: null,
      artist: null,
    };
  }

  function isBuiltinPlaying() {
    try {
      if (typeof window.__veraIsBuiltinMusicAudiblyPlaying === "function") {
        return window.__veraIsBuiltinMusicAudiblyPlaying();
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function isSpotifyPlaying() {
    try {
      if (typeof window.__veraIsSpotifyMusicAudiblyPlaying === "function") {
        return window.__veraIsSpotifyMusicAudiblyPlaying();
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function inferTargetProvider(payload, op) {
    try {
      if (typeof window.__veraInferMusicTargetProvider === "function") {
        return window.__veraInferMusicTargetProvider(payload, op);
      }
    } catch (_) {
      /* ignore */
    }
    if (op === "play_builtin") return "builtin";
    return "spotify";
  }

  function playbackSnapshot(gs) {
    const s = gs || {};
    return {
      activeSource: s.activeSource || "none",
      isPlaying: Boolean(s.isPlaying),
      trackTitle: s.trackTitle || "",
      artist: s.artist || "",
      builtinPlaying: isBuiltinPlaying(),
      spotifyPlaying: isSpotifyPlaying(),
    };
  }

  function musicControlMeta(op) {
    const isPlay = MUSIC_PLAY_OPS.has(op);
    const isTransport = MUSIC_TRANSPORT_OPS.has(op);
    const isVolume = op === "volume_delta";
    return {
      domain: "music",
      requiresSequentialExecution: isPlay || isTransport || isVolume,
      mutatesDomainState: isPlay || isTransport || isVolume,
      stateBarrier: isPlay ? "playback_settled" : null,
      dependsOnPreviousSameDomain: isTransport || isPlay,
    };
  }

  function isMusicControlPayload(payload) {
    return payload && payload.panel_type === "music_control";
  }

  function expectedTrackFromPlayPayload(payload) {
    return String(payload?.title || payload?.query || payload?.playlist_name || "").trim();
  }

  function trackMatchesExpected(gs, expectedTrack) {
    const needle = String(expectedTrack || "").toLowerCase().trim();
    if (!needle) return true;
    const title = String(gs?.trackTitle || "").toLowerCase();
    const tokens = needle.split(/\s+/).filter((t) => t.length >= 3);
    if (title.includes(needle)) return true;
    if (tokens.length && tokens.every((t) => title.includes(t))) return true;
    return false;
  }

  function providerExclusiveOk(targetProvider, gs) {
    const target = String(targetProvider || "").toLowerCase();
    const builtinOn = isBuiltinPlaying();
    const spotifyOn = isSpotifyPlaying();
    if (builtinOn && spotifyOn) return false;
    if (target === "spotify") {
      if (builtinOn) return false;
      return gs.activeSource === "spotify" || spotifyOn;
    }
    if (target === "builtin") {
      if (spotifyOn) return false;
      return gs.activeSource === "builtin" || builtinOn;
    }
    return gs.activeSource !== "none";
  }

  /**
   * Poll until target provider is exclusive and playing (optionally matching track).
   */
  async function waitForMusicPlaybackSettled(opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_BARRIER_TIMEOUT_MS;
    const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : DEFAULT_BARRIER_POLL_MS;
    const expectedTrack = String(opts.expectedTrack || "").trim();
    const targetProvider = String(opts.targetProvider || "").toLowerCase();
    const t0 = performance.now();
    const before = playbackSnapshot(readPlaybackState());

    console.warn("[music_play_settle_wait_start]", {
      expectedTrack: expectedTrack || null,
      targetProvider: targetProvider || null,
      timeoutMs,
      pollMs,
      before,
    });

    while (performance.now() - t0 < timeoutMs) {
      const gs = readPlaybackState();
      const exclusive = providerExclusiveOk(targetProvider, gs);
      const active = gs.activeSource !== "none" && gs.isPlaying;
      const trackOk = trackMatchesExpected(gs, expectedTrack);
      const providerOk = !targetProvider || gs.activeSource === targetProvider || exclusive;
      if (exclusive && active && trackOk && providerOk) {
        const elapsedMs = Math.round(performance.now() - t0);
        const after = playbackSnapshot(gs);
        console.warn("[music_play_settle_wait_done]", {
          expectedTrack: expectedTrack || null,
          targetProvider: targetProvider || null,
          elapsedMs,
          before,
          after,
        });
        return { ok: true, elapsedMs, before, after, targetProvider };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    await new Promise((r) => setTimeout(r, BARRIER_SETTLE_FALLBACK_MS));
    const after = playbackSnapshot(readPlaybackState());
    const elapsedMs = Math.round(performance.now() - t0);
    console.warn("[music_play_settle_timeout]", {
      expectedTrack: expectedTrack || null,
      targetProvider: targetProvider || null,
      elapsedMs,
      before,
      after,
    });
    return { ok: false, elapsedMs, before, after, targetProvider };
  }

  function needsBarrierBefore(op, pendingPlayBarrier) {
    if (!pendingPlayBarrier) return false;
    return MUSIC_TRANSPORT_OPS.has(op) || op === "volume_delta";
  }

  async function applyActionPayloadsInOrder(payloads, applySingleFn, context = {}) {
    const list = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
    if (!list.length) return { ok: true, results: [] };

    const seqStart = performance.now();
    const actionTypes = list.map((p) =>
      isMusicControlPayload(p) ? `music.${p.op || "unknown"}` : (p.panel_type || "unknown")
    );

    console.warn("[music_sequence_start]", {
      count: list.length,
      actionTypes,
      requestId: context.requestId || null,
      source: context.source || null,
    });

    let pendingPlayBarrier = false;
    let lastPlayExpectedTrack = "";
    let lastPlayTargetProvider = "";
    let sequenceActiveProvider = null;
    const results = [];

    try {
      for (let idx = 0; idx < list.length; idx++) {
        const payload = list[idx];
        const op = isMusicControlPayload(payload) ? (payload.op || "") : "";
        const actionType = isMusicControlPayload(payload)
          ? `music.${op || "unknown"}`
          : (payload.panel_type || "unknown");

        if (isMusicControlPayload(payload) && needsBarrierBefore(op, pendingPlayBarrier)) {
          console.warn("[music_sequence_blocked_until_play_settled]", {
            actionType,
            orderIndex: idx,
            targetProvider: lastPlayTargetProvider || null,
            expectedTrack: lastPlayExpectedTrack || null,
          });
          await waitForMusicPlaybackSettled({
            expectedTrack: lastPlayExpectedTrack,
            targetProvider: lastPlayTargetProvider,
          });
          pendingPlayBarrier = false;
        }

        const before = playbackSnapshot(readPlaybackState());
        const t0 = performance.now();
        console.warn("[music_action_start]", {
          actionType,
          orderIndex: idx,
          op: op || null,
          activeProvider: sequenceActiveProvider,
          expectedTrack: lastPlayExpectedTrack || expectedTrackFromPlayPayload(payload) || null,
          before,
        });

        let applyResult = undefined;
        try {
          applyResult = await applySingleFn(payload, {
            orderIndex: idx,
            activeProvider: sequenceActiveProvider,
            ...context,
          });
        } catch (err) {
          console.warn("[music_action_done]", {
            actionType,
            orderIndex: idx,
            ok: false,
            error: String(err?.message || err || "apply_error").slice(0, 200),
            elapsedMs: Math.round(performance.now() - t0),
            before,
            after: playbackSnapshot(readPlaybackState()),
          });
          results.push({ orderIndex: idx, actionType, ok: false, error: String(err?.message || err) });
          continue;
        }

        if (applyResult?.targetProvider) {
          sequenceActiveProvider = applyResult.targetProvider;
          window.__veraMusicSequenceActiveProvider = sequenceActiveProvider;
        }

        const after = playbackSnapshot(readPlaybackState());
        const elapsedMs = Math.round(performance.now() - t0);
        console.warn("[music_action_done]", {
          actionType,
          orderIndex: idx,
          ok: true,
          elapsedMs,
          activeProvider: sequenceActiveProvider,
          before,
          after,
          applyResult: applyResult === undefined ? null : applyResult,
        });
        results.push({ orderIndex: idx, actionType, ok: true, elapsedMs });

        if (isMusicControlPayload(payload) && MUSIC_PLAY_OPS.has(op)) {
          lastPlayExpectedTrack =
            applyResult?.expectedTrack || expectedTrackFromPlayPayload(payload);
          lastPlayTargetProvider =
            applyResult?.targetProvider || inferTargetProvider(payload, op);
          pendingPlayBarrier = true;
          const settle = await waitForMusicPlaybackSettled({
            expectedTrack: lastPlayExpectedTrack,
            targetProvider: lastPlayTargetProvider,
          });
          sequenceActiveProvider = lastPlayTargetProvider;
          window.__veraMusicSequenceActiveProvider = sequenceActiveProvider;
          pendingPlayBarrier = false;
          if (!settle.ok) {
            console.warn("[music_sequence_play_settle_incomplete]", {
              orderIndex: idx,
              targetProvider: lastPlayTargetProvider,
            });
          }
        }
      }
    } finally {
      window.__veraMusicSequenceActiveProvider = null;
    }

    console.warn("[music_sequence_done]", {
      count: list.length,
      elapsedMs: Math.round(performance.now() - seqStart),
      actionTypes,
    });

    return { ok: results.every((r) => r.ok), results };
  }

  window.veraMusicControlMeta = musicControlMeta;
  window.veraWaitForMusicPlaybackSettled = waitForMusicPlaybackSettled;
  window.veraApplyActionPayloadsInOrder = applyActionPayloadsInOrder;
})();
