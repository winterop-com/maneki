import {
    ListMusic,
    Pause,
    Play,
    Repeat,
    Repeat1,
    RotateCcw,
    RotateCw,
    Shuffle,
    SkipBack,
    SkipForward,
    Volume1,
    Volume2,
    VolumeX,
} from 'lucide-react'
import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router'

import { CoverArt } from '@/components/CoverArt'
import { LcdDisplay } from '@/components/LcdDisplay'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDragSize } from '@/hooks/use-drag-size'
import { useSpectrum } from '@/hooks/use-spectrum'
import { useStore } from '@/hooks/use-store'
import { books as booksApi } from '@/lib/api'
import { clock } from '@/lib/format'
import { nowPlayingFace } from '@/lib/lcd'
import {
    currentChapter,
    currentSong,
    cycleRepeat,
    next,
    playerStore,
    positionNow,
    previous,
    seek,
    setSpeed,
    setVolume,
    skipBy,
    SKIP_S,
    SPEEDS,
    toggle,
    toggleMuted,
    toggleShuffle,
} from '@/lib/player'
import { REPEAT_LABELS } from '@/lib/queue'
import { closePanel, openPanelTab, panelOpen, panelTab, panelTabs } from '@/lib/panels'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'
import {
    BAR_ROOM_MAX,
    BAR_ROOM_MIN,
    barRoom,
    clampBarRoom,
    openStage,
    setBarRoom,
    visualizerShown,
} from '@/lib/visualizer'
import { cn } from '@/lib/utils'

export const QUEUE_LABEL = 'Up next'
export const RESIZE_BAR_LABEL = 'Resize the player bar'

/** How far one arrow key moves the bar's edge. */
const KEYBOARD_STEP = 16

/** How many bars the width of the window gets. */
const WIDE_BANDS = 64

/** The controls' row, in pixels: `--spacing-shell-foot`, which the sleeve is sized against. */
const FOOT = 46
export const STAGE_LABEL = 'Put the spectrum over the whole screen'

/**
 * What is playing, along the foot of every screen.
 *
 * Drawn only once something has been played: an empty transport under every screen is a row of
 * dead controls.
 *
 * THE PROGRESS LINE IS ALWAYS THERE, THE SCRUBBER IS NOT. A 390px screen has no room for a
 * slider between the title and the transport, but "how far through this is" is the one fact a
 * transport must always show, so it is drawn as a hairline across the top edge of the bar at
 * every width, and the slider with its two clocks appears where there is room to drag it.
 *
 * A STATION HAS NO POSITION. It has no length, nothing to skip to and nothing to scrub, so the
 * skip buttons are disabled and the line and the clocks are not drawn at all rather than drawn
 * as zeroes.
 *
 * AND A BOOK IS DRAWN ON THIS BAR AND NO OTHER. It used to have a transport of its own on its
 * own screen, which is how somebody ended up with two now-playings and a chapter list that
 * seeked whichever of them was silent. What a book needs that a record does not -- the two
 * fifteen-second jumps, a reading speed -- joins the same row, and what it has no use for --
 * shuffle, repeat -- leaves it: a book is one thing read in one order.
 */
