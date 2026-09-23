/**
 * Asking the server to read the library folder again.
 *
 * A LIBRARY IS A FOLDER SOMEBODY PUT A RECORD IN FIVE MINUTES AGO. The server indexes what it
 * finds at startup and on its own schedule, so an album copied in while it was running is an
 * album the app cannot see, and the only way through that without restarting a server is the
 * verb Subsonic already has.
 *
 * THE WALK IS NOT THE REQUEST. `startScan` answers immediately, because a rescan of a real
 * library is minutes and a request held open for it is one that times out. What follows is a
 * poll, which is why this is a module rather than a call: the thing that has to be got right is
 * that there is one walk being watched at a time, however many times the row is pressed.
 *
 * WHAT IT SAYS, IT SAYS ALONG THE FOOT. A progress note is a fact about work in flight, which is
 * what the status bar is for and what `scanNote` already spells; a toast per poll would be a
 * notification every two seconds. The one thing raised as a toast is a refusal, because the
 * palette row that asked has no room beside it to draw one -- which is the only reason anything
 * in this app raises one, and `lib/star` is the other write with nowhere to put a sentence.
 */

import { toast } from 'sonner'

import { scanNote, screenStatus, setScreenStatus } from '@/lib/screen-status'
import { getScanStatus, startScan, type Credentials, type ScanStatus } from '@/lib/subsonic'

export const RESCAN_LABEL = 'Rescan the music library'

/**
 * How often the walk is asked about.
 *
 * Two seconds is what the books shelf already polls its own scan at, and the two are the same
 * question about the same kind of work: often enough that the count climbing reads as progress,
 * rarely enough that a long walk is not a request per frame.
 */
export const SCAN_POLL_MS = 2000

/**
 * Whether a walk is already being watched.
 *
 * Module state rather than a store: nothing renders from it. It exists so that pressing the row
 * twice is one rescan with one poll behind it, instead of two loops writing the same note over
 * each other.
 */
let watching = false

export function rescanning(): boolean {
    return watching
}

/** Say where the walk has got to, keeping whatever identifier the screen put beside it. */
function report(status: ScanStatus): void {
    setScreenStatus({
        ...scanNote(status.scanning, status.count),
        identifier: screenStatus.get().identifier,
    })
}

function wait(ms: number): Promise<void> {
    return new Promise((done) => {
        setTimeout(done, ms)
    })
}

/**
 * Say where the walk is, and ask again until it has stopped.
 *
 * A CHAIN RATHER THAN A LOOP. Each poll depends on the one before it -- there is nothing to run
 * in parallel and nothing to gather -- and written as a loop that is a sequence of awaits inside
 * one, which reads as the mistake it is not. The tail call is a promise, not a frame, so a walk
 * of a thousand polls costs the stack nothing.
 */
async function follow(credentials: Credentials, status: ScanStatus): Promise<void> {
    report(status)
    if (!status.scanning) return
    await wait(SCAN_POLL_MS)
    return follow(credentials, await getScanStatus(credentials))
}

/**
 * Start a rescan and watch it to the end.
 *
 * A SECOND PRESS JOINS THE FIRST WALK RATHER THAN STARTING ANOTHER. The server has one index and
 * would coalesce them anyway; what two of these would actually produce is two writers of one note.
 *
 * The note goes when the walk settles, which is `scanNote`'s own rule: a library that has
 * finished being read has nothing to say about the reading, and a line restating it for the rest
 * of the session is the static note the bar is not for.
 */
export async function rescan(credentials: Credentials): Promise<void> {
    if (watching) return
    watching = true
    try {
        await follow(credentials, await startScan(credentials))
    } catch (error) {
        // The bar is for work in flight, and this walk is not in flight any more.
        report({ scanning: false, count: 0 })
        toast.error(error instanceof Error ? error.message : 'the rescan was refused')
    } finally {
        watching = false
    }
}
