import { beforeEach, describe, expect, test, vi } from 'vitest'

import { connect, sessionStore } from '@/lib/session'
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

beforeEach(() => {
    vi.unstubAllGlobals()
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

    test('a server that does not answer is signed out, with the reason', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('network')
            }),
        )
        await connect({ baseUrl: 'https://host' })
        expect(sessionStore.get().phase).toBe('signed-out')
        expect(sessionStore.get().refusal).toBeTruthy()
    })
})
