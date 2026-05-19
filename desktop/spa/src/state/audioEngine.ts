/**
 * Single HTMLAudioElement wrapped in an imperative API + an FFT analyser for
 * the spectrum visualizer. One instance per app, attached to document on first
 * import so the visualizer Web Audio graph survives view changes.
 *
 * The Web Audio graph is constructed lazily on the first play() call because
 * creating an AudioContext before a user gesture leaves it in 'suspended'
 * state on Chromium. Once created we leave it - destroying / recreating per
 * track introduces audible clicks, and `createMediaElementSource` can only
 * be called once per <audio> element anyway.
 */

const audio = document.createElement("audio");
audio.preload = "auto";
audio.crossOrigin = "anonymous";
audio.style.display = "none";
if (typeof document !== "undefined") {
  document.documentElement.appendChild(audio);
}

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
// TS 5.7 distinguishes Uint8Array<ArrayBuffer> from Uint8Array<ArrayBufferLike>;
// AnalyserNode.getByteFrequencyData requires the former.
let freqData: Uint8Array<ArrayBuffer> | null = null;

function ensureAnalyser(): void {
  if (audioCtx !== null) return;
  const Ctx: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctx === undefined) return;
  audioCtx = new Ctx();
  const source = audioCtx.createMediaElementSource(audio);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.78;
  // Defaults are min=-100 dB / max=-30 dB. Most music sits at -20 to -5 dB
  // peak in the bass band, so the lowest bins clip to 255 and the visualizer
  // shows the bottom 4-5 bars permanently at 100%. Shift the headroom up so
  // peaks still fit; keep the same 70 dB dynamic range so upper bars stay
  // readable.
  analyser.minDecibels = -85;
  analyser.maxDecibels = -15;
  freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
}

type TimeCb = (currentTime: number) => void;
type EndedCb = () => void;
type DurationCb = (duration: number) => void;
type ErrorCb = (err: MediaError | null) => void;

const listeners = {
  time: new Set<TimeCb>(),
  ended: new Set<EndedCb>(),
  durationchange: new Set<DurationCb>(),
  error: new Set<ErrorCb>(),
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

export interface AudioEngine {
  load(url: string): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(v: number): void;
  setMuted(b: boolean): void;
  getFrequencyData(): Uint8Array<ArrayBuffer> | null;
  onTimeUpdate(cb: TimeCb): () => void;
  onEnded(cb: EndedCb): () => void;
  onDurationChange(cb: DurationCb): () => void;
  onError(cb: ErrorCb): () => void;
  element: HTMLAudioElement;
}

export const audioEngine: AudioEngine = {
  load(url: string): void {
    audio.src = url;
    audio.load();
  },
  async play(): Promise<void> {
    ensureAnalyser();
    if (audioCtx !== null && audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch {
        // ignore - playback may still work
      }
    }
    try {
      await audio.play();
    } catch (err) {
      // Auto-play with sound is gated by user-gesture policy. The UI only
      // calls play() after a click, so this should not fire in practice.
      console.warn("audioEngine.play rejected:", err);
    }
  },
  pause(): void {
    audio.pause();
  },
  seek(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    audio.currentTime = seconds;
  },
  setVolume(v: number): void {
    audio.volume = Math.max(0, Math.min(1, v));
  },
  setMuted(b: boolean): void {
    audio.muted = b;
  },
  getFrequencyData(): Uint8Array<ArrayBuffer> | null {
    if (analyser === null || freqData === null) return null;
    analyser.getByteFrequencyData(freqData);
    return freqData;
  },
  onTimeUpdate(cb: TimeCb): () => void {
    listeners.time.add(cb);
    return () => listeners.time.delete(cb);
  },
  onEnded(cb: EndedCb): () => void {
    listeners.ended.add(cb);
    return () => listeners.ended.delete(cb);
  },
  onDurationChange(cb: DurationCb): () => void {
    listeners.durationchange.add(cb);
    return () => listeners.durationchange.delete(cb);
  },
  onError(cb: ErrorCb): () => void {
    listeners.error.add(cb);
    return () => listeners.error.delete(cb);
  },
  element: audio,
};
