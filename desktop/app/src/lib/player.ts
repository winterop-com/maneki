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

import { scrobble, streamUrl, type Credentials, type Song } from '@/lib/subsonic'
import { createStore } from '@/lib/store'

export interface PlayerState {
    queue: Song[]
    /** Where in the queue we are; -1 when nothing has been played yet. */
    index: number
    playing: boolean
    positionS: number
    durationS: number
}

const EMPTY: PlayerState = { queue: [], index: -1, playing: false, positionS: 0, durationS: 0 }

export const playerStore = createStore<PlayerState>(EMPTY)

let audio: HTMLAudioElement | null = null
let credentials: Credentials | null = null
/** The track we last told the server about, so a repeat does not scrobble twice. */
let announced: string | null = null

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

function element(): HTMLAudioElement {
    if (audio) return audio
    audio = new Audio()
    audio.preload = 'metadata'
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
    patch({ queue: songs })
    load(Math.min(Math.max(0, startIndex), songs.length - 1), true)
}

export function toggle(): void {
    const player = element()
    if (!currentSong()) return
    if (player.paused) void player.play().catch(() => patch({ playing: false }))
    else player.pause()
}

export function next(): void {
    const { index, queue } = state()
    if (index + 1 < queue.length) load(index + 1, true)
    else patch({ playing: false })
}

export function previous(): void {
    const { index } = state()
    // Past the first few seconds, "previous" means "start this one again",
    // which is what every player does and what a listener expects.
    if (state().positionS > 3) {
        seek(0)
        return
    }
    if (index > 0) load(index - 1, true)
    else seek(0)
}

export function seek(positionS: number): void {
    const player = element()
    player.currentTime = Math.max(0, positionS)
    patch({ positionS: player.currentTime })
}

/** Stop, forget the queue, and let the element go. Used when the session goes away. */
export function clear(): void {
    audio?.pause()
    if (audio) audio.src = ''
    audio = null
    announced = null
    playerStore.set(EMPTY)
}
