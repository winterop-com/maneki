/**
 * The music library as a tree: artists A to Z, each opening on its albums.
 *
 * PURE, so the parts that can quietly be wrong are checked in Node: which id a row answers with,
 * which address a chosen row opens, which row an address chooses, and which search results the
 * tree may show. sokkel-ui's `Tree` draws the rows, opens them and loads them, in the rail's
 * body; `lib/music-library` holds the albums loaded so far.
 *
 * AN ARTIST AND AN ALBUM ARE TOLD APART BY THE ROW'S ID. The tree is one list of ids, and a
 * Subsonic server is free to give an artist and an album the same one, so each is prefixed with
 * what it is.
 */

import { albumPath, bookOfAlbum, MUSIC_PATH } from '@/lib/nav'
import { rankOf } from '@/lib/search'
import { fold, sortArtists } from '@/lib/sorting'
import type { Album, Artist, SearchResult } from '@/lib/subsonic'
import type { TreeNode, TreeTrail } from '@winterop-com/sokkel-ui/Tree'

const ARTIST = 'artist:'
const ALBUM = 'album:'

/** The row an artist is in the tree. */
export function artistNodeId(id: string): string {
    return `${ARTIST}${id}`
}

/** The row an album is in the tree. */
export function albumNodeId(id: string): string {
    return `${ALBUM}${id}`
}

/** What a row of the tree stands for, or null for an id this tree never made. */
export function nodeTarget(nodeId: string): { kind: 'artist' | 'album'; id: string } | null {
    if (nodeId.startsWith(ARTIST)) return { kind: 'artist', id: nodeId.slice(ARTIST.length) }
    if (nodeId.startsWith(ALBUM)) return { kind: 'album', id: nodeId.slice(ALBUM.length) }
    return null
}

/** Where choosing a row goes: the artist's page or the album's, the address being what is chosen. */
export function nodePath(nodeId: string): string {
    const target = nodeTarget(nodeId)
    if (target === null) return MUSIC_PATH
    return target.kind === 'artist' ? `/music/artist/${target.id}` : albumPath(target.id)
}

/**
 * An artist's row: the name, the albums counted at its end, and a branch until its albums are
 * known. An artist the server says has no albums opens on nothing, so it is no branch at all.
 */
export function artistNode(artist: Artist, albums?: readonly Album[]): TreeNode {
    const node: TreeNode = {
        id: artistNodeId(artist.id),
        label: artist.name,
        meta: artist.albumCount === undefined ? undefined : String(artist.albumCount),
    }
    if (albums !== undefined) return { ...node, children: albums.map(albumNode) }
    return artist.albumCount === 0 ? node : { ...node, hasChildren: true }
}

/** An album's row: its name, and its year at the end where it has one. */
export function albumNode(album: Album): TreeNode {
    return {
        id: albumNodeId(album.id),
        label: album.name,
        meta: album.year === undefined ? undefined : String(album.year),
    }
}

/** Every artist A to Z by the name minus its article, with the albums of those already opened. */
export function libraryNodes(
    artists: readonly Artist[],
    albums: ReadonlyMap<string, readonly Album[]>,
    articles?: readonly string[],
): TreeNode[] {
    return sortArtists(artists, 'name', articles).map((artist) => artistNode(artist, albums.get(artist.id)))
}

/** The artist each loaded album sits under, so an album's address can be found in the tree. */
export function albumParents(albums: ReadonlyMap<string, readonly Album[]>): Map<string, string> {
    const parents = new Map<string, string>()
    for (const [artistId, list] of albums) for (const album of list) parents.set(album.id, artistId)
    return parents
}

/** What the address chooses in the tree, and which artists stand open for it. */
export interface TreeChoice {
    selected: string[]
    expanded: string[]
}

/**
 * The row an address chooses.
 *
 * AN ALBUM IS CHOSEN ONLY ONCE ITS ARTIST'S ALBUMS ARE IN THE TREE. The tree opens down to a
 * choice it can find and does nothing for one it cannot, so an album chosen before its row
 * exists would stay unopened after the row arrives. Until then nothing is chosen.
 */
export function routeChoice(
    route: { artistId?: string; albumId?: string },
    parents: ReadonlyMap<string, string>,
): TreeChoice {
    if (route.albumId !== undefined) {
        const artistId = parents.get(route.albumId)
        if (artistId === undefined) return { selected: [], expanded: [] }
        return { selected: [albumNodeId(route.albumId)], expanded: [artistNodeId(artistId)] }
    }
    if (route.artistId !== undefined) return { selected: [artistNodeId(route.artistId)], expanded: [] }
    return { selected: [], expanded: [] }
}

/**
 * The search's answer as the tree's trails: each artist on its own, each album under its artist.
 *
 * ONLY WHAT THE TREE HOLDS. `search3` reaches the audiobooks too, whose authors are not among the
 * music folder's artists and whose books open on their own screen, so an artist the tree does not
 * list and an album that is a book or has no listed artist are left out. Best first, as the top
 * bar's search ranks them.
 */
export function searchTrails(
    found: SearchResult,
    artists: ReadonlyMap<string, Artist>,
    query: string,
): TreeTrail[] {
    const needle = fold(query.trim())
    const ranked = <T>(rows: readonly T[], name: (row: T) => string): T[] =>
        rows
            .map((row, index) => ({ row, index, rank: rankOf(name(row), needle) }))
            .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
            .map((scored) => scored.row)

    const trails: TreeTrail[] = []
    for (const artist of ranked(found.artists, (row) => row.name)) {
        const listed = artists.get(artist.id)
        if (listed !== undefined) trails.push({ node: artistNode(listed), ancestors: [] })
    }
    for (const album of ranked(found.albums, (row) => row.name)) {
        if (bookOfAlbum(album.id) !== null || album.artistId === undefined) continue
        const listed = artists.get(album.artistId)
        if (listed !== undefined) trails.push({ node: albumNode(album), ancestors: [artistNode(listed)] })
    }
    return trails
}

/**
 * What an address opens in the library, or null where it is not the library: `/music` is the
 * artists, `/music/artist/:id` an artist and `/music/album/:id` an album. Favourites and Downloads
 * sit under `/music` too, but are places of their own and draw no tree.
 */
export function musicRoute(pathname: string): { artistId?: string; albumId?: string } | null {
    const found = /^\/music(?:\/(artist|album)\/([^/]+))?\/?$/.exec(pathname)
    if (found === null) return null
    const [, kind, id] = found
    if (kind === undefined || id === undefined) return {}
    return kind === 'artist' ? { artistId: id } : { albumId: id }
}
