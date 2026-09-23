import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
    clear,
    currentChapter,
    cycleRepeat,
    toggleShuffle,
    setSpeed,
    setVolume,
    skipBy,
    storedVolume,
    toggleMuted,
    currentSong,
    next,
    play,
    playBook,
    playChapter,
    playerStore,
    playStation,
    previous,
    seek,
    setPlayerCredentials,
    toggle,
} from '@/lib/player'
import type { Song } from '@/lib/subsonic'
import type { BookDetail } from '@/lib/types'

/** Stands in for the browser's audio element: records what it was asked to do. */
class FakeAudio {
    currentTime = 0
    duration = 200
    paused = true
    preload = ''
    playbackRate = 1
    /** `HAVE_NOTHING` until the metadata is said to have arrived; `arrive` is what says so. */
    readyState = 0
    private source = ''
    private listeners: Record<string, { handler: () => void; once: boolean }[]> = {}

    get src(): string {
        return this.source
    }

    /** A new source has had nothing read off it yet, which is what makes a seek wait. */
    set src(wanted: string) {
        this.source = wanted
        this.readyState = 0
    }

    addEventListener(event: string, handler: () => void, options?: { once?: boolean }): void {
        ;(this.listeners[event] ??= []).push({ handler, once: options?.once === true })
    }

    emit(event: string): void {
        const held = this.listeners[event] ?? []
        this.listeners[event] = held.filter((one) => !one.once)
        for (const one of held) one.handler()
    }

