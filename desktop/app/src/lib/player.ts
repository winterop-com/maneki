/**
 * What is playing, for the whole app.
 *
 * ONE ELEMENT, OUTSIDE REACT. Music keeps playing while you browse, so the
 * audio element and the queue cannot live in a screen's state: they live
 * here, and the player bar reads them through a store. Navigating between
 * screens never touches playback.
 *
 * THE QUEUE IS A LIST AND A POSITION IN IT. Picking a track in an album
 * plays that album from there, which is what a listener means by it.
 *
 * THREE SOURCES, ONE TRANSPORT: a queue of songs, a station, and a book. A
 * book had a player of its own on its own screen once, which meant two
 * elements, two sets of buttons and a chapter that could be clicked while
 * the strip along the foot played something else. A listener has one pair of
 * ears, so there is one element and one bar, and what differs between the
 * three -- a station cannot be scrubbed, a book is several files behind one
 * timeline and keeps its place on the server -- is branches in here rather
 * than a second player.
 *
 * A BOOK'S POSITION IS ONE NUMBER, on the whole book's timeline rather than
 * a file and an offset: it is what the scrubber shows, what a chapter mark
 * means, and what the server stores. The arithmetic between that number and
 * the file the element is holding is `lib/book-timeline`, which has tests.
 */

import { books as booksApi } from '@/lib/api'
import { chapterAt, fileAt, positionOf } from '@/lib/book-timeline'
import {
    scrobble,
    stationNowPlaying,
    stationStreamUrl,
    streamUrl,
    type Credentials,
    type Song,
    type Station,
} from '@/lib/subsonic'
import {
    afterSkip,
    afterTrack,
    beforeTrack,
    buildOrder,
    nextRepeat,
    reorderAround,
    type Repeat,
} from '@/lib/queue'
import { claimSound, registerSilencer } from '@/lib/sound'
import { createStore } from '@/lib/store'
import type { BookDetail, BookFile, Chapter } from '@/lib/types'

/**
 * The book playing, as a transport needs it.
 *
 * A COPY OF THE FIELDS THE BAR DRAWS rather than the whole `BookDetail`, which also carries a
 * description, a catalogue id and a scan's worth of metadata no transport has a use for. What
 * it keeps is spelled the way the wire spells it, so the chapter list and the file table are
 * the same objects `lib/book-timeline` is given on the screen that read them.
 */
export interface PlayingBook {
    id: string
    title: string
    author: string
    /** Whether the server has a cover; the URL for one is `api.books.coverUrl` at a size. */
    has_cover: boolean
    duration_s: number
    chapter_list: Chapter[]
    files: BookFile[]
    /** How fast it is read. A book's own setting, kept between visits like the volume. */
    speed: number
}

export interface PlayerState {
    queue: Song[]
    /** Where in the queue we are; -1 when nothing has been played yet. */
    index: number
    /**
     * The order the queue is played in: positions into `queue`, shuffled or not.
     *
     * Kept apart from the queue itself so the panel can draw the album's own order while
     * playback follows another one -- see `lib/queue`.
     */
    order: number[]
    /** Where in `order` playback is; -1 when nothing has been played yet. */
    orderAt: number
    shuffle: boolean
    repeat: Repeat
    /** The station playing, when what is playing is a station rather than a queue. */
    station: Station | null
    /**
     * The book playing, when what is playing is a book rather than a queue or a station.
     *
     * While it is set, `positionS` and `durationS` are the book's own timeline rather than the
     * file the element happens to be holding, and the queue is empty: a book replaces what was
     * playing rather than joining it.
     */
    book: PlayingBook | null
    /**
     * What the station says it is playing, as its own stream announces it.
     *
     * Empty until it says: the server reads the ICY frames off the stream it is proxying, so
     * there is nothing to report until this listener has been connected long enough for one
     * to arrive.
     */
    stationTitle: string
    playing: boolean
    /**
     * Why the sound stopped, when it stopped for a reason rather than because it was asked to.
     *
     * Null the rest of the time, which is nearly all of it. The bar draws it where the artist
     * goes, because that is where somebody is already looking when they wonder why it is quiet.
     */
    refusal: string | null
    positionS: number
    durationS: number
    /** Between 0 and 1. Kept between visits, because it is a room rather than a track. */
    volume: number
    muted: boolean
}

