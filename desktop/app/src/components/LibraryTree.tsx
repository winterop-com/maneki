import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import type { RailBody } from '@winterop-com/sokkel-ui/Rail'
import { SearchField } from '@winterop-com/sokkel-ui/SearchField'
import { Tree, type TreeNode } from '@winterop-com/sokkel-ui/Tree'
import { useStore, useStoreValue } from '@winterop-com/sokkel-ui/hooks/use-store'
import { Skeleton } from '@/components/Skeleton'
import {
    albumNode,
    albumParents,
    libraryNodes,
    musicRoute,
    nodePath,
    nodeTarget,
    routeChoice,
    searchTrails,
} from '@/lib/library-tree'
import { albumsOf, musicLibraryStore, readLibrary } from '@/lib/music-library'
import { SEARCH_DEBOUNCE_MS, worthAsking } from '@/lib/search'
import { sessionStore } from '@/lib/session'
import { getAlbum, search as searchLibrary, type Credentials } from '@/lib/subsonic'

/** What the tree's field says, and its name to a screen reader. */
const FIND_LABEL = 'Find an artist or album'

/**
 * The rail's body while the address is in the music library: the artists and their albums as a
 * tree, with its field standing over it. Elsewhere there is none and the rail shows its places.
 *
 * The field's words are held here rather than in the tree, since the rail draws the field and
 * the tree apart; they are kept while the library is left and come back with it.
 */
export function useLibraryBody(): RailBody | undefined {
    const { pathname } = useLocation()
    const credentials = useStoreValue(sessionStore, (state) => state.music ?? null)
    const route = useMemo(() => musicRoute(pathname), [pathname])
    const [typed, setTyped] = useState('')
    const inLibrary = route !== null && credentials !== null

    useEffect(() => {
        if (inLibrary) readLibrary(credentials)
    }, [credentials, inLibrary])

    if (!inLibrary) return undefined
    return {
        title: 'Artists',
        // The top bar's field keeps `/`: one key, one field.
        search: <SearchField value={typed} onChange={setTyped} placeholder={FIND_LABEL} shortcut={false} />,
        content: (
            <LibraryTree
                credentials={credentials}
                artistId={route.artistId}
                albumId={route.albumId}
                typed={typed}
            />
        ),
    }
}

/**
 * The library as a tree, beside whatever the address opened.
 *
 * THE ADDRESS IS WHAT IS CHOSEN. Choosing a row navigates, and the row chosen is read back from
 * the address, so a link, Back, the palette and the top bar's search all choose in the tree the
 * way a click on it does.
 *
 * AN ARTIST'S ALBUMS ARE ASKED FOR ONCE, when the artist is first opened or an album of theirs is
 * first opened from elsewhere, and kept in `lib/music-library`: a library of thousands of artists
 * asks for the few somebody opens. The tree draws only the rows in view.
 */
function LibraryTree({
    credentials,
    artistId,
    albumId,
    typed,
}: {
    credentials: Credentials
    artistId?: string
    albumId?: string
    typed: string
}) {
    const navigate = useNavigate()
    const { pathname } = useLocation()
    const { index, refusal, albums } = useStore(musicLibraryStore)
    const artists = index?.artists
    const articles = index?.articles

    const byId = useMemo(() => new Map((artists ?? []).map((artist) => [artist.id, artist])), [artists])
    const nodes = useMemo(() => libraryNodes(artists ?? [], albums, articles), [artists, albums, articles])
    const parents = useMemo(() => albumParents(albums), [albums])
    const choice = useMemo(() => routeChoice({ artistId, albumId }, parents), [artistId, albumId, parents])
    // What stands open when the tree is first drawn; after that the tree opens down to a choice itself.
    const [expanded] = useState(choice.expanded)

    const loadChildren = useCallback(
        async (node: TreeNode): Promise<readonly TreeNode[]> => {
            const target = nodeTarget(node.id)
            if (target?.kind !== 'artist') return []
            return (await albumsOf(credentials, target.id)).map(albumNode)
        },
        [credentials],
    )

    // AN ALBUM OPENED FROM ELSEWHERE OPENS ITS ARTIST. Which artist is the album's to say, so it is
    // asked once per album; that artist's albums then put the album's row in the tree to choose.
    const placed = useRef(new Set<string>())
    useEffect(() => {
        if (albumId === undefined || parents.has(albumId) || placed.current.has(albumId)) return
        if (!byId.size) return
        placed.current.add(albumId)
        getAlbum(credentials, albumId).then(
            ({ album }) => {
                if (album.artistId !== undefined && byId.has(album.artistId)) {
                    albumsOf(credentials, album.artistId).catch(() => undefined)
                }
            },
            () => undefined,
        )
    }, [albumId, byId, credentials, parents])

    // The field answers at once; the tree is asked once the typing pauses and the query is worth a
    // request, which is what the top bar's search waits for too.
    const [query, setQuery] = useState('')
    useEffect(() => {
        const next = worthAsking(typed) ? typed.trim() : ''
        const timer = setTimeout(() => setQuery(next), next === '' ? 0 : SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [typed])
    const search = useCallback(
        async (asked: string) => searchTrails(await searchLibrary(credentials, asked), byId, asked),
        [byId, credentials],
    )

    if (refusal !== null && artists === undefined) {
        return <p className="px-2 py-4 text-sm text-muted-foreground">{refusal}</p>
    }
    if (artists === undefined) return <Skeleton rows={12} />
    if (!artists.length) return <p className="px-2 py-4 text-sm text-muted-foreground">No artists.</p>

    return (
        <Tree
            label="Music library"
            nodes={nodes}
            selected={choice.selected}
            defaultExpanded={expanded}
            onSelect={(ids) => {
                const id = ids[0]
                if (id === undefined) return
                const to = nodePath(id)
                if (to !== pathname) void navigate(to)
            }}
            loadChildren={loadChildren}
            query={query}
            search={search}
            words={{ empty: 'Nothing in the library matches.' }}
        />
    )
}
