/**
 * Whether the spectrum is drawn, and what one frame of it looks like.
 *
 * THE DECISION IS A STORE AND THE DRAWING IS A PURE FUNCTION. What a component does with an
 * analyser -- 60 frames a second of canvas calls -- cannot be tested, but the part worth
 * getting right can: how a frequency spread of bytes becomes the bars somebody sees. So
 * `bars()` takes the bytes and gives back heights between 0 and 1, and the canvas only paints
 * them.
 *
 * THE LOW END IS WHERE THE MUSIC IS. An FFT spreads its bins linearly over the whole range, so
 * more than half of them are above 10kHz, where almost nothing happens: a linear reading is a
 * wall of bars on the left and a flat line across the rest. The bins are folded into bands that
 * widen as they climb, which is roughly how hearing is spaced and what makes the thing move.
 */

import { createStore } from '@/lib/store'

/** Where the choice is kept between visits. */
export const VISUALIZER_KEY = 'maneki.visualizer'

/** How many bars are drawn. Enough to read as a spectrum, few enough to stay bars. */
export const BAND_COUNT = 32

function readFlag(fallback: boolean): boolean {
    try {
        const stored = localStorage.getItem(VISUALIZER_KEY)
        return stored === null ? fallback : stored === 'true'
    } catch {
        return fallback
    }
}

/**
 * Whether the spectrum is shown.
 *
 * On by default: it is the one thing on the bar that says the sound is actually coming out,
 * and somebody who does not want it turns it off once and it stays off.
 */
export const visualizerShown = createStore(readFlag(true))

export function setVisualizer(shown: boolean): void {
    try {
        localStorage.setItem(VISUALIZER_KEY, String(shown))
    } catch {
        // Storage denied: the choice holds for as long as this document is open.
    }
    visualizerShown.set(shown)
}

export function toggleVisualizer(): void {
    setVisualizer(!visualizerShown.get())
}

/**
 * Whether the spectrum is over the whole screen.
 *
 * NOT KEPT BETWEEN VISITS, unlike whether the strip is drawn. The stage is something somebody
 * puts on for as long as they are looking at it, and an app that opened behind a full-screen
 * canvas because of what happened yesterday is an app somebody has to escape before using.
 */
export const stageOpen = createStore(false)

export function openStage(): void {
    stageOpen.set(true)
}

export function closeStage(): void {
    stageOpen.set(false)
}

export function toggleStage(): void {
    stageOpen.update((open) => !open)
}

/**
 * One frame, as heights between 0 and 1.
 *
 * Each band averages the bins it covers rather than taking their peak: a peak makes every band
 * jump to the loudest bin in it and the whole spectrum flickers, while an average moves the way
 * the music does. Bands are laid out on a curve, so the first few cover a handful of bins each
 * and the last cover hundreds.
 *
 * Silence is all zeroes, and that is a flat row of nothing rather than a special case: a bar of
 * zero height is drawn as the floor.
 */
export function bars(frequencies: Uint8Array, bands = BAND_COUNT): number[] {
    if (frequencies.length === 0 || bands <= 0) return []
    const heights: number[] = []
    for (let band = 0; band < bands; band += 1) {
        const from = edge(band, bands, frequencies.length)
        const to = Math.max(from + 1, edge(band + 1, bands, frequencies.length))
        let total = 0
        for (let bin = from; bin < to; bin += 1) total += frequencies[bin] ?? 0
        heights.push(total / (to - from) / 255)
    }
    return heights
}

/** Where one band starts, on a curve that gives the low end most of the bars. */
function edge(band: number, bands: number, bins: number): number {
    const fraction = band / bands
    return Math.min(bins, Math.floor(bins * fraction ** 2.2))
}
