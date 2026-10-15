import { Check, ChevronLeft, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'

import { Spinner } from '@/components/Spinner'
import { Skeleton } from '@/components/Skeleton'
import { CoverArt } from '@/components/CoverArt'
import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useScrollMemory } from '@/hooks/use-scroll-memory'
import { useStoreValue } from '@/hooks/use-store'
import { books as booksApi } from '@/lib/api'
import { chapterAt } from '@/lib/book-timeline'
import { clock, duration, progressRatio, remaining } from '@/lib/format'
import { playBook, playerStore, type PlayerState } from '@/lib/player'
import type { BookDetail, BookSummary, CollectionSummary, GroupSummary } from '@/lib/types'
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
const selectBookId = (state: PlayerState) => state.book?.id ?? null
const selectChapterIndex = (state: PlayerState) =>
    state.book === null ? -1 : chapterAt(state.book.chapter_list, state.positionS)

export function BooksPage() {
    const { bookId } = useParams()
    // ONE BOOK'S PAGE IS NOT ANOTHER'S. Keyed by the address, so Back from a book that was not
    // found, or a step from one book to the next, starts clean instead of showing the last one's
    // error or contents under the new address.
    return bookId ? <Book key={bookId} id={bookId} /> : <Library />
}

/**
 * The shelf, or one collection of short recordings kept off it.
 *
 * A COLLECTION IS NOT A PILE OF BOOKS. Two thousand fifteen-minute Blinkist summaries filed as
 * books buried the three hundred real ones, so a collection is its own choice above the shelf,
 * opens on its groups, and a group is a list where each row plays. Which one is open lives in
 * the address (`?c=Blinkist&g=Science`, an empty `g` for the items outside any group), so Back
 * from a summary's page lands in the list it came from.
 */
function Library() {
    const [params, setParams] = useSearchParams()
    const [collections, setCollections] = useState<CollectionSummary[]>([])
    const chosen = params.get('c') ?? ''
    const group = params.get('g')

    useEffect(() => {
        let live = true
        booksApi
            .collections()
            .then((found) => {
                if (live) setCollections(found)
            })
            // A server from before collections answers 404: then there are none, and the shelf
            // is the whole screen as it always was.
            .catch(() => undefined)
        return () => {
            live = false
        }
    }, [])

    const open = collections.find((c) => c.name === chosen) ?? null
    return (
        <div className="flex min-h-full flex-col">
            {collections.length > 0 && (
                <div className="flex px-4 pt-4">
                    <Segmented
                        label="Shelf"
                        value={open ? open.name : ''}
                        options={[
                            { value: '', label: 'Books' },
                            ...collections.map((c) => ({ value: c.name, label: c.name })),
                        ]}
                        onChoose={(value) => setParams(value ? { c: value } : {})}
                    />
                </div>
            )}
            {open === null ? (
                <Shelf />
            ) : group === null ? (
                <Groups collection={open} onOpen={(g) => setParams({ c: open.name, g: g ?? '' })} />
            ) : (
                <Items
                    key={`${open.name}/${group}`}
                    collection={open.name}
                    group={group || null}
                    onBack={() => setParams({ c: open.name })}
                />
            )}
        </div>
    )
}

/** What a group is called; the items outside any group are the collection's own. */
function groupLabel(group: string | null): string {
    return group ?? 'Other'
}

