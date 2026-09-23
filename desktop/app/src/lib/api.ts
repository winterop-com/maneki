/**
 * The one place this app talks to a server.
 *
 * WHICH SERVER. The bundle is served by maneki itself (the browser tab, and
 * both desktop shells load it from disk and point at a server), so the base
 * URL is a fact the session carries, not a build-time constant. Same-origin
 * is the default when the page was served from a maneki instance.
 *
 * WHAT COMES BACK. The native endpoints answer FastAPI's shape: JSON on
 * success, `{detail}` on a refusal. `ApiError` carries the status and that
 * sentence, so a screen can draw the reason rather than "request failed".
 */

import { NETWORK_REFUSAL, noteRecovered, noteRefusal } from '@/lib/connection'
import type {
    BookDetail,
    BookProgress,
    BookSummary,
    Capabilities,
    VideoBrowse,
    VideoEntry,
    VideoProgress,
    VideoScanState,
    VideoSubtitleTrack,
    YouTubeChannel,
    YouTubeCounts,
    YouTubeQuality,
    YouTubeTab,
    YouTubeVideo,
} from '@/lib/types'
import { VIDEO_MOUNT, hlsPath, posterPath, streamPath, subtitlePath, thumbnailPath } from '@/lib/video'

/** A server's answer that was not a success. */
export class ApiError extends Error {
    readonly status: number

    constructor(status: number, message: string) {
        super(message)
        this.name = 'ApiError'
        this.status = status
    }
}

/** Where the app is pointed, and who it is signed in as. */
export interface Session {
    baseUrl: string
    username?: string
    token?: string
}

let session: Session = { baseUrl: '' }

/** Point the client at a server. */
export function setSession(next: Session): void {
    session = next
}

export function currentSession(): Session {
    return session
}

/** The origin the page was served from, which is a maneki server unless the shell says otherwise. */
export function defaultBaseUrl(): string {
    if (typeof window === 'undefined') return ''
    const { origin, protocol } = window.location
    // A shell loading the bundle from disk has no server behind its origin.
    return protocol === 'file:' ? '' : origin
}

/** An absolute URL for a path under the current server. */
export function url(path: string): string {
    if (!path.startsWith('/')) throw new Error(`path must start with a slash: ${path}`)
    return `${session.baseUrl}${path}`
}

/**
 * The same URL, with the token on it, for the addresses this app hands to the browser.
 *
 * EVERY OTHER CALL SENDS THE TOKEN AS A HEADER, AND THESE CANNOT. A `<video src>`, an `<img
 * src>`, a `<track src>`, an `<audio src>` and an `EventSource` are fetched by the browser
 * itself out of an address, and there is nowhere in an address to put a header -- so against a
 * server started with `--auth` every poster, stream, subtitle and stats frame would answer 401
 * while the library around them listed perfectly well.
 *
 * The server takes the same token as `?token=` on exactly those routes and validates it exactly
 * as it validates the header. A server that wants no sign-in hands back the plain URL, because
 * there is no token to put on it.
 */