/** Where the volume is kept between visits. */
const VOLUME_KEY = 'maneki.volume'

/**
 * The level this browser last set, or full.
 *
 * The string is checked before it is a number, because `Number(null)` is 0 and a missing key
 * would otherwise be read as "silent" -- an app that starts muted and shows no reason why.
 */
export function storedVolume(): number {
    try {
        const stored = localStorage.getItem(VOLUME_KEY)
        if (stored === null) return 1
        const level = Number(stored)
        return Number.isFinite(level) && level >= 0 && level <= 1 ? level : 1
    } catch {
        return 1
    }
}

/** Where the way somebody listens is kept between visits. */
const SHUFFLE_KEY = 'maneki.shuffle'
const REPEAT_KEY = 'maneki.repeat'
const SPEED_KEY = 'maneki.speed'

/** What a jump back or forward moves, the step audiobook players settle on. */
export const SKIP_S = 15

/** The speeds offered. Slower than three quarters is not reading, faster than double is not words. */
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

/** How much of a book may be lost to a closed laptop: ten seconds of it, at most. */
const SAVE_EVERY_S = 10

/** Past this many seconds in, "previous" means the beginning of what is playing. */
const RESTART_AFTER_S = 3

/** `HTMLMediaElement.HAVE_METADATA`: the point at which a seek is not thrown away. */
const HAVE_METADATA = 1

/**
 * How fast this browser last asked a book to be read, or as written.
 *
 * Checked before it is trusted for the same reason the volume is: a stored nothing read as a
 * number is 0, and a book played at zero speed is a book that never starts.
 */
function storedSpeed(): number {
    try {
        const held = Number(localStorage.getItem(SPEED_KEY))
        return SPEEDS.includes(held as (typeof SPEEDS)[number]) ? held : 1
    } catch {
        return 1
    }
}

function storedShuffle(): boolean {
    try {
        return localStorage.getItem(SHUFFLE_KEY) === 'true'
    } catch {
        return false
    }
}

function storedRepeat(): Repeat {
    try {
        const held = localStorage.getItem(REPEAT_KEY)
        return held === 'all' || held === 'one' ? held : 'off'
    } catch {
        return 'off'
    }
}

const EMPTY: PlayerState = {
    queue: [],
    index: -1,
    order: [],
    orderAt: -1,
    shuffle: storedShuffle(),
    repeat: storedRepeat(),
    station: null,
    book: null,
    stationTitle: '',
    playing: false,
    refusal: null,
    positionS: 0,
    durationS: 0,
    volume: storedVolume(),
    muted: false,
}

export const playerStore = createStore<PlayerState>(EMPTY)

let audio: HTMLAudioElement | null = null
let analyser: AnalyserNode | null = null
let graph: AudioContext | null = null
let credentials: Credentials | null = null
/** The track we last told the server about, so a repeat does not scrobble twice. */
let announced: string | null = null
/** The poll that follows a station's own announcements, while one is playing. */
let icy: ReturnType<typeof setInterval> | null = null
/** Undoes this player's registration with the sound arbiter when the element goes. */
let unregister: (() => void) | null = null
/**
 * Which of a book's files the element is holding.
 *
 * Read rather than derived: at a file's last second the position the store holds and the file
 * the element is playing disagree, and the difference is a jump of a whole file's length.
 */
let loadedFile = 0
/** The position the server was last told, so a save every ten seconds is every ten seconds. */
let savedAt = 0
/** Whether a tab going away already keeps the place. Registered once, undone by `clear`. */
let watchingPagehide = false

/** How often a station is asked what it is playing. Its own frames arrive about this often. */
const ICY_POLL_MS = 10_000

function stopIcy(): void {
    if (icy !== null) clearInterval(icy)
    icy = null
}

