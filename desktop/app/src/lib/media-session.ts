/**
 * What is playing, told to the operating system: the media keys, the Now Playing widget, the
 * lock screen.
 *
 * THE KEYS ON THE KEYBOARD ARE THE OS'S, NOT THE PAGE'S. Play/pause, next and previous never
 * arrive as key presses; the OS sends them to whichever app last said it was playing media,
 * and a page says so through the Media Session API. Telling it, and telling the position again
 * only when it strays, is sokkel-ui-media's `useMediaSession`. What is maneki's is here: what a
 * track, a chapter or a station is shown as, a screen with a video claiming the controls, and
 * the window's title.
 */

import { useEffect, useState } from 'react'

import { useMediaSession, type MediaSessionInfo } from '@winterop-com/sokkel-ui-media/use-media-session'
import { useStore } from '@winterop-com/sokkel-ui/hooks/use-store'
import { createStore } from '@winterop-com/sokkel-ui/lib/stored'
import { books as booksApi } from '@/lib/api'
import { chapterAt } from '@/lib/book-timeline'
import { announced } from '@/lib/liner'
import { next, playerStore, previous, seek, skipBy, SKIP_S, toggle, type PlayerState } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { keptCover } from '@/lib/offline'
import { coverUrl } from '@/lib/subsonic'

/** The size the OS is asked to draw the artwork at; the widget and the lock screen are small. */
const ARTWORK_SIZE = 512

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

/** The artwork as the OS takes it, at the size it draws it. */
function pictures(artwork: string | null): MediaSessionInfo['artwork'] {
    return artwork === null
        ? undefined
        : [{ src: artwork, sizes: `${String(ARTWORK_SIZE)}x${String(ARTWORK_SIZE)}` }]
}

/**
 * The player as the OS is told it, or null when nothing plays. A station offers play and pause
 * alone: it has no position, and nothing before or after it.
 */
export function playerSession(state: PlayerState, artwork: string | null): MediaSessionInfo | null {
    const shown = nowPlaying(state, artwork)
    if (shown === null) return null
    const { playing } = state
    return {
        title: shown.title,
        artist: shown.artist,
        album: shown.album,
        artwork: pictures(shown.artwork),
        playing,
        duration: shown.seekable ? state.durationS : undefined,
        position: shown.seekable ? Math.min(state.positionS, state.durationS) : undefined,
        rate: state.book?.speed ?? 1,
        skip: SKIP_S,
        handlers: {
            play: () => {
                if (!playerStore.get().playing) toggle()
            },
            pause: () => {
                if (playerStore.get().playing) toggle()
            },
            ...(shown.steps ? { nexttrack: next, previoustrack: previous } : {}),
            ...(shown.seekable
                ? {
                      seekto: seek,
                      seekbackward: (seconds: number) => skipBy(-seconds),
                      seekforward: (seconds: number) => skipBy(seconds),
                  }
                : {}),
        },
    }
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
    // A downloaded album's kept cover: the lock screen and media keys keep it with no server.
    return keptCover(song.albumId) ?? coverUrl(music, song.coverArt, ARTWORK_SIZE)
}

/**
 * What a screen playing its own picture tells the OS while it is open.
 *
 * ONE THING MAKES SOUND, AND THE OS CONTROLS ARE ITS. Only the music player ever spoke to the
 * Media Session, so while a film played the lock screen still showed the station paused under
 * it, and a media key started the station and stopped the film. A screen with a video on it
 * claims the session for as long as it is open, the way it claims Space and `m`.
 */
export interface ScreenMedia {
    title: string
    artwork: string | null
    play: () => void
    pause: () => void
    /** Read when the OS is told, so a pause the player made itself is reported too. */
    playing: () => boolean
}

const screenMedia = createStore<ScreenMedia | null>(null)

/** Hold the OS controls until the returned function is called. A later claim wins. */
export function claimMediaSession(media: ScreenMedia): () => void {
    screenMedia.set(media)
    return () => {
        if (screenMedia.get() === media) screenMedia.set(null)
    }
}

/** A claiming screen as the OS is told it: its title and picture, and play and pause alone. */
export function screenSession(screen: ScreenMedia): MediaSessionInfo {
    return {
        title: screen.title,
        artwork: pictures(screen.artwork),
        playing: screen.playing(),
        handlers: { play: screen.play, pause: screen.pause },
    }
}

/** How often a claimed session's play state is told again, since the player does not say. */
const CLAIM_POLL_MS = 1000

/**
 * The window's title: what is playing, then the app.
 *
 * It was "Maneki" whatever played, so the window could not be told from its neighbours when
 * switching, and a screen reader announced the app's name alone. A chapter names its book too:
 * chapters are mostly called "Chapter 2", which says nothing about which book is playing.
 */
export function windowTitle(
    shown: (Pick<NowPlaying, 'title' | 'artist'> & { book?: string }) | null,
): string {
    if (shown === null) return APP_TITLE
    return [shown.title, shown.book ?? '', shown.artist, APP_TITLE]
        .filter((part) => part.trim() !== '')
        .join(' · ')
}

const APP_TITLE = 'maneki'

/** Tell the OS about the player, or the screen that claimed it, for as long as this is mounted. */
export function useNowPlaying(): void {
    const state = useStore(playerStore)
    const screen = useStore(screenMedia)
    // A claiming screen's player does not say when it pauses, so it is asked again each second.
    const [, setAsked] = useState(0)
    useEffect(() => {
        if (screen === null) return
        const poll = setInterval(() => setAsked((count) => count + 1), CLAIM_POLL_MS)
        return () => clearInterval(poll)
    }, [screen])

    useMediaSession(screen === null ? playerSession(state, artworkFor(state)) : screenSession(screen))

    const shown = screen === null ? nowPlaying(state, null) : null
    // The book is the album of a chapter (see `nowPlaying`); a record's album stays out.
    const title =
        screen !== null
            ? windowTitle({ title: screen.title, artist: '' })
            : windowTitle(shown && state.book ? { ...shown, book: shown.album } : shown)
    useEffect(() => {
        document.title = title
    }, [title])
}
