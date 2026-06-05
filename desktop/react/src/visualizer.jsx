// Canvas-driven FFT visualizer. We don't have a real audio source in the
// prototype, but the brief requires this to be Canvas-driven; this synthesises
// a band-shaped spectrum that *moves* like a real FFT (low-freq dominant,
// noise-modulated peaks, smoothed falloff) so it reads as believable.
//
// Styles supported:
//   "bars"      classic vertical bars (current Maneki look)
//   "mirror"    bars mirrored above/below a centerline
//   "ridge"     smooth gradient-filled spectrum curve (flowing bars)
//   "scope"     oscilloscope trace of the live audio waveform

const { useEffect: useEff_viz, useRef: useRef_viz } = React;

function Visualizer({ style = "bars", running = true, accent, height, ambient = false, dense = true }) {
  const canvasRef = useRef_viz(null);
  const stateRef = useRef_viz({ bins: null, raf: 0, t: 0 });

  useEff_viz(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    // Denser bin counts -> slimmer columns at the same tight spacing. Doubled
    // from the original 48/32 so the bars read thin while still nearly
    // touching and spanning the full panel width.
    const N_BINS = dense ? 96 : 64;
    if (!stateRef.current.bins || stateRef.current.bins.length !== N_BINS) {
      stateRef.current.bins = new Float32Array(N_BINS);
    }
    const bins = stateRef.current.bins;

    // Memoised gradients keyed by geometry; see vGrad and drawRidge.
    // Cleared on resize because the canvas height feeds the bar gradients.
    const gradCache = new Map();

    function resize() {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      gradCache.clear();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // Run at up to 60 fps for a fluid spectrum. The per-frame paint cost
    // (the dominant CPU cost on WKWebView) is kept down by memoising the
    // bar gradients instead of allocating one per bar per frame -- see
    // vGrad -- so 60 fps costs roughly what the old 30 fps cap did before
    // gradients were cached.
    const FRAME_INTERVAL_MS = 1000 / 60;
    let lastDrawAt = 0;
    // Smoothed amplitude envelope for the "scope" style. Driven by the
    // waveform RMS while playing; decays toward 0 when paused so the
    // trace settles to a flat line instead of snapping.
    let scopeEnv = 0;
    // When idle (paused AND all bars decayed near zero) skip drawing
    // entirely. The bins are already at floor, so re-clearing and
    // re-painting empty bars just burns the GPU process.
    const IDLE_BIN_THRESHOLD = 0.005;

    function step(now) {
      stateRef.current.raf = requestAnimationFrame(step);
      if (now - lastDrawAt < FRAME_INTERVAL_MS) return;
      lastDrawAt = now;
      stateRef.current.t += 1;
      const t = stateRef.current.t;

      // Oscilloscope: plot the live time-domain waveform. Self-contained
      // (own clear + draw + return) so it skips all the FFT-bin work the
      // bar styles do. Falls back to a synthesised sine when no track has
      // played yet or while paused.
      if (style === "scope") {
        const wave = running && window.MK_AUDIO?.getWaveform?.();
        let target = 0;
        if (wave && wave.length) {
          let sum = 0;
          for (let i = 0; i < wave.length; i++) {
            const d = (wave[i] - 128) / 128;
            sum += d * d;
          }
          target = Math.min(1, Math.sqrt(sum / wave.length) * 2.2);
        }
        // Fast attack, slow release -- transients read crisply, decay is gentle.
        scopeEnv += (target - scopeEnv) * (target > scopeEnv ? 0.4 : 0.05);
        // Idle: paused and the trace has settled flat -- nothing to paint.
        if (!running && scopeEnv < 0.003) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawScope(ctx, wave, canvas.width, canvas.height, accent, t, scopeEnv, running, gradCache);
        return;
      }

      // WIRED: prefer real FFT data from the audio element when the
      // wiring layer has wired up an AnalyserNode (see _audio.js).
      // Falls through to the synthesised spectrum below if the
      // analyser isn't ready (no track played yet) or the source isn't
      // running.
      const real = running && window.MK_AUDIO?.getFrequencyData?.();
      if (real && real.length) {
        // Downsample the analyser's bins to N_BINS. The analyser
        // produces frequencyBinCount values across 0..nyquist; we map
        // them onto our 32 / 48 visual bins via a log-ish curve so
        // bass takes up more visual space (matches how the eye
        // perceives spectra).
        for (let i = 0; i < N_BINS; i++) {
          const lo = Math.floor(Math.pow(i / N_BINS, 1.7) * real.length);
          const hi = Math.floor(Math.pow((i + 1) / N_BINS, 1.7) * real.length);
          let sum = 0;
          let count = 0;
          for (let k = lo; k < Math.max(lo + 1, hi); k++) {
            sum += real[k];
            count++;
          }
          const avg = count > 0 ? sum / count / 255 : 0;
          // Gentle tilt against low-frequency dominance: music is
          // bass-heavy, so without this the left bars saturate and the
          // right ones look anaemic. 0.75 at bin 0, 1.0 at the top.
          const tilt = 0.75 + 0.25 * (i / (N_BINS - 1));
          const target = Math.min(1, avg * tilt);
          const cur = bins[i];
          const ek = target > cur ? 0.5 : 0.18;
          bins[i] = cur + (target - cur) * ek;
        }
      } else {
        // Synthesised spectrum — original artifact behaviour. Used
        // before any track has played AND while paused (so the bars
        // decay gracefully instead of snapping to zero).
        for (let i = 0; i < N_BINS; i++) {
          const x = i / N_BINS;
          const env = Math.pow(1 - x, 1.25) * 0.85 + 0.15;
          const lfo = 0.55 + 0.45 * Math.sin(t * 0.04 + i * 0.6);
          const jitter = 0.7 + 0.3 * Math.sin(t * (0.11 + i * 0.013) + i);
          const peak = Math.random() < 0.02 ? 1.4 : 1;
          let target = env * lfo * jitter * peak;
          if (!running) target = bins[i] * 0.92;
          const cur = bins[i];
          const k = target > cur ? 0.45 : 0.12;
          bins[i] = cur + (target - cur) * k;
        }
      }

      // Skip the entire draw when the source is paused AND every bin
      // has decayed below the visibility floor. clearRect + zero-height
      // bars are invisible but still cost canvas ops; this is the cheap
      // idle-screen path.
      if (!running) {
        let allIdle = true;
        for (let i = 0; i < N_BINS; i++) {
          if (bins[i] > IDLE_BIN_THRESHOLD) { allIdle = false; break; }
        }
        if (allIdle) return;
      }

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (style === "mirror") drawMirror(ctx, bins, w, h, accent, running, ambient, gradCache);
      else if (style === "ridge") drawRidge(ctx, bins, w, h, accent, running, ambient, gradCache);
      else drawBars(ctx, bins, w, h, accent, running, ambient, gradCache);
    }
    stateRef.current.raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(stateRef.current.raf);
      ro.disconnect();
    };
  }, [style, running, accent, dense, ambient]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: height ? `${height}px` : "100%", display: "block" }}
    />
  );
}

