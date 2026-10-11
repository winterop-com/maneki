import { claimSound } from '@/lib/sound'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
    bookStepCount,
    clear,
    currentChapter,
    currentSong,
    cycleRepeat,
    next,
    play,
    playBook,
    playChapter,
    playerStore,
    playStation,
    previous,
    retry,
    seek,
    setPlayerCredentials,
    setSpeed,
    setVolume,
    skipBy,
    spectrum,
    storedVolume,
    toggle,
    toggleMuted,
    toggleShuffle,
} from '@/lib/player'
import type { Song, Station } from '@/lib/subsonic'
import type { BookDetail } from '@/lib/types'

/** A Web Audio node that connects to anything and does nothing. */
const node = () => ({ connect: () => undefined })

/** Stands in for the browser's audio element: records what it was asked to do. */
class FakeAudio {
    currentTime = 0
    duration = 200
    paused = true
    preload = ''
    playbackRate = 1
    volume = 1
    muted = false
    /** `HAVE_NOTHING` until the metadata is said to have arrived; `arrive` is what says so. */
    readyState = 0
    /** What the element is complaining about, as `HTMLMediaElement.error` has it. */
    error: { code: number } | null = null
    /** What the next `play()` is to refuse with, for the switch that interrupts one. */
    refuse: Error | null = null
    /** How many times a source was put on, so a reload of the same one can be told apart. */
    loads = 0
    private source = ''
    private listeners: Record<string, { handler: () => void; once: boolean }[]> = {}

    get src(): string {
        return this.source
    }

    /** A new source has had nothing read off it yet, which is what makes a seek wait. */
    set src(wanted: string) {
        this.loads += 1
        this.source = wanted
        this.readyState = 0
        this.error = null
    }

    addEventListener(event: string, handler: () => void, options?: { once?: boolean }): void {
        ;(this.listeners[event] ??= []).push({ handler, once: options?.once === true })
    }

    removeEventListener(event: string, handler: () => void): void {
        this.listeners[event] = (this.listeners[event] ?? []).filter((one) => one.handler !== handler)
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

    /** Letting the source go: what releasing a paused station's stream does. */
    removeAttribute(name: string): void {
        if (name === 'src') this.src = ''
    }

    load(): void {
        this.readyState = 0
    }

    /** Set to keep the next `play()` in flight, the way a station still connecting does. */
    hold = false

    /** The play still in flight, which a `pause()` interrupts. */
    private inFlight: ((reason: Error) => void) | null = null

    play(): Promise<void> {
        if (this.hold) {
            this.hold = false
            this.paused = false
            return new Promise((_resolve, reject) => {
                this.inFlight = reject
            })
        }
        const refused = this.refuse
        if (refused !== null) {
            // A play the browser interrupted leaves the element where it was -- paused, and
            // saying nothing about it: no `pause` event, only the rejection.
            this.refuse = null
            this.paused = true
            return Promise.reject(refused)
        }
        this.paused = false
        this.emit('play')
        return Promise.resolve()
    }

    pause(): void {
        // Pausing while a play is still in flight rejects that play, as the browser does.
        const interrupted = this.inFlight
        this.inFlight = null
        interrupted?.(abortError())
        this.paused = true
        this.emit('pause')
    }

    /**
     * The element giving up on what it was handed.
     *
     * It goes quiet without firing `pause`, which is the whole reason the refusal has to be
     * published off the error, and the code says whether it gave up or was sent elsewhere.
     */
    fail(code = 2, { pauses = true }: { pauses?: boolean } = {}): void {
        this.error = { code }
        // Chromium leaves an element that could not decode its source unpaused.
        if (pauses) this.paused = true
        this.emit('error')
    }
}

/** The rejection a browser hands back when a new source interrupts a play still in flight. */
function abortError(): Error {
    const refusal = new Error('The play() request was interrupted by a new load request.')
    refusal.name = 'AbortError'
    return refusal
}

/** Let the microtasks a rejected `play()` queued run. */
async function settled(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
}

/** The settle a refusal is given before it is published, and a hair more. */
const SETTLE_MS = 800

const stations: Station[] = [
    { id: 'st_1', name: 'One FM', streamUrl: 'https://host/one' },
    { id: 'st_2', name: 'Two FM', streamUrl: 'https://host/two' },
    { id: 'st_3', name: 'Three FM', streamUrl: 'https://host/three' },
]

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
    // `new Audio()`: an arrow function cannot be constructed, so a plain function
    // that hands back the fake is what stands in for it.
    vi.stubGlobal('Audio', function Audio() {
        return fake
    })
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
    test('next on the last track, with repeat off, stays put and keeps playing', () => {
        // The bar said stopped while the track played on, and Play then paused it.
        play(songs, 2)
        fake.arrive()
        expect(playerStore.get().playing).toBe(true)
        next()
        expect(currentSong()?.title).toBe('Three')
        expect(playerStore.get().playing).toBe(true)
        expect(fake.paused).toBe(false)
    })

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
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    test('stops saying it is playing, and says why instead', () => {
        play(songs, 0)
        expect(playerStore.get().playing).toBe(true)
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        expect(playerStore.get().playing).toBe(false)
        expect(playerStore.get().refusal).toBe('This track would not play.')
    })

