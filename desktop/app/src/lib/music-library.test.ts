import { beforeEach, describe, expect, test, vi } from 'vitest'

import { albumsOf, forgetLibrary, musicLibraryStore, readLibrary } from '@/lib/music-library'
import type { Credentials } from '@/lib/subsonic'

const calls = vi.hoisted(() => ({ artists: 0, artist: 0, refuse: false }))

vi.mock('@/lib/subsonic', async (original) => ({
    ...(await original<typeof import('@/lib/subsonic')>()),
    getMusicFolders: async () => [],
    getArtists: async () => {
        calls.artists += 1
        if (calls.refuse) throw new Error('Gone')
        return { artists: [{ id: 'ar-1', name: 'Beck' }], ignoredArticles: 'The' }
    },
    getArtist: async (_: Credentials, id: string) => {
        calls.artist += 1
        return { artist: { id, name: 'Beck' }, albums: [{ id: 'al-1', name: 'Odelay', artist: 'Beck' }] }
    },
}))

const ADA: Credentials = { restUrl: 'https://one/rest', username: 'ada', salt: 's', token: 't' }
const OTHER: Credentials = { ...ADA, restUrl: 'https://two/rest' }

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
    forgetLibrary()
    calls.artists = 0
    calls.artist = 0
    calls.refuse = false
})

describe('the music library', () => {
    test('the artists are asked for once, however many readers want them', async () => {
        readLibrary(ADA)
        readLibrary({ ...ADA, token: 'fresh' })
        await settle()
        readLibrary(ADA)
        expect(calls.artists).toBe(1)
        expect(musicLibraryStore.get().index?.artists.map((artist) => artist.name)).toEqual(['Beck'])
    })

    test('a refusal is asked again by the next reader', async () => {
        calls.refuse = true
        readLibrary(ADA)
        await settle()
        expect(musicLibraryStore.get().refusal).toBe('Gone')
        calls.refuse = false
        readLibrary(ADA)
        await settle()
        expect(calls.artists).toBe(2)
        expect(musicLibraryStore.get().refusal).toBeNull()
    })

    test("an artist's albums are asked for once and kept", async () => {
        await Promise.all([albumsOf(ADA, 'ar-1'), albumsOf(ADA, 'ar-1')])
        expect(calls.artist).toBe(1)
        expect(
            musicLibraryStore
                .get()
                .albums.get('ar-1')
                ?.map((album) => album.name),
        ).toEqual(['Odelay'])
    })

    test('another server starts over', async () => {
        readLibrary(ADA)
        await albumsOf(ADA, 'ar-1')
        readLibrary(OTHER)
        expect(musicLibraryStore.get().albums.size).toBe(0)
        await settle()
        expect(calls.artists).toBe(2)
    })
})
