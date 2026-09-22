/**
 * Who the app is talking to, and whether it is allowed in yet.
 *
 * Three states, kept apart so a screen never guesses: `unknown` while the
 * server is being asked what it has, `ready` once it answered, and
 * `signed-out` when it wants credentials this app does not hold. The server
 * URL and any bearer token survive a reload in localStorage; nothing else
 * about a session is worth keeping.
 */

import { capabilities, defaultBaseUrl, setSession, signIn } from '@/lib/api'
import { createStore } from '@/lib/store'
import type { Capabilities } from '@/lib/types'

const STORAGE_KEY = 'maneki.session'

export type SessionPhase = 'unknown' | 'ready' | 'signed-out'

export interface SessionState {
    phase: SessionPhase
    baseUrl: string
    username?: string
    capabilities?: Capabilities
    /** Why the last attempt failed, for the sign-in screen to draw. */
    refusal?: string
}

interface StoredSession {
    baseUrl: string
    username?: string
    token?: string
}

export const sessionStore = createStore<SessionState>({ phase: 'unknown', baseUrl: defaultBaseUrl() })

function read(): StoredSession {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) return JSON.parse(raw) as StoredSession
    } catch {
        // A blocked or corrupt store just means signing in again.
    }
    return { baseUrl: defaultBaseUrl() }
}

function write(stored: StoredSession): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    } catch {
        // Not being able to remember is survivable; the session still works.
    }
}

/**
 * Point at a server and find out what it has.
 *
 * A server that answers `/capabilities` is reachable; one that wants auth
 * and has no token for us leaves the session signed out, which is the
 * sign-in screen's cue.
 */
export async function connect(stored: StoredSession = read()): Promise<void> {
    setSession(stored)
    try {
        const caps = await capabilities()
        if (caps.auth_required && !stored.token) {
            sessionStore.set({ phase: 'signed-out', baseUrl: stored.baseUrl, username: stored.username })
            return
        }
        write(stored)
        sessionStore.set({
            phase: 'ready',
            baseUrl: stored.baseUrl,
            username: stored.username,
            capabilities: caps,
        })
    } catch (error) {
        sessionStore.set({
            phase: 'signed-out',
            baseUrl: stored.baseUrl,
            username: stored.username,
            refusal: error instanceof Error ? error.message : 'the server did not answer',
        })
    }
}

/** Sign in against `baseUrl` and connect with the token it hands back. */
export async function signInTo(baseUrl: string, username: string, password: string): Promise<void> {
    setSession({ baseUrl })
    try {
        const token = await signIn(username, password)
        await connect({ baseUrl, username: token.username, token: token.token })
    } catch (error) {
        sessionStore.set({
            phase: 'signed-out',
            baseUrl,
            username,
            refusal: error instanceof Error ? error.message : 'sign-in failed',
        })
    }
}

/** Forget the token, keeping the server so the next sign-in is one field shorter. */
export function signOut(): void {
    const { baseUrl, username } = sessionStore.get()
    write({ baseUrl, username })
    setSession({ baseUrl })
    sessionStore.set({ phase: 'signed-out', baseUrl, username })
}
