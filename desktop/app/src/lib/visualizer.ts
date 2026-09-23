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
 *
 * FOUR DRAWINGS OF THE SAME FRAME. Bars and mirror are the same heights stood on the floor or
 * about the middle; ridge is those tops joined into a curve; scope leaves the spectrum alone and
 * plots the waveform itself. Each is a function from what the analyser handed over to geometry,
 * so the canvas is a loop over points and the shape of the thing has tests.
 */

import { createStore } from '@/lib/store'

/** Where the choice is kept between visits. */
export const VISUALIZER_KEY = 'maneki.visualizer'

/** Where the drawing is kept between visits. */
export const VISUALIZER_STYLE_KEY = 'maneki.visualizer.style'

/** How many bars are drawn. Enough to read as a spectrum, few enough to stay bars. */
export const BAND_COUNT = 32

/** Which drawing the spectrum is. */
export type VisualizerStyle = 'bars' | 'mirror' | 'ridge' | 'scope'

/** The drawings, in the order the control lays them out and the cycle steps through them. */
export const VISUALIZER_STYLES: readonly VisualizerStyle[] = ['bars', 'mirror', 'ridge', 'scope']

/** What each drawing is called. One word each, because the control is a row of four. */
export const VISUALIZER_STYLE_LABELS: Record<VisualizerStyle, string> = {
    bars: 'Bars',
    mirror: 'Mirror',
    ridge: 'Ridge',
    scope: 'Scope',
}

/** The drawing a fresh browser gets: the one the bar has always had. */
export const DEFAULT_STYLE: VisualizerStyle = 'bars'

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

/** Whether a string names a drawing this build has. */
export function isVisualizerStyle(candidate: string | null): candidate is VisualizerStyle {
    return candidate !== null && (VISUALIZER_STYLES as readonly string[]).includes(candidate)
}

function readStyle(): VisualizerStyle {
    try {
        const stored = localStorage.getItem(VISUALIZER_STYLE_KEY)
        return isVisualizerStyle(stored) ? stored : DEFAULT_STYLE
    } catch {
        return DEFAULT_STYLE
    }
}

/** Which drawing both canvases paint. Kept between visits, like whether the strip is drawn. */
export const visualizerStyle = createStore<VisualizerStyle>(readStyle())

export function setVisualizerStyle(style: VisualizerStyle): void {
    try {
        localStorage.setItem(VISUALIZER_STYLE_KEY, style)
    } catch {
        // Storage denied: the choice holds for as long as this document is open.
    }
    visualizerStyle.set(style)
}

/** The drawing after this one, wrapping at the end. A pure step, so the cycle has a test. */
export function nextStyle(current: VisualizerStyle): VisualizerStyle {
    const at = VISUALIZER_STYLES.indexOf(current)
    return VISUALIZER_STYLES[(at + 1) % VISUALIZER_STYLES.length]
}

/** Step to the next drawing and answer what it is, for the control and the palette row. */
export function cycleVisualizerStyle(): VisualizerStyle {
    const wanted = nextStyle(visualizerStyle.get())
    setVisualizerStyle(wanted)
    return wanted
}

/** Where the height of the panel's spectrum pane is kept between visits. */
export const SPECTRUM_HEIGHT_KEY = 'maneki.spectrumHeight'

/** Shorter than this is a strip saying sound is coming out, which the player bar already is. */
export const SPECTRUM_MIN_HEIGHT = 72

/** Taller than this and the cover and the words above it are off the top of the panel. */
export const SPECTRUM_MAX_HEIGHT = 420

/** What the client this is restored from opened at. */
export const SPECTRUM_DEFAULT_HEIGHT = 132

/** Hold a dragged height inside what the panel can actually draw. */
export function clampSpectrumHeight(height: number): number {
    return Math.min(SPECTRUM_MAX_HEIGHT, Math.max(SPECTRUM_MIN_HEIGHT, Math.round(height)))
}

function readHeight(): number {
    try {
        const stored = Number(localStorage.getItem(SPECTRUM_HEIGHT_KEY))
        return Number.isFinite(stored) && stored > 0 ? clampSpectrumHeight(stored) : SPECTRUM_DEFAULT_HEIGHT
    } catch {
        return SPECTRUM_DEFAULT_HEIGHT
    }
}

/**
 * How tall the panel's spectrum pane is.
 *
 * PX-INTENT, the way every dragged edge in this shell is kept -- see `lib/panels`. What
 * somebody dragged this to was a decision about how much of the panel the spectrum is worth
 * beside the cover, and a fraction would re-decide it every time the window changed height.
 * Read out of storage as the store is built, so the pane opens at its settled size rather than
 * snapping into it on the first paint.
 */
export const spectrumHeight = createStore(readHeight())

