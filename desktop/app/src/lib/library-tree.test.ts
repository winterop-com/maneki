import { describe, expect, test } from 'vitest'

import {
    albumNode,
    albumNodeId,
    albumParents,
    artistNode,
    artistNodeId,
    libraryNodes,
    nodePath,
    nodeTarget,
    routeChoice,
    searchTrails,
} from '@/lib/library-tree'
import type { Album, Artist } from '@/lib/subsonic'

function artist(id: string, name: string, albumCount?: number): Artist {
    return { id, name, albumCount }
}

function album(id: string, name: string, artistId?: string, year?: number): Album {
    return { id, name, artist: '', artistId, songCount: 1, duration: 60, year }
}

describe('node ids', () => {
    test('an artist and an album with one id are two rows', () => {
        expect(artistNodeId('7')).not.toBe(albumNodeId('7'))
    })

    test('a row says what it stands for', () => {
        expect(nodeTarget(artistNodeId('ar-1'))).toEqual({ kind: 'artist', id: 'ar-1' })
        expect(nodeTarget(albumNodeId('al:1'))).toEqual({ kind: 'album', id: 'al:1' })
        expect(nodeTarget('something')).toBeNull()
    })

    test('choosing a row opens its page', () => {
        expect(nodePath(artistNodeId('ar-1'))).toBe('/music/artist/ar-1')
        expect(nodePath(albumNodeId('al-1'))).toBe('/music/album/al-1')
        expect(nodePath('stray')).toBe('/music')
    })

    test('a book chosen as an album opens on the books screen', () => {
        expect(nodePath(albumNodeId('bkb_42'))).toBe('/books/42')
    })
})

describe('nodes', () => {
    test('an artist not yet opened is a branch with its albums counted', () => {
        expect(artistNode(artist('1', 'Air', 3))).toEqual({
            id: 'artist:1',
            label: 'Air',
            meta: '3',
            hasChildren: true,
        })
    })

    test('an artist with no albums opens on nothing, so is no branch', () => {
        expect(artistNode(artist('1', 'Air', 0)).hasChildren).toBeUndefined()
    })

    test('an artist whose count is unknown is still a branch', () => {
        const node = artistNode(artist('1', 'Air'))
        expect(node.hasChildren).toBe(true)
        expect(node.meta).toBeUndefined()
    })

    test('loaded albums are the artist row children, in the order given', () => {
        const node = artistNode(artist('1', 'Air', 2), [
            album('b', 'Talkie Walkie', '1', 2004),
            album('a', 'Moon Safari', '1'),
        ])
        expect(node.hasChildren).toBeUndefined()
        expect(node.children).toEqual([
            { id: 'album:b', label: 'Talkie Walkie', meta: '2004' },
            { id: 'album:a', label: 'Moon Safari', meta: undefined },
        ])
    })

    test('an album says its year at the end', () => {
        expect(albumNode(album('x', 'Moon Safari', '1', 1998)).meta).toBe('1998')
    })

    test('artists read A to Z by the name minus its article', () => {
        const nodes = libraryNodes(
            [artist('1', 'The Zombies'), artist('2', 'Beck'), artist('3', 'Air')],
            new Map(),
            ['The'],
        )
        expect(nodes.map((node) => node.label)).toEqual(['Air', 'Beck', 'The Zombies'])
    })

    test('only the opened artists carry their albums', () => {
        const nodes = libraryNodes(
            [artist('1', 'Air', 1), artist('2', 'Beck', 1)],
            new Map([['2', [album('o', 'Odelay', '2')]]]),
        )
        expect(nodes[0].children).toBeUndefined()
        expect(nodes[1].children?.map((child) => child.id)).toEqual(['album:o'])
    })
})

describe('routeChoice', () => {
    const parents = albumParents(new Map([['ar', [album('al', 'Moon Safari', 'ar')]]]))

    test('the library itself chooses nothing', () => {
        expect(routeChoice({}, parents)).toEqual({ selected: [], expanded: [] })
    })

    test('an artist address chooses the artist', () => {
        expect(routeChoice({ artistId: 'ar' }, parents)).toEqual({ selected: ['artist:ar'], expanded: [] })
    })

    test('an album address chooses the album and opens its artist', () => {
        expect(routeChoice({ albumId: 'al' }, parents)).toEqual({
            selected: ['album:al'],
            expanded: ['artist:ar'],
        })
    })

    test('an album whose artist is not loaded yet chooses nothing until it is', () => {
        expect(routeChoice({ albumId: 'elsewhere' }, parents)).toEqual({ selected: [], expanded: [] })
    })

    test('the album wins over an artist in the same address', () => {
        expect(routeChoice({ artistId: 'other', albumId: 'al' }, parents).selected).toEqual(['album:al'])
    })
})

describe('albumParents', () => {
    test('each loaded album finds its artist', () => {
        const parents = albumParents(
            new Map([
                ['a1', [album('x', 'X'), album('y', 'Y')]],
                ['a2', [album('z', 'Z')]],
            ]),
        )
        expect([...parents]).toEqual([
            ['x', 'a1'],
            ['y', 'a1'],
            ['z', 'a2'],
        ])
    })
})

describe('searchTrails', () => {
    const listed = new Map([
        ['ar', artist('ar', 'Air', 2)],
        ['be', artist('be', 'Beck', 1)],
    ])

    test('artists stand alone and albums stand under their artist', () => {
        const trails = searchTrails(
            { artists: [artist('ar', 'Air', 2)], albums: [album('al', 'Moon Safari', 'ar')], songs: [] },
            listed,
            'air',
        )
        expect(trails.map((trail) => [trail.node.id, trail.ancestors.map((each) => each.label)])).toEqual([
            ['artist:ar', []],
            ['album:al', ['Air']],
        ])
    })

    test('what the tree does not hold is left out: authors, books, albums without a listed artist', () => {
        const trails = searchTrails(
            {
                artists: [artist('author', 'Agatha Christie')],
                albums: [
                    album('bkb_1', 'Poirot', 'ar'),
                    album('loose', 'Loose'),
                    album('far', 'Far', 'nobody'),
                ],
                songs: [],
            },
            listed,
            'a',
        )
        expect(trails).toEqual([])
    })

    test('a name starting with the query comes first', () => {
        const trails = searchTrails(
            {
                artists: [],
                albums: [album('1', 'Sea Change', 'be'), album('2', 'Odelay', 'be')],
                songs: [],
            },
            listed,
            'ode',
        )
        expect(trails.map((trail) => trail.node.label)).toEqual(['Odelay', 'Sea Change'])
    })
})
