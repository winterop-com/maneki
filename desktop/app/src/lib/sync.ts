/**
 * Keeping the spectrum in time with what is coming out of the speakers.
 *
 * THE ANALYSER TAPS THE GRAPH BEFORE THE OUTPUT DOES. A frame read off the analyser describes
 * audio that has not been played yet: it still has the graph's own buffer and the device's
 * buffer to cross. Over a cable that is a few milliseconds and nobody could see it. Over
 * Bluetooth it is anywhere between 150 and 500, and what somebody sees is a spectrum running
 * ahead of the music -- the bass drops and the bars have already moved.
 *
 * SO THE SPECTRUM IS DRAWN LATE. sokkel-ui's SoundVisualizer holds its frames back by what the
 * browser reports (`delay="auto"`) plus the offset kept here.
 *
 * AND SOME OF IT HAS TO BE DIALLED IN BY HAND. `outputLatency` reads 0 on stacks that plainly
 * have a buffer, so what the browser admits to is a floor rather than the answer, and the
 * setting is added on top of it.
 */

import { createStore } from '@winterop-com/sokkel-ui/lib/stored'

/** The most somebody can ask for by hand, in milliseconds. Past this is not a latency. */
export const SPECTRUM_DELAY_MAX_MS = 1000

/** Where the hand-dialled offset is kept between visits. */
export const SPECTRUM_DELAY_KEY = 'maneki.spectrum.delay'

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
