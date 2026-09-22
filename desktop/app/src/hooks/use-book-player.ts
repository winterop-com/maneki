/**
 * Playing one book: the audio element, where it is, and where it left off.
 *
 * A POSITION IS ONE NUMBER, on the book's whole timeline, not a file and an
 * offset. A book split across files is still one thing to a listener, so
 * seeking across a file boundary is the same gesture as seeking inside one,
 * and what the server stores is the same number the scrub bar shows. The
 * arithmetic between the two is `lib/book-timeline`, which has tests.
 *
 * A SEEK WAITS FOR THE ELEMENT TO BE ABLE TO TAKE IT. Writing `currentTime`
 * before the media has its metadata is discarded silently: the element stays
 * where it was, the next `timeupdate` writes that position back into the
 * store, and picking a chapter looks like it does nothing at all. So a seek
 * is held until `loadedmetadata` when the element is not ready yet.
 *
 * SAVED WHILE LISTENING, not only at the end. An hour in, a closed laptop or
 * a lost connection must not cost the hour, so the position goes to the
 * server every `SAVE_EVERY_S` and whenever playback pauses or the screen
 * goes away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { books as booksApi } from '@/lib/api'
import { chapterAt, fileAt, positionOf } from '@/lib/book-timeline'
import { claimSound, registerSilencer } from '@/lib/sound'
import type { BookDetail } from '@/lib/types'

const SAVE_EVERY_S = 10
/** What a jump back or forward moves, the step audiobook players settle on. */
export const SKIP_S = 15
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

/** `HTMLMediaElement.HAVE_METADATA`: the point at which a seek is not thrown away. */
const HAVE_METADATA = 1

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
    /** Which file the element is actually holding, which is not always the one the position implies. */
    const loadedIndex = useRef(0)

    if (audioRef.current === null && typeof Audio !== 'undefined') {
        audioRef.current = new Audio()
        audioRef.current.preload = 'metadata'
    }

    // Only one thing makes sound at a time: opening a book and pressing play stops the album
    // that was running, and starting an album stops the book. The callback is held in a ref so
    // this player can name itself when it claims the sound -- claiming without naming yourself
    // pauses your own element a moment before you start it.
    const silence = useRef(() => {
        audioRef.current?.pause()
    })
    useEffect(() => registerSilencer(silence.current), [])

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
            const { index, offsetS } = fileAt(book.files, at)
            const file = book.files.find((one) => one.index === index)
            if (!file) return
            const wanted = booksApi.fileUrl(file.url)
            const changing = audio.src !== wanted
            if (changing) {
                audio.src = wanted
                loadedIndex.current = index
            }
            // A fresh source has no metadata yet, and neither has one the browser has not got
            // round to reading; either way the write is only kept once it can be.
            if (!changing && audio.readyState >= HAVE_METADATA) {
                audio.currentTime = offsetS
            } else {
                audio.addEventListener(
                    'loadedmetadata',
                    () => {
                        audio.currentTime = offsetS
                    },
                    { once: true },
                )
            }
            audio.playbackRate = speed
            if (resume) {
                claimSound(silence.current)
                void audio.play().catch(() => setPlaying(false))
            }
        },
        [book, speed],
    )

    // Open the book where this account stopped.
    useEffect(() => {
        if (!book) return
        setPositionS(book.position_s)
        savedAt.current = book.position_s
        place(book.position_s, false)
        // Only when the book changes: `place` moves with the speed, and rerunning
        // this on a speed change would rewind the book to where it was opened.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [book?.id])

    useEffect(() => {
        const audio = audioRef.current
        if (!audio || !book) return

        const onTime = () => {
            // Read the file the element is holding, not the one the last known position
            // implies: at a boundary those differ, and the difference is a jump.
            const at = positionOf(book.files, loadedIndex.current, audio.currentTime)
            setPositionS(at)
            if (Math.abs(at - savedAt.current) >= SAVE_EVERY_S) save(at)
        }
        const onEnded = () => {
            const next = book.files.find((one) => one.index === loadedIndex.current + 1)
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
    }, [book, place, save])

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
            claimSound(silence.current)
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

    const chapterIndex = useMemo(
        () => (book ? chapterAt(book.chapter_list, positionS) : -1),
        [book, positionS],
    )

    return { positionS, playing, speed, chapterIndex, toggle, seek, skip, setSpeed }
}
