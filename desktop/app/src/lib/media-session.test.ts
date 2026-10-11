import { afterEach, describe, expect, test, vi } from 'vitest'

import {
    claimMediaSession,
    identity,
    installMediaSession,
    needsPosition,
    nowPlaying,
    type Told,
    windowTitle,
} from '@/lib/media-session'
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

describe('a video on screen holds the OS controls', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    test('the lock screen shows the video, and its pause pauses the video, not the album', () => {
        // While a film played, the OS still showed the paused station, and a media key started
        // the station and stopped the film.
        const handlers = new Map<string, () => void>()
        const media = {
            metadata: null as MediaMetadata | null,
            playbackState: 'none',
            setActionHandler: (action: string, run: () => void) => handlers.set(action, run),
            setPositionState: () => undefined,
        }
        vi.stubGlobal('navigator', { mediaSession: media })
        vi.stubGlobal(
            'MediaMetadata',
            class {
                title: string
                constructor(init: { title: string }) {
                    this.title = init.title
                }
            },
        )
        installMediaSession()
        const pause = vi.fn()
        const release = claimMediaSession({
            title: 'Emissary',
            artwork: null,
            play: vi.fn(),
            pause,
            playing: () => true,
        })
        expect(media.metadata?.title).toBe('Emissary')
        expect(media.playbackState).toBe('playing')
        handlers.get('pause')?.()
        expect(pause).toHaveBeenCalledOnce()
        release()
        expect(media.metadata?.title ?? null).not.toBe('Emissary')
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
