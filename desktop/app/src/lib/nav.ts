/**
 * The navigation, as data.
 *
 * ONE ARRAY, READ BY THREE THINGS: the rail draws it, the drawer draws it below the breakpoint,
 * and the command palette offers every entry as a row. Adding a screen is a route plus an entry
 * here, and nothing else has to learn that the screen exists.
 *
 * AN ENTRY IS GATED ON WHAT THE SERVER HAS, not on what the account may do. maneki serves
 * whichever libraries it was pointed at, so a music-only instance draws music and nothing else:
 * a Video entry leading to an empty screen is a promise the server cannot keep. What each entry
 * needs is a field on `/capabilities`, so a server that gains a library gains its entry on the
 * next connect without this file changing.
 */

import { BookAudio, Clapperboard, MonitorPlay, Music, Radio, Star, type LucideIcon } from 'lucide-react'

import type { Capabilities } from '@/lib/types'

/** The libraries an entry can hang off, spelled as `/capabilities` spells them. */
export type Library = 'audio' | 'video' | 'books' | 'radio' | 'youtube'

/** One entry in the rail: where it goes, what it is called, and the mark beside it. */
export interface NavEntry {
    /** The route path, exactly as the router spells it. */
    path: string
    label: string
    /**
     * The line the command palette carries beside the row, saying what the screen holds.
     *
     * A FRAGMENT, NOT A SENTENCE. It sits on one row of a list being searched, so it takes no
     * full stop and no verb it can do without. The rail does not draw it -- a label that names
     * one of the things this app is made of needs no gloss under it.
     */
    hint: string
    icon: LucideIcon
    /** The library this entry needs, or null for a screen every server has. */
    requires: Library | null
}

/** A run of entries under one heading. */
export interface NavSection {
    id: string
    /** The heading, or null for the first section, which needs none. */
    label: string | null
    entries: NavEntry[]
}

/** Where a reader with no address of their own lands, when this server has music. */
export const MUSIC_PATH = '/music'

/** Where they land when it has not: a books-only instance is a whole instance. */
export const BOOKS_PATH = '/books'

/** Where the subscribed channels are, which a channel and a video both sit under. */
export const YOUTUBE_PATH = '/youtube'

export const NAV: NavSection[] = [
    {
        id: 'listen',
        label: null,
        entries: [
            {
                path: MUSIC_PATH,
                label: 'Music',
                hint: 'Artists, albums and what is on them',
                icon: Music,
                requires: 'audio',
            },
            {
                path: '/music/starred',
                label: 'Favourites',
                hint: 'Everything starred, on any client',
                icon: Star,
                requires: 'audio',
            },
            {
                path: '/radio',
                label: 'Radio',
                hint: 'The stations this server carries',
                icon: Radio,
                requires: 'radio',
            },
            {
                path: BOOKS_PATH,
                label: 'Audiobooks',
                hint: 'Books, their chapters, and where you stopped',
                icon: BookAudio,
                requires: 'books',
            },
        ],
    },
    {
        id: 'watch',
        label: 'Watch',
        entries: [
            {
                path: '/video',
                label: 'Video',
                hint: 'Films and series',
                icon: Clapperboard,
                requires: 'video',
            },
            {
                path: YOUTUBE_PATH,
                label: 'YouTube',
                hint: 'Channels you subscribed to, and what they put out',
                icon: MonitorPlay,
                requires: 'youtube',
            },
        ],
    },
]

/** Whether this server has what an entry needs. */
function present(entry: NavEntry, caps: Capabilities | null): boolean {
    if (entry.requires === null) return true
    return caps !== null && caps[entry.requires]
}

/**
 * The sections this server offers, with the empty ones dropped.
 *
 * Capabilities of null is a server that has not answered yet, and it is offered nothing rather
 * than everything: a rail that drew five entries and then took three away is worse than one
 * that arrives a frame late with the four this instance actually has.
 */
export function sectionsFor(caps: Capabilities | null): NavSection[] {
    return NAV.map((section) => ({
        ...section,
        entries: section.entries.filter((entry) => present(entry, caps)),
    })).filter((section) => section.entries.length > 0)
}

/** Every entry this server offers, flattened, which is what the palette shelves. */
export function entriesFor(caps: Capabilities | null): NavEntry[] {
    return sectionsFor(caps).flatMap((section) => section.entries)
}

/** Where a reader lands with no address of their own. */
export function homePath(caps: Capabilities | null): string {
    return caps?.audio ? MUSIC_PATH : BOOKS_PATH
}

/** Whether one address is inside a path, that path itself included. */
function inside(at: string, path: string): boolean {
    return at === path || at.startsWith(path === '/' ? '/' : `${path}/`)
}

/**
 * Whether the rail marks an entry while one address is open.
 *
 * PREFIX, EXCEPT WHERE A SIBLING CLAIMS IT. An artist and an album are Music read at a
 * particular record, so `/music/artist/x` has to mark Music, which a rule matching Music at
 * its own address alone left marking nothing at all -- a rail that says the reader is nowhere
 * is worse than one that says they are in two places. The exception is the entries that sit
 * beneath this one: `/music/starred` is Favourites' own address and belongs to Favourites, so
 * Music lets it go and the two never light together.
 */
export function marks(path: string, at: string): boolean {
    if (!inside(at, path)) return false
    return !NAV.flatMap((section) => section.entries).some(
        (entry) => entry.path !== path && inside(entry.path, path) && inside(at, entry.path),
    )
}

/**
 * The entry one address is inside, or null.
 *
 * Longest path first, so `/music/starred` answers Favourites rather than Music.
 */
export function entryAt(path: string): NavEntry | null {
    const candidates = NAV.flatMap((section) => section.entries)
        .filter((entry) => path === entry.path || path.startsWith(`${entry.path}/`))
        .toSorted((left, right) => right.path.length - left.path.length)
    return candidates[0] ?? null
}
