import { ChevronLeft, Pause, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { CoverArt } from '@/components/CoverArt'
import { Button } from '@/components/ui/button'
import { useStoreValue } from '@/hooks/use-store'
import { books as booksApi } from '@/lib/api'
import { chapterAt } from '@/lib/book-timeline'
import { clock, duration, progressRatio, remaining } from '@/lib/format'
import { playBook, playerStore, toggle, type PlayerState } from '@/lib/player'
import type { BookDetail, BookSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

/** How often to look again while the server is still reading the books folder. */
const SCAN_POLL_MS = 2000

/**
 * The three facts this screen reads off the player.
 *
 * Module scope, so each is one stable function, and one fact each rather than the whole store:
 * the player publishes four times a second while something plays, and a chapter list that
 * re-rendered on every tick is a list that will not keep up with the pointer. The chapter is a
 * number, so the rows repaint when the chapter turns and not when the second does.
 */
const selectPlaying = (state: PlayerState) => state.playing
const selectBookId = (state: PlayerState) => state.book?.id ?? null
const selectChapterIndex = (state: PlayerState) =>
    state.book === null ? -1 : chapterAt(state.book.chapter_list, state.positionS)

export function BooksPage() {
    const { bookId } = useParams()
    return bookId ? <Book id={bookId} /> : <Shelf />
}

/** Every book, with how far through each one this account is. */
function Shelf() {
    const [books, setBooks] = useState<BookSummary[] | null>(null)
    const [scanning, setScanning] = useState(false)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()

    /**
     * A first scan of a large folder takes a while, and an empty list during
     * one is not an empty shelf. Ask what the server is doing, and look again
     * while it is still reading.
     */
    useEffect(() => {
        let live = true
        let timer: ReturnType<typeof setTimeout>

        const load = async (): Promise<void> => {
            try {
                const [listed, status] = await Promise.all([booksApi.list(), booksApi.scanStatus()])
                if (!live) return
                setBooks(listed)
                setScanning(status.scanning)
                if (status.scanning) timer = setTimeout(() => void load(), SCAN_POLL_MS)
            } catch (error) {
                if (live) setRefusal(error instanceof Error ? error.message : 'the server did not answer')
            }
        }

        void load()
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!books) return <Notice>Reading the shelf.</Notice>
    if (!books.length) return <Notice>{scanning ? 'Reading the shelf.' : 'No audiobooks.'}</Notice>

    return (
        <ul className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {books.map((book) => (
                <li key={book.id}>
                    <button
                        type="button"
                        onClick={() => navigate(`/books/${book.id}`)}
                        className="row-hover w-full rounded-lg p-2 text-left"
                    >
                        <Cover book={book} size={CARD_COVER} className="mb-2 w-full rounded-md" />
                        <p className="truncate text-sm font-medium" title={book.title}>
                            {book.title}
                        </p>
                        <p className="truncate text-xs text-muted-foreground" title={book.author}>
                            {book.author}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {book.finished
                                ? 'Finished'
                                : book.position_s > 0
                                  ? remaining(book.duration_s, book.position_s)
                                  : duration(book.duration_s)}
                        </p>
                        {book.position_s > 0 && !book.finished && (
                            <Meter ratio={progressRatio(book.duration_s, book.position_s)} />
                        )}
                    </button>
                </li>
            ))}
        </ul>
    )
}

/**
 * One book: what it is, and its chapters.
 *
 * THERE IS NO TRANSPORT HERE. A book plays on the same bar as everything else, so this screen
 * has the one control an album screen has -- start it, or stop the thing it started -- and the
 * chapter list, which is a list of places to start from rather than a table of contents.
 */
function Book({ id }: { id: string }) {
    const [book, setBook] = useState<BookDetail | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()
    const playing = useStoreValue(playerStore, selectPlaying)
    const playingId = useStoreValue(playerStore, selectBookId)
    const chapterIndex = useStoreValue(playerStore, selectChapterIndex)

    useEffect(() => {
        booksApi
            .detail(id)
            .then(setBook)
            .catch((error: Error) => setRefusal(error.message))
    }, [id])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!book) return <Notice>Opening the book.</Notice>

    // THE BUTTON KNOWS WHEN THIS IS THE BOOK PLAYING, as the album screen's does: it pauses
    // that rather than saying Play beside a chapter that is sounding. And a book somebody is
    // part way through says Resume before it is touched, because that is what pressing it
    // does -- a half-read book offering Play would be promising the beginning.
    const playingThis = playingId === book.id
    const sounding = playingThis && playing
    const started = book.position_s > 0 && !book.finished

    return (
        <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 p-4">
            <div className="flex items-start gap-4">
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Back to the shelf"
                    onClick={() => navigate('/books')}
                >
                    <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <Cover book={book} size={BOOK_COVER} className="size-28 shrink-0 rounded-md sm:size-40" />
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-base">{book.title}</h1>
                    <p className="truncate text-sm text-muted-foreground">{book.author}</p>
                    {book.narrator && (
                        <p className="truncate text-xs text-muted-foreground">Read by {book.narrator}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                        {duration(book.duration_s)}
                        {book.year ? ` · ${book.year}` : ''}
                        {book.chapters ? ` · ${book.chapters} chapters` : ''}
                    </p>
                </div>
                <Button
                    size="sm"
                    onClick={() => {
                        if (playingThis) toggle()
                        else playBook(book)
                    }}
                    disabled={book.files.length === 0}
                    aria-pressed={sounding}
                >
                    {sounding ? (
                        <>
                            <Pause className="size-4" aria-hidden /> Pause
                        </>
                    ) : (
                        <>
                            <Play className="size-4" aria-hidden />{' '}
                            {playingThis || started ? 'Resume' : 'Play'}
                        </>
                    )}
                </Button>
            </div>

            {book.chapter_list.length > 0 && (
                <ol className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
                    {book.chapter_list.map((chapter, index) => {
                        // A row plays from itself. Seeking a player that was not playing this
                        // book is what the old screen did, and it is why a chapter click could
                        // look like it did nothing at all.
                        const current = playingThis && index === chapterIndex
                        return (
                            <li key={`${chapter.start_s}-${chapter.title}`}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        playBook(book, chapter.start_s)
                                    }}
                                    aria-current={current ? 'true' : undefined}
                                    className={cn(
                                        'row-hover flex min-h-finger w-full items-center gap-3 px-3 text-left text-sm',
                                        current && 'bg-muted font-medium',
                                    )}
                                >
                                    <span className="w-8 shrink-0 text-xs text-muted-foreground">
                                        {index + 1}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate" title={chapter.title}>
                                        {chapter.title}
                                    </span>
                                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                        {clock(chapter.start_s)}
                                    </span>
                                </button>
                            </li>
                        )
                    })}
                </ol>
            )}

            {book.description && (
                <p className="max-h-40 overflow-y-auto text-sm whitespace-pre-line text-muted-foreground">
                    {book.description}
                </p>
            )}
        </div>
    )
}

/** How far through a book, as a bar under its card. */
function Meter({ ratio }: { ratio: number }) {
    return (
        <div className="mt-1 h-1 w-full rounded-sm bg-muted" role="presentation">
            <div className="h-full rounded-sm bg-primary" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
    )
}

/** What a shelf card draws, and what a book's own screen draws. */
const CARD_COVER = 320
const BOOK_COVER = 640

function Cover({ book, size, className }: { book: BookSummary; size: number; className?: string }) {
    if (!book.has_cover) {
        return <CoverArt id={book.id} className={className} />
    }
    return (
        <img
            src={booksApi.coverUrl(book.id, size)}
            alt=""
            loading="lazy"
            decoding="async"
            width={size}
            height={size}
            className={cn('aspect-square object-cover', className)}
        />
    )
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">{children}</p>
        </div>
    )
}
