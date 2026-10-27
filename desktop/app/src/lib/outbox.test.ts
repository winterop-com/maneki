import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { dismissRefusal, recoveries } from '@/lib/connection'
import { keptFor, sendKept, sendPlay, sendStar, startOutbox, withKept, withoutKept } from '@/lib/outbox'
import { forgetMarks, markKept, starMarks } from '@/lib/star'
import type { Credentials } from '@/lib/subsonic'

const credentials: Credentials = { restUrl: 'http://host/audio/rest', username: 'me', salt: 's', token: 't' }
const other: Credentials = { ...credentials, username: 'someone-else' }

function fakeStorage(): Storage {
    const held = new Map<string, string>()
    return {
        getItem: (key: string) => held.get(key) ?? null,
        setItem: (key: string, value: string) => {
            held.set(key, value)
        },
        removeItem: (key: string) => {
            held.delete(key)
        },
        clear: () => {
            held.clear()
        },
        key: () => null,
        get length() {
            return held.size
        },
    }
}

/** A server that is either there, answering ok to everything, or not there at all. */
function server() {
    const asked: string[] = []
    let up = false
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
        if (!up) throw new TypeError('Failed to fetch')
        const url = new URL(String(input))
        const params = ['id', 'submission', 'time']
            .map((name) => url.searchParams.get(name))
            .filter((value) => value !== null)
        asked.push([url.pathname.split('/').pop(), ...params].join(' '))
        return Response.json({ 'subsonic-response': { status: 'ok' } })
    })
    return {
        fetch,
        asked,
        setUp: (now: boolean) => {
            up = now
        },
    }
}

beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage())
})

afterEach(() => {
    vi.unstubAllGlobals()
    forgetMarks()
    dismissRefusal()
})

describe('the kept list', () => {
    test('piles up plays, and keeps only the last thing asked of a star', () => {
        let kept = withKept([], { kind: 'play', id: 'tr_1', at: 1 })
        kept = withKept(kept, { kind: 'star', id: 'tr_1', starred: true })
        kept = withKept(kept, { kind: 'play', id: 'tr_1', at: 2 })
        kept = withKept(kept, { kind: 'star', id: 'tr_1', starred: false })
        expect(kept).toEqual([
            { kind: 'play', id: 'tr_1', at: 1 },
            { kind: 'play', id: 'tr_1', at: 2 },
            { kind: 'star', id: 'tr_1', starred: false },
        ])
    })

    test('lets go of one sent write and nothing else', () => {
        const kept = withKept(withKept([], { kind: 'play', id: 'a', at: 1 }), {
            kind: 'play',
            id: 'a',
            at: 2,
        })
        expect(withoutKept(kept, { kind: 'play', id: 'a', at: 2 })).toEqual([
            { kind: 'play', id: 'a', at: 1 },
        ])
        expect(withoutKept(kept, { kind: 'play', id: 'b', at: 1 })).toEqual(kept)
    })
})

describe('with the server out of reach', () => {
    test('a play and a star are kept for that account, and sent in order when it comes back', async () => {
        const wire = server()
        vi.stubGlobal('fetch', wire.fetch)
        await sendPlay(credentials, 'tr_1', 1000)
        await sendStar(credentials, 'al_1', true)
        await sendPlay(credentials, 'tr_2', 2000)
        expect(keptFor(credentials)).toHaveLength(3)
        expect(keptFor(other)).toEqual([])

        wire.setUp(true)
        await sendKept(credentials)
        expect(wire.asked).toEqual(['scrobble tr_1 true 1000', 'star al_1', 'scrobble tr_2 true 2000'])
        expect(keptFor(credentials)).toEqual([])
    })

    test('a flush stops at the wire refusing and keeps the rest', async () => {
        const wire = server()
        vi.stubGlobal('fetch', wire.fetch)
        await sendPlay(credentials, 'tr_1', 1000)
        await sendKept(credentials)
        expect(keptFor(credentials)).toHaveLength(1)
    })

    test('a write the server refuses is let go rather than kept', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json({
                    'subsonic-response': { status: 'failed', error: { code: 70, message: 'not found' } },
                }),
            ),
        )
        await sendPlay(credentials, 'tr_1', 1000)
        await expect(sendStar(credentials, 'tr_1', true)).rejects.toThrow('not found')
        expect(keptFor(credentials)).toEqual([])
    })

    test('the server coming back sends what was kept', async () => {
        const wire = server()
        vi.stubGlobal('fetch', wire.fetch)
        await sendPlay(credentials, 'tr_1', 1000)
        const stop = startOutbox(credentials)
        wire.setUp(true)
        recoveries.set(recoveries.get() + 1)
        await vi.waitFor(() => expect(keptFor(credentials)).toEqual([]))
        expect(wire.asked).toEqual(['scrobble tr_1 true 1000'])
        stop()
    })

    test('a kept star is drawn again after a restart, and a later star sent online replaces it', async () => {
        const wire = server()
        vi.stubGlobal('fetch', wire.fetch)
        await sendStar(credentials, 'tr_1', true)
        markKept(credentials)
        expect(starMarks.get().get('tr_1')).toBe(true)

        wire.setUp(true)
        await sendStar(credentials, 'tr_1', false)
        expect(keptFor(credentials)).toEqual([])
    })
})
