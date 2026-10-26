import { describe, expect, test } from 'vitest'

import { albumPath, bookOfAlbum, entriesFor, homePath, marks, NAV, sectionsFor } from '@/lib/nav'
import type { Capabilities } from '@/lib/types'

function server(has: Partial<Capabilities>): Capabilities {
    return {
        server: 'maneki',
        version: '0.0.0',
        audio: false,
        video: false,
        youtube: false,
        radio: false,
        books: false,
        auth_required: false,
        endpoints: {
            audio_subsonic: null,
            video_api: null,
            books_api: null,
            auth_login: '/auth/login',
        },
        ...has,
    }
}

describe('the navigation', () => {
    test('offers only what this server has', () => {
        const paths = entriesFor(server({ audio: true, radio: true })).map((entry) => entry.path)
        expect(paths).toEqual(['/music', '/music/starred', '/music/downloaded', '/playlists', '/radio'])
    })

    test('a books-only server is a whole server, not an empty music library', () => {
        const paths = entriesFor(server({ books: true })).map((entry) => entry.path)
        expect(paths).toEqual(['/books'])
    })

    test('offers YouTube on its own capability, not on there being local video', () => {
        expect(entriesFor(server({ video: true })).map((entry) => entry.path)).toEqual(['/video'])
        expect(entriesFor(server({ youtube: true })).map((entry) => entry.path)).toEqual(['/youtube'])
        expect(entriesFor(server({ video: true, youtube: true })).map((entry) => entry.path)).toEqual([
            '/video',
            '/youtube',
        ])
    })

    test('drops a section left with no entries rather than drawing its heading', () => {
        const sections = sectionsFor(server({ audio: true }))
        expect(sections.map((section) => section.id)).toEqual(['listen'])
    })

    test('a server that has not answered yet is offered nothing, not everything', () => {
        expect(entriesFor(null)).toEqual([])
    })

    test('lands on music where there is music, and on books where there is not', () => {
        expect(homePath(server({ audio: true, books: true }))).toBe('/music')
        expect(homePath(server({ books: true }))).toBe('/books')
        expect(homePath(null)).toBe('/books')
    })

    test('gives every entry a hint for the palette, which is where somebody is searching', () => {
        for (const entry of NAV.flatMap((section) => section.entries)) {
            expect(entry.hint.length).toBeGreaterThan(0)
            expect(entry.hint.endsWith('.')).toBe(false)
        }
    })
})

describe('what the rail marks', () => {
    // Regression: Music was matched at its own address alone, because Favourites sits under
    // it, so opening an artist or an album left the rail marking nothing at all.
    test('an artist and an album are music read at a record, so music stays marked', () => {
        expect(marks('/music', '/music')).toBe(true)
        expect(marks('/music', '/music/artist/ar_1')).toBe(true)
        expect(marks('/music', '/music/album/al_1')).toBe(true)
    })

    test('a sibling keeps its own address, so favourites and music never light together', () => {
        expect(marks('/music', '/music/starred')).toBe(false)
        expect(marks('/music/starred', '/music/starred')).toBe(true)
        expect(marks('/music', '/music/downloaded')).toBe(false)
        expect(marks('/music/downloaded', '/music/downloaded')).toBe(true)
        expect(marks('/music', '/playlists/pl_1')).toBe(false)
        expect(marks('/playlists', '/playlists/pl_1')).toBe(true)
        expect(marks('/music/starred', '/music')).toBe(false)
        expect(marks('/music/starred', '/music/artist/ar_1')).toBe(false)
    })

    test('an entry with nothing beneath it is a plain prefix', () => {
        expect(marks('/books', '/books/bk_1')).toBe(true)
        expect(marks('/video', '/video/browse/Films/Alien')).toBe(true)
        // A channel and a video are both inside YouTube, which stays marked on each.
        expect(marks('/youtube', '/youtube/c/UC_x5XG1OV2P6uZZ5FSM9Ttw')).toBe(true)
        expect(marks('/youtube', '/youtube/v/dQw4w9WgXcQ')).toBe(true)
    })

    test('an address outside an entry marks nothing, and a near miss is not a prefix', () => {
        expect(marks('/music', '/radio')).toBe(false)
        expect(marks('/video', '/videos')).toBe(false)
    })
})

describe('where an album found anywhere opens', () => {
    test('a record opens on the music screen', () => {
        expect(albumPath('al_123')).toBe('/music/album/al_123')
    })

    test('a book opens on its own screen, where its place is kept, not as a record', () => {
        // Found through search it opened as an album, and played as tracks: no position saved,
        // no jumps, no speed.
        expect(albumPath('bkb_c2431dd64b522529')).toBe('/books/c2431dd64b522529')
        expect(bookOfAlbum('bkb_c2431dd64b522529')).toBe('c2431dd64b522529')
        expect(bookOfAlbum('al_123')).toBeNull()
    })
})
