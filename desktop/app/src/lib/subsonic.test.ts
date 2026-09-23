import { afterEach, describe, expect, test, vi } from 'vitest'

import {
    createPlaylist,
    getAlbum,
    getPlaylist,
    musicFolderOf,
    playlistOf,
    playlistsOf,
    updatePlaylist,
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

    test('ask about one folder when the library has more than music in it', async () => {
        answer({ 'subsonic-response': { status: 'ok', artists: { index: [] } } })
        await getArtists(credentials, 1)
        expect(lastUrl().searchParams.get('musicFolderId')).toBe('1')
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
        const { artists } = await getArtists(credentials)
        expect(artists.map((a) => a.name)).toEqual(['ABBA', 'Röyksopp'])
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

describe('which folder the music screens mean', () => {
    test('is the one that is not the books, when a server serves both', () => {
        expect(
            musicFolderOf([
                { id: 1, name: 'Music' },
                { id: 2, name: 'Audiobooks' },
            ]),
        ).toBe(1)
    })

    test('is left unsaid on a server with one folder, which needs no filter', () => {
        expect(musicFolderOf([{ id: 1, name: 'Music' }])).toBeUndefined()
        expect(musicFolderOf([])).toBeUndefined()
    })

    test('carries the articles the server files names by', async () => {
        answer({
            'subsonic-response': {
                status: 'ok',
                artists: { ignoredArticles: 'The El La', index: [] },
            },
        })
        expect((await getArtists(credentials)).ignoredArticles).toBe('The El La')
    })
})

describe('playlists', () => {
    test('a listing with none is an empty list, not a missing one', () => {
        expect(playlistsOf({})).toEqual([])
        expect(playlistsOf({ playlists: {} })).toEqual([])
    })

    test('the tracks are the entries, held apart from what the playlist is', () => {
        const read = playlistOf(
            {
                playlist: {
                    id: 'pl_1',
                    name: 'Road trip',
                    songCount: 1,
                    duration: 200,
                    entry: [{ id: 'tr_1', title: 'One' }],
                },
            },
            'pl_1',
        )
        expect(read.playlist).toEqual({ id: 'pl_1', name: 'Road trip', songCount: 1, duration: 200 })
        expect(read.songs.map((song) => song.id)).toEqual(['tr_1'])
    })

    test('an empty playlist has no tracks rather than no list', () => {
        const read = playlistOf({ playlist: { id: 'pl_1', name: 'New', songCount: 0, duration: 0 } }, 'pl_1')
        expect(read.songs).toEqual([])
    })

    test('an answer without a playlist is a refusal', () => {
        expect(() => playlistOf({}, 'pl_9')).toThrow(SubsonicError)
    })

    test('reading one asks for it by id', async () => {
        answer({
            'subsonic-response': {
                status: 'ok',
                playlist: { id: 'pl_1', name: 'A', songCount: 0, duration: 0 },
            },
        })
        await getPlaylist(credentials, 'pl_1')
        expect(lastUrl().pathname).toBe('/audio/rest/getPlaylist')
        expect(lastUrl().searchParams.get('id')).toBe('pl_1')
    })

    test('making one says every track, one key each, in order', async () => {
        answer({
            'subsonic-response': {
                status: 'ok',
                playlist: { id: 'pl_1', name: 'A', songCount: 2, duration: 0 },
            },
        })
        await createPlaylist(credentials, 'A', ['tr_1', 'tr_2'])
        const url = lastUrl()
        expect(url.pathname).toBe('/audio/rest/createPlaylist')
        expect(url.searchParams.get('name')).toBe('A')
        expect(url.searchParams.getAll('songId')).toEqual(['tr_1', 'tr_2'])
    })

    test('a change carries only what it changes', async () => {
        answer({ 'subsonic-response': { status: 'ok' } })
        await updatePlaylist(credentials, 'pl_1', { remove: [3] })
        const url = lastUrl()
        expect(url.searchParams.get('playlistId')).toBe('pl_1')
        expect(url.searchParams.getAll('songIndexToRemove')).toEqual(['3'])
        expect(url.searchParams.has('name')).toBe(false)
        expect(url.searchParams.has('songIdToAdd')).toBe(false)
    })

    test('adding and renaming go in one request', async () => {
        answer({ 'subsonic-response': { status: 'ok' } })
        await updatePlaylist(credentials, 'pl_1', { name: 'B', add: ['tr_1', 'tr_2'] })
        const url = lastUrl()
        expect(url.searchParams.get('name')).toBe('B')
        expect(url.searchParams.getAll('songIdToAdd')).toEqual(['tr_1', 'tr_2'])
    })
})
