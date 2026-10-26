/**
 * Which track to fetch ahead, so the next one starts the moment it is asked for.
 *
 * A TRACK STARTED COLD IS SLOW AWAY FROM HOME. Each one is a fresh request to the server, and over
 * Tailscale from somewhere else that is round trips before the first sound. So while one track
 * plays, the one after it is fetched whole and handed to the element from memory when its turn
 * comes. The order is worked out once when the queue is built (shuffle included), so what comes
 * next is known exactly rather than guessed.
 *
 * Pure, so the rules are checked in Node; `lib/player` does the fetching.
 */

import { afterSkip, type Repeat } from '@/lib/queue'

/** A track larger than this is streamed rather than held in memory: a long mix, a live set. */
export const PRELOAD_MAX_BYTES = 60 * 1024 * 1024

/** How long a track plays before the next is fetched, so the two do not compete for the line. */
export const PRELOAD_DELAY_MS = 4000

/**
 * The id of the song to fetch ahead: the one a skip forward would play, which is also the one a
 * track ending plays, except under repeat-one, where the end replays this one and only a skip
 * moves on. Null when nothing follows, or when what follows is this track again.
 */
export function songToPreload(
    queue: readonly { id: string }[],
    order: readonly number[],
    orderAt: number,
    repeat: Repeat,
): string | null {
    if (orderAt < 0) return null
    const at = afterSkip(order, orderAt, repeat)
    if (at === null || at === orderAt) return null
    const index = order[at]
    const current = order[orderAt]
    if (index === undefined || index === current) return null
    return queue[index]?.id ?? null
}

/** Whether a response of this length is small enough to hold. An unknown length is not. */
export function worthHolding(contentLength: string | null): boolean {
    if (contentLength === null) return false
    const bytes = Number(contentLength)
    return Number.isFinite(bytes) && bytes > 0 && bytes <= PRELOAD_MAX_BYTES
}
