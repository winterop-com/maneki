import { afterEach, describe, expect, test } from 'vitest'

import type { YouTubeCounts } from '@/lib/types'
import { countsHeld, forgetCounts, rememberCounts, uncounted, withCounts } from '@/lib/youtube-counts'

function counts(videos: number): YouTubeCounts {
    return {
        videos,
        shorts: 0,
        live: 0,
        videos_capped: false,
        shorts_capped: false,
        live_capped: false,
    }
}

afterEach(forgetCounts)

describe('which channels still have to be counted', () => {
    // Regression: the whole sweep ran again on every mount, Back out of a channel included,
    // which is three yt-dlp listings per channel for numbers that had not moved.
    test('is the ones nothing has counted yet', () => {
        const held = withCounts(new Map(), 'UC_a', counts(12))
        expect(uncounted(held, ['UC_a', 'UC_b', 'UC_c'])).toEqual(['UC_b', 'UC_c'])
    })

    test('is none once every one of them is known', () => {
        const held = withCounts(withCounts(new Map(), 'UC_a', counts(12)), 'UC_b', counts(3))
        expect(uncounted(held, ['UC_a', 'UC_b'])).toEqual([])
    })

    test('is all of them when nothing has been counted', () => {
        expect(uncounted(new Map(), ['UC_a', 'UC_b'])).toEqual(['UC_a', 'UC_b'])
    })

    // The numbers fill in down the screen as they arrive, and a sweep that jumped about would
    // read as rows answering at random.
    test('keeps the order the listing was in', () => {
        const held = withCounts(new Map(), 'UC_b', counts(1))
        expect(uncounted(held, ['UC_c', 'UC_b', 'UC_a'])).toEqual(['UC_c', 'UC_a'])
    })

    test('a channel that has gone is simply not asked about', () => {
        const held = withCounts(new Map(), 'UC_gone', counts(9))
        expect(uncounted(held, ['UC_a'])).toEqual(['UC_a'])
    })
})

describe('writing a count down', () => {
    test('leaves the map it was given alone, so a store publishes on identity', () => {
        const before: ReadonlyMap<string, YouTubeCounts> = new Map()
        const after = withCounts(before, 'UC_a', counts(12))
        expect(before.size).toBe(0)
        expect(after.get('UC_a')?.videos).toBe(12)
        expect(after).not.toBe(before)
    })

    test('replaces what a channel last said rather than piling it up', () => {
        const held = withCounts(withCounts(new Map(), 'UC_a', counts(12)), 'UC_a', counts(13))
        expect(held.size).toBe(1)
        expect(held.get('UC_a')?.videos).toBe(13)
    })

    test('outlives the screen, which is the whole point of it being here', () => {
        rememberCounts('UC_a', counts(12))
        expect(countsHeld.get().get('UC_a')?.videos).toBe(12)
        forgetCounts()
        expect(countsHeld.get().size).toBe(0)
    })
})