export function setSpectrumHeight(height: number): void {
    const held = clampSpectrumHeight(height)
    try {
        localStorage.setItem(SPECTRUM_HEIGHT_KEY, String(held))
    } catch {
        // Storage denied: the height holds for as long as this document is open.
    }
    spectrumHeight.set(held)
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

/** A place on the canvas, in the units the canvas is set up in. */
export interface Point {
    x: number
    y: number
}

/** How wide a bar is and how far the next one is, for a canvas of this width. */
export interface BarLayout {
    bar: number
    gap: number
}

/**
 * Where the bars go across a given width.
 *
 * THE GAP IS A SHARE OF THE SLOT RATHER THAN A NUMBER OF PIXELS. Two pixels between bars is
 * right on a 112px strip and invisible across a whole screen, so the gap is a fifth of what one
 * band was given, with two pixels as the floor -- which is what the strip lands on anyway. Bars
 * are made slim by there being many of them, never by widening the gap.
 */
export function barLayout(width: number, count: number): BarLayout {
    if (count <= 0) return { bar: 0, gap: 0 }
    const gap = Math.max(2, Math.floor((width / count) * 0.18))
    return { bar: Math.max(1, (width - gap * (count - 1)) / count), gap }
}

/** How many places each smoothed segment of the ridge is drawn through. */
const RIDGE_STEPS = 4

/**
 * The band tops as one flowing curve, in canvas units.
 *
 * THE BARS MELTED INTO A LINE. The same heights the bars are drawn from, joined through the
 * midpoints between neighbours: a quadratic through a midpoint cannot overshoot the band either
 * side of it, which a Catmull-Rom spline through the tops themselves does -- and an overshoot on
 * a spectral spike is a curve that dips below the floor on the way back down.
 *
 * The curve is flattened here rather than handed to the canvas as control points, so what the
 * smoothing actually does is something a test can read. The caller closes the shape down to the
 * floor and fills it.
 */
export function ridgePoints(
    frequencies: Uint8Array,
    width: number,
    height: number,
    bands = BAND_COUNT,
): Point[] {
    const tops = bars(frequencies, bands)
    if (tops.length === 0 || width <= 0 || height <= 0) return []
    const at = (index: number): Point => ({
        x: tops.length === 1 ? width / 2 : (index / (tops.length - 1)) * width,
        y: height - Math.min(1, Math.max(0, tops[index])) * height,
    })
    const first = at(0)
    if (tops.length === 1)
        return [
            { x: 0, y: first.y },
            { x: width, y: first.y },
        ]

    const line: Point[] = [first]
    let from = first
    for (let index = 0; index < tops.length - 1; index += 1) {
        const control = at(index)
        const next = at(index + 1)
        const to = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 }
        for (let step = 1; step <= RIDGE_STEPS; step += 1) {
            line.push(quadratic(from, control, to, step / RIDGE_STEPS))
        }
        from = to
    }
    line.push(at(tops.length - 1))
    return line
}

/** One place along the quadratic from `from` to `to` bending towards `control`. */
function quadratic(from: Point, control: Point, to: Point, t: number): Point {
    const rest = 1 - t
    return {
        x: rest * rest * from.x + 2 * rest * t * control.x + t * t * to.x,
        y: rest * rest * from.y + 2 * rest * t * control.y + t * t * to.y,
    }
}

/**
 * The waveform itself, as a trace about the middle.
 *
 * NOT A SPECTRUM AT ALL. Every other drawing here reads the FFT; this one reads the samples the
 * analyser was handed, where 128 is silence and the distance either side of it is the pressure.
 * It is the one drawing that shows a shape somebody could recognise from an oscilloscope, which
 * is the whole reason it is offered.
 */
export function scopePoints(timeDomain: Uint8Array, width: number, height: number): Point[] {
    if (timeDomain.length === 0 || width <= 0 || height <= 0) return []
    const middle = height / 2
    if (timeDomain.length === 1)
        return [
            { x: 0, y: middle },
            { x: width, y: middle },
        ]
    const points: Point[] = []
    for (let index = 0; index < timeDomain.length; index += 1) {
        const level = (timeDomain[index] - 128) / 128
        points.push({
            x: (index / (timeDomain.length - 1)) * width,
            y: Math.min(height, Math.max(0, middle - level * middle)),
        })
    }
    return points
}

/** How loud a bin may be and still count as nothing, out of 255. */
export const IDLE_LEVEL = 2

/** How far off the middle a sample may be and still count as nothing, out of 128. */
export const FLAT_LEVEL = 2

/**
 * Whether this frame is worth painting at all.
 *
 * A TRACK GAP IS A HUNDRED FRAMES OF NOTHING. The loop keeps its own bookkeeping -- it still
 * asks for the next frame, still reads the analyser, still pushes into the delay line -- but
 * clearing the canvas and drawing a row of bars nobody can see is a paint a laptop pays for
 * every sixtieth of a second while the music is between tracks.
 */
export function isIdle(frequencies: Uint8Array, threshold = IDLE_LEVEL): boolean {
    for (const level of frequencies) {
        if (level > threshold) return false
    }
    return true
}

/** The same question of a waveform, where nothing is the middle rather than the floor. */
export function isFlat(timeDomain: Uint8Array, threshold = FLAT_LEVEL): boolean {
    for (const sample of timeDomain) {
        if (Math.abs(sample - 128) > threshold) return false
    }
    return true
}