export function mediaUrl(path: string): string {
    const absolute = url(path)
    if (!session.token) return absolute
    const separator = absolute.includes('?') ? '&' : '?'
    return `${absolute}${separator}token=${encodeURIComponent(session.token)}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set('accept', 'application/json')
    if (session.token) headers.set('authorization', `Bearer ${session.token}`)
    let response: Response
    try {
        response = await fetch(url(path), { ...init, headers })
    } catch {
        // THE ONE PLACE THIS APP LEARNS THE WIRE IS DOWN. A status is the server answering and
        // belongs to whoever asked; nothing coming back at all is everybody's, and that is the
        // banner `lib/connection` raises across the shell.
        const refusal = new ApiError(0, NETWORK_REFUSAL)
        noteRefusal(refusal)
        throw refusal
    }
    // Any answer is proof the server is there, a refusal included.
    noteRecovered()
    if (!response.ok) throw new ApiError(response.status, await refusalOf(response))
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
}

async function refusalOf(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { detail?: unknown }
        if (typeof body.detail === 'string') return body.detail
    } catch {
        // A refusal that is not JSON still has a status, which is what the caller shows.
    }
    return `the server answered ${response.status}`
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
    return request<T>(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
}

/** What this server has: which libraries, and whether it wants a sign-in. */
export function capabilities(): Promise<Capabilities> {
    return request<Capabilities>('/capabilities')
}

/**
 * Ask an address whether a maneki server is answering there, and take no for an answer.
 *
 * THIS IS A QUESTION, NOT A REQUEST, which is why it goes around `request` rather than through
 * it. Nothing being at an address is the expected answer half the time -- the door asks the
 * same question of two addresses and at most one of them is a server -- so it never raises the
 * connection banner, never throws, and never touches the session. A probe that reported "lost
 * connection to the server" for every address that turned out not to be one would be a banner
 * over the sign-in screen the first time anybody opened the app in a shell.
 *
 * `cache: 'no-store'` because what is being asked is whether something is listening right now,
 * and a cached yes from an earlier session is exactly the wrong answer.
 */
export async function probe(origin: string): Promise<Capabilities | null> {
    try {
        const response = await fetch(`${origin}/capabilities`, { cache: 'no-store' })
        if (!response.ok) return null
        const answered = (await response.json()) as Partial<Capabilities>
        // Another server may well answer `/capabilities` with something of its own, so the
        // name is checked: what the door is looking for is a maneki, not a 200.
        return answered.server === 'maneki' ? (answered as Capabilities) : null
    } catch {
        return null
    }
}

/** Trade a username and password for a bearer token. */
export function signIn(username: string, password: string): Promise<{ token: string; username: string }> {
    return send('/auth/login', 'POST', { username, password })
}

export const books = {
    list: (): Promise<BookSummary[]> => request('/books/api/books'),
    detail: (id: string): Promise<BookDetail> => request(`/books/api/books/${id}`),
    /** Record where the listener is, in seconds on the book's own timeline. */
    saveProgress: (id: string, positionS: number, finished?: boolean): Promise<BookProgress> =>
        send(`/books/api/books/${id}/progress`, 'PUT', { position_s: positionS, finished }),
    clearProgress: (id: string): Promise<void> => send(`/books/api/books/${id}/progress`, 'DELETE'),
    /** Whether the server is still reading the books folder, and how many it has so far. */
    scanStatus: (): Promise<{ scanning: boolean; books: number }> => request('/books/api/scan'),
    /**
     * The book's cover, at the size it will be drawn.
     *
     * A shelf draws two hundred of these at once. At full resolution that is tens of megabytes
     * over the wire and two hundred full-size JPEG decodes, which is felt as a window that
     * stops answering the pointer -- so a card asks for a card-sized image and only the book's
     * own screen asks for a large one.
     */
    coverUrl: (id: string, size?: number): string =>
        mediaUrl(`/books/api/books/${id}/cover${size === undefined ? '' : `?size=${String(size)}`}`),
    /** The stream URL of one file. `file.url` is relative to the books mount. */
    fileUrl: (path: string): string => mediaUrl(`/books/${path}`),
}

/** `?refresh=1` when a reader asked for it, which is what busts the server's listing cache. */
function refreshQuery(refresh: boolean | undefined, separator = '?'): string {
    return refresh === true ? `${separator}refresh=1` : ''
}

/**
 * The YouTube half of the video API.
 *
 * SUBSCRIPTIONS ARE THE SERVER'S. A channel is resolved and persisted per account by yt-dlp
 * behind these endpoints, and a video plays through the same HLS pipeline a local file does --
 * so nothing in this client ever talks to YouTube except for a thumbnail, which is a URL
 * derived from the video id and needs no round trip through maneki at all.
 */
export const youtube = {
    /** The account's channels, each with the identity and avatar the last listing found. */
    channels: (refresh?: boolean): Promise<YouTubeChannel[]> =>
        request(`${videoMount}/youtube/channels${refreshQuery(refresh)}`),
    /** Subscribe. `url` must name a YouTube host, or the server refuses it with a 422. */
    addChannel: (channelUrl: string): Promise<YouTubeChannel> =>
        send(`${videoMount}/youtube/channels`, 'POST', { url: channelUrl }),
    /** Unsubscribe. Idempotent, so a second press is not a refusal. */
    removeChannel: (channelId: string): Promise<{ removed: string }> =>
        send(`${videoMount}/youtube/channels/${encodeURIComponent(channelId)}`, 'DELETE'),
    /** How many items the channel has on each tab, capped. Three listings, so it is slow. */
    counts: (channelId: string, refresh?: boolean): Promise<YouTubeCounts> =>
        request(
            `${videoMount}/youtube/channels/${encodeURIComponent(channelId)}/counts${refreshQuery(refresh)}`,
        ),
    /** One tab's recent items. A channel with no such tab answers with an empty list. */
    videos: (channelId: string, tab: YouTubeTab, refresh?: boolean): Promise<YouTubeVideo[]> =>
        request(
            `${videoMount}/youtube/channels/${encodeURIComponent(channelId)}/videos?tab=${tab}` +
                refreshQuery(refresh, '&'),
        ),
    /** One video's title and length, which is what a deep link into the player has to ask for. */
    video: (videoId: string): Promise<YouTubeVideo> =>
        request(`${videoMount}/youtube/videos/${encodeURIComponent(videoId)}`),
    /** The heights this server offers and the one it uses when asked for none. */
    quality: (): Promise<YouTubeQuality> => request(`${videoMount}/youtube/quality`),
    /** The HLS manifest, capped at `height` when one was chosen and at the server's when not. */
    hlsUrl: (videoId: string, height?: number): string =>
        mediaUrl(
            `${videoMount}/youtube/videos/${encodeURIComponent(videoId)}/hls/index.m3u8` +
                (height !== undefined && height > 0 ? `?h=${String(height)}` : ''),
        ),
    /**
     * A thumbnail, straight from YouTube's CDN.
     *
     * Derivable from the id, so it costs no round trip through maneki and no ffmpeg: a grid of
     * sixty of them is sixty requests the server never sees. `poster` is the larger one the
     * player shows before the first frame arrives.
     */
    thumbUrl: (videoId: string): string =>
        `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    posterUrl: (videoId: string): string =>
        `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/maxresdefault.jpg`,
}

