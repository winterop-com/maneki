import { describe, expect, test } from 'vitest'

import {
    LCD_WIDTH,
    lcdClock,
    lcdLine,
    marqueeAt,
    marqueeSteps,
    trackCell,
    VU_SEGMENTS,
    vuLevels,
    vuSegments,
} from '@/lib/lcd'

describe('the line the display shows', () => {
    test('joins what is playing the way a deck joins it, in capitals', () => {
        expect(lcdLine(['Vespertine', 'Bjork'])).toBe('VESPERTINE  -  BJORK')
    })

    test('drops what nothing answered rather than drawing an empty gap', () => {
        expect(lcdLine(['Hyperballad', undefined, 'Post'])).toBe('HYPERBALLAD  -  POST')
        expect(lcdLine([null, '   ', 'Post'])).toBe('POST')
    })

    test('is empty where nothing is playing, which is what the caller stands in for', () => {
        expect(lcdLine([])).toBe('')
        expect(lcdLine([undefined])).toBe('')
    })
})

describe('the travel across the window', () => {
    test('a line that fits stands still, padded out to the cells it has', () => {
        const line = 'POST'
        expect(marqueeSteps(line)).toBe(0)
        expect(marqueeAt(line, 0)).toHaveLength(LCD_WIDTH)
        expect(marqueeAt(line, 0)).toBe(marqueeAt(line, 17))
        expect(marqueeAt(line, 0).trimEnd()).toBe('POST')
    })

    test('a line that does not fit always fills the window, wherever it has got to', () => {
        const line = 'HYPERBALLAD  -  BJORK  -  POST'
        expect(marqueeSteps(line)).toBe(line.length + 4)
        for (let at = 0; at < marqueeSteps(line) + 5; at += 1) {
            expect(marqueeAt(line, at)).toHaveLength(LCD_WIDTH)
        }
    })

    test('starts at the beginning of the line', () => {
        const line = 'HYPERBALLAD  -  BJORK  -  POST'
        expect(marqueeAt(line, 0)).toBe(line.slice(0, LCD_WIDTH))
    })

    test('moves one cell per step', () => {
        const line = 'HYPERBALLAD  -  BJORK  -  POST'
        expect(marqueeAt(line, 3)).toBe(marqueeAt(line, 2).slice(1) + line[LCD_WIDTH + 2])
    })

    // The last character is followed by the first, not by a wipe.
    test('comes round to where it started', () => {
        const line = 'HYPERBALLAD  -  BJORK  -  POST'
        const cycle = marqueeSteps(line)
        expect(marqueeAt(line, cycle)).toBe(marqueeAt(line, 0))
        expect(marqueeAt(line, cycle * 3 + 7)).toBe(marqueeAt(line, 7))
    })

    test('answers a step nothing sensible produced rather than an empty window', () => {
        const line = 'HYPERBALLAD  -  BJORK  -  POST'
        expect(marqueeAt(line, -1)).toHaveLength(LCD_WIDTH)
        expect(marqueeAt(line, -100)).toHaveLength(LCD_WIDTH)
    })
})

describe('a clock cell', () => {
    test('is padded, so a panel does not twitch as a minute rolls over', () => {
        expect(lcdClock(9)).toBe('00:09')
        expect(lcdClock(222)).toBe('03:42')
        expect(lcdClock(599)).toBe('09:59')
        expect(lcdClock(600)).toBe('10:00')
    })

    test('says the hours where a book has them', () => {
        expect(lcdClock(8045)).toBe('2:14:05')
    })

    test('is a row of dashes for anything nothing answered', () => {
        expect(lcdClock(null)).toBe('--:--')
        expect(lcdClock(undefined)).toBe('--:--')
        expect(lcdClock(Number.NaN)).toBe('--:--')
        expect(lcdClock(-4)).toBe('--:--')
    })

    // A track that has just started is not a track with no length.
    test('draws a real zero as a zero', () => {
        expect(lcdClock(0)).toBe('00:00')
    })
})

describe('the track cell', () => {
    test('is the number, padded into its two cells', () => {
        expect(trackCell(1, false)).toBe('01')
        expect(trackCell(12, false)).toBe('12')
    })

    test('says FM for a station, which has no track to be on', () => {
        expect(trackCell(undefined, true)).toBe('FM')
        expect(trackCell(3, true)).toBe('FM')
    })

    test('is dashes where the file said nothing', () => {
        expect(trackCell(undefined, false)).toBe('--')
        expect(trackCell(0, false)).toBe('--')
    })

    test('does not cut a number to fit the cells it has', () => {
        expect(trackCell(101, false)).toBe('101')
    })
})

/** A spread of bins, every one at the same level. */
function flat(level: number, bins = 128): Uint8Array {
    return new Uint8Array(bins).fill(level)
}

/** A spread with one stretch of bins loud and the rest silent. */
function band(from: number, to: number, level: number, bins = 128): Uint8Array {
    const frame = new Uint8Array(bins)
    frame.fill(level, from, to)
    return frame
}

describe('the meters', () => {
    test('silence rests both needles', () => {
        expect(vuLevels(flat(0))).toEqual({ low: 0, high: 0 })
    })

    test('full scale everywhere pins both, rather than running past the meter', () => {
        expect(vuLevels(flat(255))).toEqual({ low: 1, high: 1 })
    })

    test('reads the bottom of the spectrum on the low meter and the top on the high one', () => {
        const bass = vuLevels(band(0, 32, 255))
        expect(bass.low).toBe(1)
        expect(bass.high).toBe(0)

        const air = vuLevels(band(32, 128, 255))
        expect(air.low).toBe(0)
        expect(air.high).toBe(1)
    })

    test('lifts the high meter, because the top of a mix is never the bottom of it', () => {
        const quiet = vuLevels(band(32, 128, 40))
        expect(quiet.high).toBeGreaterThan(40 / 255)
        expect(quiet.high).toBeLessThanOrEqual(1)
    })

    test('answers an analyser with nothing in it rather than dividing by no bins', () => {
        expect(vuLevels(new Uint8Array(0))).toEqual({ low: 0, high: 0 })
        expect(vuLevels(flat(255, 1))).toEqual({ low: 1, high: 0 })
    })

    test('averages a stretch rather than taking the loudest bin in it', () => {
        const spike = new Uint8Array(128)
        spike[3] = 255
        expect(vuLevels(spike).low).toBeLessThan(0.1)
    })
})

describe('what a level lights', () => {
    test('nothing at rest and every segment at full scale', () => {
        expect(vuSegments(0)).toBe(0)
        expect(vuSegments(1)).toBe(VU_SEGMENTS)
    })

    test('lights its share of the meter', () => {
        expect(vuSegments(0.5, 18)).toBe(9)
        expect(vuSegments(0.5, 10)).toBe(5)
    })

    test('leaves the meter dark for a room tone rather than lighting a segment for a track', () => {
        expect(vuSegments(0.01)).toBe(0)
    })

    test('never lights more segments than the meter has', () => {
        expect(vuSegments(4)).toBe(VU_SEGMENTS)
        expect(vuSegments(-1)).toBe(0)
        expect(vuSegments(Number.NaN)).toBe(0)
    })
})
