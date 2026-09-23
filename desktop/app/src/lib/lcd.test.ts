import { describe, expect, test } from 'vitest'

import { LCD_WIDTH, lcdClock, lcdLine, marqueeAt, marqueeSteps, trackCell } from '@/lib/lcd'

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
