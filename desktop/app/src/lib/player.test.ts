import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
    clear,
    cycleRepeat,
    toggleShuffle,
    setVolume,
    storedVolume,
    toggleMuted,
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

/** Storage, in memory: the test runner has none, and every read here goes through it. */
function fakeStorage(): Storage {
    const held = new Map<string, string>()
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => {
            held.set(key, value)
        },
        removeItem: (key: string) => {
            held.delete(key)
        },
        clear: () => {
            held.clear()
        },
        key: () => null,
        get length() {
            return held.size
        },
    } as Storage
}

describe('the volume', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', fakeStorage())
    })

    test('starts at full when nothing was stored, because Number(null) is 0 and 0 is silence', () => {
        expect(storedVolume()).toBe(1)
    })

    test('comes back at the level this browser last set', () => {
        setVolume(0.4)
        expect(storedVolume()).toBeCloseTo(0.4)
        expect(playerStore.get().volume).toBeCloseTo(0.4)
    })

    test('is held between silence and full, whatever it is handed', () => {
        setVolume(4)
        expect(playerStore.get().volume).toBe(1)
        setVolume(-1)
        expect(playerStore.get().volume).toBe(0)
    })

    test('a level nobody could have written is read as full rather than as silence', () => {
        localStorage.setItem('maneki.volume', 'loud')
        expect(storedVolume()).toBe(1)
    })

    test('storage that refuses to be read is full as well, not silent', () => {
        vi.stubGlobal('localStorage', undefined)
        expect(storedVolume()).toBe(1)
    })

    test('muting keeps the level, which is what unmuting puts back', () => {
        setVolume(0.6)
        toggleMuted()
        expect(playerStore.get().muted).toBe(true)
        expect(playerStore.get().volume).toBeCloseTo(0.6)
        toggleMuted()
        expect(playerStore.get().muted).toBe(false)
    })

    test('moving the slider is asking to hear it, so it unmutes', () => {
        toggleMuted()
        setVolume(0.8)
        expect(playerStore.get().muted).toBe(false)
    })
})

describe('shuffle and repeat', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', fakeStorage())
    })

    test('shuffle keeps what is playing and changes what comes next', () => {
        play(songs, 0)
        expect(currentSong()?.title).toBe('One')
        if (!playerStore.get().shuffle) toggleShuffle()
        expect(playerStore.get().shuffle).toBe(true)
        expect(currentSong()?.title).toBe('One')
        expect(playerStore.get().orderAt).toBe(0)
        expect(playerStore.get().order.toSorted()).toEqual([0, 1, 2])
    })

    test('turning shuffle off carries on from where you are in the album', () => {
        play(songs, 1)
        if (!playerStore.get().shuffle) toggleShuffle()
        if (playerStore.get().shuffle) toggleShuffle()
        expect(playerStore.get().shuffle).toBe(false)
        expect(playerStore.get().order).toEqual([0, 1, 2])
        expect(currentSong()?.title).toBe('Two')
    })

    test('repeat-one plays the same track again when it ends', () => {
        play(songs, 1)
        while (playerStore.get().repeat !== 'one') cycleRepeat()
        fake.emit('ended')
        expect(currentSong()?.title).toBe('Two')
        expect(playerStore.get().positionS).toBe(0)
    })

    test('repeat-all wraps at the end instead of stopping', () => {
        play(songs, 2)
        while (playerStore.get().repeat !== 'all') cycleRepeat()
        fake.emit('ended')
        expect(currentSong()?.title).toBe('One')
        expect(playerStore.get().playing).toBe(true)
    })

    test('with repeat off the queue still ends', () => {
        play(songs, 2)
        while (playerStore.get().repeat !== 'off') cycleRepeat()
        fake.emit('ended')
        expect(playerStore.get().playing).toBe(false)
    })

    test('pressing next under repeat-one moves along, because the press says so', () => {
        play(songs, 0)
        while (playerStore.get().repeat !== 'one') cycleRepeat()
        next()
        expect(currentSong()?.title).toBe('Two')
    })

    test('the way somebody listens is kept between visits', () => {
        if (!playerStore.get().shuffle) toggleShuffle()
        expect(localStorage.getItem('maneki.shuffle')).toBe('true')
        const mode = cycleRepeat()
        expect(localStorage.getItem('maneki.repeat')).toBe(mode)
    })
})
