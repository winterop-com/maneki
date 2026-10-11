import { describe, expect, test } from 'vitest'

import {
    ATTACK,
    BAND_COUNT,
    BAR_ROOM_MIN,
    barLayout,
    bars,
    CEILING,
    clampSpectrumHeight,
    DEFAULT_EFFECT,
    isFlat,
    isIdle,
    liveSpectrumReadable,
    nextStyle,
    RELEASE,
    ridgePoints,
    roomInWindow,
    scopePoints,
    setSpectrumEffect,
    settle,
    SPECTRUM_DEFAULT_HEIGHT,
    SPECTRUM_EFFECT_LABELS,
    SPECTRUM_EFFECTS,
    SPECTRUM_MAX_HEIGHT,
    SPECTRUM_MIN_HEIGHT,
    spectrumEffect,
    spectrumReadable,
    tilt,
    type VisualizerStyle,
    VISUALIZER_STYLE_LABELS,
    VISUALIZER_STYLES,
} from '@/lib/visualizer'

/** A spread of bins, every one at the same level. */
function flat(level: number, bins = 128): Uint8Array {
    return new Uint8Array(bins).fill(level)
}

describe('whether a station can be heard by the spectrum', () => {
    const safari =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
    const tauri = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
    const iphoneChrome =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1'
    const chrome =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
    const electron =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) maneki/0.22.0 Chrome/150.0.0.0 Electron/40.0.0 Safari/537.36'
    const android =
        'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'
    const firefox = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:150.0) Gecko/20100101 Firefox/150.0'

    test('WebKit -- Safari, the macOS app, anything on an iPhone -- reads silence off a station', () => {
        expect(liveSpectrumReadable(safari)).toBe(false)
        expect(liveSpectrumReadable(tauri)).toBe(false)
        expect(liveSpectrumReadable(iphoneChrome)).toBe(false)
    })

    test('Chromium and Gecko read a station like anything else', () => {
        expect(liveSpectrumReadable(chrome)).toBe(true)
        expect(liveSpectrumReadable(electron)).toBe(true)
        expect(liveSpectrumReadable(android)).toBe(true)
        expect(liveSpectrumReadable(firefox)).toBe(true)
        expect(
            liveSpectrumReadable(
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36',
            ),
        ).toBe(true)
    })

    test('a track always has a spectrum; a station only where it can be heard', () => {
        expect(spectrumReadable(false, false)).toBe(true)
        expect(spectrumReadable(true, true)).toBe(true)
        expect(spectrumReadable(true, false)).toBe(false)
    })

    test('a station played with no relay has none, on any engine', () => {
        // Radio-only plays the station's own address without crossOrigin, so the analyser
        // hears nothing even in Chromium: the band stood empty and the stage was black.
        expect(spectrumReadable(true, true, false)).toBe(false)
        expect(spectrumReadable(false, true, false)).toBe(true)
    })
})

