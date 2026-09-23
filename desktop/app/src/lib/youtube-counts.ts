/**
 * What each subscribed channel holds, kept for as long as this document is open.
 *
 * COUNTING IS THREE LISTINGS THROUGH yt-dlp PER CHANNEL, one channel at a time, because
 * asking for all of them at once is a burst YouTube answers with its bot check. On twenty
 * subscriptions that sweep is the better part of a minute -- and the screen ran the whole of
 * it again on every mount, which includes Back from a channel. Opening one channel and
 * coming out of it cost a minute of somebody else's rate limit for numbers that had not
 * moved.
 *
 * SO THE NUMBERS OUTLIVE THE SCREEN. A channel is counted once per session, and only the
 * channels nothing has counted yet are asked about; what makes the app ask again is the
 * refresh on that screen, which is the reader saying they think there is something new.
 * Nothing here expires on a clock: a count that went stale while the screen stood open is a
 * count nobody is reading, and a sweep fired by a timer is the rate limit spent on nobody.
 *
 * A MODULE STORE RATHER THAN THE SCREEN'S OWN STATE, because the point is what survives the
 * screen. The decisions are pure and are what is worth a test; the store is the one line that
 * has to be shared.
 */

import { createStore } from '@/lib/store'
import type { YouTubeCounts } from '@/lib/types'

/** What each channel was last counted at, by channel id. */
export const countsHeld = createStore<ReadonlyMap<string, YouTubeCounts>>(new Map())

/** The cache with one channel written. A fresh map, because a store publishes on identity. */
export function withCounts(
    held: ReadonlyMap<string, YouTubeCounts>,
    id: string,
    counts: YouTubeCounts,
): ReadonlyMap<string, YouTubeCounts> {
    const next = new Map(held)
    next.set(id, counts)
    return next
}

/**
 * Which of these channels still has to be counted, in the order they were listed.
 *
 * The order is the listing's, because the numbers fill in down the screen as they arrive and
 * a sweep that jumped about would read as rows answering at random.
 */
export function uncounted(held: ReadonlyMap<string, YouTubeCounts>, ids: readonly string[]): string[] {
    return ids.filter((id) => !held.has(id))
}

/** Write one channel's numbers down. */
export function rememberCounts(id: string, counts: YouTubeCounts): void {
    countsHeld.update((held) => withCounts(held, id, counts))
}

/** Forget what was counted. Tests call this; nothing on a screen does. */
export function forgetCounts(): void {
    countsHeld.set(new Map())
}