/**
 * Follow what a station announces, for as long as it is the thing playing.
 *
 * The title is read off the stream by the server as it proxies it, so it is asked for rather
 * than pushed, and only while somebody is listening: a poll against a station nobody is
 * connected to answers with nothing, forever.
 */
function followIcy(station: Station): void {
    stopIcy()
    const ask = () => {
        if (!credentials || state().station?.id !== station.id) {
            stopIcy()
            return
        }
        void stationNowPlaying(credentials, station).then((title) => {
            if (state().station?.id === station.id) patch({ stationTitle: title })
        })
    }
    ask()
    icy = setInterval(ask, ICY_POLL_MS)
}

function state(): PlayerState {
    return playerStore.get()
}

function patch(change: Partial<PlayerState>): void {
    playerStore.set({ ...state(), ...change })
}

export function currentSong(): Song | null {
    const { queue, index, book } = state()
    // A book is not a track: everything that asks for the song asks in order to draw a title, a
    // star or a set of words, and none of those is a thing a book has.
    if (book) return null
    return index >= 0 && index < queue.length ? queue[index]! : null
}

/** The chapter the book is inside, or null for music and for a book carrying no chapter marks. */
export function currentChapter(): Chapter | null {
    const { book, positionS } = state()
    if (!book) return null
    const at = chapterAt(book.chapter_list, positionS)
    return at < 0 ? null : (book.chapter_list[at] ?? null)
}

/** Point the player at a server. Called whenever the session changes. */
export function setPlayerCredentials(next: Credentials | undefined): void {
    credentials = next ?? null
}

/** How this player is asked to stop by whatever else wants the sound. */
function silence(): void {
    audio?.pause()
}

function element(): HTMLAudioElement {
    if (audio) return audio
    audio = new Audio()
    // Only one thing makes sound at a time: a video starting stops this, and this starting
    // stops the video. Music, a station and a book are all this element, so between those
    // three there is nothing to arbitrate.
    unregister = registerSilencer(silence)
    audio.preload = 'metadata'
    audio.volume = state().volume
    audio.muted = state().muted
    // The spectrum reads the audio through a WebAudio graph, and the browser
    // only lets it read audio it is allowed to: without this, a stream from
    // another origin is silently unreadable and the spectrum stays flat.
    audio.crossOrigin = 'anonymous'
    audio.addEventListener('timeupdate', () => {
        const { book } = state()
        if (!book) {
            patch({ positionS: audio!.currentTime })
            return
        }
        const at = positionOf(book.files, loadedFile, audio!.currentTime)
        patch({ positionS: at })
        if (Math.abs(at - savedAt) >= SAVE_EVERY_S) saveBook(at)
    })
    audio.addEventListener('durationchange', () => {
        // A book's length is the book's, not the file's: the element is holding one of several
        // and would otherwise shrink the scrubber to whatever chapter is loaded.
        if (state().book) return
        patch({ durationS: Number.isFinite(audio!.duration) ? audio!.duration : 0 })
    })
    // Sound coming out is the answer to whatever went wrong last time, so the line goes.
    audio.addEventListener('play', () => patch({ playing: true, refusal: null }))
    audio.addEventListener('error', onElementError)
    audio.addEventListener('pause', () => {
        patch({ playing: false })
        // Stopping is the moment a place is worth keeping, and the one a listener expects to
        // come back to.
        if (state().book) saveBook(state().positionS)
    })
    audio.addEventListener('ended', () => {
        if (state().book) {
            onFileEnded()
            return
        }
        const song = currentSong()
        if (song && credentials) void scrobble(credentials, song.id, true)
        onEnded()
    })
    return audio
}

/**
 * What the element giving up looks like from here.
 *
 * A DEAD SOURCE HAS TO SAY SO. An element that cannot play what it was handed fires this and
 * then does nothing further -- no `pause`, no `ended` -- so a bar reading its own flags says
 * "playing" over silence until somebody presses something. A blacklisted station, a 404 off a
 * moved file, a server that went away mid-track all arrive here.
 *
 * The station's poll stops with it. A now-playing question against a stream this listener is no
 * longer connected to is answered with nothing, every ten seconds, for as long as the tab is
 * open.
 */
