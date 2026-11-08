import { describe, expect, test } from 'vitest'

import { queueNext, queuePrevious, REPEAT_MODES, type RepeatMode } from '@winterop-com/sokkel-ui-media/queue'
import { playingRow, REPEAT_LABELS } from '@/lib/queue'

describe('the repeat control', () => {
    test('names every mode the library cycles through', () => {
        expect(Object.keys(REPEAT_LABELS)).toEqual([...REPEAT_MODES])
    })
})

/** Three tracks in the album's order, standing at `at`. */
function queue(at: number, repeat: RepeatMode) {
    return { items: ['a', 'b', 'c'], order: [0, 1, 2], at, shuffle: false, repeat }
}

describe('next and previous, as the client before the library had them', () => {
    test('previous on the first track goes nowhere unless the queue repeats, and the player restarts it', () => {
        expect(queuePrevious(queue(0, 'off'))).toBeUndefined()
        expect(queuePrevious(queue(0, 'one'))).toBeUndefined()
        expect(queuePrevious(queue(0, 'all'))?.at).toBe(2)
    })

    test('next under repeat one moves along, and wraps at the end', () => {
        expect(queueNext(queue(0, 'one'))?.at).toBe(1)
        expect(queueNext(queue(2, 'one'))?.at).toBe(0)
        expect(queueNext(queue(2, 'off'))).toBeUndefined()
    })
})

describe('which row of a list is the one playing', () => {
    test('is the queue position when the list is what is playing', () => {
        // A track on a playlist three times lit all three rows.
        expect(playingRow(['a', 'b', 'a', 'c', 'a'], ['a', 'b', 'a', 'c', 'a'], 2)).toBe(2)
    })

    test('is the first copy when the track is playing from somewhere else', () => {
        expect(playingRow(['x', 'a', 'a'], ['a', 'b'], 0)).toBe(1)
    })

    test('is none when the track is not in the list', () => {
        expect(playingRow(['x', 'y'], ['a'], 0)).toBe(-1)
        expect(playingRow(['x'], [], -1)).toBe(-1)
    })
})
