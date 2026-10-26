import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
    cancelDownload,
    closeOfflineStorage,
    downloadAlbum,
    hasOfflineAlbums,
    keptCover,
    libraryOf,
    loadOffline,
    offlineAlbum,
    offlineBytes,
    offlineSongIds,
    offlineStore,
    offlineTrack,
    removeAlbum,
} from '@/lib/offline'
import type { Credentials } from '@/lib/subsonic'

const credentials: Credentials = { restUrl: 'http://host/audio/rest', username: 'me', salt: 's', token: 't' }
const other: Credentials = { ...credentials, username: 'someone-else' }

const album = { id: 'al_1', name: 'Record', artist: 'Band', songCount: 2, duration: 300, coverArt: 'al_1' }
const songs = [
    { id: 'tr_1', title: 'One', albumId: 'al_1' },
    { id: 'tr_2', title: 'Two', albumId: 'al_1' },
]

/** A server: the album's description, two track files of known sizes, and a cover. */
function server(options: { failTrack?: string; slow?: boolean } = {}) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        const endpoint = url.pathname.split('/').pop()
        const id = url.searchParams.get('id')
        if (endpoint === 'getAlbum') {
            return Response.json({ 'subsonic-response': { status: 'ok', album: { ...album, song: songs } } })
        }
        if (endpoint === 'download') {
            if (options.slow) {
                await new Promise((resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('stop', 'AbortError')),
                    )
                    setTimeout(resolve, 50)
                })
            }
            if (id === options.failTrack) return new Response('no', { status: 500 })
            return new Response(new Uint8Array(id === 'tr_1' ? 1000 : 2000))
        }
        if (endpoint === 'getCoverArt') return new Response(new Uint8Array(50))
        return new Response('unexpected', { status: 404 })
    })
}

beforeEach(async () => {
    await closeOfflineStorage()
    indexedDB.deleteDatabase('maneki-offline')
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('downloading an album', () => {
    test('keeps every track and the cover, and lists the album', async () => {
        vi.stubGlobal('fetch', server())
        await loadOffline(credentials)
        await downloadAlbum(credentials, 'al_1')

        const state = offlineStore.get()
        expect(Object.keys(state.albums)).toEqual(['al_1'])
        expect(state.albums.al_1?.songIds).toEqual(['tr_1', 'tr_2'])
        expect(offlineBytes(state)).toBe(3050)
        expect(offlineSongIds(state)).toEqual(new Set(['tr_1', 'tr_2']))
        expect(state.downloading).toEqual({})

        expect((await offlineTrack(credentials, 'tr_2'))?.size).toBe(2000)
        const kept = await offlineAlbum(credentials, 'al_1')
        expect(kept?.songs.map((song) => song.title)).toEqual(['One', 'Two'])
        expect(kept?.cover?.size).toBe(50)
    })

    test('keeps nothing when a track fails, and says why', async () => {
        vi.stubGlobal('fetch', server({ failTrack: 'tr_2' }))
        await loadOffline(credentials)
        await expect(downloadAlbum(credentials, 'al_1')).rejects.toThrow('"Two" would not download')

        expect(offlineStore.get().albums).toEqual({})
        expect(offlineStore.get().failed.al_1).toContain('"Two"')
        expect(await offlineTrack(credentials, 'tr_1')).toBeNull()
    })

    test('a cancel stops it and removes what had arrived', async () => {
        vi.stubGlobal('fetch', server({ slow: true }))
        await loadOffline(credentials)
        const going = downloadAlbum(credentials, 'al_1')
        await vi.waitFor(() => expect(offlineStore.get().downloading.al_1?.done).toBe(1))
        cancelDownload('al_1')
        await going

        expect(offlineStore.get().albums).toEqual({})
        expect(offlineStore.get().downloading).toEqual({})
        expect(offlineStore.get().failed).toEqual({})
        expect(await offlineTrack(credentials, 'tr_1')).toBeNull()
    })
})

describe('kept albums', () => {
    test('belong to one account on one server', async () => {
        vi.stubGlobal('fetch', server())
        await loadOffline(credentials)
        await downloadAlbum(credentials, 'al_1')

        expect(libraryOf(credentials)).not.toBe(libraryOf(other))
        expect(await hasOfflineAlbums(credentials)).toBe(true)
        expect(await hasOfflineAlbums(other)).toBe(false)
        expect(await offlineTrack(other, 'tr_1')).toBeNull()
        await loadOffline(other)
        expect(offlineStore.get().albums).toEqual({})
    })

    test('survive a reload, and go when removed', async () => {
        vi.stubGlobal('fetch', server())
        await loadOffline(credentials)
        await downloadAlbum(credentials, 'al_1')

        await loadOffline(credentials)
        expect(Object.keys(offlineStore.get().albums)).toEqual(['al_1'])

        // Every screen draws a kept album's cover from this device.
        expect(keptCover('al_1')).toMatch(/^blob:/)
        expect(keptCover('al_unknown')).toBeNull()

        await removeAlbum(credentials, 'al_1')
        expect(keptCover('al_1')).toBeNull()
        expect(offlineStore.get().albums).toEqual({})
        expect(await offlineTrack(credentials, 'tr_1')).toBeNull()
        expect(await offlineAlbum(credentials, 'al_1')).toBeNull()
        expect(await hasOfflineAlbums(credentials)).toBe(false)
    })
})
