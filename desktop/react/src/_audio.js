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

  function outputDelay() {
    if (!audioCtx) return 0;
    return (audioCtx.baseLatency || 0) + (audioCtx.outputLatency || 0);
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

  const listeners = {
    time: new Set(),
    ended: new Set(),
    durationchange: new Set(),
    error: new Set(),
  };

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
  audio.addEventListener("error", () => {
    for (const cb of listeners.error) cb(audio.error);
  });

  window.MK_AUDIO = {
    load(url) {
      audio.src = url;
      audio.load();
    },
    async play() {
      ensureAnalyser();
      if (audioCtx && audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch { /* ignore */ }
      }
      try {
        await audio.play();
      } catch (err) {
        // Auto-play with sound is gated by user-gesture policy on first
        // load. The artifact only ever calls play() after a click, so
        // this should not fire in practice.
        console.warn("MK_AUDIO.play rejected:", err);
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
    seek(seconds) {
      if (!Number.isFinite(seconds)) return;
      // Don't crash on streams whose duration we don't know (radio).
      audio.currentTime = seconds;
    },
    setVolume(v) {
      audio.volume = Math.max(0, Math.min(1, v));
    },
    setMuted(b) { audio.muted = !!b; },
    onTimeUpdate(cb) { listeners.time.add(cb); return () => listeners.time.delete(cb); },
    onEnded(cb) { listeners.ended.add(cb); return () => listeners.ended.delete(cb); },
    onDurationChange(cb) { listeners.durationchange.add(cb); return () => listeners.durationchange.delete(cb); },
    onError(cb) { listeners.error.add(cb); return () => listeners.error.delete(cb); },
    get element() { return audio; },
  };
})();
