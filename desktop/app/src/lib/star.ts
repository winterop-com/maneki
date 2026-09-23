/**
 * The star on a track, for everything that is not the row the track is drawn on.
 *
 * THE SERVER ANSWERS A STAR WITH NOTHING. `star` and `unstar` return an empty envelope, so
 * there is no fresh `Song` to redraw from and no way to ask cheaply what the mark is now. What
 * this client wrote is therefore held here, keyed by track id, and read on top of whatever the
 * search or the album read said -- which is how the key and the button on the album row agree
 * about a track somebody starred from the player bar a minute ago.
 *
 * THE DECISIONS ARE PURE AND THE WRITE IS NOT. `starredNow` and `withMark` are the whole of
 * what is worth a test; `toggleStar` is the one line that needs credentials and a network, and
 * it hands the marks back the moment the server refuses rather than leaving a star that is not
 * there.
 */

import { createStore } from '@/lib/store'
import { setStarred, type Credentials, type Song } from '@/lib/subsonic'

/** What this client has starred or unstarred since it loaded, by track id. */
export const starMarks = createStore<ReadonlyMap<string, boolean>>(new Map())

/** Whether a track is starred: what this client last wrote, or what the server said. */
export function starredNow(marks: ReadonlyMap<string, boolean>, song: Song | null): boolean {
    if (song === null) return false
    return marks.get(song.id) ?? Boolean(song.starred)
}

/** The marks with one id written. A fresh map, because a store publishes on identity. */
export function withMark(
    marks: ReadonlyMap<string, boolean>,
    id: string,
    starred: boolean,
): ReadonlyMap<string, boolean> {
    const next = new Map(marks)
    next.set(id, starred)
    return next
}

/**
 * Star a track, or take the mark off. Answers what the star now is, or null when there is none.
 *
 * The mark is written before the request is made and taken back if the request is refused: a
 * star that waited for a round trip would be a key press with nothing behind it for a moment,
 * on the one gesture somebody repeats while a track is playing.
 */
export function toggleStar(credentials: Credentials | undefined, song: Song | null): boolean | null {
    if (!credentials || song === null) return null
    const wanted = !starredNow(starMarks.get(), song)
    starMarks.update((marks) => withMark(marks, song.id, wanted))
    void setStarred(credentials, song.id, wanted).catch(() => {
        starMarks.update((marks) => withMark(marks, song.id, !wanted))
    })
    return wanted
}

/** Forget what this client wrote. The session going away, and tests, call this. */
export function forgetMarks(): void {
    starMarks.set(new Map())
}
