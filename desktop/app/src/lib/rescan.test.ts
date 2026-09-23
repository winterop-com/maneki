import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { rescan, rescanning, SCAN_POLL_MS } from '@/lib/rescan'
import { clearScreenStatus, screenStatus } from '@/lib/screen-status'
import type { Credentials } from '@/lib/subsonic'

const CREDENTIALS: Credentials = {
    restUrl: 'https://host/audio/rest',
    username: 'mort',
    salt: 'abc',
    token: 'def',
}

/** A server whose walk answers each of these in turn, the last one repeating. */
function walking(steps: { scanning: boolean; count: number }[]): ReturnType<typeof vi.fn> {
    let at = 0
    return vi.fn(async () => {
        const step = steps[Math.min(at, steps.length - 1)]
        at += 1
        return {
            ok: true,
            status: 200,
            json: async () => ({ 'subsonic-response': { status: 'ok', scanStatus: step } }),
        }
    })
}

beforeEach(() => {
    vi.useFakeTimers()
    clearScreenStatus()
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('a rescan', () => {
    test('says how far the walk has got, and stops saying it once it settles', async () => {
        vi.stubGlobal(
            'fetch',
            walking([
                { scanning: true, count: 0 },
                { scanning: true, count: 400 },
                { scanning: false, count: 1204 },
            ]),
        )
        const walk = rescan(CREDENTIALS)

        await vi.advanceTimersByTimeAsync(0)
        expect(screenStatus.get().note).toBe('scanning')
        expect(screenStatus.get().tone).toBe('live')

        await vi.advanceTimersByTimeAsync(SCAN_POLL_MS)
        expect(screenStatus.get().note).toBe('scanning, 400 so far')

        await vi.advanceTimersByTimeAsync(SCAN_POLL_MS)
        await walk
        // A library that has finished being read has nothing to say about the reading.
        expect(screenStatus.get().note).toBeNull()
        expect(rescanning()).toBe(false)
    })

    test('leaves whatever the screen put beside it alone', async () => {
        screenStatus.set({ note: null, tone: 'quiet', identifier: 'al-1138' })
        vi.stubGlobal('fetch', walking([{ scanning: false, count: 12 }]))
        await rescan(CREDENTIALS)
        expect(screenStatus.get().identifier).toBe('al-1138')
    })

    // The server has one index and would coalesce two requests anyway; what two loops would
    // actually produce is two writers of one note.
    test('a second press joins the walk already running rather than starting another', async () => {
        const answer = walking([
            { scanning: true, count: 0 },
            { scanning: false, count: 9 },
        ])
        vi.stubGlobal('fetch', answer)

        const first = rescan(CREDENTIALS)
        await vi.advanceTimersByTimeAsync(0)
        expect(rescanning()).toBe(true)

        await rescan(CREDENTIALS)
        const calledWhileWalking = answer.mock.calls.length

        await vi.advanceTimersByTimeAsync(SCAN_POLL_MS)
        await first
        // One startScan and one poll: the second press added neither.
        expect(calledWhileWalking).toBe(1)
        expect(answer.mock.calls).toHaveLength(2)
    })

    test('a refusal takes the note off rather than leaving work in flight that is not', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('Failed to fetch')
            }),
        )
        await rescan(CREDENTIALS)
        expect(screenStatus.get().note).toBeNull()
        expect(rescanning()).toBe(false)
    })
})
