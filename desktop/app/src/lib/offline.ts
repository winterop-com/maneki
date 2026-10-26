/**
 * Albums kept on this device, so they play where the server cannot be reached.
 *
 * WHAT IS KEPT. An album's track list as the server described it, its cover, and each track's
 * file exactly as the server holds it (`download`, never a transcode). Kept in IndexedDB, which
 * every build of this app has: the desktop shells and a browser tab alike.
 *
 * STREAMED WHEN THE SERVER ANSWERS. A kept copy is for when it does not: the player reaches for
 * one only while the connection is down, or when a stream fails mid-album. Online, a downloaded
 * album plays exactly as any other, so play counts and the server's own view stay as they were.
 *
 * KEPT PER LIBRARY. Every record is keyed by the server's REST address and the account, so a
 * second server, or a second account on the same one, never sees or plays another's albums.
 *
 * The open/put/get plumbing is the only part that touches IndexedDB; what the app reads at render
 * time is `offlineStore`, a summary loaded once per library and kept current by every change.
 */

import { assetUrl, coverUrl, getAlbum, type Album, type Credentials, type Song } from '@/lib/subsonic'
import { createStore } from '@/lib/store'

const DB_NAME = 'maneki-offline'
const DB_VERSION = 1
const ALBUMS = 'albums'
const TRACKS = 'tracks'

/** The cover kept with an album: large enough for the album screen, small enough to be cheap. */
const COVER_SIZE = 600

/** What is kept about a downloaded album besides its files. */
interface KeptAlbum {
    album: Album
    songIds: string[]
    bytes: number
    savedAt: number
}

/**
 * One downloaded album, as the screens list it.
 *
 * `coverUrl` is the kept cover as a URL the page can draw, made once when the summary loads, so
 * every cover of a kept album -- the album screen, the player bar, the full screen, the system's
 * media controls -- comes from this device and is there when the server is not.
 */
export interface OfflineAlbum extends KeptAlbum {
    coverUrl: string | null
}

/** An album being fetched: how far along, out of how many tracks. */
export interface Downloading {
    done: number
    total: number
}

export interface OfflineState {
    /** The library the summary is for; null until one is loaded. */
    library: string | null
    albums: Record<string, OfflineAlbum>
    downloading: Record<string, Downloading>
    /** What went wrong with the last download, by album, until it is tried again. */
    failed: Record<string, string>
}

const EMPTY: OfflineState = { library: null, albums: {}, downloading: {}, failed: {} }

export const offlineStore = createStore<OfflineState>(EMPTY)

interface AlbumRecord extends KeptAlbum {
    key: string
    library: string
    songs: Song[]
    cover: Blob | null
}

interface TrackRecord {
    key: string
    library: string
    blob: Blob
}

/** Which library a record belongs to: the server's REST address and the account on it. */
export function libraryOf(credentials: Pick<Credentials, 'restUrl' | 'username'>): string {
    return `${credentials.restUrl}|${credentials.username}`
}

/** The key of one album or track within a library. */
export function keyOf(library: string, id: string): string {
    return `${library}|${id}`
}

/** The kept cover of an album, when this device keeps the album; null otherwise. */
export function keptCover(albumId: string | undefined): string | null {
    if (albumId === undefined) return null
    return offlineStore.get().albums[albumId]?.coverUrl ?? null
}

function summaryOf(record: KeptAlbum & { cover: Blob | null }): OfflineAlbum {
    return {
        album: record.album,
        songIds: record.songIds,
        bytes: record.bytes,
        savedAt: record.savedAt,
        coverUrl: record.cover ? URL.createObjectURL(record.cover) : null,
    }
}

function releaseCovers(albums: Record<string, OfflineAlbum>): void {
    for (const entry of Object.values(albums)) {
        if (entry.coverUrl !== null) URL.revokeObjectURL(entry.coverUrl)
    }
}

/** Every song id in the kept albums, for the player's quick "is this here" question. */
export function offlineSongIds(state: OfflineState): Set<string> {
    return new Set(Object.values(state.albums).flatMap((entry) => entry.songIds))
}

/** How many bytes the kept albums take, all told. */
export function offlineBytes(state: OfflineState): number {
    return Object.values(state.albums).reduce((sum, entry) => sum + entry.bytes, 0)
}

// --- IndexedDB plumbing ---------------------------------------------------------------------

let opening: Promise<IDBDatabase> | null = null

