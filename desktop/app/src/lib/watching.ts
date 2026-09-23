/**
 * What the watch screen remembers between visits.
 *
 * A CHOICE ABOUT WATCHING IS MADE ONCE. Somebody who takes the list off the side of the picture
 * has not made a decision about this episode, they have said how they like to watch -- so it
 * holds for the next one, and for the next session. It is this browser's rather than the
 * account's, because what it is really about is the window in front of somebody.
 *
 * STORAGE THAT REFUSES IS THE SAME AS STORAGE THAT HOLDS NOTHING: a private window gets the
 * default and keeps the choice until the tab closes. Nothing here throws at a reader.
 */

import { createStore } from '@/lib/store'

/** Where the theater choice is kept between visits. */
export const THEATER_KEY = 'maneki.theater'

/** Where the up-next choice is kept between visits. */
export const AUTOPLAY_NEXT_KEY = 'maneki.autoplay-next'

/** How long the up-next card counts down before it plays the next video by itself. */
export const UP_NEXT_SECONDS = 5

function readFlag(key: string, fallback: boolean): boolean {
    try {
        const stored = localStorage.getItem(key)
        return stored === null ? fallback : stored === 'true'
    } catch {
        return fallback
    }
}

function writeFlag(key: string, value: boolean): void {
    try {
        localStorage.setItem(key, String(value))
    } catch {
        // Storage denied: the choice holds for as long as this document is open.
    }
}

/**
 * Whether the list beside the picture is off.
 *
 * Off by default -- the folder is how somebody gets to the next episode, and a screen that hid
 * it on a first visit would be a screen with a way out nobody can see.
 */
export const theaterOn = createStore(readFlag(THEATER_KEY, false))

export function setTheater(on: boolean): void {
    writeFlag(THEATER_KEY, on)
    theaterOn.set(on)
}

export function toggleTheater(): void {
    setTheater(!theaterOn.get())
}

/**
 * Whether the end of one video starts the next one in its folder.
 *
 * On by default, which is what a season of television is for. The card counts down in front of
 * it either way, so somebody who wanted to stop there has five seconds and a button; with this
 * off the card waits instead of counting, because the offer is still worth making.
 */
export const autoplayNext = createStore(readFlag(AUTOPLAY_NEXT_KEY, true))

export function setAutoplayNext(on: boolean): void {
    writeFlag(AUTOPLAY_NEXT_KEY, on)
    autoplayNext.set(on)
}
