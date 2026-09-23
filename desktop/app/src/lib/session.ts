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

import { ApiError, capabilities, defaultBaseUrl, setSession, setVideoMount, signIn } from '@/lib/api'
import { noteRefusal } from '@/lib/connection'
import { clear } from '@/lib/player'
import { forgetMarks } from '@/lib/star'
import { createStore } from '@/lib/store'
import { type Credentials, makeCredentials, ping, SubsonicError } from '@/lib/subsonic'
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

/** The Subsonic code for a username and password the server does not accept. */
const SUBSONIC_WRONG_PASSWORD = 40

/**
 * Whether a refusal was the server saying who, rather than the wire saying nothing.
 *
 * THIS IS THE ONE QUESTION THAT DECIDES WHETHER CREDENTIALS ARE THROWN AWAY. A server that
 * answered 401, or a Subsonic mount that answered code 40, is a server we are no longer allowed
 * into: what is kept is no longer good and the door is the only honest screen. Anything else --
 * a timeout, a refused connection, a 500, a laptop that woke up before its Wi-Fi did -- is a
 * session that is still perfectly valid against a server that is momentarily not there, and
 * signing somebody out over it means retyping a password to fix a router.
 *
 * Both grammars have to be read, because a maneki server checks two of them: the bearer token
 * on its own endpoints and the salt-and-token pair on the Subsonic mount.
 */
export function isAuthError(error: unknown): boolean {
    if (error instanceof ApiError) return error.status === 401 || error.status === 403
    if (error instanceof SubsonicError) return error.code === SUBSONIC_WRONG_PASSWORD
    return false
}

/** What a server that wants credentials this client does not hold is missing. */
export const WANTS_CREDENTIALS = 'This server needs a username and password.'

/**
 * Point at a server and find out what it has.
 *
 * A server that answers `/capabilities` is reachable; one that wants auth
 * and has no token for us leaves the session signed out, which is the
 * sign-in screen's cue.
 *
 * A SUBMIT IS ANSWERED AND A LOAD IS NOT. Falling to `signed-out` on the first connect of a
 * session is the door opening, and a door that greeted somebody with a complaint would be
 * telling them off for arriving. The same fall under a press of Connect is a question that was
 * asked and not answered, and saying nothing there leaves a screen that does not move -- so
 * `submitted` is what separates the two, and it is the caller that knows.
 */
export async function connect(stored: StoredSession = read(), submitted = false): Promise<void> {
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
            sessionStore.set({
                phase: 'signed-out',
                baseUrl: stored.baseUrl,
                username: stored.username,
                refusal: submitted ? WANTS_CREDENTIALS : undefined,
            })
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
        const reason = error instanceof Error ? error.message : 'the server did not answer'
        // AN AUTH REFUSAL CLEARS WHAT IS KEPT; A QUIET WIRE DOES NOT. The server saying we are
        // not allowed in means the credentials in storage are no longer good, so they go and
        // the door is the screen. Anything else is a session that is still valid against a
        // server that is momentarily not there.
        if (isAuthError(error)) {
            write({ baseUrl: stored.baseUrl, username: stored.username })
            sessionStore.set({
                phase: 'signed-out',
                baseUrl: stored.baseUrl,
                username: stored.username,
                refusal: reason,
            })
            return
        }
        noteRefusal(error)
        // A SESSION ALREADY STANDING KEEPS STANDING. Every screen holds what it read, the queue
        // keeps playing out of what is buffered, and the banner is what says the server went
        // quiet -- with the retry on it. Signing somebody out here would empty the app to fix a
        // router. A session that never got started has nothing to keep up: there is no library
        // drawn and no mount to stream from, so it falls to the door, which states the same
        // reason and asks nothing new.
        if (sessionStore.get().phase === 'ready') return
        sessionStore.set({
            phase: 'signed-out',
            baseUrl: stored.baseUrl,
            username: stored.username,
            refusal: reason,
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
        await connect(stored, true)
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
    // THE MUSIC STOPS FIRST. The audio element is module state outside the tree, so a queue
    // left running carries on streaming behind the door -- with the credentials it was handed
    // still in the URLs it is pulling, and with no transport on screen to stop it, because the
    // shell that draws one is not mounted on the sign-in screen.
    clear()
    // What one account starred is not what the next one did, and this document outlives the
    // sign-out: the marks go with the credentials that wrote them.
    forgetMarks()
    write({ baseUrl, username })
    setSession({ baseUrl })
    sessionStore.set({ phase: 'signed-out', baseUrl, username })
}
