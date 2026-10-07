/**
 * What is playing, told to the operating system: the media keys, the Now Playing widget, the
 * lock screen.
 *
 * THE KEYS ON THE KEYBOARD ARE THE OS'S, NOT THE PAGE'S. Play/pause, next and previous never
 * arrive as key presses; the OS sends them to whichever app last said it was playing media,
 * and a page says so through the Media Session API. Without this, the keys start Apple Music
 * while maneki is playing, and the Now Playing widget names nothing.
 *
 * WHAT IS PURE IS SEPARATE, as in `lib/window-drag`. What to show, which keys apply and when the
 * OS needs a fresh position are decisions about the player's state, and they are the part worth
 * a test. The installer is the one place that touches `navigator.mediaSession`.
 *
 * THE OS IS TOLD WHEN SOMETHING CHANGED, NOT ON EVERY TICK. The player publishes four times a
 * second; the OS extrapolates a playing position by itself, so it is given a new one only when
 * the track changes, playback starts or stops, or the position jumps (a seek, a chapter).
 */

import { books as booksApi } from '@/lib/api'
import { chapterAt } from '@/lib/book-timeline'
import { announced } from '@/lib/liner'
import { next, playerStore, previous, seek, skipBy, SKIP_S, toggle, type PlayerState } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'

/** The size the OS is asked to draw the artwork at; the widget and the lock screen are small. */
const ARTWORK_SIZE = 512

/** How far the position may wander from where the OS thinks it is before it is told again. */
const DRIFT_S = 1.5

/** What the OS shows, and which of its controls mean anything for it. */
export interface NowPlaying {
    title: string
    artist: string
    album: string
    artwork: string | null
    /** A timeline to scrub and jump along. A station has none. */
    seekable: boolean
    /** Something before and after it. A station has neither. */
    steps: boolean
}

/**
 * What the OS should show for this state, or null when nothing is playing.
 *
 * A chapter is shown the way a track is: its title, with the book's author as the artist and
 * the book as the album, which is the shape every Now Playing surface already has room for.
 */
export function nowPlaying(state: PlayerState, artwork: string | null): NowPlaying | null {
    const { book, station } = state
    if (book) {
        const at = chapterAt(book.chapter_list, state.positionS)
        const chapter = at < 0 ? null : (book.chapter_list[at] ?? null)
        return {
            title: chapter?.title ?? book.title,
            artist: book.author,
            album: chapter ? book.title : '',
            artwork,
            seekable: true,
            steps: true,
        }
    }
    if (station) {
        // What the station says it is playing, under the station's own name; before it says,
        // the station is the title.
        return {
            title: state.stationTitle ? announced(state.stationTitle, station.name) : station.name,
            artist: state.stationTitle ? station.name : '',
            album: '',
            artwork,
            seekable: false,
            steps: false,
        }
    }
    const song = state.queue[state.index]
    if (!song) return null
    return {
        title: song.title,
        artist: song.artist ?? '',
        album: song.album ?? '',
        artwork,
        seekable: true,
        steps: true,
    }
}

/** One string per distinct thing shown, so the OS is told about a new one exactly once. */
export function identity(shown: NowPlaying | null): string {
    if (shown === null) return ''
    return [shown.title, shown.artist, shown.album, shown.artwork ?? ''].join('\u0000')
}

/** Where the OS was last told the position was, and when. */
export interface Told {
    positionS: number
    atMs: number
    playing: boolean
    rate: number
}

/**
 * Whether the OS needs the position again.
 *
 * It does when playback started or stopped, when the speed changed, and when the position is
 * not where the OS has been extrapolating it to: a seek, a skip, a chapter jump.
 */
export function needsPosition(told: Told | null, now: Told): boolean {
    if (told === null) return true
    if (told.playing !== now.playing || told.rate !== now.rate) return true
    const elapsedS = told.playing ? ((now.atMs - told.atMs) / 1000) * told.rate : 0
    return Math.abs(told.positionS + elapsedS - now.positionS) > DRIFT_S
}

/** The artwork for what is playing, at the size the OS draws it. */
function artworkFor(state: PlayerState): string | null {
    if (state.book) return state.book.has_cover ? booksApi.coverUrl(state.book.id, ARTWORK_SIZE) : null
    const music = sessionStore.get().music
    if (!music) return null
    // A station's logo is its cover: what the lock screen shows while it plays.
    if (state.station) return coverUrl(music, state.station.coverArt, ARTWORK_SIZE)
    const song = state.queue[state.index]
    if (!song) return null
    return coverUrl(music, song.coverArt, ARTWORK_SIZE)
}

/** Tell the OS about the player from now on. Installed once, from `main`. */
export function installMediaSession(): void {
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaSession
    if (!media) return

    // Each control is set once and asks the player what it means at the moment it is pressed,
    // so a key pressed during a station does nothing rather than something stale.
    const handle = (action: MediaSessionAction, run: (details: MediaSessionActionDetails) => void) => {
        try {
            media.setActionHandler(action, run)
        } catch {
            // An action this browser does not know: the rest still work.
        }
    }
    handle('play', () => {
        if (!playerStore.get().playing) toggle()
    })
    handle('pause', () => {
        if (playerStore.get().playing) toggle()
    })
    handle('nexttrack', () => {
        if (!playerStore.get().station) next()
    })
    handle('previoustrack', () => {
        if (!playerStore.get().station) previous()
    })
    handle('seekto', (details) => {
        if (!playerStore.get().station && details.seekTime !== undefined) seek(details.seekTime)
    })
    handle('seekbackward', (details) => {
        if (!playerStore.get().station) skipBy(-(details.seekOffset ?? SKIP_S))
    })
    handle('seekforward', (details) => {
        if (!playerStore.get().station) skipBy(details.seekOffset ?? SKIP_S)
    })

    let shownAs = ''
    let told: Told | null = null

    const sync = () => {
        const state = playerStore.get()
        const shown = nowPlaying(state, artworkFor(state))
        const key = identity(shown)
        if (key !== shownAs) {
            shownAs = key
            told = null
            media.metadata =
                shown === null
                    ? null
                    : new MediaMetadata({
                          title: shown.title,
                          artist: shown.artist,
                          album: shown.album,
                          artwork: shown.artwork
                              ? [
                                    {
                                        src: shown.artwork,
                                        sizes: `${String(ARTWORK_SIZE)}x${String(ARTWORK_SIZE)}`,
                                    },
                                ]
                              : [],
                      })
        }
        media.playbackState = shown === null ? 'none' : state.playing ? 'playing' : 'paused'
        if (shown === null || !shown.seekable || state.durationS <= 0) return
        const now: Told = {
            positionS: Math.min(state.positionS, state.durationS),
            atMs: Date.now(),
            playing: state.playing,
            rate: state.book?.speed ?? 1,
        }
        if (!needsPosition(told, now)) return
        told = now
        try {
            media.setPositionState({
                duration: state.durationS,
                position: now.positionS,
                playbackRate: now.rate,
            })
        } catch {
            // A position the browser will not take (a duration still settling): the next sync tries again.
            told = null
        }
    }

    playerStore.subscribe(sync)
    sync()
}
