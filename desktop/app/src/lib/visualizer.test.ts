import { describe, expect, test } from 'vitest'

import { bars, BAND_COUNT } from '@/lib/visualizer'

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
