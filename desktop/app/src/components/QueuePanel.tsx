import { Play, Volume2 } from 'lucide-react'

import { useStore, useStoreValue } from '@/hooks/use-store'
import { chapterAt } from '@/lib/book-timeline'
import { clock } from '@/lib/format'
import { play, playChapter, playerStore, type PlayerState, type PlayingBook } from '@/lib/player'
import { cn } from '@/lib/utils'

/** The facts the chapter list reads off the player. Module scope, so each is one stable function. */
const selectBook = (state: PlayerState) => state.book
const selectPlaying = (state: PlayerState) => state.playing
const selectChapterIndex = (state: PlayerState) =>
    state.book === null ? -1 : chapterAt(state.book.chapter_list, state.positionS)

/**
 * What is queued, and what is playing out of it.
 *
 * The panel is the shell's rather than a screen's, because the queue outlives every screen: it
 * was filled on an album and it is still there while somebody reads a book's chapters.
 *
 * A row plays from itself, which is what picking a track in a queue means: the queue is kept
 * and the position moves, exactly as picking a track in an album does.
 *
 * A BOOK'S UP NEXT IS ITS CHAPTERS. There is no queue behind a book -- nothing follows it, and
 * nothing is played in an order somebody chose -- so what this panel is for while one plays is
 * the same thing it is for while a record plays: the list of places the next press can land.
 */
export function QueuePanel() {
    const book = useStoreValue(playerStore, selectBook)
    if (book) return <Chapters book={book} />
    return <Tracks />
}

/**
 * The chapters of the book playing, marked where it is.
 *
 * Read through selectors rather than as the whole player: the position publishes four times a
 * second, and three hundred rows rebuilt at that rate is a panel that will not scroll. What
 * the rows actually depend on is which chapter it is in, which is a number that changes once
 * every twenty minutes.
 */
function Chapters({ book }: { book: PlayingBook }) {
    const at = useStoreValue(playerStore, selectChapterIndex)
    const playing = useStoreValue(playerStore, selectPlaying)
    if (book.chapter_list.length === 0) {
        return <p className="p-4 text-sm text-muted-foreground">No chapters.</p>
    }

    return (
        <ol className="p-2">
            {book.chapter_list.map((chapter, index) => {
                const current = index === at
                return (
                    <li key={`${String(chapter.start_s)}-${chapter.title}`}>
                        <button
                            type="button"
                            onClick={() => {
                                playChapter(chapter.start_s)
                            }}
                            aria-current={current ? 'true' : undefined}
                            className={cn(
                                'row-hover flex min-h-finger w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                                current && 'bg-muted font-medium',
                            )}
                        >
                            <span className="flex size-5 shrink-0 items-center justify-center text-xs text-muted-foreground tabular-nums">
                                {current ? (
                                    playing ? (
                                        <Volume2 className="size-3.5 text-primary" aria-hidden />
                                    ) : (
                                        <Play className="size-3.5 text-primary" aria-hidden />
                                    )
                                ) : (
                                    index + 1
                                )}
                            </span>
                            <span className="min-w-0 flex-1 truncate" title={chapter.title}>
                                {chapter.title}
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                {clock(chapter.start_s)}
                            </span>
                        </button>
                    </li>
                )
            })}
        </ol>
    )
}

function Tracks() {
    const player = useStore(playerStore)
    if (player.queue.length === 0) {
        return <p className="p-4 text-sm text-muted-foreground">Nothing queued.</p>
    }

    // UP NEXT MEANS WHAT COMES NEXT. Shuffled, that is the play order rather than the album's,
    // and the numbers down the side stay the track's own place on the record, which is what
    // somebody reading the list is matching against the sleeve.
    const rows = player.shuffle
        ? player.order.map((index) => ({ index, song: player.queue[index] }))
        : player.queue.map((song, index) => ({ index, song }))
    const playingAt = player.shuffle ? player.orderAt : player.index

    return (
        <ol className="p-2">
            {rows.map(({ index, song }, position) => {
                if (!song) return null
                const current = position === playingAt
                return (
                    <li key={`${song.id}-${String(index)}`}>
                        <button
                            type="button"
                            onClick={() => {
                                play(player.queue, index)
                            }}
                            aria-current={current ? 'true' : undefined}
                            className={cn(
                                'row-hover flex min-h-finger w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                                current && 'bg-muted font-medium',
                            )}
                        >
                            <span className="flex size-5 shrink-0 items-center justify-center text-xs text-muted-foreground tabular-nums">
                                {current ? (
                                    player.playing ? (
                                        <Volume2 className="size-3.5 text-primary" aria-hidden />
                                    ) : (
                                        <Play className="size-3.5 text-primary" aria-hidden />
                                    )
                                ) : (
                                    index + 1
                                )}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate">{song.title}</span>
                                {song.artist !== undefined && (
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {song.artist}
                                    </span>
                                )}
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                {clock(song.duration ?? 0)}
                            </span>
                        </button>
                    </li>
                )
            })}
        </ol>
    )
}
