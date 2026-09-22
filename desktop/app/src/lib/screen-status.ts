/**
 * What the screen in front of somebody has to say along the foot of the shell.
 *
 * The status bar is the shell's and is drawn once; what it says about the work is the screen's,
 * and a screen states it here for as long as it is mounted. Two facts fit: one short note on
 * the left, and one identifier on the right, which is what an album or book id is.
 *
 * The note is data rather than markup, so what a scanning library says is a pure function
 * testable in Node, and the bar stays one row whatever it holds.
 */

import { createStore } from '@/lib/store'

/** How loudly the note is drawn: a scan in progress is not a warning and must not read as one. */
export type StatusTone = 'live' | 'quiet' | 'warn'

/** One screen's two facts. */
export interface ScreenStatus {
    note: string | null
    tone: StatusTone
    /** A machine's string the bar sets in mono, such as an album id. */
    identifier: string | null
}

const NOTHING: ScreenStatus = { note: null, tone: 'quiet', identifier: null }

export const screenStatus = createStore<ScreenStatus>(NOTHING)

/** Say what this screen is doing. Publishes nothing when it is saying the same thing again. */
export function setScreenStatus(next: ScreenStatus): void {
    const current = screenStatus.get()
    if (current.note === next.note && current.tone === next.tone && current.identifier === next.identifier)
        return
    screenStatus.set(next)
}

/** Say nothing, which is what the bar shows on a screen that states nothing. */
export function clearScreenStatus(): void {
    screenStatus.set(NOTHING)
}

/**
 * What a library being read says, in the words the bar uses.
 *
 * A SETTLED LIBRARY SAYS NOTHING ABOUT THE SCAN. While the server is walking the folder the
 * count climbs and the bar says so; once it has stopped, the screen itself shows what was
 * found, and a line restating it for as long as the screen is open is a static note the bar
 * is not for.
 */
export function scanNote(scanning: boolean, found: number): { note: string | null; tone: StatusTone } {
    if (!scanning) return { note: null, tone: 'quiet' }
    return { note: found > 0 ? `scanning, ${String(found)} so far` : 'scanning', tone: 'live' }
}
