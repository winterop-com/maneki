import { afterEach, describe, expect, test } from 'vitest'

import { forgetMarks, refusedStar, starMarks, starredNow, withMark } from '@/lib/star'
import { SubsonicError, type Song } from '@/lib/subsonic'

function song(id: string, starred?: string): Song {
    return { id, title: id, starred }
}

afterEach(forgetMarks)

describe('what a star says', () => {
    test("is the server's answer when this client has written nothing", () => {
        expect(starredNow(new Map(), song('a', '2026-01-01T00:00:00Z'))).toBe(true)
        expect(starredNow(new Map(), song('a'))).toBe(false)
    })

    test('is what this client wrote, over whatever the read said', () => {
        const marks = withMark(new Map(), 'a', false)
        expect(starredNow(marks, song('a', '2026-01-01T00:00:00Z'))).toBe(false)
        expect(starredNow(withMark(new Map(), 'a', true), song('a'))).toBe(true)
    })

    test('is false for nothing playing, which is what the key is pressed against', () => {
        expect(starredNow(new Map(), null)).toBe(false)
    })
})

describe('writing a mark', () => {
    test('leaves the map it was given alone, so a store publishes on identity', () => {
        const before = new Map<string, boolean>()
        const after = withMark(before, 'a', true)
        expect(before.size).toBe(0)
        expect(after.get('a')).toBe(true)
        expect(after).not.toBe(before)
    })

    test('replaces a mark rather than piling them up', () => {
        const marks = withMark(withMark(new Map(), 'a', true), 'a', false)
        expect(marks.size).toBe(1)
        expect(marks.get('a')).toBe(false)
    })

    test('forgetting empties the store, which is what a session going away does', () => {
        starMarks.set(withMark(new Map(), 'a', true))
        forgetMarks()
        expect(starMarks.get().size).toBe(0)
    })
})

// Regression: the mark was handed back with nothing said, so a star went on under somebody's
// finger and quietly came off again.
describe('a refused star', () => {
    test('says what was asked for rather than what is true now', () => {
        expect(refusedStar(song('Blue Monday'), true, new Error(''))).toBe('Could not star Blue Monday.')
        expect(refusedStar(song('Blue Monday'), false, new Error(''))).toBe('Could not unstar Blue Monday.')
    })

    test("carries the server's own reason, which is what somebody can act on", () => {
        expect(refusedStar(song('Blue Monday'), true, new SubsonicError(50, 'not allowed'))).toBe(
            'Could not star Blue Monday: not allowed',
        )
    })

    test('says it plainly when whatever was thrown has nothing to add', () => {
        expect(refusedStar(song('Blue Monday'), true, 'nope')).toBe('Could not star Blue Monday.')
    })
})
