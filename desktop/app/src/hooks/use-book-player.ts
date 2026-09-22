/**
 * Playing one book: the audio element, where it is, and where it left off.
 *
 * A POSITION IS ONE NUMBER, on the book's whole timeline, not a file and an
 * offset. A book split across files is still one thing to a listener, so
 * seeking across a file boundary is the same gesture as seeking inside one,
 * and what the server stores is the same number the scrub bar shows.
 *
 * SAVED WHILE LISTENING, not only at the end. An hour in, a closed laptop or
 * a lost connection must not cost the hour, so the position goes to the
 * server every `SAVE_EVERY_S` and whenever playback pauses or the screen
 * goes away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { books as booksApi } from '@/lib/api'
import type { BookDetail } from '@/lib/types'

const SAVE_EVERY_S = 10
/** What a jump back or forward moves, the step audiobook players settle on. */
export const SKIP_S = 15
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

export interface BookPlayer {
    positionS: number
    playing: boolean
    speed: number
    /** The chapter the position is inside, if the book has chapters. */
    chapterIndex: number
    toggle: () => void
    seek: (positionS: number) => void
    skip: (seconds: number) => void
    setSpeed: (speed: number) => void
}

export function useBookPlayer(book: BookDetail | null): BookPlayer {
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const [positionS, setPositionS] = useState(book?.position_s ?? 0)
    const [playing, setPlaying] = useState(false)
    const [speed, setSpeedState] = useState(1)
    const savedAt = useRef(0)
    const positionRef = useRef(positionS)
    positionRef.current = positionS

    if (audioRef.current === null && typeof Audio !== 'undefined') {
        audioRef.current = new Audio()
        audioRef.current.preload = 'metadata'
    }

    /** The file a book position falls in, and the offset into it. */
    const locate = useCallback(
        (at: number): { index: number; offset: number } => {
            if (!book) return { index: 0, offset: 0 }
            for (const file of book.files) {
                if (at < file.offset_s + file.duration_s) {
                    return { index: file.index, offset: Math.max(0, at - file.offset_s) }
                }
            }
            const last = book.files[book.files.length - 1]
            return { index: last?.index ?? 0, offset: last?.duration_s ?? 0 }
        },
        [book],
    )

    const save = useCallback(
        (at: number, finished?: boolean) => {
            if (!book) return
            savedAt.current = at
            void booksApi.saveProgress(book.id, at, finished).catch(() => {
                // A lost save is retried by the next tick; nothing to tell the listener.
            })
        },
        [book],
    )

    /** Put the element on the file that holds `at`, loading another file only when it changes. */
    const place = useCallback(
        (at: number, resume: boolean) => {
            const audio = audioRef.current
            if (!audio || !book) return
            const { index, offset } = locate(at)
            const wanted = booksApi.fileUrl(book.files[index]!.url)
            if (audio.src !== wanted) audio.src = wanted
            audio.currentTime = offset
            audio.playbackRate = speed
            if (resume) void audio.play().catch(() => setPlaying(false))
        },
        [book, locate, speed],
    )

    // Open the book where this account stopped.
    useEffect(() => {
        if (!book) return
        setPositionS(book.position_s)
        place(book.position_s, false)
        // Only when the book changes: `place` moves with the speed, and rerunning
        // this on a speed change would rewind the book to where it was opened.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [book?.id])

    useEffect(() => {
        const audio = audioRef.current
        if (!audio || !book) return

        const onTime = () => {
            const { index } = locate(positionRef.current)
            const file = book.files[index]
            if (!file) return
            const at = file.offset_s + audio.currentTime
            setPositionS(at)
            if (Math.abs(at - savedAt.current) >= SAVE_EVERY_S) save(at)
        }
        const onEnded = () => {
            const { index } = locate(positionRef.current)
            const next = book.files[index + 1]
            if (next) {
                place(next.offset_s, true)
                return
            }
            setPlaying(false)
            save(book.duration_s, true)
        }
        const onPlay = () => setPlaying(true)
        const onPause = () => {
            setPlaying(false)
            save(positionRef.current)
        }
        audio.addEventListener('timeupdate', onTime)
        audio.addEventListener('ended', onEnded)
        audio.addEventListener('play', onPlay)
        audio.addEventListener('pause', onPause)
        return () => {
            audio.removeEventListener('timeupdate', onTime)
            audio.removeEventListener('ended', onEnded)
            audio.removeEventListener('play', onPlay)
            audio.removeEventListener('pause', onPause)
        }
    }, [book, locate, place, save])

    // Leaving the screen, or closing the tab, keeps the position.
    useEffect(() => {
        const keep = () => save(positionRef.current)
        window.addEventListener('pagehide', keep)
        return () => {
            window.removeEventListener('pagehide', keep)
            audioRef.current?.pause()
            keep()
        }
    }, [save])

    const toggle = useCallback(() => {
        const audio = audioRef.current
        if (!audio || !book) return
        if (audio.paused) {
            if (!audio.src) place(positionRef.current, true)
            else void audio.play().catch(() => setPlaying(false))
        } else {
            audio.pause()
        }
    }, [book, place])

    const seek = useCallback(
        (at: number) => {
            if (!book) return
            const bounded = Math.min(Math.max(0, at), book.duration_s)
            setPositionS(bounded)
            place(bounded, !audioRef.current?.paused)
            save(bounded)
        },
        [book, place, save],
    )

    const skip = useCallback((seconds: number) => seek(positionRef.current + seconds), [seek])

    const setSpeed = useCallback((next: number) => {
        setSpeedState(next)
        if (audioRef.current) audioRef.current.playbackRate = next
    }, [])

    const chapterIndex = useMemo(() => {
        if (!book?.chapter_list.length) return -1
        const found = book.chapter_list.findIndex((c) => positionS >= c.start_s && positionS < c.end_s)
        return found === -1 ? book.chapter_list.length - 1 : found
    }, [book, positionS])

    return { positionS, playing, speed, chapterIndex, toggle, seek, skip, setSpeed }
}
