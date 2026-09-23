/**
 * Lengths and positions, written the way a listener reads them.
 *
 * A book runs for twenty hours, so the minutes-and-seconds clock every music
 * player uses says "1200:04" and means nothing. Hours are written when there
 * are hours.
 */

const pad = (value: number): string => String(value).padStart(2, '0')

/** `20:02:14`, or `42:15` under an hour. For a clock beside a scrub bar. */
export function clock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secs = total % 60
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

/** `20h 02m`, or `42m` under an hour. For a length in a listing. */
export function duration(seconds: number): string {
    const minutes = Math.round(Math.max(0, seconds) / 60)
    const hours = Math.floor(minutes / 60)
    return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

/** How many tracks, in words: one is "1 track", and nothing is "no tracks". */
export function trackCount(count: number): string {
    if (count === 0) return 'no tracks'
    return `${String(count)} ${count === 1 ? 'track' : 'tracks'}`
}

/** `3h 20m left`, the part of a book still ahead. */
export function remaining(durationS: number, positionS: number): string {
    return `${duration(Math.max(0, durationS - positionS))} left`
}

/** How far through, 0 to 1, for a progress bar. */
export function progressRatio(durationS: number, positionS: number): number {
    if (durationS <= 0) return 0
    return Math.min(1, Math.max(0, positionS / durationS))
}
