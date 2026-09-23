import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ApiError, books } from '@/lib/api'
import { connectionStore, dismissRefusal } from '@/lib/connection'
import { playerStore } from '@/lib/player'
import { connect, isAuthError, sessionStore, signOut, WANTS_CREDENTIALS } from '@/lib/session'
import { SubsonicError } from '@/lib/subsonic'
import type { Capabilities } from '@/lib/types'

function server(has: Partial<Capabilities>): Capabilities {
    return {
        server: 'maneki',
        version: '0.18.2',
        audio: true,
        video: false,
        youtube: false,
        radio: true,
        books: true,
        auth_required: false,
        endpoints: {
            audio_subsonic: '/audio/rest',
            video_api: null,
            books_api: '/books/api',
            auth_login: '/auth/login',
        },
        ...has,
    }
}

/** Answer `/capabilities` with one server's description, and anything else with an empty ok. */
function answering(caps: Capabilities): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => ({
            ok: true,
            status: 200,
            json: async () => (String(input).includes('/capabilities') ? caps : {}),
        })),
    )
}

/** A server that is simply not there: `fetch` rejects, which is what the browser's own does. */
function refusing(): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new TypeError('Failed to fetch')
        }),
    )
}

beforeEach(() => {
    vi.unstubAllGlobals()
    // Each of these starts from a session nobody has established, or one test's `ready` would
    // be the next one's starting point.
    sessionStore.set({ phase: 'unknown', baseUrl: '' })
    dismissRefusal()
    const held = new Map<string, string>()
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => void held.set(key, value),
        removeItem: (key: string) => void held.delete(key),
        clear: () => held.clear(),
        key: () => null,
        length: 0,
    } as Storage)
})

describe('connecting to a server', () => {
    test('a server that serves music wants credentials for it, even with no login of its own', async () => {
        // Regression: this landed on the music screen saying the server had no music library,
        // which is false, and offered no way to sign in.
        answering(server({ auth_required: false }))
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().phase).toBe('signed-out')
    })

    // Regression: pressing Connect fell to this same branch with nothing said, so the screen
    // did not move and the press read as a button that does nothing.
    test('a load greets and a submit is answered, so Connect never changes nothing', async () => {
        answering(server({ auth_required: false }))
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().refusal).toBeUndefined()

        await connect({ baseUrl: 'https://host' }, true)
        expect(sessionStore.get().refusal).toBe(WANTS_CREDENTIALS)
    })

    test('a server that wants a password and holds no token is signed out', async () => {
        answering(
            server({ auth_required: true, endpoints: { ...server({}).endpoints, audio_subsonic: null } }),
        )
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().phase).toBe('signed-out')
    })

    test('credentials in hand is a session, and the music is pointed at the mount', async () => {
        answering(server({}))
        await connect({
            baseUrl: 'https://host',
            username: 'mort',
            subsonic: { username: 'mort', salt: 'abc', token: 'def' },
        })
        const state = sessionStore.get()
        expect(state.phase).toBe('ready')
        expect(state.music?.restUrl).toBe('https://host/audio/rest')
    })

    test('a server with no music mount needs no music credentials', async () => {
        answering(server({ audio: false, endpoints: { ...server({}).endpoints, audio_subsonic: null } }))
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().phase).toBe('ready')
        expect(sessionStore.get().music).toBeUndefined()
    })

    test('a server that never answered leaves nothing to stand up, so it is the door', async () => {
        refusing()
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().phase).toBe('signed-out')
        expect(sessionStore.get().refusal).toBeTruthy()
    })

    // Signing somebody out here would empty the app to fix a router: the credentials are still
    // good, the screens still hold what they read, and the banner is what says the server went
    // quiet.
    test('a session already standing survives the server going quiet, and raises the banner', async () => {
        answering(server({}))
        await connect({
            baseUrl: 'https://host',
            username: 'mort',
            subsonic: { username: 'mort', salt: 'abc', token: 'def' },
        })
        expect(sessionStore.get().phase).toBe('ready')

        dismissRefusal()
        refusing()
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().phase).toBe('ready')
        expect(sessionStore.get().music?.restUrl).toBe('https://host/audio/rest')
        expect(connectionStore.get().down).toBe(true)
    })

    test('a server that will not have us takes the credentials with it', async () => {
        answering(server({}))
        await connect({
            baseUrl: 'https://host',
            username: 'mort',
            subsonic: { username: 'mort', salt: 'abc', token: 'def' },
        })
        expect(sessionStore.get().phase).toBe('ready')

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: false,
                status: 401,
                json: async () => ({ detail: 'sign in' }),
            })),
        )
        await connect({ baseUrl: 'https://host', username: 'mort' })
        expect(sessionStore.get().phase).toBe('signed-out')
        expect(JSON.parse(localStorage.getItem('maneki.session') ?? '{}')).toEqual({
            baseUrl: 'https://host',
            username: 'mort',
        })
    })
})