// Vertical gradient, memoised by integer pixel span. A vertical gradient
// is x-invariant and the canvas height is fixed between resizes, so a bar
// gradient is a pure function of its span endpoints (y0, y1) -- which are
// in turn driven by the bar height. Keying by rounded px height keeps the
// cache bounded by the canvas height and avoids allocating one gradient
// per bar per frame. Rounding to 1px is sub-perceptual. green -> amber ->
// rose top-down (matches the current MK look). Cache is cleared on resize.
function vGrad(cache, ctx, key, y0, y1, accent) {
  let g = cache.get(key);
  if (g) return g;
  g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, accent.hi || "#f08aa6");
  g.addColorStop(0.55, accent.mid || "#e6c065");
  g.addColorStop(1, accent.lo || "#bcd47a");
  cache.set(key, g);
  return g;
}

function drawBars(ctx, bins, w, h, accent, running, ambient, cache) {
  const N = bins.length;
  // Tight spacing: gap is ~18% of a slot, so bars nearly touch. Slimness
  // comes from the bar *count* (see N_BINS), not from widening the gap.
  const gap = Math.max(2, Math.floor(w / N * 0.18));
  const bw = (w - gap * (N - 1)) / N;
  const baseAlpha = ambient ? 0.45 : 1;
  for (let i = 0; i < N; i++) {
    const v = Math.min(1, bins[i]);
    const bh = v * (h - 8);
    const x = i * (bw + gap);
    const y = h - bh;
    const bhr = bh | 0;
    ctx.fillStyle = vGrad(cache, ctx, "b" + bhr, h - bhr, h, accent);
    ctx.globalAlpha = baseAlpha * (running ? 1 : 0.7);
    roundRect(ctx, x, y, bw, bh, Math.min(bw / 3, 4));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawMirror(ctx, bins, w, h, accent, running, ambient, cache) {
  const N = bins.length;
  const gap = Math.max(2, Math.floor(w / N * 0.18));
  const bw = (w - gap * (N - 1)) / N;
  const cy = h / 2;
  const baseAlpha = ambient ? 0.4 : 1;
  for (let i = 0; i < N; i++) {
    const v = Math.min(1, bins[i]);
    const bh = v * (h / 2 - 4);
    const x = i * (bw + gap);
    const bhr = bh | 0;
    ctx.globalAlpha = baseAlpha * (running ? 1 : 0.7);
    ctx.fillStyle = vGrad(cache, ctx, "m" + bhr, cy - bhr, cy + bhr, accent);
    roundRect(ctx, x, cy - bh, bw, bh * 2, Math.min(bw / 3, 4));
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Smooth gradient-filled spectrum curve. Same bins as drawBars, but the
// tops are joined into a flowing ridge with the area beneath filled by the
// shared vertical gradient (memoised once, cleared on resize). Reads as the
// bars melted into a single continuous line.
function drawRidge(ctx, bins, w, h, accent, running, ambient, cache) {
  const N = bins.length;
  const base = h - 2;
  // Sample tops first so the smoothing pass can read neighbours.
  const xs = new Float32Array(N);
  const ys = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    xs[i] = (i / (N - 1)) * w;
    ys[i] = base - Math.min(1, bins[i]) * (h - 8);
  }
  let g = cache.get("ridge");
  if (!g) {
    g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, accent.hi || "#f08aa6");
    g.addColorStop(0.55, accent.mid || "#e6c065");
    g.addColorStop(1, accent.lo || "#bcd47a");
    cache.set("ridge", g);
  }
  ctx.globalAlpha = (ambient ? 0.5 : 1) * (running ? 1 : 0.7);
  ctx.beginPath();
  ctx.moveTo(0, base);
  ctx.lineTo(xs[0], ys[0]);
  // Quadratic segments through the midpoints give a smooth curve without
  // overshoot (Catmull-Rom would ring on sharp spectral spikes).
  for (let i = 0; i < N - 1; i++) {
    const mx = (xs[i] + xs[i + 1]) / 2;
    const my = (ys[i] + ys[i + 1]) / 2;
    ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
  }
  ctx.lineTo(xs[N - 1], ys[N - 1]);
  ctx.lineTo(w, base);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r) {
  if (h < r * 2) r = h / 2;
  if (w < r * 2) r = w / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Oscilloscope trace. With a real waveform it plots the time-domain
// samples directly (the genuine "sine" you'd see on a scope); without one
// it synthesises a flowing sine whose amplitude follows `env` (so it
// decays to flat when paused and holds a steady base while playing before
// the analyser is ready). The stroke uses a horizontal lo->mid->hi
// gradient, memoised in the shared cache (cleared on resize).
function drawScope(ctx, wave, w, h, accent, t, env, running, cache) {
  const mid = h / 2;
  const amp = h / 2 - Math.max(4, h * 0.06);
  let g = cache.get("scope");
  if (!g) {
    g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, accent.lo || "#bcd47a");
    g.addColorStop(0.5, accent.mid || "#e6c065");
    g.addColorStop(1, accent.hi || "#f08aa6");
    cache.set("scope", g);
  }
  ctx.strokeStyle = g;
  ctx.lineWidth = Math.max(1.5, h * 0.012);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  if (wave && wave.length) {
    const N = wave.length;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * w;
      const y = mid - ((wave[i] - 128) / 128) * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  } else {
    // Synthesised sine. Hold a visible base amplitude while running (the
    // analyser may not be wired on the very first frames); otherwise ride
    // the decaying envelope.
    const a = running ? Math.max(env, 0.32) : env;
    const N = 96;
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * w;
      const phase = (i / N) * Math.PI * 4 + t * 0.08;
      const wobble = 0.6 + 0.4 * Math.sin(t * 0.03 + i * 0.2);
      const y = mid - Math.sin(phase) * amp * a * wobble;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

window.MK_Visualizer = Visualizer;
