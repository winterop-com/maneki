import { describe, expect, test } from 'vitest'

import { fromStructured, fromText, lineAt, lyricsOpen, NO_LYRICS, toggleLyrics } from '@/lib/lyrics'

describe('the structured shape', () => {
    test('carries its timings into seconds, which is what a player counts in', () => {
        const words = fromStructured({
            synced: true,
            line: [
                { start: 0, value: 'One' },
                { start: 12_500, value: 'Two' },
            ],
        })
        expect(words.synced).toBe(true)
        expect(words.lines).toEqual([
            { text: 'One', atS: 0 },
            { text: 'Two', atS: 12.5 },
        ])
    })

    test('is unsynced where no line carries a timing, whatever the flag says', () => {
        const words = fromStructured({ synced: true, line: [{ value: 'One' }, { value: 'Two' }] })
        expect(words.synced).toBe(false)
        expect(words.lines.every((line) => line.atS === null)).toBe(true)
    })

    test('is unsynced where every timing is zero, which is a file with its markers stripped', () => {
        const words = fromStructured({
            synced: true,
            line: [
                { start: 0, value: 'One' },
                { start: 0, value: 'Two' },
            ],
        })
        expect(words.synced).toBe(false)
    })

    test('keeps a blank line, which is what stands between two verses', () => {
        const words = fromStructured({ line: [{ value: 'One' }, {}, { value: 'Two' }] })
        expect(words.lines.map((line) => line.text)).toEqual(['One', '', 'Two'])
    })

    test('is nothing at all for a track the server holds no words for', () => {
        expect(fromStructured(null)).toEqual(NO_LYRICS)
        expect(fromStructured({ synced: false, line: [] })).toEqual(NO_LYRICS)
        expect(fromStructured(undefined)).toEqual(NO_LYRICS)
    })
})

describe('LRC text', () => {
    test('reads a marker in every dialect the files in the wild are written in', () => {
        const words = fromText('[00:01]a\n[00:02.5]b\n[00:03.25]c\n[01:00.125]d')
        expect(words.synced).toBe(true)
        expect(words.lines).toEqual([
            { text: 'a', atS: 1 },
            { text: 'b', atS: 2.5 },
            { text: 'c', atS: 3.25 },
            { text: 'd', atS: 60.125 },
        ])
    })

    test('drops the headers, which look like markers and are not', () => {
        const words = fromText('[ar: Oasis]\n[length: 03:42]\n[00:01.00]Slowly walking down the hall')
        expect(words.lines.map((line) => line.text)).toEqual(['Slowly walking down the hall'])
    })

    test('makes a line per marker where a line carries several, and sings them in order', () => {
        const words = fromText('[00:20.00][01:10.00]the chorus\n[00:50.00]a verse')
        expect(words.lines).toEqual([
            { text: 'the chorus', atS: 20 },
            { text: 'a verse', atS: 50 },
            { text: 'the chorus', atS: 70 },
        ])
    })

    test('leaves a marker inside a lyric alone, being part of the words rather than a time', () => {
        const words = fromText('[00:01.00]and then [00:02.00] happened')
        expect(words.lines).toEqual([{ text: 'and then [00:02.00] happened', atS: 1 }])
    })

    test('reads plain text as a page rather than as something to follow', () => {
        const words = fromText('One\n\nTwo')
        expect(words.synced).toBe(false)
        expect(words.lines).toEqual([
            { text: 'One', atS: null },
            { text: '', atS: null },
            { text: 'Two', atS: null },
        ])
    })

    test('is nothing at all for a body that is empty or only whitespace', () => {
        expect(fromText('')).toEqual(NO_LYRICS)
        expect(fromText('   \n  ')).toEqual(NO_LYRICS)
    })
})

describe('which line is being sung', () => {
    const { lines } = fromText('[00:10.00]one\n[00:20.00]two\n[00:30.00]three')

    test('is none before the first marker, which is the instrumental opening', () => {
        expect(lineAt(lines, 0)).toBe(-1)
        expect(lineAt(lines, 9.9)).toBe(-1)
    })

    test('is the line whose moment has passed, not the one about to arrive', () => {
        expect(lineAt(lines, 10)).toBe(0)
        expect(lineAt(lines, 19.9)).toBe(0)
        expect(lineAt(lines, 20)).toBe(1)
    })

    test('stays on the last line once the words have run out', () => {
        expect(lineAt(lines, 300)).toBe(2)
    })

    test('is none at all for words with no timings, and for no words', () => {
        expect(lineAt(fromText('one\ntwo').lines, 42)).toBe(-1)
        expect(lineAt([], 42)).toBe(-1)
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
