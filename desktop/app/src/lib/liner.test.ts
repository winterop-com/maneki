import { describe, expect, test } from 'vitest'

import { announced, LINER_ROOM, linerByline, linerEyebrow, linerTitle, linerTitlePx } from '@/lib/liner'
import type { PlayerState, PlayingBook } from '@/lib/player'

function state(change: Partial<PlayerState>): PlayerState {
    return {
        queue: [],
        index: -1,
        order: [],
        orderAt: -1,
        shuffle: false,
        repeat: 'off',
        station: null,
        book: null,
        stationTitle: '',
        playing: false,
        refusal: null,
        positionS: 0,
        durationS: 0,
        volume: 1,
        muted: false,
        ...change,
    }
}

const album = Array.from({ length: 13 }, (_, n) => ({
    id: `tr_${String(n)}`,
    title: `Track ${String(n + 1)}`,
    artist: 'Avril Lavigne',
    album: 'Under My Skin',
    year: 2004,
}))

const book: PlayingBook = {
    id: 'bk_1',
    title: 'Thinking, Fast and Slow',
    author: 'Daniel Kahneman',
    has_cover: true,
    duration_s: 3600,
    chapter_list: [
        { title: 'Introduction', start_s: 0, end_s: 600 },
        { title: 'Part One', start_s: 600, end_s: 1800 },
        { title: 'Part Two', start_s: 1800, end_s: 3600 },
    ],
    files: [],
    speed: 1,
}

describe('the line over the title', () => {
    test('says where a track sits, and the record it is from', () => {
        expect(linerEyebrow(state({ queue: album, index: 4 }))).toBe('Track 5 of 13 · Under My Skin · 2004')
    })

    test('leaves out a place when the track is all there is', () => {
        expect(linerEyebrow(state({ queue: [album[0]!], index: 0 }))).toBe('Under My Skin · 2004')
    })

    test('leaves out what the tags do not carry', () => {
        expect(linerEyebrow(state({ queue: [{ id: 'tr_x', title: 'Untagged' }], index: 0 }))).toBe('')
    })

    test('says which chapter of which book', () => {
        expect(linerEyebrow(state({ book, positionS: 700 }))).toBe('Chapter 2 of 3 · Thinking, Fast and Slow')
        expect(linerEyebrow(state({ book: { ...book, chapter_list: [] } }))).toBe('Audiobook')
    })

    test('says a station is live', () => {
        expect(linerEyebrow(state({ station: { id: 'st_1', name: 'NRK P3', streamUrl: 'x' } }))).toBe(
            'Live radio',
        )
    })
})

// Regression: a station's announced song never reached the title, which kept the station's
// name while the name was also printed under it.
describe('the title', () => {
    test('is what a station announced once it has, and its name until then', () => {
        const station = { id: 'st_1', name: 'NRK P3 Musikk', streamUrl: 'x' }
        expect(linerTitle(state({ station }))).toBe('NRK P3 Musikk')
        expect(linerTitle(state({ station, stationTitle: 'P3 Musikk: Gogo dag, Åsane City' }))).toBe(
            'Gogo dag, Åsane City',
        )
    })

    test('is the chapter of a book, or the book when it has no chapters, or the track', () => {
        expect(linerTitle(state({ book, positionS: 700 }))).toBe('Part One')
        expect(linerTitle(state({ book: { ...book, chapter_list: [] } }))).toBe('Thinking, Fast and Slow')
        expect(linerTitle(state({ queue: album, index: 2 }))).toBe('Track 3')
    })
})

describe('the line under the title', () => {
    test('is the artist, the author, or the station once it has announced a song', () => {
        expect(linerByline(state({ queue: album, index: 0 }))).toBe('Avril Lavigne')
        expect(linerByline(state({ book }))).toBe('Daniel Kahneman')
        const station = { id: 'st_1', name: 'NRK P3', streamUrl: 'x' }
        expect(linerByline(state({ station }))).toBe('')
        expect(linerByline(state({ station, stationTitle: 'Song - Band' }))).toBe('NRK P3')
    })
})

describe('the sizes', () => {
    test('the title grows with the room, from its smallest to its largest', () => {
        expect(linerTitlePx(LINER_ROOM)).toBe(24)
        expect(linerTitlePx(320)).toBe(44)
        expect(linerTitlePx(235)).toBe(34)
    })

    test('stays in bounds outside the range', () => {
        expect(linerTitlePx(40)).toBe(24)
        expect(linerTitlePx(1000)).toBe(44)
    })
})

describe('what a station announced', () => {
    test('loses the station introducing itself', () => {
        expect(announced('NRK mP3 - Alltid musikk: PILLOWTALK, ZAYN', 'NRK mP3')).toBe('PILLOWTALK, ZAYN')
        expect(announced('P3 Musikk: The Feeling, Steve Lacy', 'NRK P3 Musikk')).toBe(
            'The Feeling, Steve Lacy',
        )
    })

    test('keeps a colon that belongs to the song', () => {
        expect(announced('Daft Punk - Harder: Better', 'Nectarine Demoscene Radio')).toBe(
            'Daft Punk - Harder: Better',
        )
        expect(announced('Purple Motion - Satellite One', 'Nectarine Demoscene Radio')).toBe(
            'Purple Motion - Satellite One',
        )
    })

    test('keeps the whole line when nothing follows the colon', () => {
        expect(announced('NRK P3: ', 'NRK P3')).toBe('NRK P3: ')
    })
})
