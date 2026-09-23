import { describe, expect, test } from 'vitest'

import { barHeights, COVER_KINDS, COVER_TINTS, coverFace, hashOf } from '@/lib/covers'

describe('the hash behind a face', () => {
    test('answers the same number for the same string', () => {
        expect(hashOf('al-1138')).toBe(hashOf('al-1138'))
    })

    test('answers a different one for a string differing in one character', () => {
        expect(hashOf('al-1138')).not.toBe(hashOf('al-1139'))
    })

    test('stays a 32-bit unsigned number, whatever it was handed', () => {
        for (const id of ['', 'a', 'al-1138', 'ÅÆØ', 'x'.repeat(500)]) {
            const hash = hashOf(id)
            expect(Number.isInteger(hash)).toBe(true)
            expect(hash).toBeGreaterThanOrEqual(0)
            expect(hash).toBeLessThanOrEqual(0xff_ff_ff_ff)
        }
    })
})

describe('the face an id wears', () => {
    test('is one this build can draw', () => {
        for (let at = 0; at < 200; at += 1) {
            const face = coverFace(`al-${String(at)}`)
            expect(COVER_KINDS).toContain(face.kind)
            expect(face.tint).toBeGreaterThanOrEqual(0)
            expect(face.tint).toBeLessThan(COVER_TINTS.length)
        }
    })

    test('is the same one every time, which is what makes it the record’s mark', () => {
        expect(coverFace('al-1138')).toEqual(coverFace('al-1138'))
    })

    // A generator that put nine out of ten albums on one shape would be the grey square again
    // with extra steps.
    test('spreads a library across every shape and every ink', () => {
        const kinds = new Set<string>()
        const tints = new Set<number>()
        for (let at = 0; at < 400; at += 1) {
            const face = coverFace(`al-${String(at)}`)
            kinds.add(face.kind)
            tints.add(face.tint)
        }
        expect(kinds.size).toBe(COVER_KINDS.length)
        expect(tints.size).toBe(COVER_TINTS.length)
    })

    test('draws an id nothing gave us rather than refusing it', () => {
        const face = coverFace('')
        expect(COVER_KINDS).toContain(face.kind)
    })
})

describe('the bars of the bars face', () => {
    test('are as many as were asked for', () => {
        expect(barHeights(1)).toHaveLength(7)
        expect(barHeights(1, 3)).toHaveLength(3)
    })

    test('stay inside the square and never read as a rendering fault', () => {
        for (const height of barHeights(hashOf('al-1138'), 32)) {
            expect(height).toBeGreaterThanOrEqual(0.32)
            expect(height).toBeLessThan(1)
        }
    })

    test('are the same bars for the same hash and different ones for another', () => {
        expect(barHeights(hashOf('a'))).toEqual(barHeights(hashOf('a')))
        expect(barHeights(hashOf('a'))).not.toEqual(barHeights(hashOf('b')))
    })

    test('answer a hash of zero rather than standing still on it', () => {
        const heights = barHeights(0, 4)
        expect(new Set(heights).size).toBeGreaterThan(1)
    })
})