/**
 * Where the video API answers, which this instance states rather than this bundle assuming.
 *
 * `/capabilities` carries the mount, so a server that moved it is followed on the next connect
 * instead of on the next release. Until it has answered, the default is what maneki mounts.
 */
let videoMount = VIDEO_MOUNT

export function setVideoMount(mount: string | null | undefined): void {
    videoMount = mount ?? VIDEO_MOUNT
}

export const video = {
    /** Everything under the library root, flat. The folder browser reads `browse` instead. */
    list: (): Promise<VideoEntry[]> => request(`${videoMount}/videos`),
    /** One video by id, for a link somebody was sent rather than a folder they walked into. */
    detail: (id: string): Promise<VideoEntry> => request(`${videoMount}/videos/${encodeURIComponent(id)}`),
    /** One folder's immediate children. The empty path is the library root. */
    browse: (path = ''): Promise<VideoBrowse> =>
        request(`${videoMount}/browse${path === '' ? '' : `?path=${encodeURIComponent(path)}`}`),
    /** Filename search across the whole library. The server caps what it answers with. */
    search: (query: string): Promise<VideoEntry[]> => {
        const trimmed = query.trim()
        if (trimmed === '') return Promise.resolve([])
        return request(`${videoMount}/search?q=${encodeURIComponent(trimmed)}`)
    },
    /** What the server is doing to the library, which a cold start is mostly made of. */
    scanStatus: (): Promise<VideoScanState> => request(`${videoMount}/scan_status`),
    /**
     * Ask for the library to be read again.
     *
     * Fire and forget: the walk takes as long as the library is big, so the server answers at
     * once with where it is and the screen watches `scanStatus` from there.
     */
    scan: (): Promise<{ started: boolean; status: VideoScanState }> => send(`${videoMount}/scan`, 'POST'),
    /** Which ids have a still frame and which have a contact sheet, right now. */
    thumbnailsReady: (): Promise<{ ready: string[]; posters_ready: string[] }> =>
        request(`${videoMount}/thumbnails/ready`),
    /** Every subtitle track a file offers, sidecars and embedded streams alike. */
    subtitles: (id: string): Promise<VideoSubtitleTrack[]> =>
        request(`${videoMount}/videos/${encodeURIComponent(id)}/subtitles`),
    /** Where this account stopped in one video. A video never started reads as 0. */
    readProgress: (id: string): Promise<VideoProgress> =>
        request(`${videoMount}/videos/${encodeURIComponent(id)}/progress`),
    /**
     * Record where the viewer is, in seconds into the file.
     *
     * Safe on a timer: the server holds one row per video and writes it in place. `finished`
     * left out lets the server decide from the tail, which is what a position report means; the
     * end of playback says so outright.
     */
    saveProgress: (id: string, positionS: number, finished?: boolean): Promise<VideoProgress> =>
        send(`${videoMount}/videos/${encodeURIComponent(id)}/progress`, 'PUT', {
            position_s: positionS,
            finished,
        }),
    /** Every video this account has started. One request fills a folder with resume points. */
    progress: (): Promise<VideoProgress[]> => request(`${videoMount}/progress`),
    /**
     * Drop whatever the server is still transcoding ahead of this video.
     *
     * Called when a player goes. Segments are transcoded speculatively either side of the last
     * one asked for, and each completion starts the next -- so without this the machine keeps
     * encoding a film nobody is watching for as long as it takes to reach the end of it.
     * Best effort: a server that has already gone is not a failure worth reporting.
     */
    cancelSession: (id: string): void => {
        try {
            void fetch(url(`${videoMount}/videos/${encodeURIComponent(id)}/session`), {
                method: 'DELETE',
                // The call is made while a component is coming down, and often while the tab
                // is closing with it, which is exactly the request a browser drops.
                keepalive: true,
                headers: session.token ? { authorization: `Bearer ${session.token}` } : undefined,
            })
        } catch {
            // Nothing on this side is improved by knowing the cancel did not land.
        }
    },
    /** The live transcode stats, which arrive as server-sent events rather than as an answer. */
    statsStreamUrl: (): string => mediaUrl(`${videoMount}/stats/stream`),
    /** The HLS manifest, which is what the player is pointed at whatever the container is. */
    hlsUrl: (id: string): string => mediaUrl(hlsPath(videoMount, id)),
    /** The file's own bytes, ranges and all. */
    streamUrl: (id: string): string => mediaUrl(streamPath(videoMount, id)),
    thumbnailUrl: (id: string, token?: number): string => mediaUrl(thumbnailPath(videoMount, id, token)),
    posterUrl: (id: string, token?: number): string => mediaUrl(posterPath(videoMount, id, token)),
    subtitleUrl: (id: string, trackId: string): string => mediaUrl(subtitlePath(videoMount, id, trackId)),
}