function database(): Promise<IDBDatabase> {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.addEventListener('upgradeneeded', () => {
            const db = request.result
            if (!db.objectStoreNames.contains(ALBUMS)) {
                db.createObjectStore(ALBUMS, { keyPath: 'key' }).createIndex('library', 'library')
            }
            if (!db.objectStoreNames.contains(TRACKS)) {
                db.createObjectStore(TRACKS, { keyPath: 'key' }).createIndex('library', 'library')
            }
        })
        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => {
            opening = null
            reject(request.error ?? new Error('could not open offline storage'))
        })
    })
    return opening
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result))
        request.addEventListener('error', () => reject(request.error ?? new Error('offline storage refused')))
    })
}

function done(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.addEventListener('complete', () => resolve())
        transaction.addEventListener('error', () =>
            reject(transaction.error ?? new Error('offline storage refused')),
        )
        transaction.addEventListener('abort', () =>
            reject(transaction.error ?? new Error('offline storage gave up')),
        )
    })
}

/** Close and forget the connection: for tests, which delete the database between cases. */
export async function closeOfflineStorage(): Promise<void> {
    const db = opening ? await opening.catch(() => null) : null
    db?.close()
    opening = null
    releaseCovers(offlineStore.get().albums)
    offlineStore.set(EMPTY)
}

// --- what the app calls ---------------------------------------------------------------------

/** Read which albums this library keeps, into `offlineStore`. Called when a session is ready. */
export async function loadOffline(credentials: Credentials): Promise<void> {
    const library = libraryOf(credentials)
    const db = await database()
    const records = (await settled(
        db.transaction(ALBUMS).objectStore(ALBUMS).index('library').getAll(library),
    )) as AlbumRecord[]
    const albums: Record<string, OfflineAlbum> = {}
    for (const record of records) albums[record.album.id] = summaryOf(record)
    releaseCovers(offlineStore.get().albums)
    offlineStore.set({ library, albums, downloading: {}, failed: {} })
}

/** Whether this library keeps any albums, without loading them: the offline start asks it. */
export async function hasOfflineAlbums(
    credentials: Pick<Credentials, 'restUrl' | 'username'>,
): Promise<boolean> {
    const db = await database()
    const count = await settled(
        db.transaction(ALBUMS).objectStore(ALBUMS).index('library').count(libraryOf(credentials)),
    )
    return count > 0
}

const running = new Map<string, AbortController>()

/**
 * Fetch an album's tracks and cover and keep them. Resolves once kept, or rejects with why not.
 *
 * Tracks are fetched one at a time, so a slow line shows steady progress and a cancel stops at
 * the track in hand. Nothing is listed as downloaded until every track is in; a cancel or a
 * failure removes whatever had arrived.
 */
export async function downloadAlbum(credentials: Credentials, albumId: string): Promise<void> {
    if (running.has(albumId)) return
    const library = libraryOf(credentials)
    const controller = new AbortController()
    running.set(albumId, controller)
    patchDownloading(albumId, { done: 0, total: 0 })
    const kept: string[] = []
    try {
        persistStorage()
        const { album, songs } = await getAlbum(credentials, albumId)
        patchDownloading(albumId, { done: 0, total: songs.length })
        const db = await database()
        let bytes = 0
        for (const [index, song] of songs.entries()) {
            // oxlint-disable-next-line no-await-in-loop -- one track at a time: steady progress, a prompt cancel
            const response = await fetch(assetUrl(credentials, 'download', { id: song.id }), {
                signal: controller.signal,
            })
            if (!response.ok)
                throw new Error(`"${song.title}" would not download (${String(response.status)}).`)
            // oxlint-disable-next-line no-await-in-loop -- one track at a time: steady progress, a prompt cancel
            const blob = await response.blob()
            const write = db.transaction(TRACKS, 'readwrite')
            write
                .objectStore(TRACKS)
                .put({ key: keyOf(library, song.id), library, blob } satisfies TrackRecord)
            // oxlint-disable-next-line no-await-in-loop -- one track at a time: steady progress, a prompt cancel
            await done(write)
            kept.push(song.id)
            bytes += blob.size
            patchDownloading(albumId, { done: index + 1, total: songs.length })
        }
        const cover = await fetchCover(credentials, album.coverArt, controller.signal)
        const record: AlbumRecord = {
            key: keyOf(library, album.id),
            library,
            album,
            songs,
            songIds: songs.map((song) => song.id),
            cover,
            bytes: bytes + (cover?.size ?? 0),
            savedAt: Date.now(),
        }
        const write = db.transaction(ALBUMS, 'readwrite')
        write.objectStore(ALBUMS).put(record)
        await done(write)
        if (offlineStore.get().library === library) {
            const { albums, downloading, failed } = offlineStore.get()
            const { [albumId]: _finished, ...still } = downloading
            const { [albumId]: _cleared, ...otherFailures } = failed
            offlineStore.set({
                library,
                albums: { ...albums, [albumId]: summaryOf(record) },
                downloading: still,
                failed: otherFailures,
            })
        }
    } catch (error) {
        await removeTracks(library, kept)
        const cancelled = controller.signal.aborted
        const { downloading, failed } = offlineStore.get()
        const { [albumId]: _stopped, ...still } = downloading
        offlineStore.set({
            ...offlineStore.get(),
            downloading: still,
            failed: cancelled
                ? failed
                : { ...failed, [albumId]: error instanceof Error ? error.message : 'The download failed.' },
        })
        if (!cancelled) throw error
    } finally {
        running.delete(albumId)
    }
}

