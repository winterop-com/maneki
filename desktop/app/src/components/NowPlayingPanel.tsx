import { Maximize2, RadioTower, Star } from 'lucide-react'
import { useRef } from 'react'
import { NavLink } from 'react-router'

import { CoverArt } from '@/components/CoverArt'
import { nextStyleLabel } from '@/components/FullscreenVisualizer'
import { Button } from '@/components/ui/button'
import { useDragSize } from '@/hooks/use-drag-size'
import { useSpectrum } from '@/hooks/use-spectrum'
import { useStore, useStoreValue } from '@/hooks/use-store'
import { currentSong, playerStore } from '@/lib/player'
import { chapterAt } from '@/lib/book-timeline'
import type { Chapter } from '@/lib/types'
import { books as booksApi } from '@/lib/api'
import { sessionStore } from '@/lib/session'
import { starMarks, starredNow, toggleStar } from '@/lib/star'
import { coverUrl, type Song } from '@/lib/subsonic'
import { cn } from '@/lib/utils'
import {
    barRoom,
    clampSpectrumHeight,
    cycleVisualizerStyle,
    openStage,
    setSpectrumHeight,
    SPECTRUM_MAX_HEIGHT,
    SPECTRUM_MIN_HEIGHT,
    spectrumHeight,
    VISUALIZER_STYLE_LABELS,
    visualizerShown,
    visualizerStyle,
} from '@/lib/visualizer'

export const NOW_PLAYING_LABEL = 'Now playing'
export const SPECTRUM_HEADING = 'Spectrum'
export const RESIZE_SPECTRUM_LABEL = 'Resize the spectrum'
export const STAGE_LABEL = 'Put the spectrum over the whole screen'
export const NOTHING_PLAYING = 'Nothing playing.'

/** How far one arrow key moves the pane's edge. A keyboard does what the pointer does. */
const KEYBOARD_STEP = 16

/**
 * How many bars the pane gets.
 *
 * More than the strip and fewer than the stage: the panel is 240px at its narrowest and 720px
 * at its widest, and a band count that suited a 112px strip would be eight fat columns here.
 */
const PANE_BANDS = 48

/** The facts this panel reads off the player. Module scope, so each is one stable function. */
const selectSongId = (state: { queue: { id: string }[]; index: number }) =>
    state.queue[state.index]?.id ?? null
const selectPlaying = (state: { playing: boolean }) => state.playing

/**
 * What is playing, at the size a panel can give it.
 *
 * THE CENTRE OF GRAVITY, RESTORED. The client this replaces put the sleeve, the words about it
 * and a spectrum beside them across the top of the window; this app has a 46px strip along the
 * foot, which says the sound is coming out and nothing else. So the band comes back as a tab in
 * the side panel, beside Up next: the cover at the panel's own width, the title, who it is by
 * and what record it is on, and under it the spectrum as a pane rather than a decoration.
 *
 * THE PANE IS DRAGGED AND THE HEIGHT IS KEPT. What somebody drags it to is a decision about how
 * much of the panel the spectrum is worth beside the cover, so it is pixels in storage -- see
 * `lib/visualizer` -- and the grip is a `separator` answering the arrow keys, because a pane
 * only a pointer can size is a pane some people cannot.
 *
 * THE CANVAS IS THE SAME LOOP the strip and the stage run, at its own band count: which drawing
 * the spectrum is and how a frame of bytes becomes geometry is decided once, in
 * `hooks/use-spectrum` over `lib/visualizer`. Clicking it steps to the next drawing, which is
 * what the old pane did and where somebody deciding is already looking.
 *
 * IT READS ONE FACT AT A TIME OFF THE PLAYER. The store publishes four times a second while a
 * track plays and none of that is this panel's business: which track, whether it is playing, and
 * whether it is starred are the whole of what it is subscribed to.
 */
const selectBookId = (state: { book: { id: string } | null }) => state.book?.id ?? null
const selectChapterIndex = (state: { book: { chapter_list: Chapter[] } | null; positionS: number }) =>
    state.book === null ? -1 : chapterAt(state.book.chapter_list, state.positionS)
const selectStationId = (state: { station: { id: string } | null }) => state.station?.id ?? null
const selectStationTitle = (state: { stationTitle: string }) => state.stationTitle

