import { describe, expect, test } from 'vitest'

import { chapterAt, fileAt, positionOf } from '@/lib/book-timeline'
import type { BookFile, Chapter } from '@/lib/types'

/** Three files of ten minutes each, laid end to end the way the server lays them. */
const FILES: BookFile[] = [
    { index: 0, duration_s: 600, offset_s: 0, size_bytes: 1, url: 'a/1.m4b' },
    { index: 1, duration_s: 600, offset_s: 600, size_bytes: 1, url: 'a/2.m4b' },
    { index: 2, duration_s: 600, offset_s: 1200, size_bytes: 1, url: 'a/3.m4b' },
]

const ONE_FILE: BookFile[] = [{ index: 0, duration_s: 3600, offset_s: 0, size_bytes: 1, url: 'a/whole.m4b' }]

const CHAPTERS: Chapter[] = [
    { title: 'One', start_s: 0, end_s: 500 },
    { title: 'Two', start_s: 500, end_s: 1100 },
    { title: 'Three', start_s: 1100, end_s: 1700 },
]

describe('placing a position on the files', () => {
    test('finds the file a position is inside, and the offset into it', () => {
        expect(fileAt(FILES, 0)).toEqual({ index: 0, offsetS: 0 })
        expect(fileAt(FILES, 300)).toEqual({ index: 0, offsetS: 300 })
        expect(fileAt(FILES, 700)).toEqual({ index: 1, offsetS: 100 })
        expect(fileAt(FILES, 1500)).toEqual({ index: 2, offsetS: 300 })
    })

    test('a boundary belongs to the file it starts, not the one it ends', () => {
        expect(fileAt(FILES, 600)).toEqual({ index: 1, offsetS: 0 })
        expect(fileAt(FILES, 1200)).toEqual({ index: 2, offsetS: 0 })
    })

    test('the end of the book places at the end of the last file, which is what finished is', () => {
        expect(fileAt(FILES, 1800)).toEqual({ index: 2, offsetS: 600 })
        expect(fileAt(FILES, 9999)).toEqual({ index: 2, offsetS: 600 })
    })

    test('a position before the start is the start', () => {
        expect(fileAt(FILES, -10)).toEqual({ index: 0, offsetS: 0 })
    })

    test('one file is the whole timeline, which is what most books are', () => {
        expect(fileAt(ONE_FILE, 2400)).toEqual({ index: 0, offsetS: 2400 })
    })

    test('a book with no files at all still answers somewhere', () => {
        expect(fileAt([], 100)).toEqual({ index: 0, offsetS: 0 })
    })
})

describe('reading the element back onto the timeline', () => {
    test('adds the file its own offset, which is the inverse of placing', () => {
        expect(positionOf(FILES, 1, 100)).toBe(700)
        const { index, offsetS } = fileAt(FILES, 1234)
        expect(positionOf(FILES, index, offsetS)).toBe(1234)
    })

    test('a file the book does not have reads as the offset alone rather than NaN', () => {
        expect(positionOf(FILES, 9, 30)).toBe(30)
    })
})

describe('which chapter a position is in', () => {
    test('is the one whose range holds it', () => {
        expect(chapterAt(CHAPTERS, 0)).toBe(0)
        expect(chapterAt(CHAPTERS, 499)).toBe(0)
        expect(chapterAt(CHAPTERS, 500)).toBe(1)
        expect(chapterAt(CHAPTERS, 1100)).toBe(2)
    })

    test('past the last mark is still the last chapter, not nowhere', () => {
        expect(chapterAt(CHAPTERS, 5000)).toBe(2)
    })

    test('before the first mark is the first chapter', () => {
        expect(chapterAt([{ title: 'Late', start_s: 30, end_s: 60 }], 0)).toBe(0)
    })

    test('a book with no chapters is in none of them', () => {
        expect(chapterAt([], 100)).toBe(-1)
    })
})
