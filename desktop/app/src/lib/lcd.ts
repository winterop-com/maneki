/**
 * The deck face: what a segmented display shows, and how the line moves across it.
 *
 * WHY THERE IS A SECOND NOW-PLAYING AT ALL. The standard strip is the app's own voice -- a
 * title, an artist, a slider -- and it is what most people want. This one is the other thing a
 * music player can be: the front panel of a hi-fi, a fixed window of glyphs with the title
 * walking through it. It is a choice on a settings row rather than a theme, because it changes
 * what is on the bar rather than what colour it is.
 *
 * A FIXED WINDOW IS THE WHOLE IDEA. A display has a number of cells and that number does not
 * change, so a title longer than the window is not truncated with an ellipsis -- it travels. All
 * of that is arithmetic over a string and a step count, which is what puts it here: what the
 * window holds at step 14 of a given title is a decision a Node test makes, and the component is
 * left with a timer and a list of spans.
 *
 * THE CLOCK IS NOT `lib/format`'s. `clock` writes `42:15`, which is what a person reads beside a
 * slider; a display cell is a fixed width and `4:15` sliding to `42:15` is a panel that twitches
 * once a minute. These are padded, and anything unknown is the row of dashes a deck shows rather
 * than a zero it would be read as.
 */

import { createStore } from '@/lib/store'

/** How many cells the title line has. Twenty-two is what the deck this is ported from had. */
export const LCD_WIDTH = 22

/** How long one cell of travel takes. */
export const MARQUEE_MS = 320

/** The gap that separates the end of the line from its own beginning as it comes round. */
export const MARQUEE_GAP = '    '

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * The one line the display shows, joined the way a deck joins it.
 *
 * Upper case because that is what a segmented display has: the glyph set is capitals and digits,
 * and a lower-case descender on a panel of them reads as a different typeface rather than as a
 * word. Empty parts are dropped rather than drawn as an empty gap between two separators.
 */
export function lcdLine(parts: readonly (string | undefined | null)[]): string {
    const said = parts.filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    return said.join('  -  ').toUpperCase()
}

/** How many steps a line takes to come all the way round, or 0 for one that fits. */
export function marqueeSteps(line: string, width = LCD_WIDTH): number {
    return line.length <= width ? 0 : line.length + MARQUEE_GAP.length
}

/**
 * What the window holds at one step of the travel.
 *
 * A line that fits does not travel: it is padded out to the window and stands still, because a
 * short title sliding about would be motion saying nothing. A line that does not fit is read off
 * a copy of itself laid end to end, so the last character is followed by the first rather than
 * by a wipe.
 */
export function marqueeAt(line: string, at: number, width = LCD_WIDTH): string {
    if (line.length <= width) return line.padEnd(width, ' ')
    const cycle = line.length + MARQUEE_GAP.length
    const start = ((Math.trunc(at) % cycle) + cycle) % cycle
    const round = line + MARQUEE_GAP + line + MARQUEE_GAP
    return round.slice(start, start + width).padEnd(width, ' ')
}

/**
 * A position as a display cell: `03:42`, or `2:14:05` where there are hours.
 *
 * Nothing known is `--:--`, which is what a deck with no disc in it shows. A duration of zero is
 * a real zero and is drawn as one -- a track that has just started is not a track with no length.
 */
export function lcdClock(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return '--:--'
    }
    const total = Math.floor(seconds)
    const hours = Math.floor(total / 3600)
    const minutes = pad(Math.floor((total % 3600) / 60))
    return hours > 0 ? `${String(hours)}:${minutes}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`
}

/** What the display says a track is, in the two cells a deck gives it. */
export function trackCell(track: number | undefined, isStation: boolean): string {
    if (isStation) return 'FM'
    if (track === undefined || track <= 0) return '--'
    return track > 99 ? String(track) : pad(track)
}

/** How many segments one meter has. Eighteen is what the deck this is ported from had. */
export const VU_SEGMENTS = 18

/** The share of the analyser's bins the low meter reads. The rest is the high one's. */
export const VU_SPLIT = 0.25

/** What the high meter's reading is multiplied by before it is drawn -- see `vuLevels`. */
export const VU_HIGH_GAIN = 2.5

/** What the two meters are showing, each between 0 and 1. */
export interface VuLevels {
    low: number
    high: number
}

/** Both needles at rest. A module constant, so a store publishing it twice re-renders nothing. */
export const VU_QUIET: VuLevels = { low: 0, high: 0 }

