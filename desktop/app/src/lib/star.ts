/**
 * The star on a track, an album or an artist, for everything that is not the row it is drawn on.
 *
 * THE SERVER ANSWERS A STAR WITH NOTHING. `star` and `unstar` return an empty envelope, so
 * there is no fresh `Song` to redraw from and no way to ask cheaply what the mark is now. What
 * this client wrote is therefore held here, keyed by id, and read on top of whatever the
 * search or the album read said -- which is how the key and the button on the album row agree
 * about a track somebody starred from the player bar a minute ago.
 *
 * THE DECISIONS ARE PURE AND THE WRITE IS NOT. `starredNow`, `withMark` and `refusedStar` are
 * the whole of what is worth a test; `toggleStar` is the one line that needs credentials and a
 * network, and it hands the marks back the moment the server refuses rather than leaving a
 * star that is not there.
 *
 * A REFUSAL IS SAID, AND IT IS SAID AS A TOAST. A star is a row's own button, and on the
 * player bar it is a glyph in a strip -- neither has room beside it for a sentence, which is
 * the case the one notification this app raises exists for. Taking the mark back and saying
 * nothing was the star going on under somebody's finger and quietly coming off again.
 */

import { toast } from 'sonner'

import { createStore } from '@/lib/store'
import { setStarred, type Credentials } from '@/lib/subsonic'

/**
 * Anything the server keeps a star for: a track, an album or an artist.
 *
 * ONE ID SPACE. The server's ids carry their kind (`tr_`, `al_`, `ar_`) and `star` takes any of
 * them as `id`, so one map of marks holds all three without one shadowing another.
 */
export interface Starrable {
    id: string
    starred?: string
    /** A track's name. */
    title?: string
    /** An album's or an artist's name. */
    name?: string
}

/** What a refusal calls the thing: a track by its title, an album or an artist by its name. */
export function starName(item: Starrable): string {
    return item.title ?? item.name ?? ''
}

/** What this client has starred or unstarred since it loaded, by id. */
export const starMarks = createStore<ReadonlyMap<string, boolean>>(new Map())

/** Whether something is starred: what this client last wrote, or what the server said. */
export function starredNow(marks: ReadonlyMap<string, boolean>, item: Starrable | null): boolean {
    if (item === null) return false
    return marks.get(item.id) ?? Boolean(item.starred)
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
 * What a refused star says.
 *
 * The verb is what was asked for rather than what is true now, because what the reader has
 * just seen come undone is their own gesture. The server's own sentence follows it where there
 * is one: a refusal that names the reason is one somebody can do something about.
 */
export function refusedStar(name: string, wanted: boolean, error: unknown): string {
    const asked = wanted ? `Could not star ${name}` : `Could not unstar ${name}`
    const reason = error instanceof Error ? error.message.trim() : ''
    return reason ? `${asked}: ${reason}` : `${asked}.`
}

/**
 * Star a track, an album or an artist, or take the mark off. Answers what the star now is, or
 * null when there is none.
 *
 * The mark is written before the request is made and taken back if the request is refused: a
 * star that waited for a round trip would be a key press with nothing behind it for a moment,
 * on the one gesture somebody repeats while a track is playing.
 */
export function toggleStar(credentials: Credentials | undefined, item: Starrable | null): boolean | null {
    if (!credentials || item === null) return null
    const wanted = !starredNow(starMarks.get(), item)
    starMarks.update((marks) => withMark(marks, item.id, wanted))
    void setStarred(credentials, item.id, wanted).catch((error: unknown) => {
        starMarks.update((marks) => withMark(marks, item.id, !wanted))
        toast.error(refusedStar(starName(item), wanted, error))
    })
    return wanted
}

/** Forget what this client wrote. The session going away, and tests, call this. */
export function forgetMarks(): void {
    starMarks.set(new Map())
}
