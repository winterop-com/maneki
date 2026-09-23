import { describe, expect, test } from 'vitest'

import {
    ALBUMS_SHELF,
    ARTISTS_SHELF,
    closeSearch,
    openSearch,
    rankOf,
    searchOpen,
    searchSeed,
    shelveResults,
    TRACKS_SHELF,
    TRACK_LIMIT,
    worthAsking,
} from '@/lib/search'
import type { Album, Artist, SearchResult, Song } from '@/lib/subsonic'

function artist(name: string, albumCount?: number): Artist {
    return { id: `ar:${name}`, name, albumCount }
}

function album(name: string, by = 'Somebody', year?: number): Album {
    return { id: `al:${name}`, name, artist: by, songCount: 1, duration: 1, year }
}

function song(title: string, by?: string, on?: string): Song {
    return { id: `tr:${title}`, title, artist: by, album: on }
}

function answer(found: Partial<SearchResult>): SearchResult {
    return { artists: [], albums: [], songs: [], ...found }
}

describe('when the server is asked', () => {
    test('never for one letter, which matches a slice of the alphabet', () => {
        expect(worthAsking('')).toBe(false)
        expect(worthAsking('a')).toBe(false)
        expect(worthAsking('ab')).toBe(true)
    })

    test('on what was typed rather than on the spaces around it', () => {
        expect(worthAsking('  a  ')).toBe(false)
        expect(worthAsking('  ab  ')).toBe(true)
    })
})

describe('the shelves', () => {
    test('are nothing at all for a query the server was never asked', () => {
        const found = answer({ artists: [artist('Oasis')] })
        expect(shelveResults(found, '')).toEqual([])
        expect(shelveResults(found, 'o')).toEqual([])
        expect(shelveResults(null, 'oasis')).toEqual([])
    })

    test('are headed Artists, Albums and Tracks, in that order', () => {
        const found = answer({
            artists: [artist('Oasis')],
            albums: [album('Definitely Maybe')],
            songs: [song('Live Forever')],
        })
        expect(shelveResults(found, 'oasis').map((shelf) => shelf.label)).toEqual([
            ARTISTS_SHELF,
            ALBUMS_SHELF,
            TRACKS_SHELF,
        ])
    })

    test('leave out a kind the search did not find, rather than heading an empty one', () => {
        const found = answer({ songs: [song('Live Forever')] })
        expect(shelveResults(found, 'live').map((shelf) => shelf.label)).toEqual([TRACKS_SHELF])
    })

    test('cap the tracks, which is the kind a broad query answers with hundreds of', () => {
        const many = Array.from({ length: 40 }, (_unused, index) => song(`Love ${index}`))
        const [tracks] = shelveResults(answer({ songs: many }), 'love')
        expect(tracks?.rows).toHaveLength(TRACK_LIMIT)
    })

    test('carry what each row says about itself, with no separator around a gap', () => {
        const found = answer({
            artists: [artist('Oasis', 1)],
            albums: [album('Love Sux', 'Avril Lavigne', 2022)],
            songs: [song('Love Sux', 'Avril Lavigne', 'Love Sux'), song('Untagged')],
        })
        const [artists, albums, tracks] = shelveResults(found, 'love')
        expect(artists?.rows[0]).toEqual({
            kind: 'artist',
            id: 'ar:Oasis',
            title: 'Oasis',
            subtitle: '1 album',
        })
        expect(albums?.rows[0]?.subtitle).toBe('Avril Lavigne · 2022')
        expect(tracks?.rows[0]?.subtitle).toBe('Avril Lavigne · Love Sux')
        expect(tracks?.rows[1]?.subtitle).toBe('')
    })
})

describe('the order inside a shelf', () => {
    test('lifts a name that starts with the query over one that merely holds it', () => {
        const found = answer({
            albums: [album('Absolute Love Songs'), album('Love Sux')],
        })
        const [albums] = shelveResults(found, 'love')
        expect(albums?.rows.map((row) => row.title)).toEqual(['Love Sux', 'Absolute Love Songs'])
    })

    test("keeps the server's own order between rows that rank alike", () => {
        const found = answer({ albums: [album('Love Sux'), album('Love Is Here')] })
        const [albums] = shelveResults(found, 'love')
        expect(albums?.rows.map((row) => row.title)).toEqual(['Love Sux', 'Love Is Here'])
    })

    test('folds the marks off a name, so royk ranks Röyksopp first', () => {
        const found = answer({ artists: [artist('Rank 1'), artist('Röyksopp')] })
        const [artists] = shelveResults(found, 'royk')
        expect(artists?.rows[0]?.title).toBe('Röyksopp')
        expect(rankOf('Röyksopp', 'royk')).toBe(0)
        expect(rankOf('The Röyksopp Remixes', 'royk')).toBe(1)
        expect(rankOf('Oasis', 'royk')).toBe(2)
    })

    test('keeps a row the server matched on something other than its name', () => {
        // search3 matches a track on its album as well, and a row it found is a row.
        const found = answer({ songs: [song('Wonderwall', 'Oasis', 'Love Sux')] })
        const [tracks] = shelveResults(found, 'love')
        expect(tracks?.rows).toHaveLength(1)
    })
})

describe('opening the search', () => {
    test('carries what was typed into the strip over to the box', () => {
        openSearch('röyk')
        expect(searchOpen.get()).toBe(true)
        expect(searchSeed.get()).toBe('röyk')
    })

    test('opens empty for everything that hands it nothing', () => {
        closeSearch()
        openSearch()
        expect(searchOpen.get()).toBe(true)
        expect(searchSeed.get()).toBe('')
        closeSearch()
    })
})
