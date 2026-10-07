/**
 * The player bar's liner notes: what the room above the controls says once it is tall enough
 * to say something.
 *
 * THE ROOM WAS ONLY EVER THE SPECTRUM'S. Dragged tall with the spectrum off it was an empty
 * slab over a 14px title, and with the spectrum on the title was still 14px. Past
 * `LINER_ROOM` the room carries the record instead: a line saying where this sits, the title
 * at a size that grows with the room, who made it, how far through, and a timeline wide enough
 * to aim at. The spectrum, when it is on, is drawn faintly behind all of that.
 *
 * PURE, so the wording and the sizes are tested without a DOM.
 */

import { chapterAt } from '@/lib/book-timeline'
import type { PlayerState } from '@/lib/player'

/** The room height at which the bar stops being a strip and becomes liner notes. */
export const LINER_ROOM = 150

/** The title's size at the shortest liner room and at the tallest the bar can be dragged to. */
const TITLE_MIN_PX = 24
const TITLE_MAX_PX = 44
const ROOM_AT_MAX = 320

/** How big the title is drawn in a room this tall. */
export function linerTitlePx(room: number): number {
    const span = Math.min(1, Math.max(0, (room - LINER_ROOM) / (ROOM_AT_MAX - LINER_ROOM)))
    return Math.round(TITLE_MIN_PX + span * (TITLE_MAX_PX - TITLE_MIN_PX))
}

/** The clock beside the title: big enough to read across a room, smaller than the title. */
export function linerClockPx(room: number): number {
    return Math.round(linerTitlePx(room) * 0.62)
}

/**
 * The line over the title: where this sits.
 *
 * A track says its place in what is playing and the record it is from; a chapter says its
 * place in the book and the book; a station says it is live, which is the one true thing about
 * it. Parts the tags do not carry are left out rather than drawn as gaps.
 */
export function linerEyebrow(state: PlayerState): string {
    const { book, station } = state
    if (book) {
        const at = chapterAt(book.chapter_list, state.positionS)
        if (at < 0) return 'Audiobook'
        return `Chapter ${String(at + 1)} of ${String(book.chapter_list.length)} · ${book.title}`
    }
    if (station) return 'Live radio'
    const song = state.queue[state.index]
    if (!song) return ''
    const place =
        state.queue.length > 1 ? `Track ${String(state.index + 1)} of ${String(state.queue.length)}` : ''
    return [place, song.album, song.year ? String(song.year) : '']
        .filter((part) => part !== '' && part !== undefined)
        .join(' · ')
}

/** The line under the title: who made it, or for a station, which station it is. */
export function linerByline(state: PlayerState): string {
    if (state.book) return state.book.author
    if (state.station) return state.stationTitle ? state.station.name : ''
    return state.queue[state.index]?.artist ?? ''
}
