import { describe, expect, test } from 'vitest'

import {
    afterSkip,
    afterTrack,
    beforeTrack,
    buildOrder,
    nextRepeat,
    REPEATS,
    reorderAround,
} from '@/lib/queue'

/** A shuffle nobody has to guess at: always picks the last remaining slot, so it reverses. */
const predictable = () => 0.999999

describe('the order a queue plays in', () => {
    test('in order is the album, from the top', () => {
        expect(buildOrder(4, 0, false)).toEqual([0, 1, 2, 3])
    })

    test('in order does not start at the picked track, because the album has an order', () => {
        // Starting at track 3 plays 3 next; the order itself is still the album's.
        expect(buildOrder(4, 2, false)).toEqual([0, 1, 2, 3])
    })

    test('shuffled, what is playing leads and the rest follow', () => {
        const order = buildOrder(5, 2, true, predictable)
        expect(order[0]).toBe(2)
        expect(order.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
    })

    test('a queue of one shuffles to itself', () => {
        expect(buildOrder(1, 0, true, predictable)).toEqual([0])
    })

    test('an empty queue has no order at all', () => {
        expect(buildOrder(0, 0, true)).toEqual([])
    })

    test('a start outside the queue is held inside it', () => {
        expect(buildOrder(3, 99, true, predictable)[0]).toBe(2)
        expect(buildOrder(3, -5, true, predictable)[0]).toBe(0)
    })
})

describe('what happens when a track ends', () => {
    const order = [0, 1, 2]

    test('moves along the order', () => {
        expect(afterTrack(order, 0, 'off')).toBe(1)
    })

    test('repeat-one plays the same track again, not the queue again', () => {
        expect(afterTrack(order, 1, 'one')).toBe(1)
    })

    test('the end of the queue stops, unless the queue repeats', () => {
        expect(afterTrack(order, 2, 'off')).toBeNull()
        expect(afterTrack(order, 2, 'all')).toBe(0)
    })

    test('an empty queue has nothing to move to', () => {
        expect(afterTrack([], 0, 'all')).toBeNull()
    })
})

describe('what happens when skip is pressed', () => {
    const order = [0, 1, 2]

    test('repeat-one still moves along: the press says this one is done', () => {
        expect(afterSkip(order, 1, 'one')).toBe(2)
    })

    test('at the end it wraps unless repeat is off', () => {
        expect(afterSkip(order, 2, 'all')).toBe(0)
        expect(afterSkip(order, 2, 'one')).toBe(0)
        expect(afterSkip(order, 2, 'off')).toBeNull()
    })
})

describe('what happens when skip-back is pressed', () => {
    const order = [0, 1, 2]

    test('moves back along the order', () => {
        expect(beforeTrack(order, 2, 'off')).toBe(1)
    })

    test('before the first track there is nowhere to go, so the caller restarts it', () => {
        expect(beforeTrack(order, 0, 'off')).toBeNull()
    })

    test('a queue that repeats has no first track, so it wraps to the end', () => {
        expect(beforeTrack(order, 0, 'all')).toBe(2)
    })
})

describe('turning shuffle on and off mid-queue', () => {
    test('keeps what is playing, and rearranges what is left', () => {
        const { order, at } = reorderAround([0, 1, 2, 3], 1, true, predictable)
        expect(order[at]).toBe(1)
        expect(at).toBe(0)
        expect(order.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3])
    })

    test('turning it off carries on from where you are in the album', () => {
        const { order, at } = reorderAround([2, 0, 3, 1], 0, false)
        expect(order).toEqual([0, 1, 2, 3])
        expect(order[at]).toBe(2)
    })

    test('an empty order is left alone', () => {
        expect(reorderAround([], 0, true)).toEqual({ order: [], at: 0 })
    })
})

describe('cycling the repeat control', () => {
    test('goes off, queue, track, off', () => {
        expect(nextRepeat('off')).toBe('all')
        expect(nextRepeat('all')).toBe('one')
        expect(nextRepeat('one')).toBe('off')
    })

    test('every mode is reachable from every other', () => {
        const seen = new Set<string>()
        let mode = REPEATS[0]!
        for (let i = 0; i < REPEATS.length; i += 1) {
            seen.add(mode)
            mode = nextRepeat(mode)
        }
        expect(seen.size).toBe(REPEATS.length)
    })
})
