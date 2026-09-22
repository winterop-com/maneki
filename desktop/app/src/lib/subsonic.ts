/**
 * The Subsonic half of the server: music, and audiobooks seen as music.
 *
 * AUTHENTICATION IS A SALT AND A TOKEN, not a password. The password is
 * turned into `md5(password + salt)` once, at sign-in, and only that pair is
 * kept: every request carries them as query parameters, which is the grammar
 * every Subsonic client and server speaks. The password itself is never
 * stored and never sent again.
 *
 * EVERY ANSWER IS AN ENVELOPE. A Subsonic server returns HTTP 200 whatever
 * happened, with the outcome inside `subsonic-response`. A failure there is
 * raised as `SubsonicError` carrying the server's own code and sentence, so
 * a screen can say what went wrong rather than "request failed".
 */

import { md5 } from '@/lib/md5'

/** What a Subsonic server refused, in its own words. */
export class SubsonicError extends Error {
    readonly code: number

    constructor(code: number, message: string) {
        super(message)
        this.name = 'SubsonicError'
        this.code = code
    }
}

/** Enough to sign every request to one server as one account. */
export interface Credentials {
    /** The `/rest` base, e.g. `https://host:8765/audio/rest`. */
    restUrl: string
    username: string
    salt: string
    token: string
}

export interface Artist {
    id: string
    name: string
    albumCount?: number
    coverArt?: string
    starred?: string
}

export interface Album {
    id: string
    name: string
    artist: string
    artistId?: string
    songCount: number
    duration: number
    coverArt?: string
    year?: number
    genre?: string
    starred?: string
}

export interface Song {
    id: string
    title: string
    artist?: string
    album?: string
    albumId?: string
    artistId?: string
    coverArt?: string
    duration?: number
    track?: number
    discNumber?: number
    year?: number
    suffix?: string
    contentType?: string
    starred?: string
    /** `music` or `audiobook`; books are served in their own folder. */
    type?: string
    /** Where this account stopped inside the track, in milliseconds. */
    bookmarkPosition?: number
}

const CLIENT = 'maneki'
const API_VERSION = '1.16.1'

/** Turn a password into the pair that signs requests. The password is not kept. */
export function makeCredentials(restUrl: string, username: string, password: string): Credentials {
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    const salt = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return { restUrl: restUrl.replace(/\/+$/, ''), username, salt, token: md5(password + salt) }
}

function authQuery(credentials: Credentials): URLSearchParams {
    return new URLSearchParams({
        u: credentials.username,
        t: credentials.token,
        s: credentials.salt,
        v: API_VERSION,
        c: CLIENT,
        f: 'json',
    })
}

type Params = Record<string, string | number | boolean | undefined | null>

function withParams(credentials: Credentials, endpoint: string, params?: Params): string {
    const query = authQuery(credentials)
    for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null) query.set(key, String(value))
    }
    return `${credentials.restUrl}/${endpoint}?${query.toString()}`
}

/** Call one endpoint and return the inside of its envelope. */
export async function call<T = Record<string, unknown>>(
    credentials: Credentials,
    endpoint: string,
    params?: Params,
): Promise<T> {
    let response: Response
    try {
        response = await fetch(withParams(credentials, endpoint, params))
    } catch {
        throw new SubsonicError(0, 'the server did not answer')
    }
    if (!response.ok) throw new SubsonicError(0, `the server answered ${response.status}`)
    const body = (await response.json()) as { 'subsonic-response'?: Record<string, unknown> }
    const inner = body['subsonic-response']
    if (!inner) throw new SubsonicError(0, 'the answer was not a Subsonic response')
    if (inner.status === 'failed') {
        const error = (inner.error ?? {}) as { code?: number; message?: string }
        throw new SubsonicError(error.code ?? 0, error.message ?? 'the server refused')
    }
    return inner as T
}

/**
 * A URL an `<img>` or `<audio>` element can use directly.
 *
 * These are handed to the browser rather than fetched here, so the
 * credentials have to travel in the URL; that is what the Subsonic grammar
 * provides for.
 */
export function assetUrl(credentials: Credentials, endpoint: string, params: Params): string {
    return withParams(credentials, endpoint, params)
}

export function streamUrl(credentials: Credentials, id: string): string {
    return assetUrl(credentials, 'stream', { id })
}

export function coverUrl(
    credentials: Credentials,
    coverArt: string | undefined,
    size?: number,
): string | null {
    if (!coverArt) return null
    return assetUrl(credentials, 'getCoverArt', { id: coverArt, size })
}

/** Check the credentials against the server. Throws when they are wrong. */
export async function ping(credentials: Credentials): Promise<void> {
    await call(credentials, 'ping')
}

/** One library folder this server serves: music and audiobooks are two of them. */
export interface MusicFolder {
    id: number
    name: string
}

/**
 * The folders this server keeps its media in.
 *
 * maneki serves audiobooks as a folder of their own so a phone client can browse books without
 * the music, which means the music screens have to say which folder they mean: without it the
 * artist list is every musician plus every author of an audiobook.
 */
export async function getMusicFolders(credentials: Credentials): Promise<MusicFolder[]> {
    const inner = await call<{ musicFolders?: { musicFolder?: MusicFolder[] } }>(
        credentials,
        'getMusicFolders',
    )
    return inner.musicFolders?.musicFolder ?? []
}

/** The name maneki gives the folder holding books, which is the one the music screens leave out. */
export const BOOKS_FOLDER_NAME = 'Audiobooks'