/**
 * The two meters, read off one frame of the analyser.
 *
 * THERE ARE NO CHANNELS HERE TO METER. The graph is a media element into a single AnalyserNode
 * -- see `lib/player` -- and an analyser mixes what it is handed down to one channel before it
 * transforms it, so a left and a right would need a splitter and two graphs, which is not what
 * the spectrum is tapped off. What the deck's pair of needles reads instead is the bottom of the
 * spectrum and the top of it, which is the other thing two meters on a front panel are used for.
 *
 * SO THEY ARE LABELLED FOR WHAT THEY READ. A meter named for a channel it is not reading is a
 * lie in the one place on the bar that is read literally, and the display already says the
 * things it knows -- the elapsed, the remaining, the format -- exactly.
 *
 * THE HIGH ONE IS LIFTED. Almost every mix is fifteen to twenty dB down above a few kilohertz,
 * so a high band read at the low band's gain is a bar that never lights at all. The lift is a
 * constant stated here rather than a curve discovered in a component: what a meter is for is
 * movement somebody reads at a glance, and both of these are levels rather than measurements.
 */
export function vuLevels(frequencies: Uint8Array): VuLevels {
    if (frequencies.length === 0) return VU_QUIET
    const split = Math.max(1, Math.min(frequencies.length, Math.round(frequencies.length * VU_SPLIT)))
    return {
        low: meanLevel(frequencies, 0, split, 1),
        high: meanLevel(frequencies, split, frequencies.length, VU_HIGH_GAIN),
    }
}

/**
 * The average of one stretch of bins, as a fraction of full scale.
 *
 * An average rather than the loudest bin in the stretch: a peak makes the meter jump to whatever
 * one bin did and the needle flickers, while an average moves the way the music does -- which is
 * the same reason `lib/visualizer` averages a band.
 */
function meanLevel(frequencies: Uint8Array, from: number, to: number, gain: number): number {
    if (to <= from) return 0
    let total = 0
    for (let bin = from; bin < to; bin += 1) total += frequencies[bin] ?? 0
    return Math.min(1, (total / (to - from) / 255) * gain)
}

/**
 * How many segments a level lights, out of the meter's own.
 *
 * Rounded rather than rounded up, so a room tone that never quite reaches nothing leaves the
 * meter dark instead of lighting its first segment for the whole of a quiet track.
 */
export function vuSegments(level: number, segments = VU_SEGMENTS): number {
    if (!Number.isFinite(level) || level <= 0) return 0
    return Math.round(Math.min(1, level) * segments)
}

/** Which face the player bar wears. */
export type NowPlayingFace = 'standard' | 'lcd'

export const NOW_PLAYING_FACES: readonly NowPlayingFace[] = ['standard', 'lcd']

export const NOW_PLAYING_LABELS: Record<NowPlayingFace, string> = {
    standard: 'Standard',
    lcd: 'LCD',
}

/** What the glass is lit in. */
export type LcdTint = 'green' | 'amber' | 'blue'

export const LCD_TINTS: readonly LcdTint[] = ['green', 'amber', 'blue']

export const LCD_TINT_LABELS: Record<LcdTint, string> = {
    green: 'Green',
    amber: 'Amber',
    blue: 'Blue',
}

export const NOW_PLAYING_KEY = 'maneki.nowPlaying'
export const LCD_TINT_KEY = 'maneki.lcdTint'

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    try {
        const held = localStorage.getItem(key)
        return (allowed as readonly string[]).includes(held ?? '') ? (held as T) : fallback
    } catch {
        return fallback
    }
}

/**
 * Both choices, kept between visits.
 *
 * Standard by default: the deck is a thing somebody chooses, and an app that opened as one for
 * a reader who never asked would be a toy rather than a preference. Neither of these is written
 * onto the document, so neither needs the pre-paint script -- what they change is what the
 * player bar renders, and the bar is not drawn until there is something playing anyway.
 */
export const nowPlayingFace = createStore<NowPlayingFace>(
    stored(NOW_PLAYING_KEY, NOW_PLAYING_FACES, 'standard'),
)

export const lcdTint = createStore<LcdTint>(stored(LCD_TINT_KEY, LCD_TINTS, 'green'))

function keep(key: string, value: string): void {
    try {
        localStorage.setItem(key, value)
    } catch {
        // Storage denied: the choice holds for as long as this document is open.
    }
}

export function chooseNowPlaying(face: NowPlayingFace): void {
    keep(NOW_PLAYING_KEY, face)
    nowPlayingFace.set(face)
}

export function chooseLcdTint(tint: LcdTint): void {
    keep(LCD_TINT_KEY, tint)
    lcdTint.set(tint)
}
