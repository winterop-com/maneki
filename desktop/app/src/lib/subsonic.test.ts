import { afterEach, describe, expect, test, vi } from 'vitest'

import {
    getAlbum,
    getArtists,
    makeCredentials,
    SubsonicError,
    call,
    coverUrl,
    streamUrl,
} from '@/lib/subsonic'

const credentials = {
    restUrl: 'https://host/audio/rest',
    username: 'mort',
    salt: 'abc123',
    token: 'deadbeef',
}

function answer(body: unknown, ok = true): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response),
    )
}

function lastUrl(): URL {
    const mock = fetch as unknown as { mock: { calls: [string][] } }
    return new URL(mock.mock.calls[0]![0])
}

afterEach(() => vi.unstubAllGlobals())

describe('credentials', () => {
    test('are a salt and a token, never the password', () => {
        const made = makeCredentials('https://host/audio/rest/', 'mort', 'secret')
        expect(made.restUrl).toBe('https://host/audio/rest') // trailing slash trimmed
        expect(made.salt).toMatch(/^[0-9a-f]{24}$/)
        expect(made.token).toMatch(/^[0-9a-f]{32}$/)
        expect(JSON.stringify(made)).not.toContain('secret')
    })

    test('a fresh salt each time, so two sign-ins never share a token', () => {
        const one = makeCredentials('https://host/rest', 'mort', 'secret')
        const two = makeCredentials('https://host/rest', 'mort', 'secret')
        expect(one.salt).not.toBe(two.salt)
        expect(one.token).not.toBe(two.token)
    })
})

describe('requests', () => {
    test('carry the account, the client and the version', async () => {
        answer({ 'subsonic-response': { status: 'ok' } })
        await call(credentials, 'ping')
        const url = lastUrl()
        expect(url.pathname).toBe('/audio/rest/ping')
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            u: 'mort',
            t: 'deadbeef',
            s: 'abc123',
            c: 'maneki',
            f: 'json',
            v: '1.16.1',
        })
    })

    test('leave out parameters that were not given', async () => {
        answer({ 'subsonic-response': { status: 'ok', artists: { index: [] } } })
        await getArtists(credentials)
        expect(lastUrl().searchParams.has('musicFolderId')).toBe(false)
    })

    test('raise what the server refused, with its own code', async () => {
        answer({
            'subsonic-response': {
                status: 'failed',
                error: { code: 40, message: 'Wrong username or password' },
            },
        })
        await expect(call(credentials, 'ping')).rejects.toThrow(SubsonicError)
        await expect(call(credentials, 'ping')).rejects.toThrow('Wrong username or password')
    })

    test('a server that does not answer is a refusal too', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('network')
            }),
        )
        await expect(call(credentials, 'ping')).rejects.toThrow('the server did not answer')
    })
})

describe('reading the library', () => {
    test('artists come back flat, out of their A-Z grouping', async () => {
        answer({
            'subsonic-response': {
                status: 'ok',
                artists: {
                    index: [
                        { name: 'A', artist: [{ id: 'ar_1', name: 'ABBA' }] },
                        { name: 'R', artist: [{ id: 'ar_2', name: 'Röyksopp' }] },
                    ],
                },
            },
        })
        expect((await getArtists(credentials)).map((a) => a.name)).toEqual(['ABBA', 'Röyksopp'])
    })

    test('an album carries its songs', async () => {
        answer({
            'subsonic-response': {
                status: 'ok',
                album: {
                    id: 'al_1',
                    name: 'Junior',
                    artist: 'Röyksopp',
                    songCount: 1,
                    duration: 200,
                    song: [{ id: 'tr_1', title: 'Happy Up Here' }],
                },
            },
        })
        const { album, songs } = await getAlbum(credentials, 'al_1')
        expect(album.name).toBe('Junior')
        expect(songs.map((s) => s.title)).toEqual(['Happy Up Here'])
    })
})

describe('asset urls', () => {
    test('stream and cover carry the credentials, since the browser fetches them', () => {
        const stream = new URL(streamUrl(credentials, 'tr_1'))
        expect(stream.pathname).toBe('/audio/rest/stream')
        expect(stream.searchParams.get('id')).toBe('tr_1')
        expect(stream.searchParams.get('t')).toBe('deadbeef')

        const cover = coverUrl(credentials, 'al_1', 500)
        expect(cover).not.toBeNull()
        expect(new URL(cover!).searchParams.get('size')).toBe('500')
    })

    test('no cover art means no url to ask for', () => {
        expect(coverUrl(credentials, undefined)).toBeNull()
    })
})