/** A collection's groups, each with how much of it this account has heard. */
function Groups({
    collection,
    onOpen,
}: {
    collection: CollectionSummary
    onOpen: (group: string | null) => void
}) {
    return (
        <div className="p-4">
            <p className="mb-3 text-xs text-muted-foreground">
                {collection.items} items, {collection.finished} finished
            </p>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {collection.groups.map((group: GroupSummary) => (
                    <li key={group.name ?? ''}>
                        <button
                            type="button"
                            onClick={() => onOpen(group.name)}
                            className="row-hover w-full rounded-lg border p-3 text-left"
                        >
                            <p className="truncate text-sm font-medium" title={groupLabel(group.name)}>
                                {groupLabel(group.name)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {group.items} · {duration(group.duration_s)}
                                {group.finished ? ` · ${String(group.finished)} finished` : ''}
                            </p>
                            {group.finished > 0 && <Meter ratio={group.finished / group.items} />}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    )
}

/**
 * One group's items, a row each. A row plays from itself, as a chapter row does: a summary is
 * fifteen minutes, and a page to open before pressing Play would be a click for nothing.
 */
function Items({
    collection,
    group,
    onBack,
}: {
    collection: string
    group: string | null
    onBack: () => void
}) {
    const [items, setItems] = useState<BookSummary[] | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [query, setQuery] = useState('')
    const [starting, setStarting] = useState<string | null>(null)
    const playingId = useStoreValue(playerStore, selectBookId)

    useEffect(() => {
        let live = true
        booksApi
            .items(collection, group)
            .then((found) => {
                if (live) setItems(found)
            })
            .catch((error: Error) => {
                if (live) setRefusal(error.message)
            })
        return () => {
            live = false
        }
    }, [collection, group, attempt])

    // The row lights at once; its detail (files, chapters) is one more request before it can play.
    const start = (item: BookSummary): void => {
        setStarting(item.id)
        booksApi
            .detail(item.id)
            .then((detail) => {
                playBook(detail)
            })
            .catch((error: Error) => {
                setRefusal(error.message)
            })
            .finally(() => {
                setStarting(null)
            })
    }

    if (refusal) {
        return (
            <Notice
                onRetry={() => {
                    setRefusal(null)
                    setAttempt((count) => count + 1)
                }}
            >
                {refusal}
            </Notice>
        )
    }
    if (!items) {
        return (
            <div className="p-4">
                <Skeleton rows={15} />
            </div>
        )
    }

    const needle = query.trim().toLocaleLowerCase()
    const shown = needle
        ? items.filter((item) => `${item.title} ${item.author}`.toLocaleLowerCase().includes(needle))
        : items

    return (
        <div className="flex flex-col gap-2 p-4">
            <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" aria-label="Back to the groups" onClick={onBack}>
                    <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <h1 className="min-w-0 flex-1 truncate text-base">{groupLabel(group)}</h1>
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    aria-label="Filter this group"
                    placeholder="Filter"
                    className="w-40 sm:w-60"
                />
            </div>
            <ol className="rounded-lg border">
                {shown.map((item) => {
                    const current = playingId === item.id
                    return (
                        <li key={item.id}>
                            <button
                                type="button"
                                data-plays
                                onClick={() => {
                                    start(item)
                                }}
                                disabled={starting === item.id}
                                aria-current={current ? 'true' : undefined}
                                className={cn(
                                    'row-hover flex min-h-finger w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left',
                                    current && 'bg-muted',
                                )}
                            >
                                <span className="min-w-0 flex-1">
                                    <span
                                        className={cn('block truncate text-sm', current && 'font-medium')}
                                        title={item.title}
                                    >
                                        {item.title}
                                    </span>
                                    <span
                                        className="block truncate text-xs text-muted-foreground"
                                        title={item.author}
                                    >
                                        {item.author}
                                    </span>
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {item.finished ? (
                                        <Check className="size-4" aria-label="Finished" />
                                    ) : item.position_s > 0 ? (
                                        remaining(item.duration_s, item.position_s)
                                    ) : (
                                        duration(item.duration_s)
                                    )}
                                </span>
                            </button>
                        </li>
                    )
                })}
            </ol>
            {!shown.length && <p className="p-4 text-sm text-muted-foreground">Nothing matches.</p>}
        </div>
    )
}

/** Every book, with how far through each one this account is. */
/** Where the shelf's scroll is remembered; see `lib/scroll-memory`. */
const SHELF_SCROLL = 'books-shelf'

function Shelf() {
    const [books, setBooks] = useState<BookSummary[] | null>(null)
    const [scanning, setScanning] = useState(false)
    const [refusal, setRefusal] = useState<string | null>(null)
    // Bumped by Retry: a shelf that failed once stayed failed until the screen was left.
    const [attempt, setAttempt] = useState(0)
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
                if (live) setRefusal(error instanceof Error ? error.message : 'The server did not answer.')
            }
        }

        void load()
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [attempt])

    // Back from a book is back where the shelf was left: see `useScrollMemory`.
    useScrollMemory(SHELF_SCROLL, books !== null && books.length > 0)

    if (refusal) {
        return (
            <Notice
                onRetry={() => {
                    setRefusal(null)
                    setAttempt((count) => count + 1)
                }}
            >
                {refusal}
            </Notice>
        )
    }
    if (!books || (!books.length && scanning)) {
        return (
            <div className="p-4">
                <Skeleton rows={15} kind="card" />
            </div>
        )
    }
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
    const [attempt, setAttempt] = useState(0)
    const navigate = useNavigate()
    const playingId = useStoreValue(playerStore, selectBookId)
    const chapterIndex = useStoreValue(playerStore, selectChapterIndex)

    useEffect(() => {
        // An answer that comes back after the reader has moved on is not this page's.
        let live = true
        booksApi
            .detail(id)
            .then((found) => {
                if (live) setBook(found)
            })
            .catch((error: Error) => {
                if (live) setRefusal(error.message)
            })
        return () => {
            live = false
        }
    }, [id, attempt])

    // OPENED ON THE BOOK THAT IS PLAYING, THE LIST SHOWS WHERE IT IS. Resumed in chapter 301 of 498,
    // the row was lit far below the fold. Once per book, not on every chapter change, so a list
    // somebody is scrolling is not pulled back.
    const chapters = useRef<HTMLOListElement | null>(null)
    const shownFor = useRef<string | null>(null)
    useEffect(() => {
        if (!book || playingId !== book.id || shownFor.current === book.id) return
        const row = chapters.current?.querySelector('[aria-current="true"]')
        if (!row) return
        shownFor.current = book.id
        row.scrollIntoView({ block: 'center' })
    })

    if (refusal) {
        return (
            <Notice
                onRetry={() => {
                    setRefusal(null)
                    setAttempt((count) => count + 1)
                }}
            >
                {refusal}
            </Notice>
        )
    }
    if (!book) return <Spinner label="Opening the book" />

    // THE BUTTON KNOWS WHEN THIS IS THE BOOK PLAYING, as the album screen's does, and steps
    // aside for the transport. And a book somebody is part way through says Resume before it
    // is touched, because that is what pressing it does -- a half-read book offering Play
    // would be promising the beginning.
    const playingThis = playingId === book.id
    const started = book.position_s > 0 && !book.finished

    return (
        <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 p-4">
            <div className="flex items-start gap-4">
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Back to the shelf"
                    // An item of a collection goes back to its group's list, not to the books.
                    onClick={() =>
                        navigate(
                            book.collection
                                ? `/books?${new URLSearchParams({ c: book.collection, g: book.group ?? '' }).toString()}`
                                : '/books',
                        )
                    }
                >
                    <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <Cover book={book} size={BOOK_COVER} className="size-28 shrink-0 rounded-md sm:size-40" />
                <div className="min-w-0 flex-1">
                    {/* Two lines on a phone rather than one cut short: the title is what the page is for. */}
                    <h1 className="line-clamp-2 text-base md:truncate" title={book.title}>
                        {book.title}
                    </h1>
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
                {/* Starting the book is this button's; once it is the book playing, pausing
                    and resuming are the transport's, and the button goes rather than drawing
                    the same control twice. */}
                {!playingThis && (
                    <Button
                        size="sm"
                        onClick={() => {
                            playBook(book)
                        }}
                        disabled={book.files.length === 0}
                    >
                        <Play className="size-4" aria-hidden /> {started ? 'Resume' : 'Play'}
                    </Button>
                )}
            </div>

            {book.chapter_list.length > 0 && (
                <ol ref={chapters} className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
                    {book.chapter_list.map((chapter, index) => {
                        // A row plays from itself. Seeking a player that was not playing this
                        // book is what the old screen did, and it is why a chapter click could
                        // look like it did nothing at all.
                        const current = playingThis && index === chapterIndex
                        return (
                            <li key={`${chapter.start_s}-${chapter.title}`}>
                                <button
                                    type="button"
                                    data-plays
                                    onClick={() => {
                                        playBook(book, chapter.start_s)
                                    }}
                                    aria-current={current ? 'true' : undefined}
                                    className={cn(
                                        'row-hover flex min-h-finger w-full min-w-0 items-center gap-3 px-3 text-left text-sm',
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

/** A screen's one sentence, and a way to ask again when that sentence is a failure. */
function Notice({ children, onRetry }: { children: React.ReactNode; onRetry?: () => void }) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
            <p className="text-sm text-muted-foreground">{children}</p>
            {onRetry && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                    Retry
                </Button>
            )}
        </div>
    )
}
