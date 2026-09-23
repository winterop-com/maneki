/**
 * The words of what is playing: what a server answers with, as lines this app can follow.
 *
 * TWO SHAPES ARRIVE AND ONE LEAVES. `getLyricsBySongId` answers the OpenSubsonic structure --
 * a list of lines, each with the millisecond it is sung at where the file carried timings --
 * and `getLyrics` answers one string, which is whatever was embedded in the track and may
 * itself be LRC. Both become `{ lines, synced }` here, so the overlay draws one thing and never
 * learns which call reached it.
 *
 * SYNCED MEANS THE LINES ARE ACTUALLY TIMED, not that a flag said so. A server that sets the
 * flag over lines with no timings would give a highlight with nothing to move it, which reads
 * as a stuck first line rather than as an absent feature.
 *
 * THE PARSING AND THE LOOKUP ARE PURE. Which line is being sung at 94.2 seconds is arithmetic
 * over a sorted list and it is checked in Node; what an overlay does with a ref is not worth a
 * test and cannot have one.
 */

import { createStore } from '@/lib/store'
import {
    getPlainLyrics,
    getStructuredLyrics,
    type Credentials,
    type Song,
    type StructuredLyrics,
} from '@/lib/subsonic'

/** One line, and the second it is sung at where the words carry timings. */
export interface LyricLine {
    text: string
    /** Seconds into the track, or null where these words are not timed. */
    atS: number | null
}

/** The words of one track, and whether they follow it. */
export interface Lyrics {
    lines: LyricLine[]
    synced: boolean
}

/** A track with no words, which is a state rather than a failure. */
export const NO_LYRICS: Lyrics = { lines: [], synced: false }

/**
 * Whether the words are on screen.
 *
 * Not kept between visits, like the stage: it is put up to read along with a track, and the
 * track it was put up for has ended by the next visit.
 */
export const lyricsOpen = createStore(false)

export function openLyrics(): void {
    lyricsOpen.set(true)
}

export function closeLyrics(): void {
    lyricsOpen.set(false)
}

export function toggleLyrics(): void {
    lyricsOpen.update((open) => !open)
}

/** `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xx]` and `[mm:ss.xxx]`, which are the LRC dialects in the wild. */
const TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g

/** `[ar: Artist]`, `[length: 03:42]`: a header that looks like a timestamp and is not one. */
const META_HEADER = /^\[[a-zA-Z]+:.*\]$/

/**
 * The OpenSubsonic structure as lines.
 *
 * A line with no `value` is a blank line rather than a line missing: LRC bodies carry them
 * between verses, and dropping them closes up a song into a paragraph.
 */
export function fromStructured(entry: StructuredLyrics | null | undefined): Lyrics {
    const raw = entry?.line ?? []
    if (raw.length === 0) return NO_LYRICS
    const lines: LyricLine[] = raw.map((line) => ({
        text: line.value ?? '',
        atS: typeof line.start === 'number' && Number.isFinite(line.start) ? line.start / 1000 : null,
    }))
    return settle(lines)
}

/**
 * One string as lines, whether it is LRC or plain text.
 *
 * A line may carry several timestamps -- `[00:01.00][01:12.00] the chorus again` -- and each
 * one is a line of its own, because that is what the second timestamp is saying.
 */
export function fromText(text: string): Lyrics {
    if (text.trim() === '') return NO_LYRICS
    const lines: LyricLine[] = []
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trimEnd()
        if (META_HEADER.test(line)) continue
        const stamps = [...line.matchAll(TIMESTAMP)]
        // Only the timestamps that lead the line are markers; one in the middle of a lyric is
        // part of the lyric, and where the run breaks is where the words start.
        let leading = 0
        let end = 0
        for (const stamp of stamps) {
            if (stamp.index !== end) break
            end = stamp.index + stamp[0].length
            leading += 1
        }
        if (leading === 0) {
            lines.push({ text: line, atS: null })
            continue
        }
        const body = line.slice(end).trim()
        for (const stamp of stamps.slice(0, leading)) lines.push({ text: body, atS: secondsOf(stamp) })
    }
    return settle(lines)
}

/** The words of one track, however this server can answer for them. */
export async function readLyrics(credentials: Credentials, song: Song): Promise<Lyrics> {
    const structured = await getStructuredLyrics(credentials, song.id).catch(() => null)
    const words = fromStructured(structured)
    if (words.lines.length > 0) return words
    // A server with no OpenSubsonic extension has nothing to answer that with, and one with it
    // answers an empty list for a track whose file carried none. Either way the older call is
    // the only one left to ask, and it needs a name rather than an id.
    const artist = song.artist ?? ''
    const title = song.title
    if (artist === '' || title === '') return NO_LYRICS
    const text = await getPlainLyrics(credentials, artist, title).catch(() => '')
    return fromText(text)
}

/**
 * Which line is being sung, as an index, or -1 for none.
 *
 * The last line whose moment has passed: a song is between its markers almost all of the time,
 * and the line somebody is reading is the one that started, not the one about to. Before the
 * first marker there is no line yet, which is the instrumental opening.
 */
export function lineAt(lines: readonly LyricLine[], positionS: number): number {
    let found = -1
    for (let index = 0; index < lines.length; index += 1) {
        const at = lines[index]?.atS
        if (at === null || at === undefined) continue
        if (at > positionS) break
        found = index
    }
    return found
}

/**
 * Settle a parsed body: decide whether it is timed, and put it in the order it is sung in.
 *
 * A BODY IS TIMED ONLY IF SOMETHING HAPPENS AFTER THE START. Every line at zero is a file whose
 * markers were stripped, and following it would park the highlight on the last line from the
 * first second. An untimed body keeps every line in the order it was written, markers and all
 * gone, because that is a page to read rather than a thing to follow.
 */
function settle(lines: LyricLine[]): Lyrics {
    const synced = lines.some((line) => line.atS !== null && line.atS > 0)
    if (!synced) return { lines: lines.map((line) => ({ text: line.text, atS: null })), synced: false }
    // A multi-timestamp line puts a chorus's repeats where they were written rather than where
    // they are sung, so a timed body is ordered by its own markers. The sort is stable, which
    // keeps two lines sharing one moment in the order the file had them.
    const timed = lines.filter((line) => line.atS !== null)
    return { lines: timed.toSorted((left, right) => (left.atS ?? 0) - (right.atS ?? 0)), synced: true }
}

/** One `[mm:ss.xx]` as seconds. The fraction is decimal: `5` is half a second, not five ms. */
function secondsOf(stamp: RegExpMatchArray): number {
    const minutes = Number(stamp[1])
    const seconds = Number(stamp[2])
    const fraction = Number((stamp[3] ?? '0').padEnd(3, '0').slice(0, 3))
    return minutes * 60 + seconds + fraction / 1000
}