    // Regression: Chromium fires `error` on a source it cannot decode and leaves the element
    // unpaused, and the refusal waited for a pause, so the bar said playing over silence.
    test('says so even when the element was left unpaused', () => {
        play(songs, 0)
        fake.fail(4, { pauses: false })
        vi.advanceTimersByTime(SETTLE_MS)
        expect(playerStore.get().refusal).toBe('This track would not play.')
        expect(playerStore.get().playing).toBe(false)
    })

    test('says nothing until the failure has had a moment to be contradicted', () => {
        play(songs, 0)
        fake.fail()
        expect(playerStore.get().refusal).toBeNull()
        vi.advanceTimersByTime(SETTLE_MS)
        expect(playerStore.get().refusal).toBe('This track would not play.')
    })

    test('the next thing that plays clears the line', () => {
        play(songs, 0)
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        next()
        expect(playerStore.get().refusal).toBeNull()
        expect(playerStore.get().playing).toBe(true)
    })

    test('retry asks for the same track again, from the second it stopped', () => {
        play(songs, 1)
        fake.currentTime = 42
        fake.emit('timeupdate')
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        const loads = fake.loads
        retry()
        expect(fake.loads).toBe(loads + 1)
        expect(fake.src).toContain('id=tr_2')
        expect(playerStore.get().refusal).toBeNull()
        expect(playerStore.get().playing).toBe(true)
        fake.arrive()
        expect(fake.currentTime).toBe(42)
        expect(playerStore.get().positionS).toBe(42)
    })

    test('play on a refused track tries it again rather than asking the dead load', () => {
        play(songs, 0)
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        const loads = fake.loads
        toggle()
        expect(fake.loads).toBe(loads + 1)
        expect(playerStore.get().playing).toBe(true)
    })

    test('retry does nothing when nothing was refused', () => {
        play(songs, 0)
        const loads = fake.loads
        retry()
        expect(fake.loads).toBe(loads)
    })

    test('retry reloads a station from now', () => {
        playStation(stations[0]!)
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        const loads = fake.loads
        retry()
        expect(fake.loads).toBe(loads + 1)
        expect(playerStore.get().refusal).toBeNull()
        expect(playerStore.get().station?.id).toBe('st_1')
    })

    test('retry reloads the book file it already held, rather than keeping the dead load', () => {
        playBook(book, 0)
        fake.arrive()
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        const loads = fake.loads
        const src = fake.src
        retry()
        expect(fake.loads).toBe(loads + 1)
        expect(fake.src).toBe(src)
        expect(playerStore.get().refusal).toBeNull()
    })

    test('a station names itself, because the bar is about to say nothing else', () => {
        playStation({ id: 'st_1', name: 'A Station', streamUrl: 'https://host/stream' })
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        expect(playerStore.get().refusal).toBe('No sound from A Station.')
        expect(playerStore.get().playing).toBe(false)
    })

    test('a book says it is the file rather than the book, because the rest of it is fine', () => {
        playBook(book, 0)
        fake.arrive()
        fake.fail()
        vi.advanceTimersByTime(SETTLE_MS)
        expect(playerStore.get().refusal).toBe('This part of the book would not play.')
        expect(playerStore.get().playing).toBe(false)
    })

    test('an aborted load is the element being sent elsewhere, which is not news', () => {
        playStation(stations[0]!)
        fake.fail(1)
        vi.advanceTimersByTime(SETTLE_MS)
        expect(playerStore.get().refusal).toBeNull()
        expect(playerStore.get().playing).toBe(true)
    })

    test('the station clicked past does not speak for the one now playing', () => {
        playStation(stations[0]!)
        // The first station's load dies as it is abandoned; by then the element is already
        // opening the station that was clicked instead.
        fake.fail()
        expect(playerStore.get().refusal).toBeNull()
        playStation(stations[1]!)
        vi.advanceTimersByTime(SETTLE_MS)
        expect(playerStore.get().refusal).toBeNull()
        expect(playerStore.get().playing).toBe(true)
        expect(playerStore.get().station?.name).toBe('Two FM')
    })
})

