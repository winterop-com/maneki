/**
 * Where one position on a book's timeline actually is.
 *
 * A BOOK IS ONE TIMELINE AND SEVERAL FILES. A listener scrubs, picks a chapter and reads a
 * clock on the whole book; the element plays one file at a time. Turning one into the other is
 * arithmetic, and it is the arithmetic that decides whether picking chapter 14 lands in chapter
 * 14 -- so it lives here, as pure functions with tests, rather than inside an effect where it
 * can only be checked by listening.
 */

import type { BookFile, Chapter } from '@/lib/types'

/** Which file a position falls in, and how far into that file it is. */
export interface Placement {
    index: number
    offsetS: number
}

/**
 * The file holding `at`, and the offset into it.
 *
 * The end of the book is the end of the last file rather than nothing: a position past the last
 * byte is what a finished book has, and it has to place somewhere.
 */
export function fileAt(files: readonly BookFile[], at: number): Placement {
    if (files.length === 0) return { index: 0, offsetS: 0 }
    const wanted = Math.max(0, at)
    for (const file of files) {
        if (wanted < file.offset_s + file.duration_s) {
            return { index: file.index, offsetS: Math.max(0, wanted - file.offset_s) }
        }
    }
    const last = files[files.length - 1]!
    return { index: last.index, offsetS: last.duration_s }
}

/** Where one file's position sits on the book's own timeline. */
export function positionOf(files: readonly BookFile[], index: number, offsetS: number): number {
    const file = files.find((one) => one.index === index)
    return (file?.offset_s ?? 0) + Math.max(0, offsetS)
}

/**
 * The chapter a position is inside, or -1 for a book with no chapters.
 *
 * A position past the last chapter's end answers the last chapter rather than nothing: the
 * chapter marks a book carries do not always reach its final second, and the listener is still
 * in the last chapter when they do not.
 */
export function chapterAt(chapters: readonly Chapter[], at: number): number {
    if (chapters.length === 0) return -1
    const found = chapters.findIndex((chapter) => at >= chapter.start_s && at < chapter.end_s)
    if (found !== -1) return found
    return at < (chapters[0]?.start_s ?? 0) ? 0 : chapters.length - 1
}
