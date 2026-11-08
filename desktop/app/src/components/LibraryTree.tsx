import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { SearchField } from '@winterop-com/sokkel-ui/SearchField'
import { Tree, type TreeNode } from '@winterop-com/sokkel-ui/Tree'
import {
    albumNode,
    albumParents,
    libraryNodes,
    nodePath,
    nodeTarget,
    routeChoice,
    searchTrails,
} from '@/lib/library-tree'
import { SEARCH_DEBOUNCE_MS, worthAsking } from '@/lib/search'
import {
    getAlbum,
    getArtist,
    search as searchLibrary,
    type Album,
    type Artist,
    type Credentials,
} from '@/lib/subsonic'

/** What the tree's field says, and its name to a screen reader. */
const FIND_LABEL = 'Find an artist or album'

/**
 * The library as a tree, beside whatever the address opened.
 *
 * THE ADDRESS IS WHAT IS CHOSEN. Choosing a row navigates, and the row chosen is read back from
 * the address, so a link, Back, the palette and the top bar's search all choose in the tree the
 * way a click on it does.
 *
 * AN ARTIST'S ALBUMS ARE ASKED FOR ONCE, when the artist is first opened or an album of theirs is
 * first opened from elsewhere, and kept while the screen is: a library of thousands of artists
 * asks for the few somebody opens. The tree draws only the rows in view.
 */
export function LibraryTree({
    credentials,
    artists,
    articles,
    artistId,
    albumId,
}: {
    credentials: Credentials
    artists: readonly Artist[]
    articles: readonly string[]
    artistId?: string
    albumId?: string
}) {
    const navigate = useNavigate()
    const { pathname } = useLocation()
    const [albums, setAlbums] = useState<ReadonlyMap<string, readonly Album[]>>(() => new Map())
    const asking = useRef(new Map<string, Promise<readonly Album[]>>())

    const byId = useMemo(() => new Map(artists.map((artist) => [artist.id, artist])), [artists])
    const nodes = useMemo(() => libraryNodes(artists, albums, articles), [artists, albums, articles])
    const parents = useMemo(() => albumParents(albums), [albums])
    const choice = useMemo(() => routeChoice({ artistId, albumId }, parents), [artistId, albumId, parents])
    // What stands open when the tree is first drawn; after that the tree opens down to a choice itself.
    const [expanded] = useState(choice.expanded)

    /** One artist's albums, asked for once however many times they are wanted. */
    const albumsOf = useCallback(
        (id: string): Promise<readonly Album[]> => {
            const held = asking.current.get(id)
            if (held !== undefined) return held
            const asked = getArtist(credentials, id).then(({ albums: list }) => {
                setAlbums((now) => new Map(now).set(id, list))
                return list
            })
            // A refusal is not kept: the tree's row to try again asks again.
            asked.catch(() => asking.current.delete(id))
            asking.current.set(id, asked)
            return asked
        },
        [credentials],
    )

    const loadChildren = useCallback(
        async (node: TreeNode): Promise<readonly TreeNode[]> => {
            const target = nodeTarget(node.id)
            if (target?.kind !== 'artist') return []
            return (await albumsOf(target.id)).map(albumNode)
        },
        [albumsOf],
    )

    // AN ALBUM OPENED FROM ELSEWHERE OPENS ITS ARTIST. Which artist is the album's to say, so it is
    // asked once per album; that artist's albums then put the album's row in the tree to choose.
    const placed = useRef(new Set<string>())
    useEffect(() => {
        if (albumId === undefined || parents.has(albumId) || placed.current.has(albumId)) return
        placed.current.add(albumId)
        getAlbum(credentials, albumId).then(
            ({ album }) => {
                if (album.artistId !== undefined && byId.has(album.artistId)) {
                    albumsOf(album.artistId).catch(() => undefined)
                }
            },
            () => undefined,
        )
    }, [albumId, albumsOf, byId, credentials, parents])

    // The field answers at once; the tree is asked once the typing pauses and the query is worth a
    // request, which is what the top bar's search waits for too.
    const [typed, setTyped] = useState('')
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

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 p-2">
                {/* The top bar's field keeps `/`: one key, one field. */}
                <SearchField value={typed} onChange={setTyped} placeholder={FIND_LABEL} shortcut={false} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
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
            </div>
        </div>
    )
}