export function NowPlayingPanel() {
    const songId = useStoreValue(playerStore, selectSongId)
    const bookId = useStoreValue(playerStore, selectBookId)
    const stationId = useStoreValue(playerStore, selectStationId)
    const stationTitle = useStoreValue(playerStore, selectStationTitle)
    const chapterIndex = useStoreValue(playerStore, selectChapterIndex)
    const playing = useStoreValue(playerStore, selectPlaying)
    const marks = useStore(starMarks)
    const session = useStore(sessionStore)
    const shown = useStore(visualizerShown)
    const style = useStore(visualizerStyle)
    const height = useStore(spectrumHeight)
    // ONE SPECTRUM AT A TIME: while the player bar has been pulled open and draws it across the
    // whole width, the pane's copy stands down and the panel is the sleeve and the words.
    const room = useStore(barRoom)
    const pane = useRef<HTMLButtonElement | null>(null)
    const canvas = useSpectrum(shown && playing, PANE_BANDS)
    // Dragging the top edge UP makes the pane taller: it is docked to the foot of the panel
    // and grows into the room above it, which is why the sign is negative.
    const { dragging, beginResize } = useDragSize(
        'y',
        height,
        -1,
        setSpectrumHeight,
        clampSpectrumHeight,
        pane,
    )
    // The id is what is subscribed to and the record is read: a change of track is a change of
    // id, and everything else the words need travels with the track rather than on its own.
    const song = songId === null ? null : currentSong()
    const credentials = session.music

    return (
        <div className="flex h-full min-h-0 flex-col">
            {bookId !== null ? (
                <BookSleeve chapterIndex={chapterIndex} />
            ) : stationId !== null ? (
                <StationSleeve announced={stationTitle} />
            ) : song === null ? (
                <p className="p-4 text-sm text-muted-foreground">{NOTHING_PLAYING}</p>
            ) : (
                <Sleeve
                    song={song}
                    starred={starredNow(marks, song)}
                    onStar={() => {
                        toggleStar(credentials, song)
                    }}
                    cover={credentials ? coverUrl(credentials, song.coverArt, 600) : null}
                />
            )}

            {/* NOTHING WEARS CHROME UNLESS IT DOES SOMETHING. One switch turns the spectrum on
                and off wherever it is drawn, so a reader who has turned it off gets the sleeve
                and the words rather than a heading over an empty box with a grip under it. */}
            {shown && room === 0 && (
                <div className="mt-auto flex shrink-0 flex-col">
                    <div
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label={RESIZE_SPECTRUM_LABEL}
                        aria-valuenow={height}
                        aria-valuemin={SPECTRUM_MIN_HEIGHT}
                        aria-valuemax={SPECTRUM_MAX_HEIGHT}
                        tabIndex={0}
                        data-dragging={dragging}
                        onPointerDown={beginResize}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowUp') setSpectrumHeight(height - KEYBOARD_STEP)
                            else if (event.key === 'ArrowDown') setSpectrumHeight(height + KEYBOARD_STEP)
                            else return
                            event.preventDefault()
                        }}
                        className="resize-handle resize-handle-pane h-2 shrink-0 cursor-row-resize touch-none"
                    />

                    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-border px-3">
                        <span className="text-xs font-semibold tracking-wide text-faint uppercase">
                            {SPECTRUM_HEADING}
                        </span>
                        {/* Which drawing is in front of somebody, and the way to the next one: a
                            word on its own read as a label nobody asked for, so the word is the
                            control, doing what a click on the canvas does. */}
                        <button
                            type="button"
                            aria-label={nextStyleLabel(style)}
                            title={nextStyleLabel(style)}
                            onClick={() => {
                                cycleVisualizerStyle()
                            }}
                            className="control-link ml-auto text-xs text-faint hover:text-foreground"
                        >
                            {VISUALIZER_STYLE_LABELS[style]}
                        </button>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={STAGE_LABEL}
                            onClick={openStage}
                            className="-mr-1 shrink-0 text-muted-foreground"
                        >
                            <Maximize2 className="size-4" aria-hidden />
                        </Button>
                    </div>

                    <button
                        ref={pane}
                        type="button"
                        aria-label={nextStyleLabel(style)}
                        onClick={() => {
                            cycleVisualizerStyle()
                        }}
                        style={{ height }}
                        className="block w-full shrink-0 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                        {/* How faint it is belongs to the element rather than to the colour: a
                            chosen ramp is spelled opaque, and every theme is to read alike. */}
                        <canvas ref={canvas} aria-hidden className="size-full text-primary" />
                    </button>
                </div>
            )}
        </div>
    )
}

