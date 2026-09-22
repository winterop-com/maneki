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

import type { BookDetail, BookProgress, BookSummary, Capabilities } from '@/lib/types'

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set('accept', 'application/json')
    if (session.token) headers.set('authorization', `Bearer ${session.token}`)
    let response: Response
    try {
        response = await fetch(url(path), { ...init, headers })
    } catch {
        throw new ApiError(0, 'the server did not answer')
    }
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
        url(`/books/api/books/${id}/cover${size === undefined ? '' : `?size=${String(size)}`}`),
    /** The stream URL of one file. `file.url` is relative to the books mount. */
    fileUrl: (path: string): string => url(`/books/${path}`),
}
