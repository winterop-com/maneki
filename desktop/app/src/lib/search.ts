/**
 * The search over the whole library: when the server is asked, and what its answer reads as.
 *
 * THE SHELVING AND THE RANKING ARE PURE, because they are what can quietly be wrong: a query
 * that finds an album but buries it under eight tracks, a name typed without its marks that
 * finds nothing, an empty box that shows the last answer. All three are decided here and
 * checked in Node, and the overlay only draws the answer.
 *
 * FOLDED ON BOTH SIDES, the way `Music` filters artists. "royk" has to rank Röyksopp first: the
 * server's own index is built with the marks removed, so a client that ranked on the raw string
 * would disagree with the results it is ordering.
 *
 * THE SERVER DECIDES WHAT IS IN THE LIBRARY, not this module. `search3` here adds audiobooks to
 * what it finds, and the ids it answers with browse exactly the way an artist's and an album's
 * do -- so a book found by its title opens on the same screen a record does, and nothing here
 * tries to guess which of the two a row is.
 */

import { fold } from '@/lib/sorting'
import type { SearchResult } from '@/lib/subsonic'
import { createStore } from '@/lib/store'

/**
 * Whether the search is on screen.
 *
 * Not kept between visits, like the stage and unlike the spectrum: it is opened to ask one
 * question, and an app that opened behind a search box because of yesterday is an app somebody
 * dismisses before using.
 */
export const searchOpen = createStore(false)

export function openSearch(): void {
    searchOpen.set(true)
}

export function closeSearch(): void {
    searchOpen.set(false)
}

/** How much has to be typed before the server is asked at all. */
export const SEARCH_MIN = 2

/** How long to wait after a keystroke, so a burst of them is one request. */
export const SEARCH_DEBOUNCE_MS = 250

/** How many of each kind a shelf holds. Tracks get more, being what most searches are for. */
export const ARTIST_LIMIT = 5
export const ALBUM_LIMIT = 5
export const TRACK_LIMIT = 8

/** What the shelves are called. */
export const ARTISTS_SHELF = 'Artists'
export const ALBUMS_SHELF = 'Albums'
export const TRACKS_SHELF = 'Tracks'

/** What kind of thing a row stands for, which is what Enter on it does. */
export type ResultKind = 'artist' | 'album' | 'track'

/** One row of the search: what it is, what it says, and what opening it needs. */
export interface SearchRow {
    kind: ResultKind
    /** The Subsonic id: an artist's and an album's are addresses, a track's is what it plays. */
    id: string
    title: string
    /** The line under the title. Empty where the row has nothing more to say about itself. */
    subtitle: string
}

/** One shelf: its heading and its rows, best first. */
export interface SearchShelf {
    label: string
    rows: SearchRow[]
}

/**
 * Whether a query is worth a request.
 *
 * One letter matches most of a library, so the answer would be a slice of the alphabet arriving
 * a keystroke behind the hands typing it.
 */
export function worthAsking(query: string): boolean {
    return query.trim().length >= SEARCH_MIN
}

/**
 * The answer as shelves, best first inside each.
 *
 * AN EMPTY QUERY ANSWERS NOTHING AT ALL, rather than everything: a palette opened with no
 * intention shows what it can do, but a search box with nothing in it has not been asked
 * anything, and showing the previous answer under an empty box is showing a stale one. The same
 * holds for a query too short to have been sent -- what is on screen then is not its answer.
 *
 * A SHELF WITH NOTHING ON IT IS NOT DRAWN, so a search that found one artist is one heading
 * rather than three with two saying nothing.
 */
export function shelveResults(found: SearchResult | null, query: string): SearchShelf[] {
    if (found === null || !worthAsking(query)) return []
    const needle = fold(query.trim())
    const shelves: SearchShelf[] = [
        {
            label: ARTISTS_SHELF,
            rows: best(found.artists, needle, ARTIST_LIMIT, (artist) => ({
                kind: 'artist',
                id: artist.id,
                title: artist.name,
                subtitle: albumCount(artist.albumCount),
            })),
        },
        {
            label: ALBUMS_SHELF,
            rows: best(found.albums, needle, ALBUM_LIMIT, (album) => ({
                kind: 'album',
                id: album.id,
                title: album.name,
                subtitle: joined([album.artist, album.year === undefined ? '' : String(album.year)]),
            })),
        },
        {
            label: TRACKS_SHELF,
            rows: best(found.songs, needle, TRACK_LIMIT, (song) => ({
                kind: 'track',
                id: song.id,
                title: song.title,
                subtitle: joined([song.artist ?? '', song.album ?? '']),
            })),
        },
    ]
    return shelves.filter((shelf) => shelf.rows.length > 0)
}

/** The best few of one kind, ranked against the query and capped. */
function best<T extends { name?: string; title?: string }>(
    found: readonly T[],
    needle: string,
    limit: number,
    row: (one: T) => SearchRow,
): SearchRow[] {
    return found
        .map((one, index) => ({ one, index, rank: rankOf(one.name ?? one.title ?? '', needle) }))
        .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
        .slice(0, limit)
        .map((scored) => row(scored.one))
}

/**
 * Where one name sorts for one query: a name that starts with it, then one that holds it.
 *
 * Everything else keeps the order the server put it in, which is its own relevance: a track
 * matched on its album rather than on its title is still a match, and this only lifts the rows
 * somebody was obviously typing towards above the ones they were not.
 */
export function rankOf(name: string, needle: string): number {
    const folded = fold(name)
    if (folded.startsWith(needle)) return 0
    if (folded.includes(needle)) return 1
    return 2
}

/** The parts of a subtitle with the empty ones left out, so no row reads " · ". */
function joined(parts: readonly string[]): string {
    return parts.filter((part) => part !== '').join(' · ')
}

function albumCount(count: number | undefined): string {
    if (count === undefined) return ''
    return `${count} ${count === 1 ? 'album' : 'albums'}`
}
