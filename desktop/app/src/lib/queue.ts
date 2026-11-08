/**
 * What maneki adds to the library's queue: the words for its repeat control, and which row of a
 * list is the one playing.
 *
 * The play order, shuffle, repeat and what next and previous move to are sokkel-ui-media's
 * `queue` helpers, which `lib/player` drives over its own store.
 */

import type { RepeatMode } from '@winterop-com/sokkel-ui-media/queue'

/** What happens at the end of the queue. */
export type Repeat = RepeatMode

/** What each mode is called, for the control that cycles them. */
export const REPEAT_LABELS: Record<Repeat, string> = {
    off: 'Repeat off',
    all: 'Repeat the queue',
    one: 'Repeat this track',
}

/**
 * Which row of a list is the one playing, or -1.
 *
 * A TRACK CAN BE IN A LIST TWICE. Matched by id alone, a track on a playlist three times lit all
 * three rows. When the list is what is playing (the queue holds exactly its tracks), the row is
 * the queue's own position; when the track is playing from somewhere else, it is the first copy.
 */
export function playingRow(
    rowIds: readonly string[],
    queueIds: readonly string[],
    queueIndex: number,
): number {
    const playing = queueIds[queueIndex]
    if (playing === undefined) return -1
    const same = rowIds.length === queueIds.length && rowIds.every((id, at) => id === queueIds[at])
    if (same) return queueIndex
    return rowIds.indexOf(playing)
}