function onElementError(): void {
    stopIcy()
    patch({ playing: false, refusal: refusalOf() })
}

/** What to say about it, which is as much as the element is willing to say. */
function refusalOf(): string {
    const { station, book } = state()
    if (station) return `No sound from ${station.name}.`
    if (book) return 'This part of the book would not play.'
    return currentSong() ? 'This track would not play.' : 'That would not play.'
}

/** Play the track at position `orderAt` of the play order. */
function loadAt(orderAt: number, autoplay: boolean): void {
    const { order } = state()
    const index = order[orderAt]
    if (index === undefined) return
    load(index, autoplay, orderAt)
}

function load(index: number, autoplay: boolean, orderAt?: number): void {
    const { queue, order } = state()
    const song = queue[index]
    if (!song || !credentials) return
    const player = element()
    player.src = streamUrl(credentials, song.id)
    patch({
        index,
        orderAt: orderAt ?? order.indexOf(index),
        positionS: 0,
        durationS: song.duration ?? 0,
        // A new source is a fresh chance: whatever the last one refused with is not this
        // one's news, and if this one fails too it will say so itself.
        refusal: null,
    })
    if (announced !== song.id) {
        announced = song.id
        void scrobble(credentials, song.id, false)
    }
    if (autoplay) void player.play().catch(() => patch({ playing: false }))
}

/** Play `songs`, starting at `startIndex`. */
export function play(songs: Song[], startIndex = 0): void {
    if (!songs.length) return
    stopIcy()
    leaveBook()
    claimSound(silence)
    const at = Math.min(Math.max(0, startIndex), songs.length - 1)
    const order = buildOrder(songs.length, at, state().shuffle)
    patch({ queue: songs, order, station: null, book: null, stationTitle: '' })
    load(at, true, order.indexOf(at))
}

/**
 * Play a station.
 *
 * A station is not a queue of one: it has no length, no end, and nothing to
 * skip to, so it replaces whatever was playing and the transport says so.
 */
export function playStation(station: Station): void {
    if (!credentials) return
    const player = element()
    leaveBook()
    claimSound(silence)
    player.src = stationStreamUrl(credentials, station)
    patch({
        queue: [],
        index: -1,
        station,
        book: null,
        stationTitle: '',
        refusal: null,
        positionS: 0,
        durationS: 0,
    })
    void player.play().catch(() => patch({ playing: false }))
    followIcy(station)
}

/**
 * Playing a book, on the same element and the same bar as everything else.
 *
 * `atS` is a place on the book's timeline -- a chapter's start, a scrubber's value -- and
 * without one the book opens where this account stopped, which is the whole point of a book
 * remembering anything.
 */
export function playBook(book: BookDetail, atS?: number): void {
    stopIcy()
    // Another book's place is worth keeping; this one's is about to be overwritten by the
    // position being opened, and two saves racing could land in the wrong order.
    const held = state().book
    if (held && held.id !== book.id) saveBook(state().positionS)
    const playing: PlayingBook = {
        id: book.id,
        title: book.title,
        author: book.author,
        has_cover: book.has_cover,
        duration_s: book.duration_s,
        chapter_list: book.chapter_list,
        files: book.files,
        speed: storedSpeed(),
    }
    // A FINISHED BOOK OPENS AT ITS BEGINNING. The place it kept is the fact that it was
    // finished, so resuming there is two seconds of the last chapter and then nothing; asking
    // for a book somebody has already read is asking to read it again.
    const opened = book.finished || book.position_s >= book.duration_s ? 0 : book.position_s
    const at = Math.min(Math.max(0, atS ?? opened), book.duration_s)
    savedAt = at
    patch({
        queue: [],
        index: -1,
        order: [],
        orderAt: -1,
        station: null,
        stationTitle: '',
        book: playing,
        positionS: at,
        durationS: book.duration_s,
    })
    keepPlaceOnPagehide()
    placeBook(at, true)
}

