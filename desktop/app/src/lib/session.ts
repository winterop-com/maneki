/**
 * Who the app is talking to, and whether it is allowed in yet.
 *
 * Three states, kept apart so a screen never guesses: `unknown` while the
 * server is being asked what it has, `ready` once it answered, and
 * `signed-out` when it wants credentials this app does not hold.
 *
 * TWO GRAMMARS, ONE SIGN-IN. The native endpoints (books, video) take a
 * bearer token when the server was started with `--auth`; the Subsonic mount
 * takes a salt and a token on every request. One form fills both, and what
 * is kept is the bearer token and the salt/token pair. The password is used
 * once and dropped.
 */

import { capabilities, defaultBaseUrl, setSession, setVideoMount, signIn } from '@/lib/api'
import { forgetMarks } from '@/lib/star'
import { createStore } from '@/lib/store'
import { type Credentials, makeCredentials, ping } from '@/lib/subsonic'
import type { Capabilities } from '@/lib/types'

const STORAGE_KEY = 'maneki.session'

export type SessionPhase = 'unknown' | 'ready' | 'signed-out'

export interface SessionState {
    phase: SessionPhase
    baseUrl: string
    username?: string
    capabilities?: Capabilities
    /** Present when this server has a Subsonic mount and we are signed in to it. */
    music?: Credentials
    /** Why the last attempt failed, for the sign-in screen to draw. */
    refusal?: string
}

interface StoredSubsonic {
    username: string
    salt: string
    token: string
}

interface StoredSession {
    baseUrl: string
    username?: string
    token?: string
    subsonic?: StoredSubsonic
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

/** The `/rest` base this server serves Subsonic on, if it serves one. */
function restUrl(baseUrl: string, caps: Capabilities): string | null {
    const path = caps.endpoints.audio_subsonic
    return path ? `${baseUrl}${path}` : null
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
        // Where the video API answers is this instance's to state, not this bundle's to assume.
        setVideoMount(caps.endpoints.video_api)
        const rest = restUrl(stored.baseUrl, caps)
        // TWO WAYS TO BE SIGNED OUT. A server started with --auth wants a bearer token for its
        // own endpoints; the Subsonic mount wants a salt and a token on every request whether
        // or not the rest of the server asked for a password. A server that needs no login but
        // serves music still needs credentials for that music, and without them this screen
        // would say the server has no music library -- which is false, and offers no way in.
        if ((caps.auth_required && !stored.token) || (rest !== null && !stored.subsonic)) {
            sessionStore.set({ phase: 'signed-out', baseUrl: stored.baseUrl, username: stored.username })
            return
        }
        const music = rest && stored.subsonic ? { restUrl: rest, ...stored.subsonic } : undefined
        write(stored)
        sessionStore.set({
            phase: 'ready',
            baseUrl: stored.baseUrl,
            username: stored.username,
            capabilities: caps,
            music,
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

/** Sign in against `baseUrl`, to both grammars, and connect with what it hands back. */
export async function signInTo(baseUrl: string, username: string, password: string): Promise<void> {
    setSession({ baseUrl })
    try {
        const caps = await capabilities()
        const stored: StoredSession = { baseUrl, username }
        if (caps.auth_required) {
            const token = await signIn(username, password)
            stored.token = token.token
            stored.username = token.username
        }
        const rest = restUrl(baseUrl, caps)
        if (rest) {
            // Check the pair against the server before keeping it, so a typo
            // is a sentence on this screen rather than an empty library.
            const credentials = makeCredentials(rest, username, password)
            await ping(credentials)
            stored.subsonic = { username, salt: credentials.salt, token: credentials.token }
        }
        await connect(stored)
    } catch (error) {
        sessionStore.set({
            phase: 'signed-out',
            baseUrl,
            username,
            refusal: error instanceof Error ? error.message : 'sign-in failed',
        })
    }
}

/** Forget the credentials, keeping the server so the next sign-in is one field shorter. */
export function signOut(): void {
    const { baseUrl, username } = sessionStore.get()
    // What one account starred is not what the next one did, and this document outlives the
    // sign-out: the marks go with the credentials that wrote them.
    forgetMarks()
    write({ baseUrl, username })
    setSession({ baseUrl })
    sessionStore.set({ phase: 'signed-out', baseUrl, username })
}
