import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
    clear,
    currentSong,
    next,
    play,
    playerStore,
    previous,
    seek,
    setPlayerCredentials,
} from '@/lib/player'
import type { Song } from '@/lib/subsonic'

/** Stands in for the browser's audio element: records what it was asked to do. */
class FakeAudio {
    src = ''
    currentTime = 0
    duration = 200
    paused = true
    preload = ''
    private listeners: Record<string, (() => void)[]> = {}

    addEventListener(event: string, handler: () => void): void {
        ;(this.listeners[event] ??= []).push(handler)
    }

    emit(event: string): void {
        for (const handler of this.listeners[event] ?? []) handler()
    }

    play(): Promise<void> {
        this.paused = false
        this.emit('play')
        return Promise.resolve()
    }

    pause(): void {
        this.paused = true
        this.emit('pause')
    }
}

const songs: Song[] = [
    { id: 'tr_1', title: 'One', duration: 100 },
    { id: 'tr_2', title: 'Two', duration: 200 },
    { id: 'tr_3', title: 'Three', duration: 300 },
]

let fake: FakeAudio

beforeEach(() => {
    clear()
    fake = new FakeAudio()
    // `new Audio()`: an arrow function cannot be constructed, so a class that
    // hands back the fake is what stands in for it.
    vi.stubGlobal(
        'Audio',
        class {
            constructor() {
                return fake
            }
        },
    )
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response),
    )
    setPlayerCredentials({ restUrl: 'https://host/audio/rest', username: 'm', salt: 's', token: 't' })
})

describe('playing an album', () => {
    test('starts where the listener picked, not at the top', () => {
        play(songs, 1)
        expect(currentSong()?.title).toBe('Two')
        expect(playerStore.get().queue).toHaveLength(3)
        expect(fake.src).toContain('id=tr_2')
    })

    test('a track that ends hands over to the next one', () => {
        play(songs, 0)
        fake.emit('ended')
        expect(currentSong()?.title).toBe('Two')
    })

    test('the last track ends the queue rather than wrapping', () => {
        play(songs, 2)
        fake.emit('ended')
        expect(currentSong()?.title).toBe('Three')
        expect(playerStore.get().playing).toBe(false)
    })

    test('an empty album does nothing', () => {
        play([], 0)
        expect(currentSong()).toBeNull()
    })
})

describe('previous', () => {
    test('restarts the track once it is under way', () => {
        play(songs, 1)
        seek(30)
        previous()
        expect(currentSong()?.title).toBe('Two')
        expect(playerStore.get().positionS).toBe(0)
    })

    test('goes back a track when pressed at the start', () => {
        play(songs, 1)
        previous()
        expect(currentSong()?.title).toBe('One')
    })

    test('on the first track it just returns to the start', () => {
        play(songs, 0)
        seek(2)
        previous()
        expect(currentSong()?.title).toBe('One')
        expect(playerStore.get().positionS).toBe(0)
    })
})

describe('the store', () => {
    test('follows the element', () => {
        play(songs, 0)
        fake.currentTime = 42
        fake.emit('timeupdate')
        expect(playerStore.get().positionS).toBe(42)

        fake.pause()
        expect(playerStore.get().playing).toBe(false)
    })

    test('clearing stops and forgets', () => {
        play(songs, 0)
        clear()
        expect(currentSong()).toBeNull()
        expect(playerStore.get().queue).toEqual([])
    })
})

describe('next', () => {
    test('moves along the queue', () => {
        play(songs, 0)
        next()
        expect(currentSong()?.title).toBe('Two')
    })
})