/** Tell the server where the listener is. A failure is the next tick's problem, not theirs. */
function saveBook(at: number, finished?: boolean): void {
    const { book } = state()
    if (!book) return
    savedAt = at
    void booksApi.saveProgress(book.id, at, finished).catch(() => {
        // A lost save is retried by the next tick; nothing to tell the listener.
    })
}

/** The seek waiting on a file's metadata, if one is. See `placeBook`. */
let heldSeek: (() => void) | null = null

/** Forget a seek that was waiting on metadata, because the element is going elsewhere. */
function dropHeldSeek(): void {
    if (heldSeek === null) return
    audio?.removeEventListener('loadedmetadata', heldSeek)
    heldSeek = null
}

/**
 * Give the book up, keeping its place: something else is about to take the element.
 *
 * Everything the book set on the element goes with it -- a seek still waiting on the file's
 * metadata, and the reading speed, which a track played at 1.5x would otherwise inherit.
 */
function leaveBook(): void {
    if (!state().book) return
    saveBook(state().positionS)
    dropHeldSeek()
    if (audio) audio.playbackRate = 1
    patch({ book: null })
}

/**
 * Put the element on the file holding `at`, and the playhead at the offset into it.
 *
 * A SEEK WAITS FOR THE ELEMENT TO BE ABLE TO TAKE IT. Writing `currentTime` before the media
 * has its metadata is discarded silently: the element stays where it was, the next `timeupdate`
 * writes that position back into the store, and picking a chapter looks like it did nothing at
 * all. So the write is held until `loadedmetadata` whenever the element is not ready for it.
 */
function placeBook(at: number, resume: boolean): void {
    const { book } = state()
    if (!book) return
    const player = element()
    const { index, offsetS } = fileAt(book.files, at)
    const file = book.files.find((one) => one.index === index)
    if (!file) return
    const wanted = booksApi.fileUrl(file.url)
    const changing = player.src !== wanted
    if (changing) {
        player.src = wanted
        loadedFile = index
    }
    dropHeldSeek()
    if (!changing && player.readyState >= HAVE_METADATA) {
        player.currentTime = offsetS
    } else {
        // Held, and remembered: a source that takes the element before this file's metadata
        // arrives must take the seek back with it, or the next track starts wherever the
        // chapter was going to.
        heldSeek = () => {
            heldSeek = null
            player.currentTime = offsetS
        }
        player.addEventListener('loadedmetadata', heldSeek, { once: true })
    }
    // Set on every placement rather than once: a new file is a fresh element state, and a book
    // that fell back to single speed at every file boundary would be read by nobody.
    player.playbackRate = book.speed
    patch({ positionS: at, durationS: book.duration_s, refusal: null })
    if (resume) {
        claimSound(silence)
        void player.play().catch(() => patch({ playing: false }))
    }
}

/** What the end of one of a book's files does: carry on, or finish the book. */
function onFileEnded(): void {
    const { book } = state()
    if (!book) return
    const following = book.files.find((one) => one.index === loadedFile + 1)
    if (following) {
        placeBook(following.offset_s, true)
        return
    }
    patch({ playing: false, positionS: book.duration_s })
    saveBook(book.duration_s, true)
}

/**
 * The points a book steps between.
 *
 * Its chapters, where it has them; where it has none, the files it is made of, which are a
 * disc or an hour each and are the only division the book actually carries.
 */
function bookStops(book: PlayingBook): number[] {
    if (book.chapter_list.length > 0) return book.chapter_list.map((chapter) => chapter.start_s)
    return book.files.map((file) => file.offset_s)
}

/** Walk a book by chapters: what next and previous mean when what is playing is a book. */
function stepBook(step: -1 | 1): void {
    const { book, positionS } = state()
    if (!book) return
    const stops = bookStops(book)
    if (stops.length === 0) return
    let at = 0
    for (let index = 0; index < stops.length; index += 1) {
        if (positionS >= stops[index]!) at = index
    }
    // Past the first few seconds, "previous" means "start this chapter again", which is what
    // every player does and what a listener reaching for it expects.
    const wanted = step < 0 && positionS - stops[at]! > RESTART_AFTER_S ? at : at + step
    // The far end of the book is not a chapter: pressing next on the last one would otherwise
    // play it a second time, which is not what the press asked for.
    if (wanted >= stops.length) return
    seek(stops[Math.max(0, wanted)]!)
}

