import { describe, expect, test } from 'vitest'

import {
    bars,
    BAND_COUNT,
    barLayout,
    isFlat,
    isIdle,
    nextStyle,
    ridgePoints,
    scopePoints,
    VISUALIZER_STYLE_LABELS,
    VISUALIZER_STYLES,
    type VisualizerStyle,
} from '@/lib/visualizer'

/** A spread of bins, every one at the same level. */
function flat(level: number, bins = 128): Uint8Array {
    return new Uint8Array(bins).fill(level)
}

describe('one frame of the spectrum', () => {
    test('gives one height per band, whatever the analyser handed over', () => {
        expect(bars(flat(0), 32)).toHaveLength(32)
        expect(bars(flat(0, 1024), 8)).toHaveLength(8)
        expect(bars(flat(0))).toHaveLength(BAND_COUNT)
    })

    test('reads as a fraction of full scale, so the canvas needs no scale of its own', () => {
        expect(bars(flat(255), 8).every((height) => height === 1)).toBe(true)
        expect(bars(flat(0), 8).every((height) => height === 0)).toBe(true)
        const half = bars(flat(128), 8)
        expect(half.every((height) => height > 0.49 && height < 0.51)).toBe(true)
    })

    test('silence is a flat row rather than a special case the canvas has to know about', () => {
        expect(bars(flat(0), 4)).toEqual([0, 0, 0, 0])
    })

    test('gives the low end the bars, because that is where the music is', () => {
        // Only the lowest eighth of the bins carries anything: on a linear reading that would
        // light one or two bands, and on this curve it lights most of the low half.
        const bins = new Uint8Array(256)
        bins.fill(255, 0, 32)
        const heights = bars(bins, 16)
        const low = heights.slice(0, 8).filter((height) => height > 0).length
        expect(low).toBeGreaterThan(4)
        expect(heights.at(-1)).toBe(0)
    })

    test('averages the bins a band covers rather than taking their peak, so it does not flicker', () => {
        const bins = new Uint8Array(256)
        // One loud bin in the top band, which covers many: a peak reading would answer 1.
        bins[255] = 255
        const heights = bars(bins, 8)
        expect(heights.at(-1)).toBeGreaterThan(0)
        expect(heights.at(-1)).toBeLessThan(0.2)
    })

    test('an analyser with nothing in it, or no bands asked for, is no bars', () => {
        expect(bars(new Uint8Array(0), 8)).toEqual([])
        expect(bars(flat(255), 0)).toEqual([])
    })

    test('never gives a band no bins, however many bands are asked for', () => {
        expect(bars(flat(255, 16), 64).every((height) => Number.isFinite(height))).toBe(true)
    })
})

describe('which drawing the spectrum is', () => {
    test('cycles through every style and wraps, so pressing it enough times comes home', () => {
        const seen: VisualizerStyle[] = []
        let style: VisualizerStyle = 'bars'
        for (let step = 0; step < VISUALIZER_STYLES.length; step += 1) {
            style = nextStyle(style)
            seen.push(style)
        }
        expect(new Set(seen).size).toBe(VISUALIZER_STYLES.length)
        expect(style).toBe('bars')
    })

    test('names every style, because the control is a row of words rather than glyphs', () => {
        for (const style of VISUALIZER_STYLES) expect(VISUALIZER_STYLE_LABELS[style]).toBeTruthy()
    })
})

describe('where the bars go', () => {
    test('fills the width it was given, gaps and all', () => {
        const { bar, gap } = barLayout(112, 32)
        expect(bar * 32 + gap * 31).toBeCloseTo(112, 5)
    })

    test('keeps two pixels between bars on a strip and opens up across a screen', () => {
        expect(barLayout(112, 32).gap).toBe(2)
        expect(barLayout(1600, 64).gap).toBeGreaterThan(2)
    })

    test('never gives a bar no width, however many are asked for', () => {
        expect(barLayout(112, 200).bar).toBeGreaterThan(0)
    })

    test('no bands is no layout rather than a division by zero', () => {
        expect(barLayout(112, 0)).toEqual({ bar: 0, gap: 0 })
    })
})

