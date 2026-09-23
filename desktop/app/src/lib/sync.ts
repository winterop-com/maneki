/**
 * Keeping the spectrum in time with what is coming out of the speakers.
 *
 * THE ANALYSER TAPS THE GRAPH BEFORE THE OUTPUT DOES. A frame read off the analyser describes
 * audio that has not been played yet: it still has the graph's own buffer and the device's
 * buffer to cross. Over a cable that is a few milliseconds and nobody could see it. Over
 * Bluetooth it is anywhere between 150 and 500, and what somebody sees is a spectrum running
 * ahead of the music -- the bass drops and the bars have already moved.
 *
 * SO THE FRAMES ARE HELD AND READ BACK LATE. A ring of recent frames, each stamped with the
 * graph's own clock, and what gets drawn is the one from as long ago as the output is behind.
 * Stamped by the clock rather than counted in frames, because a draw loop that misses frames --
 * a background tab, a busy page -- would otherwise read back the wrong amount of time.
 *
 * AND SOME OF IT HAS TO BE DIALLED IN BY HAND. `outputLatency` reads 0 on stacks that plainly
 * have a buffer, so what the browser admits to is a floor rather than the answer, and the
 * setting is added on top of it.
 */

import { createStore } from '@/lib/store'

/** How many frames are held. About a second and a half at sixty a second, which is the ceiling. */
export const DELAY_SLOTS = 96

/** The most somebody can ask for by hand, in milliseconds. Past this is not a latency. */
export const SPECTRUM_DELAY_MAX_MS = 1000

/** Below this there is nothing worth holding back: the freshest frame is the honest one. */
export const DELAY_FLOOR_MS = 20

/** Where the hand-dialled offset is kept between visits. */
export const SPECTRUM_DELAY_KEY = 'maneki.spectrum.delay'

/** A ring of recent frames, read back as it was some milliseconds ago. */
export interface DelayLine {
    /** Take a copy of this frame under the clock it was read at. */
    push: (frame: Uint8Array, atMs: number) => void
    /** The frame from `delayMs` ago, or the freshest one when there is no delay worth honouring. */
    read: (delayMs: number) => Uint8Array
}

/**
 * A delay line for frames of `width` bytes.
 *
 * It copies rather than holding what it was handed: the caller reads the analyser into one
 * buffer every frame, so a ring of references would be a ring of the same array.
 */
export function makeDelayLine(width: number, slots = DELAY_SLOTS): DelayLine {
    const size = Math.max(1, Math.floor(width))
    const depth = Math.max(1, Math.floor(slots))
    const held = Array.from({ length: depth }, () => new Uint8Array(size))
    const stamps = new Float64Array(depth)
    const nothing = new Uint8Array(size)
    let head = 0
    let count = 0

    return {
        push: (frame, atMs) => {
            head = count === 0 ? 0 : (head + 1) % depth
            held[head].set(frame.length > size ? frame.subarray(0, size) : frame)
            stamps[head] = atMs
            if (count < depth) count += 1
        },
        read: (delayMs) => {
            if (count === 0) return nothing
            const newest = held[head]
            if (!(delayMs > DELAY_FLOOR_MS)) return newest
            const wanted = stamps[head] - delayMs
            // Back from the newest; the first frame old enough is the one that is audible now.
            // A ring not yet deep enough answers with the oldest it holds rather than with
            // nothing, so a delay dialled up mid-track eases in instead of blanking.
            let best = newest
            for (let back = 0; back < count; back += 1) {
                const at = (head - back + depth) % depth
                best = held[at]
                if (stamps[at] <= wanted) break
            }
            return best
        },
    }
}

/** The little of an `AudioContext` this module reads, so the sum has a test. */
export interface OutputLatency {
    baseLatency?: number
    outputLatency?: number
}

/**
 * How far behind the graph the speakers are, in milliseconds, as the browser tells it.
 *
 * Both halves are seconds and either may be missing, nonsense, or absent entirely -- Safari has
 * no `outputLatency` at all -- so each is read for itself and an answer that is not a positive
 * number counts as nothing rather than as a NaN that would poison the sum.
 */
export function outputDelayMs(context: OutputLatency | null | undefined): number {
    if (!context) return 0
    return (seconds(context.baseLatency) + seconds(context.outputLatency)) * 1000
}

function seconds(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** What a delay somebody typed or dragged is worth: milliseconds, inside the bounds. */
export function clampDelayMs(ms: number): number {
    if (!Number.isFinite(ms)) return 0
    return Math.min(SPECTRUM_DELAY_MAX_MS, Math.max(0, Math.round(ms)))
}

function readDelay(): number {
    try {
        const stored = localStorage.getItem(SPECTRUM_DELAY_KEY)
        return stored === null ? 0 : clampDelayMs(Number(stored))
    } catch {
        return 0
    }
}

/** What somebody added on top of what the browser admits to. */
export const spectrumDelayMs = createStore(readDelay())

export function setSpectrumDelay(ms: number): void {
    const held = clampDelayMs(ms)
    try {
        localStorage.setItem(SPECTRUM_DELAY_KEY, String(held))
    } catch {
        // Storage denied: the offset holds for as long as this document is open.
    }
    spectrumDelayMs.set(held)
}
