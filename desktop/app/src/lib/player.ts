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
 */

import {
    scrobble,
    stationNowPlaying,
    stationStreamUrl,
    streamUrl,
    type Credentials,
    type Song,
    type Station,
} from '@/lib/subsonic'
import { claimSound, registerSilencer } from '@/lib/sound'
import { createStore } from '@/lib/store'

export interface PlayerState {
    queue: Song[]
    /** Where in the queue we are; -1 when nothing has been played yet. */
    index: number
    /** The station playing, when what is playing is a station rather than a queue. */
    station: Station | null
    /**
     * What the station says it is playing, as its own stream announces it.
     *
     * Empty until it says: the server reads the ICY frames off the stream it is proxying, so
     * there is nothing to report until this listener has been connected long enough for one
     * to arrive.
     */
    stationTitle: string
    playing: boolean
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

const EMPTY: PlayerState = {
    queue: [],
    index: -1,
    station: null,
    stationTitle: '',
    playing: false,
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
    const { queue, index } = state()
    return index >= 0 && index < queue.length ? queue[index]! : null
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
    // Only one thing makes sound at a time: a book started on its own screen stops this,
    // and starting this stops the book.
    unregister = registerSilencer(silence)
    audio.preload = 'metadata'
    audio.volume = state().volume
    audio.muted = state().muted
    // The spectrum reads the audio through a WebAudio graph, and the browser
    // only lets it read audio it is allowed to: without this, a stream from
    // another origin is silently unreadable and the spectrum stays flat.
    audio.crossOrigin = 'anonymous'
    audio.addEventListener('timeupdate', () => patch({ positionS: audio!.currentTime }))
    audio.addEventListener('durationchange', () => {
        patch({ durationS: Number.isFinite(audio!.duration) ? audio!.duration : 0 })
    })
    audio.addEventListener('play', () => patch({ playing: true }))
    audio.addEventListener('pause', () => patch({ playing: false }))
    audio.addEventListener('ended', () => {
        const song = currentSong()
        if (song && credentials) void scrobble(credentials, song.id, true)
        next()
    })
    return audio
}

function load(index: number, autoplay: boolean): void {
    const { queue } = state()
    const song = queue[index]
    if (!song || !credentials) return
    const player = element()
    player.src = streamUrl(credentials, song.id)
    patch({ index, positionS: 0, durationS: song.duration ?? 0 })
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
    claimSound(silence)
    patch({ queue: songs, station: null, stationTitle: '' })
    load(Math.min(Math.max(0, startIndex), songs.length - 1), true)
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
    claimSound(silence)
    player.src = stationStreamUrl(credentials, station)
    patch({ queue: [], index: -1, station, stationTitle: '', positionS: 0, durationS: 0 })
    void player.play().catch(() => patch({ playing: false }))
    followIcy(station)
}

export function toggle(): void {
    const player = element()
    if (!currentSong() && !state().station) return
    if (player.paused) {
        claimSound(silence)
        void player.play().catch(() => patch({ playing: false }))
    } else player.pause()
}

export function next(): void {
    const { index, queue, station } = state()
    if (station) return // a station has nothing to skip to
    if (index + 1 < queue.length) load(index + 1, true)
    else patch({ playing: false })
}

export function previous(): void {
    const { index, station } = state()
    if (station) return
    // Past the first few seconds, "previous" means "start this one again",
    // which is what every player does and what a listener expects.
    if (state().positionS > 3) {
        seek(0)
        return
    }
    if (index > 0) load(index - 1, true)
    else seek(0)
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
        analyser.smoothingTimeConstant = 0.8
        source.connect(analyser)
        analyser.connect(graph.destination)
    } catch {
        // No graph means no spectrum; the audio still plays.
        analyser = null
    }
    return analyser
}

/** Stop, forget the queue, and let the element go. Used when the session goes away. */
export function clear(): void {
    stopIcy()
    unregister?.()
    unregister = null
    audio?.pause()
    if (audio) audio.src = ''
    audio = null
    analyser = null
    void graph?.close()
    graph = null
    announced = null
    playerStore.set({ ...EMPTY, volume: state().volume, muted: state().muted })
}
