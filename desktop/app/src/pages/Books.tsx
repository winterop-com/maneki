import { ChevronLeft, Pause, Play, RotateCcw, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { SPEEDS, SKIP_S, useBookPlayer } from '@/hooks/use-book-player'
import { books as booksApi } from '@/lib/api'
import { clock, duration, progressRatio, remaining } from '@/lib/format'
import type { BookDetail, BookSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

export function BooksPage() {
    const { bookId } = useParams()
    return bookId ? <Book id={bookId} /> : <Shelf />
}

/** Every book, with how far through each one this account is. */
function Shelf() {
    const [books, setBooks] = useState<BookSummary[] | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()

    useEffect(() => {
        booksApi
            .list()
            .then(setBooks)
            .catch((error: Error) => setRefusal(error.message))
    }, [])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!books) return <Notice>Reading the shelf.</Notice>
    if (!books.length) return <Notice>No audiobooks.</Notice>

    return (
        <ul className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {books.map((book) => (
                <li key={book.id}>
                    <button
                        type="button"
                        onClick={() => navigate(`/books/${book.id}`)}
                        className="row-hover w-full rounded-lg p-2 text-left"
                    >
                        <Cover book={book} className="mb-2 w-full rounded-md" />
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

/** One book: its chapters, and the player that keeps your place. */
function Book({ id }: { id: string }) {
    const [book, setBook] = useState<BookDetail | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()
    const player = useBookPlayer(book)

    useEffect(() => {
        booksApi
            .detail(id)
            .then(setBook)
            .catch((error: Error) => setRefusal(error.message))
    }, [id])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!book) return <Notice>Opening the book.</Notice>

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
                <Cover book={book} className="size-28 shrink-0 rounded-md sm:size-40" />
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
            </div>

            <Transport book={book} player={player} />

            {book.chapter_list.length > 0 && (
                <ol className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
                    {book.chapter_list.map((chapter, index) => (
                        <li key={`${chapter.start_s}-${chapter.title}`}>
                            <button
                                type="button"
                                onClick={() => player.seek(chapter.start_s)}
                                aria-current={index === player.chapterIndex ? 'true' : undefined}
                                className={cn(
                                    'row-hover flex min-h-finger w-full items-center gap-3 px-3 text-left text-sm',
                                    index === player.chapterIndex && 'bg-muted font-medium',
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
                    ))}
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

function Transport({ book, player }: { book: BookDetail; player: ReturnType<typeof useBookPlayer> }) {
    return (
        <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Back ${SKIP_S} seconds`}
                    onClick={() => player.skip(-SKIP_S)}
                >
                    <RotateCcw className="size-4" aria-hidden />
                </Button>
                <Button
                    size="sm"
                    aria-label={player.playing ? 'Pause' : 'Play'}
                    onClick={player.toggle}
                    className="min-w-finger"
                >
                    {player.playing ? (
                        <Pause className="size-4" aria-hidden />
                    ) : (
                        <Play className="size-4" aria-hidden />
                    )}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Forward ${SKIP_S} seconds`}
                    onClick={() => player.skip(SKIP_S)}
                >
                    <RotateCw className="size-4" aria-hidden />
                </Button>
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {clock(player.positionS)} / {clock(book.duration_s)}
                </span>
                <select
                    aria-label="Playback speed"
                    value={player.speed}
                    onChange={(event) => player.setSpeed(Number(event.target.value))}
                    className="ml-auto h-8 rounded-md border bg-field px-2 text-xs"
                >
                    {SPEEDS.map((speed) => (
                        <option key={speed} value={speed}>
                            {speed}x
                        </option>
                    ))}
                </select>
            </div>
            <input
                type="range"
                aria-label="Position"
                min={0}
                max={Math.max(1, Math.floor(book.duration_s))}
                step={1}
                value={Math.floor(player.positionS)}
                onChange={(event) => player.seek(Number(event.target.value))}
                className="mt-3 w-full accent-primary"
            />
            <p className="mt-1 text-xs text-muted-foreground">
                {remaining(book.duration_s, player.positionS)}
            </p>
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

function Cover({ book, className }: { book: BookSummary; className?: string }) {
    if (!book.has_cover) {
        return <div className={cn('aspect-square bg-muted', className)} aria-hidden />
    }
    return (
        <img
            src={booksApi.coverUrl(book.id)}
            alt=""
            loading="lazy"
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
