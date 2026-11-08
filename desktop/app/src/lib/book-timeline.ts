/**
 * Where one position on a book's timeline actually is.
 *
 * A BOOK IS ONE TIMELINE AND SEVERAL FILES. A listener scrubs, picks a chapter and reads a
 * clock on the whole book; the element plays one file at a time. The arithmetic is
 * sokkel-ui-media's `timeline` and `chapters`; this file reads the server's file table and
 * chapter marks into what those take. The server lays the files end to end, so each file's
 * `offset_s` is the length of the ones before it, which is what the library counts from.
 */

import { chapterIndex } from '@winterop-com/sokkel-ui-media/chapters'
import { fileAt as placeOnFiles, timelinePosition } from '@winterop-com/sokkel-ui-media/timeline'
import type { BookFile, Chapter } from '@/lib/types'

/** Which file a position falls in, by the server's own index, and how far into that file it is. */
export interface Placement {
    index: number
    offsetS: number
}

const lengths = (files: readonly BookFile[]) => files.map((file) => file.duration_s)

/**
 * The file holding `at`, and the offset into it. The end of the book is the end of the last
 * file: a position past the last byte is what a finished book has, and it has to place somewhere.
 */
export function fileAt(files: readonly BookFile[], at: number): Placement {
    const { file, offset } = placeOnFiles(lengths(files), at)
    return { index: files[file]?.index ?? 0, offsetS: offset }
}

/** Where one file's position sits on the book's own timeline. */
export function positionOf(files: readonly BookFile[], index: number, offsetS: number): number {
    return timelinePosition(
        lengths(files),
        files.findIndex((file) => file.index === index),
        offsetS,
    )
}

/**
 * The chapter a position is inside, or -1 for a book with no chapters. Before the first mark is
 * the first chapter: the listener is in it from the book's first second.
 */
export function chapterAt(chapters: readonly Chapter[], at: number): number {
    if (chapters.length === 0) return -1
    return Math.max(
        0,
        chapterIndex(
            chapters.map((chapter) => chapter.start_s),
            at,
        ),
    )
}
