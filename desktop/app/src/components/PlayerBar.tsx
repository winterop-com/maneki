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
import { NavLink } from 'react-router'

import { CoverArt } from '@/components/CoverArt'
import { LcdDisplay } from '@/components/LcdDisplay'
import { Visualizer } from '@/components/Visualizer'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { panelOpen, panelTabs, togglePanel } from '@/lib/panels'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'
import { openStage, visualizerShown } from '@/lib/visualizer'
import { cn } from '@/lib/utils'

export const QUEUE_LABEL = 'Up next'
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

    const cover = book
        ? book.has_cover
            ? booksApi.coverUrl(book.id, 96)
            : null
        : song && session.music
          ? coverUrl(session.music, song.coverArt, 96)
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
            className="relative flex h-shell-foot shrink-0 items-center gap-3 border-t border-border-strong bg-sidebar px-3"
        >
            {/* The hairline stands in for the scrubber where the scrubber does not fit, and
                nowhere else: both at once is the same fact drawn twice. */}
            {!station && (
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary transition-[width] duration-200 md:hidden"
                    style={{ width: `${String(through * 100)}%` }}
                />
            )}

            {cover ? (
                <img src={cover} alt="" className="size-9 shrink-0 rounded-sm object-cover" />
            ) : (
                // The album's id rather than the track's, so every track off one record wears
                // the same mark here that the record wears on the shelf. A book's own id, for
                // the same reason: the mark on the bar is the mark on the shelf.
                <CoverArt
                    id={book?.id ?? song?.albumId ?? song?.id ?? station?.id ?? ''}
                    className="size-9 shrink-0 rounded-sm"
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
                                <NavLink to={`/music/album/${song.albumId}`} className="control-link">
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
                            player.refusal === null ? 'text-muted-foreground' : 'text-critical-ink',
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
                            className={cn('hidden sm:inline-flex', player.shuffle && 'text-primary')}
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
                            className={cn('hidden sm:inline-flex', player.repeat !== 'off' && 'text-primary')}
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
                <Button size="icon-sm" aria-label={player.playing ? 'Pause' : 'Play'} onClick={toggle}>
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
                    className={cn('hidden min-w-0 flex-1 items-center gap-2 md:flex', station && 'invisible')}
                >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                        {clock(player.positionS)}
                    </span>
                    <input
                        type="range"
                        aria-label="Position"
                        min={0}
                        max={Math.max(1, Math.floor(duration))}
                        value={Math.floor(player.positionS)}
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
            {spectrumShown && (
                <button
                    type="button"
                    aria-label={STAGE_LABEL}
                    onClick={openStage}
                    className="hidden shrink-0 rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none lg:block"
                >
                    {/* The quiet is the element's opacity rather than an alpha on the token: a
                    chosen spectrum ramp is spelled opaque, and every theme is to read as faint
                    on the bar alike. */}
                    <Visualizer className="h-7 w-28 text-primary opacity-70" />
                </button>
            )}

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
                                aria-pressed={open}
                                className="hidden shrink-0 md:inline-flex"
                                onClick={togglePanel}
                            >
                                <ListMusic className="size-4" aria-hidden />
                            </Button>
                        }
                    />
                    <TooltipContent side="top">{QUEUE_LABEL}</TooltipContent>
                </Tooltip>
            )}
        </div>
    )
}

/** Loud, quiet or silent: the glyph says which without anybody reading a number. */
function VolumeGlyph({ muted, volume }: { muted: boolean; volume: number }) {
    if (muted || volume === 0) return <VolumeX className="size-4" aria-hidden />
    if (volume < 0.5) return <Volume1 className="size-4" aria-hidden />
    return <Volume2 className="size-4" aria-hidden />
}
