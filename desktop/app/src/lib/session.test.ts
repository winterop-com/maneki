import { beforeEach, describe, expect, test, vi } from 'vitest'

import { ApiError } from '@/lib/api'
import { connectionStore, dismissRefusal } from '@/lib/connection'
import { connect, isAuthError, sessionStore } from '@/lib/session'
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