describe('one frame of the spectrum', () => {
    test('gives one height per band, whatever the analyser handed over', () => {
        expect(bars(flat(0), 32)).toHaveLength(32)
        expect(bars(flat(0, 1024), 8)).toHaveLength(8)
        expect(bars(flat(0))).toHaveLength(BAND_COUNT)
    })

    test('reads as a fraction of full scale, leaning against the low end', () => {
        // Full scale is 0.75 at the first band and 1 at the last: the tilt that keeps a
        // bass-heavy record from being a wall on the left and stubs on the right.
        const full = bars(flat(255), 8)
        expect(full[0]).toBeCloseTo(0.75)
        expect(full.at(-1)).toBeCloseTo(1)
        expect(bars(flat(0), 8).every((height) => height === 0)).toBe(true)
        const half = bars(flat(128), 8)
        expect(half[0]).toBeCloseTo(0.5 * 0.75, 1)
        expect(half.at(-1)).toBeCloseTo(0.5, 1)
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

    test('stops where the music stops, so the top of the analyser is not a row of stubs', () => {
        // Energy only above the ceiling: nothing an FFT this coarse can show, and no band
        // is laid over it, so the picture stays free for what is audible.
        const bins = new Uint8Array(256)
        bins.fill(255, Math.ceil(256 * CEILING), 256)
        expect(bars(bins, 16).every((height) => height === 0)).toBe(true)
        // Energy just under the ceiling lights the last band rather than being lost.
        const under = new Uint8Array(256)
        under.fill(255, Math.floor(256 * CEILING) - 4, Math.floor(256 * CEILING))
        expect(bars(under, 16).at(-1)).toBeGreaterThan(0)
    })

    test('averages the bins a band covers rather than taking their peak, so it does not flicker', () => {
        const bins = new Uint8Array(256)
        // One loud bin in the top band, which covers many: a peak reading would answer 1.
        bins[Math.floor(256 * CEILING) - 1] = 255
        const heights = bars(bins, 8)
        expect(heights.at(-1)).toBeGreaterThan(0)
        expect(heights.at(-1)).toBeLessThan(0.2)
    })

    test('an analyser with nothing in it, or no bands asked for, is no bars', () => {
        expect(bars(new Uint8Array(0), 8)).toEqual([])
        expect(bars(flat(255), 0)).toEqual([])
    })

    test('more bands than bins is a slope, not a staircase of equal bars', () => {
        // A rising low end across the first few bins, read by more bands than it has bins:
        // taking the one bin a band starts in drew runs of identical neighbours.
        const bins = new Uint8Array(1024)
        for (let bin = 0; bin < 40; bin += 1) bins[bin] = 20 + bin * 5
        // Read with the tilt taken back out: the tilt alone makes copies of one bin differ by a
        // hair, which on screen is still a run of equal bars.
        const low = bars(bins, 192)
            .map((height, band) => height / tilt(band, 192))
            .slice(0, 24)
        expect(low.every((level, at) => at === 0 || level > low[at - 1]! + 1e-9)).toBe(true)
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
        // Full scale leans with the tilt: the last band touches the top, the first sits at 0.75.
        const top = ridgePoints(flat(255), 200, 40, 8)
        expect(top.at(-1)?.y).toBe(0)
        expect(Math.min(...top.map((point) => point.y))).toBe(0)
        expect(Math.max(...top.map((point) => point.y))).toBeLessThanOrEqual(10)
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

describe('how tall the spectrum pane is', () => {
    test('holds a dragged height between a strip and the whole panel', () => {
        expect(clampSpectrumHeight(10)).toBe(SPECTRUM_MIN_HEIGHT)
        expect(clampSpectrumHeight(9000)).toBe(SPECTRUM_MAX_HEIGHT)
        expect(clampSpectrumHeight(SPECTRUM_DEFAULT_HEIGHT)).toBe(SPECTRUM_DEFAULT_HEIGHT)
    })

    test('answers whole pixels, which is what the style it is written to takes', () => {
        expect(clampSpectrumHeight(140.4)).toBe(140)
        expect(clampSpectrumHeight(139.5)).toBe(140)
    })

    test('opens at a height it is allowed to open at', () => {
        expect(SPECTRUM_DEFAULT_HEIGHT).toBeGreaterThanOrEqual(SPECTRUM_MIN_HEIGHT)
        expect(SPECTRUM_DEFAULT_HEIGHT).toBeLessThanOrEqual(SPECTRUM_MAX_HEIGHT)
    })
})

describe('the lean and the envelope', () => {
    test('the tilt runs from three quarters at the first band to full at the last', () => {
        expect(tilt(0, 32)).toBeCloseTo(0.75)
        expect(tilt(31, 32)).toBeCloseTo(1)
        expect(tilt(0, 1)).toBe(1)
    })

    test('a bar rises fast and falls slowly', () => {
        const up = settle([0, 0], [1, 1])
        expect(up[0]).toBeCloseTo(ATTACK)
        const down = settle([1, 1], [0, 0])
        expect(down[0]).toBeCloseTo(1 - RELEASE)
        expect(ATTACK).toBeGreaterThan(RELEASE)
    })

    test('a band that was not there last frame starts from the floor', () => {
        expect(settle([], [1])[0]).toBeCloseTo(ATTACK)
        expect(settle([1, 1, 1], [1])).toHaveLength(1)
    })
})

describe('the effect the stage wears', () => {
    test('starts on nothing, because an effect is a thing somebody adds', () => {
        expect(DEFAULT_EFFECT).toBe('none')
        expect(SPECTRUM_EFFECTS[0]).toBe('none')
        expect(spectrumEffect.get()).toBe('none')
    })

    test('takes a name it knows and answers the plain drawing for one it does not', () => {
        expect(setSpectrumEffect('glow')).toBe('glow')
        expect(spectrumEffect.get()).toBe('glow')
        expect(setSpectrumEffect('lens flare')).toBe('none')
        expect(spectrumEffect.get()).toBe('none')
    })

    test('names every effect, because the control is a list of words', () => {
        for (const effect of SPECTRUM_EFFECTS) expect(SPECTRUM_EFFECT_LABELS[effect]).toBeTruthy()
    })
})

describe('the room a window has for the player bar', () => {
    test('is what was dragged, where the window is tall enough for it', () => {
        expect(roomInWindow(237, 900)).toBe(237)
    })

    test('leaves the whole bar at most two fifths of a short window, so the page keeps the rest', () => {
        // Dragged tall on a desktop and seen in a 500 px window, the page had 33 px; a phone in
        // landscape had its header covered.
        expect(roomInWindow(320, 500)).toBe(153)
        expect(roomInWindow(320, 343)).toBe(90)
        expect(roomInWindow(320, 200)).toBe(BAR_ROOM_MIN)
    })
})