/** The folder a music screen should ask about, or undefined when this server keeps only one. */
export function musicFolderOf(folders: readonly MusicFolder[]): number | undefined {
    if (folders.length < 2) return undefined
    const music = folders.find((folder) => folder.name !== BOOKS_FOLDER_NAME)
    return music?.id
}

/** Every artist, flattened out of the server's A-Z grouping, with the articles it files them by. */
export async function getArtists(
    credentials: Credentials,
    musicFolderId?: number,
): Promise<{ artists: Artist[]; ignoredArticles?: string }> {
    const inner = await call<{
        artists?: { index?: { artist?: Artist[] }[]; ignoredArticles?: string }
    }>(credentials, 'getArtists', { musicFolderId })
    return {
        artists: (inner.artists?.index ?? []).flatMap((group) => group.artist ?? []),
        ignoredArticles: inner.artists?.ignoredArticles,
    }
}

/** One artist's albums. */
export async function getArtist(
    credentials: Credentials,
    id: string,
): Promise<{ artist: Artist; albums: Album[] }> {
    const inner = await call<{ artist?: Artist & { album?: Album[] } }>(credentials, 'getArtist', { id })
    const artist = inner.artist
    if (!artist) throw new SubsonicError(70, `no artist ${id}`)
    return { artist, albums: artist.album ?? [] }
}

/** One album with its tracks, in order. */
export async function getAlbum(
    credentials: Credentials,
    id: string,
): Promise<{ album: Album; songs: Song[] }> {
    const inner = await call<{ album?: Album & { song?: Song[] } }>(credentials, 'getAlbum', { id })
    const album = inner.album
    if (!album) throw new SubsonicError(70, `no album ${id}`)
    return { album, songs: album.song ?? [] }
}

export interface AlbumListOptions {
    type?:
        | 'alphabeticalByName'
        | 'alphabeticalByArtist'
        | 'newest'
        | 'recent'
        | 'frequent'
        | 'random'
        | 'starred'
    size?: number
    offset?: number
    musicFolderId?: number
}

/** A flat list of albums, for a shelf. */
export async function getAlbumList(
    credentials: Credentials,
    options: AlbumListOptions = {},
): Promise<Album[]> {
    const inner = await call<{ albumList2?: { album?: Album[] } }>(credentials, 'getAlbumList2', {
        type: options.type ?? 'alphabeticalByName',
        size: options.size ?? 100,
        offset: options.offset ?? 0,
        musicFolderId: options.musicFolderId,
    })
    return inner.albumList2?.album ?? []
}

export interface SearchResult {
    artists: Artist[]
    albums: Album[]
    songs: Song[]
}

export async function search(credentials: Credentials, query: string, size = 20): Promise<SearchResult> {
    const inner = await call<{ searchResult3?: { artist?: Artist[]; album?: Album[]; song?: Song[] } }>(
        credentials,
        'search3',
        { query, artistCount: size, albumCount: size, songCount: size },
    )
    const found = inner.searchResult3 ?? {}
    return { artists: found.artist ?? [], albums: found.album ?? [], songs: found.song ?? [] }
}

export interface Station {
    id: string
    name: string
    streamUrl: string
    homePageUrl?: string
}

/** The stations this server carries. */
export async function getStations(credentials: Credentials): Promise<Station[]> {
    const inner = await call<{ internetRadioStations?: { internetRadioStation?: Station[] } }>(
        credentials,
        'getInternetRadioStations',
    )
    return inner.internetRadioStations?.internetRadioStation ?? []
}

/**
 * A station played through the server rather than straight from the source.
 *
 * Public stations routinely answer without the headers a browser needs to
 * play them cross-origin, and their redirects drop them too. The server
 * follows the station itself and re-serves it, so the browser only ever
 * talks to one origin.
 */
export function stationStreamUrl(credentials: Credentials, station: Station): string {
    return assetUrl(credentials, 'radioStream', { url: station.streamUrl })
}

/** What a station says it is playing, as its stream announces it. Empty until it says. */
export async function stationNowPlaying(credentials: Credentials, station: Station): Promise<string> {
    try {
        const response = await fetch(assetUrl(credentials, 'radioMeta', { url: station.streamUrl }))
        if (!response.ok) return ''
        const body = (await response.json()) as { title?: string }
        return body.title ?? ''
    } catch {
        return ''
    }
}

export interface Starred {
    artists: Artist[]
    albums: Album[]
    songs: Song[]
}

/** Everything this account marked as a favourite. */
export async function getStarred(credentials: Credentials): Promise<Starred> {
    const inner = await call<{ starred2?: { artist?: Artist[]; album?: Album[]; song?: Song[] } }>(
        credentials,
        'getStarred2',
    )
    const found = inner.starred2 ?? {}
    return { artists: found.artist ?? [], albums: found.album ?? [], songs: found.song ?? [] }
}

/** Mark a track, album or artist as a favourite, or take the mark off. */
export async function setStarred(credentials: Credentials, id: string, starred: boolean): Promise<void> {
    await call(credentials, starred ? 'star' : 'unstar', { id })
}

/**
 * Tell the server a track is playing, or has played.
 *
 * `submission: false` is the now-playing probe at the start of a track;
 * `true` is the finished play. A failure here never reaches the listener:
 * the music is already playing, and nothing on screen depends on it.
 */
export async function scrobble(credentials: Credentials, id: string, submission: boolean): Promise<void> {
    try {
        await call(credentials, 'scrobble', { id, submission })
    } catch {
        // Nothing to say and nothing to do: the track plays either way.
    }
}
