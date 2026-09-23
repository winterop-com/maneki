import { describe, expect, test } from 'vitest'

import { clock, duration, progressRatio, remaining, trackCount } from '@/lib/format'

describe('clock', () => {
    test('writes hours when a book has them', () => {
        expect(clock(72130)).toBe('20:02:10')
        expect(clock(2535)).toBe('42:15')
        expect(clock(9)).toBe('0:09')
    })

    test('never goes below zero', () => {
        expect(clock(-5)).toBe('0:00')
    })
})

describe('duration', () => {
    test('reads as a length, not a clock', () => {
        expect(duration(72130)).toBe('20h 02m')
        expect(duration(2535)).toBe('42m')
    })
})

describe('remaining', () => {
    test('says what is left of the book', () => {
        expect(remaining(72130, 60130)).toBe('3h 20m left')
        expect(remaining(72130, 72130)).toBe('0m left')
    })
})

describe('progressRatio', () => {
    test('is a fraction, bounded at both ends', () => {
        expect(progressRatio(100, 25)).toBe(0.25)
        expect(progressRatio(100, 500)).toBe(1)
        expect(progressRatio(0, 10)).toBe(0)
    })
})

describe('trackCount', () => {
    test('says one track in the singular and none in words', () => {
        expect(trackCount(0)).toBe('no tracks')
        expect(trackCount(1)).toBe('1 track')
        expect(trackCount(12)).toBe('12 tracks')
    })
})
