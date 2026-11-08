import { describe, expect, test } from 'vitest'

import { fromStructured, lyricsOpen, NO_LYRICS, toggleLyrics } from '@/lib/lyrics'

describe('the structured shape', () => {
    test('carries its timings into seconds, which is what a player counts in', () => {
        const words = fromStructured({
            synced: true,
            line: [
                { start: 0, value: 'One' },
                { start: 12_500, value: 'Two' },
            ],
        })
        expect(words.timed).toBe(true)
        expect(words.lines).toEqual([
            { text: 'One', time: 0 },
            { text: 'Two', time: 12.5 },
        ])
    })

    test('keeps the milliseconds and the minutes of a timing', () => {
        const words = fromStructured({ line: [{ start: 61_125, value: 'Late' }] })
        expect(words.lines).toEqual([{ text: 'Late', time: 61.125 }])
    })

    test('is untimed where no line carries a timing, whatever the flag says', () => {
        const words = fromStructured({ synced: true, line: [{ value: 'One' }, { value: 'Two' }] })
        expect(words.timed).toBe(false)
        expect(words.lines.every((line) => line.time === undefined)).toBe(true)
    })

    test('is untimed where every timing is zero, which is a file with its markers stripped', () => {
        const words = fromStructured({
            synced: true,
            line: [
                { start: 0, value: 'One' },
                { start: 0, value: 'Two' },
            ],
        })
        expect(words.timed).toBe(false)
        expect(words.lines.map((line) => line.text)).toEqual(['One', 'Two'])
    })

    test('keeps a blank line, which is what stands between two verses', () => {
        const words = fromStructured({ line: [{ value: 'One' }, {}, { value: 'Two' }] })
        expect(words.lines.map((line) => line.text)).toEqual(['One', '', 'Two'])
    })

    test('is nothing at all for a track the server holds no words for', () => {
        expect(fromStructured(null)).toEqual(NO_LYRICS)
        expect(fromStructured({ synced: false, line: [] })).toEqual(NO_LYRICS)
        expect(fromStructured(undefined)).toEqual(NO_LYRICS)
        expect(NO_LYRICS.lines).toEqual([])
    })
})

describe('whether the words are up', () => {
    test('starts down and answers the key both ways', () => {
        expect(lyricsOpen.get()).toBe(false)
        toggleLyrics()
        expect(lyricsOpen.get()).toBe(true)
        toggleLyrics()
        expect(lyricsOpen.get()).toBe(false)
    })
})