describe('the ridge', () => {
    test('runs left to right across the whole width, never doubling back', () => {
        const line = ridgePoints(flat(128), 200, 40, 16)
        expect(line[0].x).toBe(0)
        expect(line.at(-1)!.x).toBeCloseTo(200, 5)
        for (let at = 1; at < line.length; at += 1) {
            expect(line[at].x).toBeGreaterThanOrEqual(line[at - 1].x)
        }
    })

    test('stays inside the box, which is what stops a smoothed curve leaving the canvas', () => {
        // Alternating loud and silent bins is the worst case for a curve through the tops.
        const bins = new Uint8Array(256)
        for (let bin = 0; bin < bins.length; bin += 2) bins[bin] = 255
        for (const point of ridgePoints(bins, 200, 40, 24)) {
            expect(point.y).toBeGreaterThanOrEqual(0)
            expect(point.y).toBeLessThanOrEqual(40)
        }
    })

    test('silence lies along the floor and full scale along the top', () => {
        expect(ridgePoints(flat(0), 200, 40, 8).every((point) => point.y === 40)).toBe(true)
        expect(ridgePoints(flat(255), 200, 40, 8).every((point) => point.y === 0)).toBe(true)
    })

    test('draws through more places than there are bands, which is what smoothing is', () => {
        expect(ridgePoints(flat(128), 200, 40, 8).length).toBeGreaterThan(8)
    })

    test('an analyser with nothing in it, or a box with no room, is no curve', () => {
        expect(ridgePoints(new Uint8Array(0), 200, 40)).toEqual([])
        expect(ridgePoints(flat(128), 0, 40)).toEqual([])
        expect(ridgePoints(flat(128), 200, 0)).toEqual([])
    })
})

describe('the scope', () => {
    test('silence is a flat line through the middle', () => {
        const trace = scopePoints(flat(128, 8), 200, 40)
        expect(trace.every((point) => point.y === 20)).toBe(true)
    })

    test('the top of the wave is the top of the box and the bottom is the bottom', () => {
        expect(scopePoints(flat(255, 4), 200, 40)[0].y).toBeLessThan(1)
        expect(scopePoints(flat(0, 4), 200, 40)[0].y).toBe(40)
    })

    test('plots one place per sample, across the whole width', () => {
        const trace = scopePoints(flat(128, 64), 200, 40)
        expect(trace).toHaveLength(64)
        expect(trace[0].x).toBe(0)
        expect(trace.at(-1)!.x).toBeCloseTo(200, 5)
    })

    test('a waveform nothing handed over, or a box with no room, is no trace', () => {
        expect(scopePoints(new Uint8Array(0), 200, 40)).toEqual([])
        expect(scopePoints(flat(128, 8), 0, 40)).toEqual([])
    })
})

describe('a frame not worth painting', () => {
    test('silence is idle and a note is not', () => {
        expect(isIdle(flat(0))).toBe(true)
        expect(isIdle(flat(200))).toBe(false)
    })

    test('one bin still ringing keeps the canvas painting', () => {
        const bins = flat(0)
        bins[7] = 40
        expect(isIdle(bins)).toBe(false)
    })

    test('the floor is a threshold rather than zero, because an analyser never quite settles', () => {
        expect(isIdle(flat(1))).toBe(true)
        expect(isIdle(flat(1), 0)).toBe(false)
    })

    test('a waveform is idle about the middle rather than about zero', () => {
        expect(isFlat(flat(128))).toBe(true)
        expect(isFlat(flat(0))).toBe(false)
        expect(isFlat(flat(255))).toBe(false)
    })

    test('an analyser with nothing in it is idle rather than a frame to paint', () => {
        expect(isIdle(new Uint8Array(0))).toBe(true)
        expect(isFlat(new Uint8Array(0))).toBe(true)
    })
})
