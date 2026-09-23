/**
 * The two grammars a maneki server accepts a token in, and which call uses which.
 *
 * Everything that goes through `fetch` signs itself with a header. Everything the browser
 * fetches out of an address -- a picture, a stream, a subtitle track, an event stream -- has no
 * header to sign with and carries the same token in the query instead. What is checked here is
 * that each builder is on the right side of that line, and that a server wanting no sign-in
 * gets neither.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { books, mediaUrl, setSession, url, video, youtube } from '@/lib/api'

const BASE = 'https://box.local'
/** A token with a character that has to be escaped before it goes in a URL. */
const TOKEN = 'abc+def/ghi=='

beforeEach(() => {
    setSession({ baseUrl: BASE })
})

afterEach(() => {
    vi.unstubAllGlobals()
    setSession({ baseUrl: '' })
})

describe('mediaUrl', () => {
    test('is the plain URL when the server wants no sign-in', () => {
        expect(mediaUrl('/books/api/books/b1/cover')).toBe(`${BASE}/books/api/books/b1/cover`)
        expect(mediaUrl('/books/api/books/b1/cover')).toBe(url('/books/api/books/b1/cover'))
    })

    test('hangs the token off a path that had no query', () => {
        setSession({ baseUrl: BASE, token: TOKEN })
        expect(mediaUrl('/video/api/stats/stream')).toBe(
            `${BASE}/video/api/stats/stream?token=abc%2Bdef%2Fghi%3D%3D`,
        )
    })

    test('joins on to a query that is already there', () => {
        setSession({ baseUrl: BASE, token: TOKEN })
        expect(mediaUrl('/books/api/books/b1/cover?size=200')).toBe(
            `${BASE}/books/api/books/b1/cover?size=200&token=abc%2Bdef%2Fghi%3D%3D`,
        )
    })

    test('escapes the token, so the URL survives whatever is in it', () => {
        setSession({ baseUrl: BASE, token: TOKEN })
        const parsed = new URL(mediaUrl('/video/api/stats/stream'))
        expect(parsed.searchParams.get('token')).toBe(TOKEN)
    })
})

/** Every media URL, as the screens ask for them. */
function everyMediaUrl(): string[] {
    return [
        books.coverUrl('b1'),
        books.coverUrl('b1', 200),
        books.fileUrl('api/books/b1/files/0'),
        video.streamUrl('v1'),
        video.hlsUrl('v1'),
        video.posterUrl('v1'),
        video.posterUrl('v1', 7),
        video.thumbnailUrl('v1'),
        video.thumbnailUrl('v1', 7),
        video.subtitleUrl('v1', 'sidecar:en'),
        video.statsStreamUrl(),
        youtube.hlsUrl('yt1'),
        youtube.hlsUrl('yt1', 720),
    ]
}

/** Answer everything with an empty list, remembering what was asked and how. */
function recording(): { url: string; init?: RequestInit }[] {
    const asked: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal(
        'fetch',
        vi.fn((input: string, init?: RequestInit) => {
            asked.push({ url: String(input), init })
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) })
        }),
    )
    return asked
}

describe('the builders that hand an address to the browser', () => {
    test('carry the token when the session holds one', () => {
        setSession({ baseUrl: BASE, token: TOKEN })
        for (const built of everyMediaUrl()) {
            expect(new URL(built).searchParams.get('token'), built).toBe(TOKEN)
        }
    })

    test('carry nothing extra when it does not', () => {
        for (const built of everyMediaUrl()) {
            expect(built.includes('token='), built).toBe(false)
        }
    })

    test('keep the query they were already carrying', () => {
        setSession({ baseUrl: BASE, token: TOKEN })
        expect(new URL(books.coverUrl('b1', 200)).searchParams.get('size')).toBe('200')
        // The video builders' own `token` is a cache-busting version, not this one.
        expect(new URL(video.thumbnailUrl('v1', 7)).searchParams.get('v')).toBe('7')
        expect(new URL(youtube.hlsUrl('yt1', 720)).searchParams.get('h')).toBe('720')
    })
})

describe('the calls that go through fetch', () => {
    test('sign themselves with the header and leave the URL alone', async () => {
        const asked = recording()
        setSession({ baseUrl: BASE, token: TOKEN })
        await books.list()
        const call = asked[0]
        expect(call?.url).toBe(`${BASE}/books/api/books`)
        expect(new Headers(call?.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    })

    test('send no authorization at all against a server that wants none', async () => {
        const asked = recording()
        await books.list()
        expect(new Headers(asked[0]?.init?.headers).get('authorization')).toBe(null)
    })
})