/** Jump by `seconds`, which is what the two round arrows on the bar do. */
export function skipBy(seconds: number): void {
    seek(state().positionS + seconds)
}

/**
 * Play the book already on the element, from `atS`.
 *
 * What a chapter row in the side panel does, and it starts rather than scrubs: picking a
 * chapter out of a list is asking to hear it, where dragging the scrubber is not.
 */
export function playChapter(atS: number): void {
    const { book } = state()
    if (!book) return
    const at = Math.min(Math.max(0, atS), book.duration_s)
    placeBook(at, true)
    saveBook(at)
}

/** How fast a book is read. Kept between visits, because it is how somebody listens. */
export function setSpeed(rate: number): void {
    const held = Math.min(Math.max(SPEEDS[0], rate), SPEEDS[SPEEDS.length - 1]!)
    try {
        localStorage.setItem(SPEED_KEY, String(held))
    } catch {
        // Storage denied: the speed holds for as long as this document is open.
    }
    if (audio) audio.playbackRate = held
    const { book } = state()
    if (book) patch({ book: { ...book, speed: held } })
}

/**
 * A tab going away keeps the place.
 *
 * `pagehide` rather than `unload`, which a browser that put the page in its back-forward cache
 * never fires. Registered when a book first plays and undone by `clear`, so a session that only
 * ever played music never binds it.
 */
function keepPlaceOnPagehide(): void {
    if (watchingPagehide || typeof window === 'undefined') return
    watchingPagehide = true
    window.addEventListener('pagehide', onPagehide)
}

function onPagehide(): void {
    if (state().book) saveBook(state().positionS)
}

export function toggle(): void {
    const player = element()
    const { station, book } = state()
    if (!currentSong() && !station && !book) return
    if (player.paused) {
        claimSound(silence)
        // A book whose element holds nothing has been picked up rather than resumed -- the
        // source is put on before it is asked to play.
        if (book && !player.src) placeBook(state().positionS, true)
        else void player.play().catch(() => patch({ playing: false }))
    } else player.pause()
}

export function next(): void {
    const { order, orderAt, station, book, repeat } = state()
    if (station) return // a station has nothing to skip to
    if (book) {
        stepBook(1)
        return
    }
    const moved = afterSkip(order, orderAt, repeat)
    if (moved === null) patch({ playing: false })
    else loadAt(moved, true)
}

/** What a track ending does, which is not the same as pressing skip -- see `lib/queue`. */
function onEnded(): void {
    const { order, orderAt, repeat } = state()
    const moved = afterTrack(order, orderAt, repeat)
    if (moved === null) {
        patch({ playing: false })
        return
    }
    // Repeat-one lands on the same position, and a browser will not replay a track by being
    // asked for the same src: it is rewound instead.
    if (moved === orderAt) {
        seek(0)
        const player = element()
        void player.play().catch(() => patch({ playing: false }))
        return
    }
    loadAt(moved, true)
}

export function previous(): void {
    const { order, orderAt, station, book, repeat } = state()
    if (station) return
    if (book) {
        stepBook(-1)
        return
    }
    // Past the first few seconds, "previous" means "start this one again",
    // which is what every player does and what a listener expects.
    if (state().positionS > RESTART_AFTER_S) {
        seek(0)
        return
    }
    const moved = beforeTrack(order, orderAt, repeat)
    if (moved === null) seek(0)
    else loadAt(moved, true)
}

