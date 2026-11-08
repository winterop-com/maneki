import { Disc3, Music2, User } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'

import type { PaletteSearch } from '@winterop-com/sokkel-ui/CommandPalette'
import {
    Search,
    type SearchGroup,
    type SearchResult,
    type SearchSource,
} from '@winterop-com/sokkel-ui/Search'
import { useStore } from '@winterop-com/sokkel-ui/hooks/use-store'
import { Artwork } from '@winterop-com/sokkel-ui-media/Artwork'
import { albumPath, bookOfAlbum } from '@/lib/nav'
import { play } from '@/lib/player'
import {
    SEARCH_DEBOUNCE_MS,
    SEARCH_MIN,
    searchAsked,
    searchOpen,
    searchSeed,
    shelveResults,
    type ResultKind,
    type SearchRow,
} from '@/lib/search'
import { sessionStore } from '@/lib/session'
import { coverUrl, getAlbum, search as searchLibrary, type Credentials, type Song } from '@/lib/subsonic'

export const SEARCH_TITLE = 'Search the library'
export const SEARCH_PLACEHOLDER = 'Search'
export const SEARCH_RESULTS = 'In the library'
export const SEARCH_EMPTY = 'Nothing in the library answers to that'
export const SEARCH_ASKING = 'Searching.'
export const SEARCH_FAILED = 'The server did not answer the search'

/** The mark each kind of row wears, so the three shelves are told apart at a glance. */
const GLYPHS = { artist: User, album: Disc3, track: Music2 }

/** The pixel size asked of the server for a row's cover, twice the row's thumbnail. */
const THUMB_PX = 80

/** The library as sokkel-ui's search asks it, and what choosing a result does. */
export interface LibrarySearchSource {
    search: SearchSource
    onOpen: (result: SearchResult, group: SearchGroup) => void
}

/**
 * The search over the whole library, for the top bar's field and the palette alike; null where
 * there is no library to ask (radio-only).
 *
 * THE QUESTION IS ASKED ONCE PER PAUSE, not once per keystroke, and an answer to a query somebody
 * has typed past never lands: both are `Search`'s, given `SEARCH_DEBOUNCE_MS` and `SEARCH_MIN`.
 *
 * A TRACK PLAYS ITS ALBUM FROM THERE, AND OPENS IT, which is what picking a track does everywhere
 * else in this app. It costs one `getAlbum`, and a track whose album cannot be read plays alone.
 */
export function useLibrarySearch(): LibrarySearchSource | null {
    const credentials = useStore(sessionStore).music ?? null
    const navigate = useNavigate()
    // The tracks of the answers so far, by id, so choosing one has the song to play.
    const songs = useRef(new Map<string, Song>())

    return useMemo(() => {
        if (credentials === null) return null
        return {
            search: async (query) => {
                const found = await searchLibrary(credentials, query.trim())
                for (const song of found.songs) songs.current.set(song.id, song)
                return shelveResults(found, query).map((shelf) => ({
                    kind: shelf.kind,
                    title: shelf.label,
                    results: shelf.rows.map((row) => resultOf(credentials, row)),
                }))
            },
            onOpen: (result, group) => {
                const kind = group.kind as ResultKind
                if (kind === 'artist') {
                    void navigate(`/music/artist/${result.id}`)
                    return
                }
                if (kind === 'album') {
                    void navigate(albumPath(result.id))
                    return
                }
                const song = songs.current.get(result.id)
                if (song === undefined) return
                // A part of a book is the book: it opens where its place is kept.
                const book = song.albumId === undefined ? null : bookOfAlbum(song.albumId)
                if (book !== null) {
                    void navigate(`/books/${book}`)
                    return
                }
                if (song.albumId !== undefined) void navigate(`/music/album/${song.albumId}`)
                void playFrom(credentials, song)
            },
        }
    }, [credentials, navigate])
}

/** One row as `Search` draws it: an artist's and an album's cover, a track's mark. */
function resultOf(credentials: Credentials, row: SearchRow): SearchResult {
    const pictured = row.kind !== 'track'
    return {
        id: row.id,
        title: row.title,
        detail: row.subtitle === '' ? undefined : row.subtitle,
        icon: GLYPHS[row.kind],
        artwork: pictured ? (
            <Artwork src={coverUrl(credentials, row.art, THUMB_PX) ?? undefined} seed={row.id} />
        ) : undefined,
    }
}

/** The same search in the frame's palette, so one box finds what to do and what there is. */
export function paletteSearchOf(source: LibrarySearchSource | null): PaletteSearch | undefined {
    if (source === null) return undefined
    return { ...source, minQuery: SEARCH_MIN, words: { searching: SEARCH_ASKING } }
}

/**
 * The library search in the top bar, which `/` focuses: its results open in a popover under it.
 *
 * Choosing a result takes focus out of the field, so Space and the arrows are the player's again
 * on the screen it opened. `onUnreachable` is called when something asks for the field while it
 * is not drawn (a phone, where the top bar gives the palette its place).
 */
export function LibrarySearch({
    source,
    onUnreachable,
}: {
    source: LibrarySearchSource
    onUnreachable: () => void
}) {
    const query = useStore(searchSeed)
    const open = useStore(searchOpen)
    const asked = useStore(searchAsked)
    const frame = useRef<HTMLDivElement | null>(null)
    const unreachable = useRef(onUnreachable)
    useEffect(() => {
        unreachable.current = onUnreachable
    })

    // The palette's row asks for the field once the palette has closed and given focus back.
    useEffect(() => {
        if (asked === 0) return
        const timer = setTimeout(() => {
            const input = frame.current?.querySelector('input')
            if (input && input.getClientRects().length > 0) input.focus()
            else unreachable.current()
        }, 0)
        return () => {
            clearTimeout(timer)
        }
    }, [asked])

    return (
        <div ref={frame} className="min-w-0">
            <Search
                search={source.search}
                onOpen={(result, group) => {
                    const focused = document.activeElement
                    if (focused instanceof HTMLElement && frame.current?.contains(focused)) focused.blur()
                    source.onOpen(result, group)
                }}
                query={query}
                onQueryChange={searchSeed.set}
                open={open}
                onOpenChange={searchOpen.set}
                debounce={SEARCH_DEBOUNCE_MS}
                minQuery={SEARCH_MIN}
                words={{
                    placeholder: SEARCH_PLACEHOLDER,
                    results: SEARCH_RESULTS,
                    searching: SEARCH_ASKING,
                    empty: () => SEARCH_EMPTY,
                    failed: () => SEARCH_FAILED,
                }}
            />
        </div>
    )
}

/** Play a track the way picking one anywhere else in this app does: its album, from there. */
async function playFrom(credentials: Credentials, song: Song): Promise<void> {
    if (song.albumId !== undefined) {
        try {
            const { songs } = await getAlbum(credentials, song.albumId)
            const at = songs.findIndex((one) => one.id === song.id)
            if (at >= 0) {
                play(songs, at)
                return
            }
        } catch {
            // The album could not be read. The track itself is still a track.
        }
    }
    play([song], 0)
}
