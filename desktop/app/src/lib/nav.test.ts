import { describe, expect, test } from 'vitest'

import { entriesFor, entryAt, homePath, marksOnlyItself, NAV, sectionsFor } from '@/lib/nav'
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
        expect(paths).toEqual(['/music', '/music/starred', '/radio'])
    })

    test('a books-only server is a whole server, not an empty music library', () => {
        const paths = entriesFor(server({ books: true })).map((entry) => entry.path)
        expect(paths).toEqual(['/books'])
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
    test('music is marked at its own address only, because favourites sits under it', () => {
        expect(marksOnlyItself('/music')).toBe(true)
        expect(marksOnlyItself('/music/starred')).toBe(false)
        expect(marksOnlyItself('/books')).toBe(false)
    })

    test('the longest path wins, so favourites is not read as music', () => {
        expect(entryAt('/music/starred')?.label).toBe('Favourites')
        expect(entryAt('/music/album/al_1')?.label).toBe('Music')
        expect(entryAt('/books/bk_1')?.label).toBe('Audiobooks')
    })

    test('an address under no entry marks nothing', () => {
        expect(entryAt('/nowhere')).toBeNull()
    })
})