export function PlayerBar() {
    const player = useStore(playerStore)
    const spectrumShown = useStore(visualizerShown)
    const session = useStore(sessionStore)
    const tabs = useStore(panelTabs)
    const open = useStore(panelOpen)
    const tab = useStore(panelTab)
    // THE BAR IS DRAGGED TALLER AND THE ROOM IS THE SPECTRUM. The grip is the bar's top edge;
    // pulling it up gives the room above the controls more height, and the spectrum is drawn
    // across the whole of it, always along the foot: never elsewhere, never a second copy.
    const room = useStore(barRoom)
    // THE DRAG WRITES A HEIGHT ONTO THE ELEMENT IT IS GIVEN, so it is given the room and not
    // the bar: handed the bar, it forced the whole of it to the room's height mid-drag and the
    // controls spilled out under the status bar.
    const bar = useRef<HTMLDivElement | null>(null)
    const { dragging, beginResize } = useDragSize('y', room, -1, setBarRoom, clampBarRoom, bar)
    const wide = useSpectrum(spectrumShown && player.playing, WIDE_BANDS)
    // THE SCRUBBER MOVES EVERY FRAME, NOT FOUR TIMES A SECOND. The store publishes the position
    // on the element's own timeupdate, which is a quarter-second step; a thumb that jumps a
    // quarter second at a time reads as a stutter. So the input is uncontrolled and a frame
    // loop writes the element's clock into it while a track plays, standing off while it is
    // being dragged so the hand is not fought.
    const scrubber = useRef<HTMLInputElement | null>(null)
    const scrubbing = useRef(false)
    const playing = player.playing
    useEffect(() => {
        if (!playing) return
        let request = 0
        const tick = () => {
            request = requestAnimationFrame(tick)
            const input = scrubber.current
            if (input === null || scrubbing.current) return
            input.value = String(positionNow())
        }
        request = requestAnimationFrame(tick)
        return () => {
            cancelAnimationFrame(request)
        }
    }, [playing])
    // A seek or a paused store still lands on the input: what is written between frames.
    useEffect(() => {
        const input = scrubber.current
        if (input !== null && !scrubbing.current) input.value = String(player.positionS)
    }, [player.positionS])
    // THE BUTTON SAYS UP NEXT, SO IT SHOWS UP NEXT. The panel has other tabs, and a button that
    // merely toggled the panel could open it on one of those; this one lands on the queue, and
    // only when the queue is already the thing showing does pressing it again take the panel down.
    const onQueue = open && tab === 'queue'
    const face = useStore(nowPlayingFace)
    const song = currentSong()
    const station = player.station
    const book = player.book
    const chapter = currentChapter()
    if (!song && !station && !book) return null
    // A track's cover and its stream are the music server's, so there is nothing to draw
    // without one. A book is maneki's own, and a server with books and no music still has a
    // transport.
    if (!book && !session.music) return null

    // The sleeve is drawn at up to a few hundred pixels, so it is asked for at that size.
    const sleeve = book
        ? book.has_cover
            ? booksApi.coverUrl(book.id, 600)
            : null
        : song && session.music
          ? coverUrl(session.music, song.coverArt, 600)
          : null
    const duration = player.durationS || song?.duration || 0
    const through = duration > 0 ? Math.min(1, player.positionS / duration) : 0
    const queued = tabs.length > 0
    // The chapter is what is playing and the book is what it is out of, which is the same
    // shape as a track and its artist. A book with no chapter marks is its own title.
    const title = book ? (chapter?.title ?? book.title) : (song?.title ?? station?.name)
    const beneath = book
        ? chapter
            ? `${book.title} · ${book.author}`
            : book.author
        : station
          ? player.stationTitle || 'Live'
          : song?.artist

    return (
        <div
            data-shell-strip="player"
            className="relative flex shrink-0 flex-col border-t border-border-strong bg-sidebar"
        >
            <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={RESIZE_BAR_LABEL}
                aria-valuenow={room}
                aria-valuemin={BAR_ROOM_MIN}
                aria-valuemax={BAR_ROOM_MAX}
                tabIndex={0}
                data-dragging={dragging}
                onPointerDown={beginResize}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') setBarRoom(room + KEYBOARD_STEP)
                    else if (event.key === 'ArrowDown') setBarRoom(room - KEYBOARD_STEP)
                    else return
                    event.preventDefault()
                }}
                className="resize-handle resize-handle-pane absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none"
            />
            {/* THE DOCK: one sleeve on the left the whole height of the bar, and beside it the
                spectrum over the controls, as the client before this one drew it. The sleeve
                grows with the room, because it is the room's height plus the controls'. */}
            <div className="flex min-w-0">
                <div
                    style={{ width: room + FOOT, height: room + FOOT }}
                    className="shrink-0 overflow-hidden bg-muted"
                >
                    {sleeve ? (
                        <img src={sleeve} alt="" className="size-full object-cover" />
                    ) : (
                        <CoverArt
                            id={book?.id ?? song?.albumId ?? song?.id ?? station?.id ?? ''}
                            className="size-full"
                        />
                    )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                    {spectrumShown ? (
                        <button
                            type="button"
                            aria-label={STAGE_LABEL}
                            onClick={openStage}
                            style={{ height: room }}
                            className="block w-full shrink-0 px-3 pt-2 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                            <canvas ref={wide} aria-hidden className="size-full text-primary" />
                        </button>
                    ) : (
                        <div style={{ height: room }} className="shrink-0" />
                    )}
                    <div className="relative flex h-shell-foot items-center gap-3 px-3">
                        {/* The hairline stands in for the scrubber where the scrubber does not fit, and
                nowhere else: both at once is the same fact drawn twice. */}
                        {!station && (
                            <div
                                aria-hidden
                                className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary transition-[width] duration-200 md:hidden"
                                style={{ width: `${String(through * 100)}%` }}
                            />
                        )}

                        {/* THE DECK FACE REPLACES THE TITLE BLOCK AND THE SCRUBBER, AND NOTHING ELSE. It says
                what both of them said -- what is playing, and how far through -- so drawing the
                two together would be the same facts twice at two sizes. The transport stays
                where it is: what the buttons do does not change with the face.

                AND IT IS A MUSIC FACE. Its window is a track, an artist and a track number read
                the way a hi-fi reads them, and a chapter of a novel is none of those -- so a
                book is drawn in the app's own voice whichever face was chosen. */}
                        {face === 'lcd' && !book ? (
                            <LcdDisplay
                                song={song}
                                station={station}
                                stationTitle={player.stationTitle}
                                positionS={player.positionS}
                                durationS={duration}
                                playing={player.playing}
                                muted={player.muted}
                                volume={player.volume}
                            />
                        ) : (
                            <div className="min-w-0 flex-1 md:max-w-64">
                                <p className="truncate text-sm" title={title}>
                                    {book ? (
                                        <NavLink to={`/books/${book.id}`} className="control-link">
                                            {title}
                                        </NavLink>
                                    ) : song ? (
                                        song.albumId ? (
                                            <NavLink
                                                to={`/music/album/${song.albumId}`}
                                                className="control-link"
                                            >
                                                {song.title}
                                            </NavLink>
                                        ) : (
                                            song.title
                                        )
                                    ) : (
                                        station?.name
                                    )}
                                </p>
                                {/* A station that has announced what it is playing says that; one that has
                        not says it is live, which is the only other true thing about it.

                        AND A SOURCE THAT DIED TAKES THAT LINE. Why it went quiet is the only
                        thing anybody wants off this bar at that moment, it is one line either
                        way so the strip does not move, and it is where the eye already is. */}
                                <p
                                    className={cn(
                                        'truncate text-xs',
                                        player.refusal === null
                                            ? 'text-muted-foreground'
                                            : 'text-critical-ink',
                                    )}
                                    title={player.refusal ?? beneath}
                                >
                                    {player.refusal ?? beneath}
                                </p>
                            </div>
                        )}

                        <div className="flex items-center gap-1">
                            {/* Shuffle and repeat sit beside the transport they change, and are drawn as
                    pressed rather than as a different glyph: what they do is a state the
                    queue is in, not an action. A station has no queue to be in one, and a book
                    is one thing read in one order -- neither is offered the controls, and a
                    book is not offered them disabled either, because they are not a thing a
                    book can be missing. */}
                            {!book && (
                                <>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label="Shuffle the queue"
                                        aria-pressed={player.shuffle}
                                        onClick={toggleShuffle}
                                        disabled={station !== null}
                                        className={cn(
                                            'hidden sm:inline-flex',
                                            player.shuffle && 'text-primary',
                                        )}
                                    >
                                        <Shuffle className="size-4" aria-hidden />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={REPEAT_LABELS[player.repeat]}
                                        aria-pressed={player.repeat !== 'off'}
                                        onClick={cycleRepeat}
                                        disabled={station !== null}
                                        className={cn(
                                            'hidden sm:inline-flex',
                                            player.repeat !== 'off' && 'text-primary',
                                        )}
                                    >
                                        {player.repeat === 'one' ? (
                                            <Repeat1 className="size-4" aria-hidden />
                                        ) : (
                                            <Repeat className="size-4" aria-hidden />
                                        )}
                                    </Button>
                                </>
                            )}
                            {/* THE TWO JUMPS ARE A BOOK'S, and they stand outside the chapter steps rather
                    than replacing them: fifteen seconds is for the sentence somebody missed,
                    a chapter is for the part of the book they are in. A record has no use for
                    either, so it is not given a control that would only mean "scrub a bit". */}
                            {book && (
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Back ${String(SKIP_S)} seconds`}
                                    onClick={() => {
                                        skipBy(-SKIP_S)
                                    }}
                                >
                                    <RotateCcw className="size-4" aria-hidden />
                                </Button>
                            )}
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={book ? 'Previous chapter' : 'Previous'}
                                onClick={previous}
                                disabled={station !== null}
                            >
                                <SkipBack className="size-4" aria-hidden />
                            </Button>
                            <Button
                                size="icon-sm"
                                aria-label={player.playing ? 'Pause' : 'Play'}
                                onClick={toggle}
                            >
                                {player.playing ? (
                                    <Pause className="size-4" aria-hidden />
                                ) : (
                                    <Play className="size-4" aria-hidden />
                                )}
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={book ? 'Next chapter' : 'Next'}
                                onClick={next}
                                disabled={station !== null}
                            >
                                <SkipForward className="size-4" aria-hidden />
                            </Button>
                            {book && (
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={`Forward ${String(SKIP_S)} seconds`}
                                    onClick={() => {
                                        skipBy(SKIP_S)
                                    }}
                                >
                                    <RotateCw className="size-4" aria-hidden />
                                </Button>
                            )}
                        </div>

                        {/* Not hidden with a class: two controls with one accessible name is two of them in
                the document, and a slider nobody can see is still a slider somebody lands on.
                A book is drawn in the standard face whatever was chosen, so it keeps the
                slider the face would have replaced. */}
                        {(face === 'standard' || book !== null) && (
                            <div
                                className={cn(
                                    'hidden min-w-0 flex-1 items-center gap-2 md:flex',
                                    station && 'invisible',
                                )}
                            >
                                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                    {clock(player.positionS)}
                                </span>
                                <input
                                    ref={scrubber}
                                    type="range"
                                    aria-label="Position"
                                    min={0}
                                    max={Math.max(1, duration)}
                                    step="any"
                                    defaultValue={player.positionS}
                                    onPointerDown={() => {
                                        scrubbing.current = true
                                    }}
                                    onPointerUp={() => {
                                        scrubbing.current = false
                                    }}
                                    onChange={(event) => {
                                        seek(Number(event.target.value))
                                    }}
                                    className="w-full accent-primary"
                                />
                                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                    {clock(duration)}
                                </span>
                            </div>
                        )}

                        {/* HOW FAST IT IS READ IS A BOOK'S ALONE. Music at 1.25x is a novelty; a narrator
                at 1.25x is how a lot of people listen to every book they own, so the choice is
                on the transport rather than behind a settings pane -- and it is offered only
                where it means something. Below the breakpoint the bar has no room for it and
                the palette carries the same speeds. */}
                        {book && (
                            <select
                                aria-label="Reading speed"
                                value={book.speed}
                                onChange={(event) => {
                                    setSpeed(Number(event.target.value))
                                }}
                                className="hidden h-8 shrink-0 rounded-md border bg-field px-2 text-xs md:block"
                            >
                                {SPEEDS.map((speed) => (
                                    <option key={speed} value={speed}>
                                        {speed}x
                                    </option>
                                ))}
                            </select>
                        )}

                        {/* The strip is the way to the stage with a pointer, as the F key is without one. It is
                drawn only while the spectrum is: `Visualizer` answers nothing when it is off, and a
                button around nothing is an empty stop in the tab order with a name and no face. */}

                        <div className="hidden shrink-0 items-center gap-1 md:flex">
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={player.muted ? 'Unmute' : 'Mute'}
                                aria-pressed={player.muted}
                                onClick={toggleMuted}
                            >
                                <VolumeGlyph muted={player.muted} volume={player.volume} />
                            </Button>
                            <input
                                type="range"
                                aria-label="Volume"
                                min={0}
                                max={100}
                                value={Math.round((player.muted ? 0 : player.volume) * 100)}
                                onChange={(event) => {
                                    setVolume(Number(event.target.value) / 100)
                                }}
                                className="w-20 accent-primary"
                            />
                        </div>

                        {queued && (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={QUEUE_LABEL}
                                            aria-pressed={onQueue}
                                            className="hidden shrink-0 md:inline-flex"
                                            onClick={() => {
                                                if (onQueue) closePanel()
                                                else openPanelTab('queue')
                                            }}
                                        >
                                            <ListMusic className="size-4" aria-hidden />
                                        </Button>
                                    }
                                />
                                <TooltipContent side="top">{QUEUE_LABEL}</TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

/** Loud, quiet or silent: the glyph says which without anybody reading a number. */
function VolumeGlyph({ muted, volume }: { muted: boolean; volume: number }) {
    if (muted || volume === 0) return <VolumeX className="size-4" aria-hidden />
    if (volume < 0.5) return <Volume1 className="size-4" aria-hidden />
    return <Volume2 className="size-4" aria-hidden />
}
