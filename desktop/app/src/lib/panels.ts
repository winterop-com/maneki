/**
 * How the navigation rail is laid out, and what survives a reload.
 *
 * Small facts, module stores, each read straight out of storage as it is built so the shell
 * renders at its settled size on the first paint rather than snapping into place.
 */

import { createStore } from '@/lib/store'

/** The rail's width when it shows labels and nobody has dragged it. */
export const RAIL_WIDTH = 240

/** Narrower and the labels it exists to show start truncating. */
export const RAIL_MIN_WIDTH = 160

/** Wider is dead space: the longest label fits long before this. */
export const RAIL_MAX_WIDTH = 320

/** Its width when collapsed: icons, and the room for a focus ring around them. */
export const RAIL_COLLAPSED_WIDTH = 56

const RAIL_KEY = 'maneki.railCollapsed'
const RAIL_WIDTH_KEY = 'maneki.railWidth'

function readFlag(key: string, fallback: boolean): boolean {
    try {
        const stored = localStorage.getItem(key)
        return stored === null ? fallback : stored === 'true'
    } catch {
        return fallback
    }
}

function readWidth(key: string, fallback: number, clamp: (width: number) => number): number {
    try {
        const stored = Number(localStorage.getItem(key))
        return Number.isFinite(stored) && stored > 0 ? clamp(stored) : fallback
    } catch {
        return fallback
    }
}

function write(key: string, value: string): void {
    try {
        localStorage.setItem(key, value)
    } catch {
        // Storage denied: the layout holds for as long as this document is open.
    }
}

/** Hold a dragged rail width between the labels' needs and the screen's. */
export function clampRailWidth(width: number): number {
    return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, Math.round(width)))
}

export const railCollapsed = createStore(readFlag(RAIL_KEY, false))
export const railWidth = createStore(readWidth(RAIL_WIDTH_KEY, RAIL_WIDTH, clampRailWidth))

/**
 * Whether the rail's edge is being dragged right now.
 *
 * Everything that follows the rail's width -- the status bar's settings cell as much as the
 * rail itself -- animates a committed width and follows a dragged one raw: a transition
 * chasing a hand makes the edge rubber-band behind it.
 */
export const railDragging = createStore(false)

/** Collapse or expand the navigation rail. */
export function toggleRail(): void {
    railCollapsed.update((collapsed) => {
        write(RAIL_KEY, String(!collapsed))
        return !collapsed
    })
}

/** Set the rail's width, in pixels, clamped to what the shell can draw. */
export function setRailWidth(width: number): void {
    const clamped = clampRailWidth(width)
    railWidth.set(clamped)
    write(RAIL_WIDTH_KEY, String(clamped))
}