/**
 * The sleeve and what is written on it.
 *
 * THE COVER TAKES THE PANEL'S WIDTH, which is the whole reason this is a panel and not a row:
 * the transport's is 36px, and what a record looks like is a thing people put on a screen to
 * look at. A record with no sleeve gets the mark its shelf card wears rather than a grey square.
 *
 * THE YEAR AND THE FILE ARE THERE WHERE THE TRACK CARRIES THEM, and absent where it does not --
 * a row of dashes is a panel saying nothing in four places.
 */
function Sleeve({
    song,
    starred,
    cover,
    onStar,
}: {
    song: Song
    starred: boolean
    cover: string | null
    onStar: () => void
}) {
    const facts = [song.year === undefined ? '' : String(song.year), (song.suffix ?? '').toUpperCase()]
        .filter((fact) => fact !== '')
        .join(' · ')

    return (
        <div className="flex flex-col gap-3 p-3">
            {cover === null ? (
                <CoverArt id={song.albumId ?? song.id} className="w-full rounded-lg" />
            ) : (
                <img src={cover} alt="" className="aspect-square w-full rounded-lg object-cover" />
            )}

            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium" title={song.title}>
                        {song.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                        {song.artistId === undefined ? (
                            (song.artist ?? '')
                        ) : (
                            <NavLink to={`/music/artist/${song.artistId}`} className="control-link">
                                {song.artist}
                            </NavLink>
                        )}
                        {song.album !== undefined && (
                            <>
                                {' · '}
                                {song.albumId === undefined ? (
                                    song.album
                                ) : (
                                    <NavLink to={`/music/album/${song.albumId}`} className="control-link">
                                        {song.album}
                                    </NavLink>
                                )}
                            </>
                        )}
                    </p>
                    {facts !== '' && <p className="mt-1 font-mono text-xs text-faint">{facts}</p>}
                </div>

                {/* The star is a pointer's way to what `*` does. It is filled when it is on,
                    because a mark that only changed colour is a mark nobody reads at a glance. */}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={starred ? 'Unstar this track' : 'Star this track'}
                    aria-pressed={starred}
                    onClick={onStar}
                    className={cn('shrink-0', starred && 'text-primary')}
                >
                    <Star className={cn('size-4', starred && 'fill-current')} aria-hidden />
                </Button>
            </div>
        </div>
    )
}

/**
 * A station on the panel: the mast, the station's name, and what it says it is playing.
 *
 * A STATION HAS NO SLEEVE. It is not in the library, so there is no cover to ask for and no id
 * to draw a mark from -- the square the cover would take carries the sign of the thing itself
 * instead, at the size and the rounding a book's cover has, so the panel does not change shape
 * between the two.
 *
 * WHAT IT ANNOUNCES IS THE SECOND LINE, where it has announced anything: the title is read off
 * the stream and arrives a little after the sound does, and until it comes the only other true
 * thing about a station is that it is live. Subscribed to by itself, because it is the one fact
 * here that changes while the station plays.
 */
function StationSleeve({ announced }: { announced: string }) {
    const station = playerStore.get().station
    if (station === null) return null
    const beneath = announced || 'Live'
    return (
        <div className="p-3">
            <div className="flex aspect-square w-full items-center justify-center rounded-md bg-muted">
                <RadioTower className="size-16 text-muted-foreground" aria-hidden />
            </div>
            <p className="mt-3 truncate text-sm font-medium" title={station.name}>
                {station.name}
            </p>
            <p className="truncate text-xs text-muted-foreground" title={beneath}>
                {beneath}
            </p>
        </div>
    )
}

/**
 * A book on the panel: its cover, the chapter being read, and whose book it is.
 *
 * A book is not starred and carries no album, so the sleeve is its own rather than the song's
 * with holes in it. The chapter index is what is subscribed to, so the words change when the
 * chapter turns and not four times a second.
 */
function BookSleeve({ chapterIndex }: { chapterIndex: number }) {
    const book = playerStore.get().book
    if (book === null) return null
    const chapter = chapterIndex >= 0 ? book.chapter_list[chapterIndex] : undefined
    return (
        <div className="p-3">
            {book.has_cover ? (
                <img
                    src={booksApi.coverUrl(book.id, 600)}
                    alt=""
                    className="aspect-square w-full rounded-md object-cover"
                />
            ) : (
                <CoverArt id={book.id} className="aspect-square w-full rounded-md" />
            )}
            <p className="mt-3 truncate text-sm font-medium" title={chapter?.title ?? book.title}>
                {chapter?.title ?? book.title}
            </p>
            <p className="truncate text-xs text-muted-foreground" title={`${book.title} · ${book.author}`}>
                {chapter ? `${book.title} · ${book.author}` : book.author}
            </p>
        </div>
    )
}
