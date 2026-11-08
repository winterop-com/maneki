import { describe, expect, test } from 'vitest'

import { rowsHeightFor } from '@winterop-com/sokkel-ui-media/MediaBar'
import {
    BAR_SIZE_DEFAULT,
    BAR_SIZE_MAX,
    clampBarSize,
    sizeFromRoom,
    soundLook,
    liveSpectrumReadable,
    nextStyle,
    spectrumReadable,
    type VisualizerStyle,
    VISUALIZER_STYLE_LABELS,
    VISUALIZER_STYLES,
} from '@/lib/visualizer'

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

describe('which drawing the spectrum is', () => {
    test('cycles through every style and wraps, so pressing it enough times comes home', () => {
        const seen: VisualizerStyle[] = []
        let style: VisualizerStyle = 'spectrum'
        for (let step = 0; step < VISUALIZER_STYLES.length; step += 1) {
            style = nextStyle(style)
            seen.push(style)
        }
        expect(new Set(seen).size).toBe(VISUALIZER_STYLES.length)
        expect(style).toBe('spectrum')
    })

    test('names every style, because the control is a row of words rather than glyphs', () => {
        for (const style of VISUALIZER_STYLES) expect(VISUALIZER_STYLE_LABELS[style]).toBeTruthy()
    })
})

describe('how tall the player bar is dragged', () => {
    test('is held under the most the bar may take; the bar itself keeps its one line', () => {
        expect(clampBarSize(9000)).toBe(BAR_SIZE_MAX)
        expect(clampBarSize(140.4)).toBe(140)
    })

    test('a stored nonsense is the bar an undragged one starts at, not a broken bar', () => {
        expect(clampBarSize(Number.NaN)).toBe(BAR_SIZE_DEFAULT)
    })

    test('starts grown, with the cover the client before this one opened with', () => {
        expect(BAR_SIZE_DEFAULT).toBe(rowsHeightFor(158))
    })

    test("carries the old bar's room over as the height that gives the same cover", () => {
        // The old default room of 112 drew the 158 px cover.
        expect(sizeFromRoom(112)).toBe(BAR_SIZE_DEFAULT)
        expect(sizeFromRoom(200)).toBeGreaterThan(BAR_SIZE_DEFAULT)
    })
})

describe('the drawings the library does not name', () => {
    test('Mirror is the bars about the middle', () => {
        expect(soundLook('mirror')).toEqual({ kind: 'spectrum', align: 'center' })
        expect(soundLook('ring')).toEqual({ kind: 'ring', align: 'bottom' })
    })
})