/** A server that wants a bearer token and serves no music, so the token is the whole session. */
function tokenOnly(): Capabilities {
    return server({ auth_required: true, endpoints: { ...server({}).endpoints, audio_subsonic: null } })
}

/** One answer to everything, for a server that has stopped accepting what it accepted. */
function answeringWith(status: number, detail: string): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status, json: async () => ({ detail }) })),
    )
}

describe('a bearer token that expired while the app was standing', () => {
    // Regression: `connect` only asks the unauthenticated `/capabilities`, so a token the
    // server aged out overnight left the app on `ready` with every screen behind it refused
    // and no way back to the door.
    test('takes the session with it the first time a call is refused', async () => {
        answering(tokenOnly())
        await connect({ baseUrl: 'https://host', username: 'mort', token: 'stale' })
        expect(sessionStore.get().phase).toBe('ready')

        answeringWith(401, 'token expired')
        await expect(books.list()).rejects.toThrow('token expired')

        expect(sessionStore.get().phase).toBe('signed-out')
        expect(sessionStore.get().refusal).toBe('token expired')
        // The server is kept and the credentials go, so the next sign-in is one field shorter.
        expect(JSON.parse(localStorage.getItem('maneki.session') ?? '{}')).toEqual({
            baseUrl: 'https://host',
            username: 'mort',
        })
    })

    // A 500, a 404, a rescan this account may not ask for: only the sentence about who we are
    // throws credentials away, or a server having a bad minute would empty the app.
    test('and no other refusal does, whatever the server is having trouble with', async () => {
        answering(tokenOnly())
        await connect({ baseUrl: 'https://host', username: 'mort', token: 'good' })

        answeringWith(500, 'something broke')
        await expect(books.list()).rejects.toThrow('something broke')
        expect(sessionStore.get().phase).toBe('ready')
    })

    test('and a server that was never handed a token is not signed out of one', async () => {
        answering(
            server({ auth_required: false, endpoints: { ...server({}).endpoints, audio_subsonic: null } }),
        )
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().phase).toBe('ready')

        answeringWith(401, 'sign in')
        await expect(books.list()).rejects.toThrow('sign in')
        expect(sessionStore.get().phase).toBe('ready')
    })
})

describe('signing out', () => {
    // Regression: the audio element is module state outside the tree, so what was playing
    // carried on streaming behind the sign-in screen, which draws no transport to stop it.
    test('takes the queue with it, so nothing is left playing behind the door', () => {
        sessionStore.set({ phase: 'ready', baseUrl: 'https://host', username: 'mort' })
        playerStore.update((state) => ({
            ...state,
            queue: [{ id: 'tr_1', title: 'One', duration: 100 }],
            order: [0],
            index: 0,
            orderAt: 0,
            playing: true,
        }))

        signOut()

        expect(playerStore.get().queue).toEqual([])
        expect(playerStore.get().playing).toBe(false)
        expect(sessionStore.get().phase).toBe('signed-out')
    })
})

describe('telling a refusal from a silence', () => {
    test('a server answering 401 or 403 is one we are no longer allowed into', () => {
        expect(isAuthError(new ApiError(401, 'sign in'))).toBe(true)
        expect(isAuthError(new ApiError(403, 'not you'))).toBe(true)
    })

    test('Subsonic code 40 is the same sentence in the other grammar', () => {
        expect(isAuthError(new SubsonicError(40, 'wrong username or password'))).toBe(true)
    })

    // A timeout, a refused connection, a laptop that woke before its Wi-Fi: a session that is
    // still perfectly valid against a server that is momentarily not there.
    test('nothing else is, whatever it says', () => {
        expect(isAuthError(new ApiError(0, 'the server did not answer'))).toBe(false)
        expect(isAuthError(new ApiError(500, 'the server answered 500'))).toBe(false)
        expect(isAuthError(new SubsonicError(0, 'the server did not answer'))).toBe(false)
        expect(isAuthError(new SubsonicError(70, 'no album 12'))).toBe(false)
        expect(isAuthError(new TypeError('Failed to fetch'))).toBe(false)
        expect(isAuthError('nope')).toBe(false)
    })
})
