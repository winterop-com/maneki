/**
 * The player bar's liner notes: what the room above the controls says once it is tall enough
 * to say something.
 *
 * THE ROOM WAS ONLY EVER THE SPECTRUM'S. Dragged tall with the spectrum off it was an empty
 * slab over a 14px title, and with the spectrum on the title was still 14px. Past
 * `LINER_ROOM` the room carries the record instead: a line saying where this sits, the title
 * at a size that grows with the room, who made it, and a timeline wide enough to aim at. The spectrum, when it is on, is drawn faintly behind all of that.
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

/**
 * What a station says it is playing, without the station saying its own name first.
 *
 * NRK sends "NRK mP3 - Alltid musikk: PILLOWTALK, ZAYN" and "P3 Musikk: The Feeling, Steve
 * Lacy": the part before the last colon is the station introducing itself, which the screen
 * already says. It goes when it names the station (shares a word of two letters or more with
 * the station's name); a colon that is part of a song title stays.
 */
export function announced(stationTitle: string, stationName: string): string {
    const at = stationTitle.lastIndexOf(': ')
    if (at < 0) return stationTitle
    const head = stationTitle.slice(0, at).toLowerCase()
    const words = stationName
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 2)
    const rest = stationTitle.slice(at + 2).trim()
    return rest && words.some((word) => head.includes(word)) ? rest : stationTitle
}

/**
 * The title itself, as text: the chapter, the track, or what a station says it is playing.
 *
 * A station's own name is its title only until it announces a song; after that the song is
 * the title and the station moves to the line under it, which is where an artist would be.
 */
export function linerTitle(state: PlayerState): string {
    const { book, station } = state
    if (book) {
        const at = chapterAt(book.chapter_list, state.positionS)
        return (at < 0 ? null : book.chapter_list[at]?.title) ?? book.title
    }
    if (station) return state.stationTitle ? announced(state.stationTitle, station.name) : station.name
    return state.queue[state.index]?.title ?? ''
}

/** The line under the title: who made it, or for a station, which station it is. */
export function linerByline(state: PlayerState): string {
    if (state.book) return state.book.author
    if (state.station) return state.stationTitle ? state.station.name : ''
    return state.queue[state.index]?.artist ?? ''
}