    /** The browser has read the file's metadata, so a held seek lands now. */
    arrive(): void {
        this.readyState = 1
        this.emit('loadedmetadata')
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
/** Every request the player made, so a test can read what the server was told and when. */
let asked: { path: string; body: unknown }[] = []

beforeEach(() => {
    clear()
    fake = new FakeAudio()
    asked = []
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
        vi.fn(async (path: string, init?: RequestInit) => {
            asked.push({
                path,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            })
            return { ok: true, status: 200, json: async () => ({}) } as Response
        }),
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

describe('a source that will not play', () => {
    test('stops saying it is playing, and says why instead', () => {
        play(songs, 0)
        expect(playerStore.get().playing).toBe(true)
        fake.emit('error')
        expect(playerStore.get().playing).toBe(false)
        expect(playerStore.get().refusal).toBe('This track would not play.')
    })

    test('the next thing that plays clears the line', () => {
        play(songs, 0)
        fake.emit('error')
        next()
        expect(playerStore.get().refusal).toBeNull()
        expect(playerStore.get().playing).toBe(true)
    })

    test('a station names itself, because the bar is about to say nothing else', () => {
        playStation({ id: 'st_1', name: 'A Station', streamUrl: 'https://host/stream' })
        fake.emit('error')
        expect(playerStore.get().refusal).toBe('No sound from A Station.')
        expect(playerStore.get().playing).toBe(false)
    })

    test('a book says it is the file rather than the book, because the rest of it is fine', () => {
        playBook(book, 0)
        fake.arrive()
        fake.emit('error')
        expect(playerStore.get().refusal).toBe('This part of the book would not play.')
        expect(playerStore.get().playing).toBe(false)
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

/**
 * A book of one hour, in two half-hour files, with three twenty-minute chapters.
 *
 * The chapter marks deliberately do not line up with the file boundary -- chapter two runs from
 * 20:00 to 40:00 and the second file starts at 30:00 -- because that is the case the arithmetic
 * is for, and a fixture whose chapters were its files would pass either way.
 */
const book: BookDetail = {
    id: 'bk_1',
    title: 'A Book',
    author: 'An Author',
    narrator: 'A Reader',
    year: null,
    series: null,
    series_position: null,
    duration_s: 3600,
    chapters: 3,
    has_cover: true,
    position_s: 0,
    finished: false,
    description: null,
    asin: null,
    chapter_source: 'file',
    chapter_list: [
        { title: 'One', start_s: 0, end_s: 1200 },
        { title: 'Two', start_s: 1200, end_s: 2400 },
        { title: 'Three', start_s: 2400, end_s: 3600 },
    ],
    files: [
        { index: 0, duration_s: 1800, offset_s: 0, size_bytes: 1, url: 'bk_1/one.m4b' },
        { index: 1, duration_s: 1800, offset_s: 1800, size_bytes: 1, url: 'bk_1/two.m4b' },
    ],
}

/** The same book as this account left it. */
function leftAt(positionS: number): BookDetail {
    return { ...book, position_s: positionS }
}

/** What the server was told about the place, in the order it was told. */
function saves(): { position_s: number; finished?: boolean }[] {
    return asked
        .filter((one) => one.path.includes('/progress'))
        .map((one) => one.body as { position_s: number; finished?: boolean })
}

describe('playing a book', () => {
    test('opens where this account stopped', () => {
        playBook(leftAt(900))
        expect(fake.src).toContain('one.m4b')
        // The seek waits: a source with no metadata read off it yet throws the write away.
        expect(fake.currentTime).toBe(0)
        fake.arrive()
        expect(fake.currentTime).toBe(900)
        expect(playerStore.get().positionS).toBe(900)
        expect(playerStore.get().durationS).toBe(3600)
        expect(playerStore.get().playing).toBe(true)
    })

    test('a book that was finished opens at its beginning rather than at its last second', () => {
        playBook({ ...book, position_s: 3600, finished: true })
        fake.arrive()
        expect(playerStore.get().positionS).toBe(0)
        expect(fake.src).toContain('one.m4b')
    })

    test('a chapter is played from its own start, on whichever file holds it', () => {
        playBook(book, 2400)
        fake.arrive()
        expect(fake.src).toContain('two.m4b')
        expect(fake.currentTime).toBe(600)
        expect(playerStore.get().positionS).toBe(2400)
        expect(currentChapter()?.title).toBe('Three')
    })

    test('a seek across a file boundary loads the other file at the right offset', () => {
        playBook(book, 0)
        fake.arrive()
        seek(2000)
        expect(fake.src).toContain('two.m4b')
        fake.arrive()
        expect(fake.currentTime).toBe(200)
        expect(playerStore.get().positionS).toBe(2000)
    })

    test('a file that ends carries on into the next one', () => {
        playBook(book, 1700)
        fake.arrive()
        fake.emit('ended')
        expect(fake.src).toContain('two.m4b')
        fake.arrive()
        expect(fake.currentTime).toBe(0)
        expect(playerStore.get().positionS).toBe(1800)
        expect(playerStore.get().playing).toBe(true)
    })

    test('the last file ending finishes the book', () => {
        playBook(book, 3500)
        fake.arrive()
        fake.emit('ended')
        expect(playerStore.get().playing).toBe(false)
        expect(saves().at(-1)).toEqual({ position_s: 3600, finished: true })
    })

    test('a book is not a track, so nothing asks the queue about it', () => {
        playBook(book, 60)
        expect(currentSong()).toBeNull()
        expect(playerStore.get().queue).toEqual([])
        expect(playerStore.get().book?.title).toBe('A Book')
    })

    test('the fifteen-second jumps move the position on the book, not on the file', () => {
        playBook(book, 1790)
        fake.arrive()
        skipBy(15)
        expect(playerStore.get().positionS).toBe(1805)
        expect(fake.src).toContain('two.m4b')
    })

    test('picking it up again plays rather than needing the source put on twice', () => {
        playBook(book, 100)
        fake.arrive()
        fake.pause()
        expect(playerStore.get().playing).toBe(false)
        toggle()
        expect(playerStore.get().playing).toBe(true)
    })
})

describe('walking a book', () => {
    test('next and previous are chapters', () => {
        playBook(book, 0)
        fake.arrive()
        next()
        expect(playerStore.get().positionS).toBe(1200)
        next()
        expect(playerStore.get().positionS).toBe(2400)
        expect(fake.src).toContain('two.m4b')
        previous()
        expect(playerStore.get().positionS).toBe(1200)
    })

    test('previous restarts the chapter once it is under way', () => {
        playBook(book, 1500)
        fake.arrive()
        previous()
        expect(playerStore.get().positionS).toBe(1200)
    })

    test('a chapter picked out of the panel starts, where a scrub would not', () => {
        playBook(book, 0)
        fake.arrive()
        fake.pause()
        playChapter(1200)
        expect(playerStore.get().positionS).toBe(1200)
        expect(playerStore.get().playing).toBe(true)
    })

    test('next on the last chapter stays where it is rather than playing it again', () => {
        playBook(book, 2500)
        fake.arrive()
        next()
        expect(playerStore.get().positionS).toBe(2500)
    })

    test('a book with no chapter marks steps by its files instead', () => {
        playBook({ ...book, chapter_list: [], chapters: 0 }, 0)
        fake.arrive()
        next()
        expect(playerStore.get().positionS).toBe(1800)
        expect(currentChapter()).toBeNull()
    })
})

describe("a book's place and its speed", () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', fakeStorage())
    })

    test('is saved as it plays, every ten seconds of it', () => {
        playBook(leftAt(0))
        fake.arrive()
        fake.currentTime = 5
        fake.emit('timeupdate')
        expect(saves()).toEqual([])
        fake.currentTime = 12
        fake.emit('timeupdate')
        expect(saves().at(-1)?.position_s).toBe(12)
    })

    test('is saved when playback stops, which is where a listener comes back to', () => {
        playBook(leftAt(0))
        fake.arrive()
        fake.currentTime = 42
        fake.emit('timeupdate')
        asked = []
        fake.pause()
        expect(saves().at(-1)?.position_s).toBe(42)
    })

    test('is saved before an album takes the player over', () => {
        playBook(leftAt(600))
        fake.arrive()
        fake.currentTime = 700
        fake.emit('timeupdate')
        asked = []
        play(songs, 0)
        expect(saves().at(-1)?.position_s).toBe(700)
        expect(playerStore.get().book).toBeNull()
        expect(currentSong()?.title).toBe('One')
    })

    test('the speed is kept between visits and survives a file change', () => {
        setSpeed(1.5)
        expect(localStorage.getItem('maneki.speed')).toBe('1.5')
        playBook(book, 1700)
        fake.arrive()
        expect(fake.playbackRate).toBe(1.5)
        expect(playerStore.get().book?.speed).toBe(1.5)
        fake.emit('ended')
        expect(fake.src).toContain('two.m4b')
        expect(fake.playbackRate).toBe(1.5)
    })
})
