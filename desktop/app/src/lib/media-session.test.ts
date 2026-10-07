import { describe, expect, test } from 'vitest'

import { identity, needsPosition, nowPlaying, type Told } from '@/lib/media-session'
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

const book: PlayingBook = {
    id: 'bk_1',
    title: 'Thinking, Fast and Slow',
    author: 'Daniel Kahneman',
    has_cover: true,
    duration_s: 3600,
    chapter_list: [
        { title: 'Introduction', start_s: 0, end_s: 600 },
        { title: 'Part One', start_s: 600, end_s: 3600 },
    ],
    files: [],
    speed: 1.5,
}

describe('what the OS is shown', () => {
    test('is nothing when nothing is playing', () => {
        expect(nowPlaying(state({}), null)).toBeNull()
    })

    test('is a track with its artist and album, and every control', () => {
        const shown = nowPlaying(
            state({
                queue: [{ id: 'tr_1', title: 'Eple', artist: 'Röyksopp', album: 'Melody A.M.' }],
                index: 0,
            }),
            'http://host/cover',
        )
        expect(shown).toEqual({
            title: 'Eple',
            artist: 'Röyksopp',
            album: 'Melody A.M.',
            artwork: 'http://host/cover',
            seekable: true,
            steps: true,
        })
    })

    test('is the chapter, with the author as the artist and the book as the album', () => {
        const shown = nowPlaying(state({ book, positionS: 700 }), null)
        expect(shown?.title).toBe('Part One')
        expect(shown?.artist).toBe('Daniel Kahneman')
        expect(shown?.album).toBe('Thinking, Fast and Slow')
    })

    test('is the book itself when the book carries no chapter marks', () => {
        const shown = nowPlaying(state({ book: { ...book, chapter_list: [] } }), null)
        expect(shown?.title).toBe('Thinking, Fast and Slow')
        expect(shown?.album).toBe('')
    })

    test('is what a station announced, under its name, with nothing to seek or skip', () => {
        const station = { id: 'st_1', name: 'NRK P3', streamUrl: 'https://host/p3' }
        expect(nowPlaying(state({ station }), null)).toMatchObject({
            title: 'NRK P3',
            artist: '',
            seekable: false,
            steps: false,
        })
        expect(nowPlaying(state({ station, stationTitle: 'Song - Band' }), null)).toMatchObject({
            title: 'Song - Band',
            artist: 'NRK P3',
        })
    })

    test('changes identity with the chapter, so the OS hears about each one once', () => {
        const first = identity(nowPlaying(state({ book, positionS: 10 }), null))
        expect(identity(nowPlaying(state({ book, positionS: 20 }), null))).toBe(first)
        expect(identity(nowPlaying(state({ book, positionS: 700 }), null))).not.toBe(first)
        expect(identity(null)).toBe('')
    })
})

describe('when the OS needs the position again', () => {
    const playing: Told = { positionS: 10, atMs: 0, playing: true, rate: 1 }

    test('is the first time', () => {
        expect(needsPosition(null, playing)).toBe(true)
    })

    test('is not while playback runs where the OS is extrapolating it to', () => {
        expect(needsPosition(playing, { ...playing, positionS: 15, atMs: 5000 })).toBe(false)
    })

    test('is after a seek, which the OS could not have guessed', () => {
        expect(needsPosition(playing, { ...playing, positionS: 60, atMs: 5000 })).toBe(true)
    })

    test('is when playback starts or stops, or the speed changes', () => {
        expect(needsPosition(playing, { ...playing, playing: false })).toBe(true)
        expect(needsPosition(playing, { ...playing, rate: 1.5 })).toBe(true)
    })

    test('follows the speed it was told, so a book at 1.5x is not re-sent every tick', () => {
        const fast: Told = { ...playing, rate: 1.5 }
        expect(needsPosition(fast, { ...fast, positionS: 17.5, atMs: 5000 })).toBe(false)
    })

    test('stands still while paused', () => {
        const paused: Told = { ...playing, playing: false }
        expect(needsPosition(paused, { ...paused, atMs: 60_000 })).toBe(false)
    })
})
