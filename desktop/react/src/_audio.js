// Audio controller — wraps a single <audio> element and exposes
// imperative play/pause/seek/volume/mute via `window.MK_AUDIO`.
//
// The Claude Designer artifact's `App()` keeps `playing`, `pos`, `vol`,
// `muted` as React state. Without a real audio element those just
// drive a setInterval that fakes a clock. The wiring layer needs to:
//
//   1. Point an <audio> at the stream URL when playTrack() runs
//   2. Forward UI controls (play/pause/seek/vol/mute) to that element
//   3. Push real `timeupdate` events back into React's `pos` state so
//      the scrub bar tracks the audio, not a synthetic clock
//   4. Fire `ended` so handleNext() runs at end-of-track
//
// Lives outside the artifact (underscored filename) so design-zip
// drops don't touch it.

(function () {
  "use strict";

  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.crossOrigin = "anonymous";
  // Attach to the document so DevTools / a11y trees see it. Hidden via
  // CSS — the artifact's transport bar IS the UI.
  audio.style.display = "none";
  document.documentElement.appendChild(audio);

  // Web Audio graph for the spectrum visualizer. We don't construct it
  // until the user clicks play once, because creating an AudioContext
  // before a user gesture leaves it in 'suspended' state on Chromium
  // and most browsers log a warning.
  //
  // Once created we leave it in place — destroying / recreating the
  // graph per-track introduces clicks. `MediaElementSource` can only
  // be created ONCE per <audio> element so this is a one-shot setup.
  let audioCtx = null;
  let analyser = null;
  let freqLine = null;
  let waveLine = null;

  // Latency-compensating delay line. The analyser taps the graph at
  // `source -> analyser`, i.e. BEFORE the output buffer + device latency,
  // so a freshly-read frame describes audio you won't HEAR for another
  // baseLatency + outputLatency seconds. On wired output that's a few ms
  // (invisible); on Bluetooth it's 150-500ms, which reads as the spectrum
  // running ahead of the sound. We keep a ring of recent timestamped
  // frames and hand back the one from `latency` seconds ago so the drawn
  // frame lines up with what's actually reaching the ears. Indexed by
  // audioCtx.currentTime (not frame count) so a variable draw rate stays
  // correct. ~96 slots ~= 1.5s of headroom at 60fps.
  function makeDelayLine(width) {
    const SLOTS = 96;
    const buf = new Array(SLOTS);
    for (let i = 0; i < SLOTS; i++) buf[i] = { t: -1, data: new Uint8Array(width) };
    let head = 0;
    let count = 0;
    return function pushAndRead(fill, nowT, delay) {
      head = (head + 1) % SLOTS;
      const slot = buf[head];
      slot.t = nowT;
      fill(slot.data);
      if (count < SLOTS) count++;
      // No meaningful delay (wired / unknown): return the freshest frame.
      if (!(delay > 0.02)) return slot.data;
      const targetT = nowT - delay;
      // Walk back from newest; first frame old enough is the match. If the
      // ring isn't deep enough yet, fall back to the oldest we have.
      let best = slot;
      for (let k = 0; k < count; k++) {
        const s = buf[(head - k + SLOTS) % SLOTS];
        best = s;
        if (s.t <= targetT) break;
      }
      return best.data;
    };
  }

  // Manual spectrum-delay offset (seconds), added on top of the device's
  // reported latency. Some stacks under-report outputLatency (it reads 0
  // on wired output even when the real buffer is larger), leaving the
  // spectrum ahead of the sound; this lets the user dial that out. Set
  // from the "Spectrum delay" tweak via setVizDelay.
  let manualVizDelay = 0;

  function outputDelay() {
    const auto = audioCtx ? (audioCtx.baseLatency || 0) + (audioCtx.outputLatency || 0) : 0;
    return auto + manualVizDelay;
  }

  function ensureAnalyser() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
    const source = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    // Defaults are min=-100 dB / max=-30 dB. Most music sits at -20 to
    // -5 dB peak in the bass band, so the lowest bins clip to 255 and
    // the visualizer shows the bottom 4-5 bars permanently at 100%.
    // Shift the headroom up so peaks still fit; keep the same 70 dB
    // dynamic range so the upper bars stay readable.
    analyser.minDecibels = -85;
    analyser.maxDecibels = -15;
    freqLine = makeDelayLine(analyser.frequencyBinCount);
    waveLine = makeDelayLine(analyser.fftSize);
    // Chain: <audio> -> source -> analyser -> destination. Without
    // routing to destination, audio plays silently (browser cuts the
    // chain). The legacy frontend hit this exact bug — see
    // _app.css / visualizer.js for the original fix.
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  }

  // Monotonic source-load counter. Bumped on every load(); play() reads
  // it to tell whether a newer source superseded the one it started, so
  // a rapid run of station switches doesn't leave a stale play() fighting
  // the latest one. See load()/play() below.
  let loadSeq = 0;

  const listeners = {
    time: new Set(),
    ended: new Set(),
    durationchange: new Set(),
    error: new Set(),
    play: new Set(),
    pause: new Set(),
  };

  // Mirror the element's real play/pause state so the app can treat the
  // <audio> element as the single source of truth — including when it's
  // paused by something other than the transport button (e.g. a video
  // starting playback). The 'play' / 'pause' events fire for every
  // transition, programmatic or not.
  audio.addEventListener("play", () => {
    for (const cb of listeners.play) cb();
  });
  audio.addEventListener("pause", () => {
    for (const cb of listeners.pause) cb();
  });

  // Count rebuffering events (the element fired 'waiting' because it ran
  // out of buffered data) so the stats overlay can show how often the
  // stream has stalled — the audio equivalent of the video buffer story.
  let stallCount = 0;
  audio.addEventListener("waiting", () => { stallCount += 1; });

  audio.addEventListener("timeupdate", () => {
    for (const cb of listeners.time) cb(audio.currentTime);
  });
  audio.addEventListener("ended", () => {
    for (const cb of listeners.ended) cb();
  });
  audio.addEventListener("durationchange", () => {
    if (Number.isFinite(audio.duration)) {
      for (const cb of listeners.durationchange) cb(audio.duration);
    }
  });
  // Error handling has to tolerate the user clicking through stations
  // fast. Each source we skip past can fire a transient error as its
  // load is aborted or its proxy connection is torn down — surfacing
  // those as the "Stream failed" banner made aggressive clicking pop a
  // spurious "not available". So: ignore MEDIA_ERR_ABORTED (an
  // intentional switch), and debounce the rest — only report an error
  // that survives a short settle while still being the latest source and
  // still not playing. A genuinely-dead station thus still surfaces
  // (~700ms later); the ones you clicked past don't.
  let errCheck = null;
  audio.addEventListener("error", () => {
    const err = audio.error;
    if (err && err.code === 1 /* MEDIA_ERR_ABORTED */) return;
    const seq = loadSeq;
    clearTimeout(errCheck);
    errCheck = setTimeout(() => {
      if (seq === loadSeq && audio.error && audio.paused) {
        for (const cb of listeners.error) cb(audio.error);
      }
    }, 700);
  });

  window.MK_AUDIO = {
    load(url) {
      // Setting `audio.src` alone (re)starts resource selection. We
      // deliberately do NOT call `audio.load()`: an explicit load()
      // aborts any in-flight play() with "interrupted by a new load
      // request", and on WebKit (Tauri / Safari) and Electron that
      // leaves the element paused instead of recovering the way
      // Chromium does. That surfaced as radio channels not switching
      // when clicked while playing — you had to pause first. Bumping
      // loadSeq lets play() detect when a newer source supersedes it.
      loadSeq++;
      if (audio.src === url) {
        // Same source re-selected (e.g. replay the current track):
        // assigning an identical src is a no-op and wouldn't restart, so
        // rewind instead. Harmless on live radio (currentTime is pinned
        // to the live edge and just throws, which we swallow).
        try { audio.currentTime = 0; } catch { /* not seekable */ }
      } else {
        audio.src = url;
      }
    },
    async play() {
      ensureAnalyser();
      if (audioCtx && audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch { /* ignore */ }
      }
      const seq = loadSeq;
      try {
        await audio.play();
      } catch (err) {
        // A rapid source switch (clicking through stations) can interrupt
        // this play() with AbortError. If a newer load() has since run, a
        // newer play() owns playback and this one is stale — drop it. If
        // we're still the latest request but the element ended up paused
        // (WebKit doesn't auto-recover like Chromium), nudge it once on
        // the next frame. Other errors (autoplay-gesture policy, decode)
        // still warn.
        if (err && err.name === "AbortError") {
          if (seq === loadSeq && audio.paused) {
            await new Promise((r) => requestAnimationFrame(r));
            try { await audio.play(); } catch (e2) { console.warn("MK_AUDIO.play retry rejected:", e2); }
          }
        } else {
          console.warn("MK_AUDIO.play rejected:", err);
        }
      }
    },
    // Pull an FFT frame for the visualizer, latency-compensated so it
    // matches what's audible now (see makeDelayLine). Returns null if the
    // analyser hasn't been wired yet (no play() call ever happened).
    getFrequencyData() {
      if (!analyser || !freqLine) return null;
      return freqLine((d) => analyser.getByteFrequencyData(d), audioCtx.currentTime, outputDelay());
    },
    // Pull a time-domain (waveform) frame for the oscilloscope, also
    // latency-compensated. Same lifetime rules as getFrequencyData: null
    // until the analyser is wired. Values are 0..255 centered on 128.
    getWaveform() {
      if (!analyser || !waveLine) return null;
      return waveLine((d) => analyser.getByteTimeDomainData(d), audioCtx.currentTime, outputDelay());
    },
    pause() { audio.pause(); },
    // Snapshot of the <audio> element's delivery health for the stats
    // overlay. Audio is served as a single ranged file (no per-segment
    // transcode pipeline like video), so everything the panel needs comes
    // straight off the element: how far the buffer runs ahead of the
    // playhead, the ready/network state machine, and the stall count.
    getStats() {
      let bufferedEnd = 0;
      try {
        if (audio.buffered && audio.buffered.length > 0) {
          bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
        }
      } catch (_e) { /* buffered can throw in transient states */ }
      return {
        bufferAhead: Math.max(0, bufferedEnd - audio.currentTime),
        currentTime: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : null,
        readyState: audio.readyState,    // 0 nothing .. 4 enough-data
        networkState: audio.networkState, // 0 empty, 1 idle, 2 loading, 3 no-source
        paused: audio.paused,
        stalls: stallCount,
      };
    },
    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      // Don't crash on streams whose duration we don't know (radio).
      audio.currentTime = seconds;
    },
    setVolume(v) {
      audio.volume = Math.max(0, Math.min(1, v));
    },
    setMuted(b) { audio.muted = !!b; },
    // Manual spectrum-delay offset in seconds (see manualVizDelay). Clamped
    // to a sane range; the delay line only holds ~1.5s of frames.
    setVizDelay(seconds) {
      const s = Number(seconds);
      manualVizDelay = Number.isFinite(s) ? Math.max(0, Math.min(1.2, s)) : 0;
    },
    onTimeUpdate(cb) { listeners.time.add(cb); return () => listeners.time.delete(cb); },
    onEnded(cb) { listeners.ended.add(cb); return () => listeners.ended.delete(cb); },
    onDurationChange(cb) { listeners.durationchange.add(cb); return () => listeners.durationchange.delete(cb); },
    onError(cb) { listeners.error.add(cb); return () => listeners.error.delete(cb); },
    onPlay(cb) { listeners.play.add(cb); return () => listeners.play.delete(cb); },
    onPause(cb) { listeners.pause.add(cb); return () => listeners.pause.delete(cb); },
    get element() { return audio; },
  };
})();
