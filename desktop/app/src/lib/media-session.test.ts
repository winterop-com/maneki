import { describe, expect, test, vi } from 'vitest'

import { nowPlaying, playerSession, screenSession, windowTitle } from '@/lib/media-session'
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
})

describe('what the OS controls do', () => {
    const song = { id: 'tr_1', title: 'Eple', artist: 'Röyksopp', album: 'Melody A.M.' }

    test('a track has every control, its position and its length', () => {
        const info = playerSession(state({ queue: [song], index: 0, positionS: 30, durationS: 200 }), null)
        expect(info?.duration).toBe(200)
        expect(info?.position).toBe(30)
        expect(Object.keys(info?.handlers ?? {}).toSorted()).toEqual(
            [
                'nexttrack',
                'pause',
                'play',
                'previoustrack',
                'seekbackward',
                'seekforward',
                'seekto',
            ].toSorted(),
        )
    })

    test('a book tells the OS its reading speed', () => {
        expect(playerSession(state({ book, durationS: 3600 }), null)?.rate).toBe(1.5)
    })

    test('a station offers play and pause alone, and no position', () => {
        const station = { id: 'st_1', name: 'NRK P3', streamUrl: 'https://host/p3' }
        const info = playerSession(state({ station }), null)
        expect(info?.duration).toBeUndefined()
        expect(Object.keys(info?.handlers ?? {}).toSorted()).toEqual(['pause', 'play'])
    })

    test('nothing playing tells the OS nothing', () => {
        expect(playerSession(state({}), null)).toBeNull()
    })
})

describe('a video on screen holds the OS controls', () => {
    test('the lock screen shows the video, and its pause pauses the video, not the album', () => {
        // While a film played, the OS still showed the paused station, and a media key started
        // the station and stopped the film.
        const pause = vi.fn()
        const info = screenSession({
            title: 'Emissary',
            artwork: null,
            play: vi.fn(),
            pause,
            playing: () => true,
        })
        expect(info.title).toBe('Emissary')
        expect(info.playing).toBe(true)
        info.handlers?.pause?.()
        expect(pause).toHaveBeenCalledOnce()
        expect(info.handlers?.nexttrack).toBeUndefined()
    })
})

describe('the window title', () => {
    test('is what is playing, so the window can be told apart from the others', () => {
        // It was "Maneki" whatever played, for window switching and for a screen reader alike.
        expect(windowTitle({ title: 'Last Child', artist: 'Aerosmith' })).toBe(
            'Last Child · Aerosmith · maneki',
        )
    })

    test("names the book a chapter is from, since chapters are mostly called 'Chapter 2'", () => {
        expect(windowTitle({ title: 'Chapter 2', artist: 'J. R. R. Tolkien', book: 'The Hobbit' })).toBe(
            'Chapter 2 · The Hobbit · J. R. R. Tolkien · maneki',
        )
    })

    test('is the app alone when nothing plays', () => {
        expect(windowTitle(null)).toBe('maneki')
    })
})
