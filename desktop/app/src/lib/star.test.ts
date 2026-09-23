import { afterEach, describe, expect, test } from 'vitest'

import { forgetMarks, starMarks, starredNow, withMark } from '@/lib/star'
import type { Song } from '@/lib/subsonic'

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
