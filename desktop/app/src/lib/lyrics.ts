/**
 * The words of what is playing: what a server answers with, as lines the library's `Lyrics`
 * can follow.
 *
 * TWO SHAPES ARRIVE AND ONE LEAVES. `getLyricsBySongId` answers the OpenSubsonic structure --
 * a list of lines, each with the millisecond it is sung at where the file carried timings --
 * and `getLyrics` answers one string, which is whatever was embedded in the track and may
 * itself be LRC. Both are read by sokkel-ui-media's `parseLyrics`: the structure is written out
 * as LRC first, so whether the lines are timed and the order they are sung in are decided in
 * one place.
 */

import { parseLyrics, type ParsedLyrics } from '@winterop-com/sokkel-ui-media/lrc'
import { createStore } from '@winterop-com/sokkel-ui/lib/stored'
import {
    getPlainLyrics,
    getStructuredLyrics,
    type Credentials,
    type Song,
    type StructuredLyrics,
} from '@/lib/subsonic'

/** A track with no words, which is a state rather than a failure. */
export const NO_LYRICS: ParsedLyrics = parseLyrics('')

/**
 * Whether the words are on screen, in the player's fullscreen view.
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

/** Milliseconds as an LRC stamp, `[mm:ss.xxx]`. */
function stamp(ms: number): string {
    const whole = Math.max(0, Math.round(ms))
    const minutes = Math.floor(whole / 60_000)
    const seconds = Math.floor((whole % 60_000) / 1000)
    const rest = whole % 1000
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(rest).padStart(3, '0')}]`
}

/**
 * The OpenSubsonic structure as lines.
 *
 * A line with no `value` is a blank line rather than a line missing: LRC bodies carry them
 * between verses, and dropping them closes up a song into a paragraph.
 */
export function fromStructured(entry: StructuredLyrics | null | undefined): ParsedLyrics {
    const raw = entry?.line ?? []
    if (raw.length === 0) return NO_LYRICS
    const text = raw
        .map((line) => {
            const words = line.value ?? ''
            return typeof line.start === 'number' && Number.isFinite(line.start)
                ? `${stamp(line.start)}${words}`
                : words
        })
        .join('\n')
    return parseLyrics(text)
}

/** The words of one track, however this server can answer for them. */
export async function readLyrics(credentials: Credentials, song: Song): Promise<ParsedLyrics> {
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
    return parseLyrics(text)
}
