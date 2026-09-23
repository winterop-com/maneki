import { beforeEach, describe, expect, test } from 'vitest'

import { ApiError } from '@/lib/api'
import {
    connectionStore,
    dismissRefusal,
    isNetworkRefusal,
    NETWORK_REFUSAL,
    noteRecovered,
    noteRefusal,
} from '@/lib/connection'
import { SubsonicError } from '@/lib/subsonic'

beforeEach(() => {
    dismissRefusal()
})

describe('what counts as the wire going quiet', () => {
    test('is a request that never came back, in either grammar', () => {
        expect(isNetworkRefusal(new ApiError(0, NETWORK_REFUSAL))).toBe(true)
        expect(isNetworkRefusal(new SubsonicError(0, NETWORK_REFUSAL))).toBe(true)
    })

    test("is a bare fetch rejection, which is what the browser's own failure is", () => {
        expect(isNetworkRefusal(new TypeError('Failed to fetch'))).toBe(true)
    })

    // The banner is about reachability. A server answering badly is a server that is there, and
    // whoever asked has a refusal of its own to draw where the content would be.
    test('is never a status the server answered with', () => {
        expect(isNetworkRefusal(new ApiError(404, 'no such book'))).toBe(false)
        expect(isNetworkRefusal(new ApiError(500, 'the server answered 500'))).toBe(false)
        expect(isNetworkRefusal(new ApiError(401, 'sign in'))).toBe(false)
        expect(isNetworkRefusal(new SubsonicError(0, 'the server answered 503'))).toBe(false)
    })

    test('is never a Subsonic code, which is an answer as much as a status is', () => {
        expect(isNetworkRefusal(new SubsonicError(40, 'wrong username or password'))).toBe(false)
        expect(isNetworkRefusal(new SubsonicError(70, 'no album 12'))).toBe(false)
    })

    test('is not a thrown thing that is not an error at all', () => {
        expect(isNetworkRefusal('offline')).toBe(false)
        expect(isNetworkRefusal(null)).toBe(false)
        expect(isNetworkRefusal(undefined)).toBe(false)
    })
})

describe('the banner', () => {
    test('starts down about nothing', () => {
        expect(connectionStore.get()).toEqual({ down: false, reason: null })
    })

    test('goes up on a refusal from the wire, carrying its words', () => {
        expect(noteRefusal(new ApiError(0, NETWORK_REFUSAL))).toBe(true)
        expect(connectionStore.get()).toEqual({ down: true, reason: NETWORK_REFUSAL })
    })

    test('stays down for a server that answered', () => {
        expect(noteRefusal(new ApiError(503, 'the server answered 503'))).toBe(false)
        expect(connectionStore.get().down).toBe(false)
    })

    // A screen polling every two seconds against a dead server would otherwise re-render the
    // whole shell every two seconds to say the same sentence again.
    test('publishes nothing when it is already saying the same thing', () => {
        let published = 0
        const stop = connectionStore.subscribe(() => {
            published += 1
        })
        noteRefusal(new ApiError(0, NETWORK_REFUSAL))
        noteRefusal(new SubsonicError(0, NETWORK_REFUSAL))
        noteRefusal(new ApiError(0, NETWORK_REFUSAL))
        stop()
        expect(published).toBe(1)
    })

    test('comes down the moment anything answers', () => {
        noteRefusal(new ApiError(0, NETWORK_REFUSAL))
        noteRecovered()
        expect(connectionStore.get()).toEqual({ down: false, reason: null })
    })

    test('costs nothing to recover while nothing is wrong', () => {
        let published = 0
        const stop = connectionStore.subscribe(() => {
            published += 1
        })
        noteRecovered()
        noteRecovered()
        stop()
        expect(published).toBe(0)
    })

    test('can be dismissed, and is raised again by the next refusal', () => {
        noteRefusal(new ApiError(0, NETWORK_REFUSAL))
        dismissRefusal()
        expect(connectionStore.get().down).toBe(false)
        noteRefusal(new ApiError(0, NETWORK_REFUSAL))
        expect(connectionStore.get().down).toBe(true)
    })
})