/** Stop an album's download; what had arrived is removed. */
export function cancelDownload(albumId: string): void {
    running.get(albumId)?.abort()
}

/** Forget a kept album and its tracks. */
export async function removeAlbum(credentials: Credentials, albumId: string): Promise<void> {
    const library = libraryOf(credentials)
    const db = await database()
    const record = (await settled(
        db.transaction(ALBUMS).objectStore(ALBUMS).get(keyOf(library, albumId)),
    )) as AlbumRecord | undefined
    await removeTracks(library, record?.songIds ?? [])
    const write = db.transaction(ALBUMS, 'readwrite')
    write.objectStore(ALBUMS).delete(keyOf(library, albumId))
    await done(write)
    if (offlineStore.get().library === library) {
        const { [albumId]: gone, ...albums } = offlineStore.get().albums
        if (gone) releaseCovers({ [albumId]: gone })
        offlineStore.set({ ...offlineStore.get(), albums })
    }
}

/** Forget every album this library keeps. */
export async function removeAllAlbums(credentials: Credentials): Promise<void> {
    for (const albumId of Object.keys(offlineStore.get().albums)) {
        // oxlint-disable-next-line no-await-in-loop -- one removal at a time keeps the store consistent
        await removeAlbum(credentials, albumId)
    }
}

/** A kept track's file, or null when it is not kept. */
export async function offlineTrack(credentials: Credentials, songId: string): Promise<Blob | null> {
    const db = await database()
    const record = (await settled(
        db
            .transaction(TRACKS)
            .objectStore(TRACKS)
            .get(keyOf(libraryOf(credentials), songId)),
    )) as TrackRecord | undefined
    return record?.blob ?? null
}

/** A kept album as the album screen draws it: its description, tracks and cover. */
export async function offlineAlbum(
    credentials: Credentials,
    albumId: string,
): Promise<{ album: Album; songs: Song[]; cover: Blob | null } | null> {
    const db = await database()
    const record = (await settled(
        db
            .transaction(ALBUMS)
            .objectStore(ALBUMS)
            .get(keyOf(libraryOf(credentials), albumId)),
    )) as AlbumRecord | undefined
    return record ? { album: record.album, songs: record.songs, cover: record.cover } : null
}

// --- helpers --------------------------------------------------------------------------------

function patchDownloading(albumId: string, progress: Downloading): void {
    const state = offlineStore.get()
    offlineStore.set({ ...state, downloading: { ...state.downloading, [albumId]: progress } })
}

async function removeTracks(library: string, songIds: readonly string[]): Promise<void> {
    if (songIds.length === 0) return
    const db = await database()
    const write = db.transaction(TRACKS, 'readwrite')
    const tracks = write.objectStore(TRACKS)
    for (const id of songIds) tracks.delete(keyOf(library, id))
    await done(write)
}

async function fetchCover(credentials: Credentials, coverArt: string | undefined, signal: AbortSignal) {
    const url = coverUrl(credentials, coverArt, COVER_SIZE)
    if (url === null) return null
    try {
        const response = await fetch(url, { signal })
        return response.ok ? await response.blob() : null
    } catch (error) {
        // A cover that will not come is no reason to give up an album; a cancel still is.
        if (signal.aborted) throw error
        return null
    }
}

/**
 * Ask that kept albums not be cleared when the device runs short of space. Asked once, at the
 * first download: a browser may prompt, and a prompt belongs to the moment somebody asked to keep.
 */
let askedToPersist = false
function persistStorage(): void {
    if (askedToPersist) return
    askedToPersist = true
    void navigator.storage?.persist?.().catch(() => false)
}
