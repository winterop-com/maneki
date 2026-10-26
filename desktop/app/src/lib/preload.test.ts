import { describe, expect, test } from 'vitest'

import { PRELOAD_MAX_BYTES, songToPreload, worthHolding } from '@/lib/preload'

const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('the track fetched ahead', () => {
    test('is the next one in the order', () => {
        expect(songToPreload(queue, [0, 1, 2], 0, 'off')).toBe('b')
    })

    test('follows a shuffled order, not the album', () => {
        expect(songToPreload(queue, [2, 0, 1], 0, 'off')).toBe('a')
    })

    test('is nothing at the end of a queue that does not repeat', () => {
        expect(songToPreload(queue, [0, 1, 2], 2, 'off')).toBeNull()
    })

    test('wraps to the first under repeat-all', () => {
        expect(songToPreload(queue, [0, 1, 2], 2, 'all')).toBe('a')
    })

    test('is what a skip plays under repeat-one', () => {
        expect(songToPreload(queue, [0, 1, 2], 1, 'one')).toBe('c')
    })

    test('is nothing when the queue is this one track', () => {
        expect(songToPreload([{ id: 'a' }], [0], 0, 'all')).toBeNull()
        expect(songToPreload(queue, [0, 1, 2], -1, 'off')).toBeNull()
    })
})

describe('what is held in memory', () => {
    test('is a track of a known, ordinary size', () => {
        expect(worthHolding('7864320')).toBe(true)
    })

    test('is not one too large or of unknown length', () => {
        expect(worthHolding(String(PRELOAD_MAX_BYTES + 1))).toBe(false)
        expect(worthHolding(null)).toBe(false)
        expect(worthHolding('0')).toBe(false)
        expect(worthHolding('nonsense')).toBe(false)
    })
})