/** Play in a surprising order, or back in the album's own. What is playing keeps playing. */
export function toggleShuffle(): void {
    const { order, orderAt, shuffle } = state()
    const wanted = !shuffle
    try {
        localStorage.setItem(SHUFFLE_KEY, String(wanted))
    } catch {
        // Storage denied: the choice holds while this document is open.
    }
    if (order.length === 0 || orderAt < 0) {
        patch({ shuffle: wanted })
        return
    }
    const rebuilt = reorderAround(order, orderAt, wanted)
    patch({ shuffle: wanted, order: rebuilt.order, orderAt: rebuilt.at })
}

/** Cycle what happens at the end of the queue: off, the whole queue, this track. */
export function cycleRepeat(): Repeat {
    const wanted = nextRepeat(state().repeat)
    try {
        localStorage.setItem(REPEAT_KEY, wanted)
    } catch {
        // Storage denied: the choice holds while this document is open.
    }
    patch({ repeat: wanted })
    return wanted
}

/** How loud, between 0 and 1. Setting it unmutes: moving the slider is asking to hear it. */
export function setVolume(volume: number): void {
    const held = Math.min(1, Math.max(0, volume))
    if (audio) {
        audio.volume = held
        audio.muted = false
    }
    try {
        localStorage.setItem(VOLUME_KEY, String(held))
    } catch {
        // Storage denied: the level holds for as long as this document is open.
    }
    patch({ volume: held, muted: false })
}

/** Silence without forgetting the level, which is what unmuting puts back. */
export function toggleMuted(): void {
    const muted = !state().muted
    if (audio) audio.muted = muted
    patch({ muted })
}

export function seek(positionS: number): void {
    const { book } = state()
    // A BOOK IS SEEKED ON ITS OWN TIMELINE, so a scrub across a file boundary is the same
    // gesture as one inside a file: the position is placed rather than written, and the place
    // is kept, which is what makes the counter on the shelf right after a jump.
    if (book) {
        const at = Math.min(Math.max(0, positionS), book.duration_s)
        placeBook(at, !element().paused)
        saveBook(at)
        return
    }
    const player = element()
    player.currentTime = Math.max(0, positionS)
    patch({ positionS: player.currentTime })
}

/**
 * The spectrum's tap into what is playing, built on first use.
 *
 * A browser will not start an audio graph before someone has asked for sound,
 * so this is built when playback starts rather than at load, and resumed each
 * time in case the browser suspended it.
 */
export function spectrum(): AnalyserNode | null {
    if (!audio) return null
    if (analyser) {
        if (graph?.state === 'suspended') void graph.resume()
        return analyser
    }
    try {
        graph = new AudioContext()
        const source = graph.createMediaElementSource(audio)
        analyser = graph.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.78
        // The window the bytes are scaled over. The default (-100..-30 dB) leaves music
        // sitting in the bottom third of the range; the old graph read -85..-15, which is
        // where a mastered record lives, and the bars use their height.
        analyser.minDecibels = -85
        analyser.maxDecibels = -15
        source.connect(analyser)
        analyser.connect(graph.destination)
    } catch {
        // No graph means no spectrum; the audio still plays.
        analyser = null
    }
    return analyser
}

/**
 * The graph the spectrum is tapped off, for what only the graph itself knows.
 *
 * Its clock is what a frame is stamped with, and what it says about its own latency is how far
 * behind the analyser the speakers are -- see `lib/sync`. Null until something has played.
 */
export function spectrumContext(): AudioContext | null {
    return graph
}

/** Stop, forget the queue, and let the element go. Used when the session goes away. */
export function clear(): void {
    stopIcy()
    // The place goes to the server before the element does: a sign-out mid-chapter is still an
    // hour of listening somebody expects to come back to. Given up first as well, so the pause
    // below is not a second save of the same second.
    leaveBook()
    if (watchingPagehide && typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPagehide)
    }
    watchingPagehide = false
    loadedFile = 0
    savedAt = 0
    unregister?.()
    unregister = null
    audio?.pause()
    if (audio) audio.src = ''
    audio = null
    analyser = null
    void graph?.close()
    graph = null
    announced = null
    playerStore.set({
        ...EMPTY,
        volume: state().volume,
        muted: state().muted,
        shuffle: state().shuffle,
        repeat: state().repeat,
    })
}