describe('pausing a station that is still connecting', () => {
    test('stays paused: the interrupted play is not asked again', async () => {
        vi.useFakeTimers()
        try {
            fake.hold = true
            playStation(stations[0]!)
            // The listener changes their mind before any sound arrives.
            toggle()
            await settled()
            vi.advanceTimersByTime(SETTLE_MS)
            expect(fake.paused).toBe(true)
            expect(playerStore.get().playing).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('a station paused and picked up again', () => {
    test('lets its stream go while paused, and comes back live rather than where it stopped', () => {
        // Resumed, it played the audio it had buffered 30 s and more behind live, under a title
        // that had moved on, and the server held the stream open for the whole pause.
        playStation(stations[0]!)
        const live = fake.src
        expect(live).toContain('one')
        toggle()
        expect(playerStore.get().playing).toBe(false)
        expect(fake.src).toBe('')
        toggle()
        expect(fake.src).toBe(live)
        expect(playerStore.get().playing).toBe(true)
        expect(playerStore.get().station?.id).toBe(stations[0]!.id)
    })
})

describe('a station something else silenced', () => {
    test('lets its stream go, as a pause does', () => {
        // A video opening paused the station, but the stream stayed connected the whole film.
        playStation(stations[0]!)
        expect(fake.src).not.toBe('')
        claimSound(() => undefined)
        expect(fake.src).toBe('')
        expect(playerStore.get().playing).toBe(false)
    })
})

describe('switching stations faster than they open', () => {
    test('a play the next station interrupted is not silence', async () => {
        playStation(stations[0]!)
        expect(playerStore.get().playing).toBe(true)
        // The second station's play is still in flight when the third is clicked, so the
        // browser rejects it with an AbortError about a source nobody is listening to.
        fake.refuse = abortError()
        playStation(stations[1]!)
        playStation(stations[2]!)
        await settled()
        expect(playerStore.get().playing).toBe(true)
        expect(playerStore.get().refusal).toBeNull()
        expect(playerStore.get().station?.name).toBe('Three FM')
    })

    test('the latest load, left paused by the abort, is asked once more', async () => {
        vi.useFakeTimers()
        try {
            playStation(stations[0]!)
            fake.refuse = abortError()
            playStation(stations[1]!)
            await settled()
            // WebKit does not pick itself up after the abort: the element sits paused on the
            // station somebody actually asked for.
            expect(fake.paused).toBe(true)
            vi.advanceTimersByTime(SETTLE_MS)
            expect(fake.paused).toBe(false)
            expect(playerStore.get().playing).toBe(true)
            expect(playerStore.get().refusal).toBeNull()
        } finally {
            vi.useRealTimers()
        }
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

    // Regression: the volume was the element's, which scales the signal before the analyser,
    // so a quiet or muted player drew a flat spectrum over music that was playing.
    test('once the spectrum is drawn, the volume is after it and the element plays at full level', () => {
        const gains: { gain: { value: number } }[] = []
        vi.stubGlobal(
            'AudioContext',
            class {
                state = 'running'
                destination = {}
                createMediaElementSource = node
                createAnalyser = () => ({ ...node(), fftSize: 0, smoothingTimeConstant: 0 })
                createGain = () => {
                    const made = { ...node(), gain: { value: 1 } }
                    gains.push(made)
                    return made
                }
                close = () => Promise.resolve()
                resume = () => Promise.resolve()
            },
        )
        setVolume(0.3)
        play(songs, 0)
        expect(fake.volume).toBeCloseTo(0.3)

        spectrum()
        expect(fake.volume).toBe(1)
        expect(gains[0]?.gain.value).toBeCloseTo(0.3)

        toggleMuted()
        expect(fake.muted).toBe(false)
        expect(gains[0]?.gain.value).toBe(0)

        setVolume(0.7)
        expect(gains[0]?.gain.value).toBeCloseTo(0.7)
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
    return (
        asked
            // A save carries a body; asking where the book was left does not.
            .filter((one) => one.path.includes('/progress') && one.body !== undefined)
            .map((one) => one.body as { position_s: number; finished?: boolean })
    )
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

    test('a jump past the end finishes the book rather than starting it again', () => {
        // WebKit rewinds an ended element to its start when it is told to play, so a jump that
        // landed on the last second restarted the book and saved 0 over hours of progress.
        playBook(book, 3594)
        fake.arrive()
        skipBy(15)
        expect(playerStore.get().playing).toBe(false)
        expect(playerStore.get().positionS).toBe(3600)
        expect(saves().at(-1)).toEqual({ position_s: 3600, finished: true })
        expect(saves().some((one) => one.position_s === 0)).toBe(false)
    })

    test('a finished book is not saved again at the place the element last reported', () => {
        // The pause that finishing caused arrived after a tick and saved 1516.7 over the end.
        playBook(book, 3594)
        fake.arrive()
        fake.currentTime = 1794
        skipBy(15)
        fake.emit('timeupdate')
        fake.emit('pause')
        expect(saves().at(-1)).toEqual({ position_s: 3600, finished: true })
        expect(playerStore.get().positionS).toBe(3600)
    })

    test('a scrub to the very end finishes the book too', () => {
        playBook(book, 100)
        fake.arrive()
        seek(3600)
        expect(playerStore.get().playing).toBe(false)
        expect(saves().at(-1)).toEqual({ position_s: 3600, finished: true })
    })

    test('picking up a paused book takes a newer place another device saved', async () => {
        // A tab left paused at 1:23 resumed from what it held and saved over the 2:30 a phone had
        // kept since, so the phone's listening was lost.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (path: string, init?: RequestInit) => {
                asked.push({
                    path,
                    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
                })
                const body =
                    init?.method === 'PUT'
                        ? { book_id: 'bk_1', position_s: 100, finished: false, updated_at: 1000 }
                        : { book_id: 'bk_1', position_s: 2000, finished: false, updated_at: 2000 }
                return { ok: true, status: 200, json: async () => body } as Response
            }),
        )
        playBook(book, 100)
        fake.arrive()
        seek(100)
        await vi.waitFor(() => expect(saves().length).toBeGreaterThan(0))
        fake.pause()
        const before = saves().length
        toggle()
        await vi.waitFor(() => expect(playerStore.get().positionS).toBe(2000))
        expect(fake.src).toContain('two.m4b')
        // Nothing this tab held is written back over the newer place.
        expect(
            saves()
                .slice(before)
                .some((one) => one.position_s === 100),
        ).toBe(false)
    })

    test('picking up a paused book keeps its own place when nothing newer was saved', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (path: string, init?: RequestInit) => {
                asked.push({
                    path,
                    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
                })
                const body = { book_id: 'bk_1', position_s: 100, finished: false, updated_at: 1000 }
                return { ok: true, status: 200, json: async () => body } as Response
            }),
        )
        playBook(book, 100)
        fake.arrive()
        seek(100)
        await vi.waitFor(() => expect(saves().length).toBeGreaterThan(0))
        fake.pause()
        toggle()
        await vi.waitFor(() => expect(playerStore.get().playing).toBe(true))
        expect(playerStore.get().positionS).toBe(100)
        expect(fake.src).toContain('one.m4b')
    })

    test('switching books never saves the new one at the start before its place is applied', () => {
        // The new file reports 0:00 while its metadata loads; that tick was saved as the book's
        // place, so a load that failed there lost it.
        playBook(book, 1700)
        fake.arrive()
        playBook({ ...book, id: 'bk_2', position_s: 3000 })
        fake.currentTime = 0
        fake.emit('timeupdate')
        expect(asked.filter((one) => one.path.includes('bk_2') && one.body !== undefined)).toEqual([])
    })

    test('a tick that arrives after signing out is ignored rather than thrown', () => {
        playBook(book, 100)
        fake.arrive()
        clear()
        expect(() => fake.emit('timeupdate')).not.toThrow()
    })

    test('a single file with no chapter marks has nothing to step between', () => {
        // Next and previous chapter were offered on such a book, and next did nothing.
        expect(bookStepCount({ ...book, chapter_list: [], files: book.files.slice(0, 1) })).toBe(1)
        expect(bookStepCount({ ...book, chapter_list: [] })).toBe(book.files.length)
        expect(bookStepCount(book)).toBe(book.chapter_list.length)
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

    test('picking it up again plays rather than needing the source put on twice', async () => {
        playBook(book, 100)
        fake.arrive()
        fake.pause()
        expect(playerStore.get().playing).toBe(false)
        toggle()
        // The server is asked for a newer place first; see `resumeBook`.
        await vi.waitFor(() => expect(playerStore.get().playing).toBe(true))
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

describe('leaving a book for a track', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', fakeStorage())
    })

    test('a seek still waiting on the book file does not land on the track', () => {
        playBook(book, 0)
        // Move into the second file while the element has no metadata for it: the seek is held.
        seek(1900)
        expect(fake.readyState).toBe(0)
        play(songs, 0)
        fake.currentTime = 0
        // The track's metadata arrives now; the book's held seek must not fire on it.
        fake.arrive()
        expect(fake.currentTime).toBe(0)
        expect(currentSong()?.title).toBe('One')
        expect(playerStore.get().book).toBeNull()
    })

    test('the reading speed does not follow into the music', () => {
        playBook(book, 0)
        setSpeed(1.5)
        expect(fake.playbackRate).toBe(1.5)
        play(songs, 0)
        expect(fake.playbackRate).toBe(1)
    })
})
