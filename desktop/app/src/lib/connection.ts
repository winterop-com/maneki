/**
 * Whether the server is answering at all.
 *
 * ONE FACT, AND IT IS ABOUT THE WIRE RATHER THAN ABOUT A REQUEST. A refusal belongs to the
 * screen that asked for it -- an album that will not load says so where the album would be. A
 * server that has stopped answering belongs to the whole app: every screen is about to fail the
 * same way, the queue is about to stop mid-track, and telling a reader once along the top is the
 * difference between "the network went" and five screens each reporting their own mystery.
 *
 * A 404 IS NOT THIS, AND NEITHER IS A 500. The server answering badly is the server answering:
 * it is reachable, the session is good, and whatever asked has a refusal of its own to draw. The
 * banner is only for the case where nothing came back at all -- `fetch` rejecting, which is what
 * a refused connection, a dropped Wi-Fi and a stopped server all arrive as. Raising it on a
 * status would put "lost connection to the server" over a screen the server just answered.
 *
 * NOTHING HERE IMPORTS THE WIRE MODULES. `lib/api` and `lib/subsonic` both call in here, so a
 * dependency the other way would be a cycle. What a network refusal looks like is therefore
 * recognised by its shape -- the one sentence both of them raise, on an error carrying no status
 * of its own -- and that sentence is declared here, where both can read it.
 */

import { createStore } from '@/lib/store'

/**
 * What both wire modules say when the request did not come back.
 *
 * Declared here rather than in either of them, because it is the one string this module
 * recognises and two copies of it would be one copy that drifts.
 */
export const NETWORK_REFUSAL = 'the server did not answer'

/** Whether the server has gone quiet, and in what words. */
export interface ConnectionState {
    down: boolean
    /** The sentence the failed request carried, or null while nothing is wrong. */
    reason: string | null
}

/** The settled state, held as one object so returning to it publishes nothing twice. */
const ANSWERING: ConnectionState = { down: false, reason: null }

export const connectionStore = createStore<ConnectionState>(ANSWERING)

/**
 * Whether a thrown thing is the network refusing rather than the server answering.
 *
 * Three shapes reach here: `ApiError(0, ...)` and `SubsonicError(0, ...)` from the two wire
 * modules' own catch around `fetch`, and a bare `TypeError` from the handful of places that
 * call `fetch` without wrapping it. Everything else -- a status, a Subsonic code, a parse that
 * failed -- is a server that answered, and answers to whoever asked.
 */
export function isNetworkRefusal(error: unknown): boolean {
    if (error instanceof TypeError) return true
    if (!(error instanceof Error)) return false
    if (error.message !== NETWORK_REFUSAL) return false
    // A refusal that carries a status or a code is one the server sent, whatever it says.
    const answered = error as { status?: number; code?: number }
    return (answered.status ?? 0) === 0 && (answered.code ?? 0) === 0
}

/**
 * Say a request failed, and raise the banner if it was the wire that failed.
 *
 * Answers whether it raised anything, so a caller can tell a server that refused from a server
 * that is not there without inspecting the error twice.
 */
export function noteRefusal(error: unknown): boolean {
    if (!isNetworkRefusal(error)) return false
    const reason = error instanceof Error ? error.message : NETWORK_REFUSAL
    const current = connectionStore.get()
    // Already saying it, in the same words: a poll that fails every two seconds must not
    // re-publish and re-render the shell every two seconds.
    if (current.down && current.reason === reason) return true
    connectionStore.set({ down: true, reason })
    return true
}

/**
 * Say the server answered.
 *
 * Called on every answer, whatever its status, because a 404 is proof the server is there. It
 * publishes only when something had actually been said, so the ordinary case -- a request
 * succeeding while nothing is wrong -- costs a comparison and nothing else.
 */
export function noteRecovered(): void {
    if (!connectionStore.get().down) return
    connectionStore.set(ANSWERING)
}

/**
 * Take the banner off without claiming the server is back.
 *
 * Somebody who knows their server is down does not need a bar across every screen saying so for
 * the rest of the evening. The next request that fails the same way raises it again, because by
 * then it is news once more.
 */
export function dismissRefusal(): void {
    connectionStore.set(ANSWERING)
}
