import { AudioLines, Pause, Play, SkipBack, SkipForward, Star, X } from 'lucide-react'
import { useRef } from 'react'

import { Button } from '@/components/ui/button'
import { useOverlay } from '@/hooks/use-overlay'
import { useSpectrum } from '@/hooks/use-spectrum'
import { useStore } from '@/hooks/use-store'
import { books as booksApi } from '@/lib/api'
import { clock } from '@/lib/format'
import { currentChapter, currentSong, next, playerStore, previous, seek, toggle } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { starMarks, starredNow, toggleStar } from '@/lib/star'
import { coverUrl } from '@/lib/subsonic'
import { cn } from '@/lib/utils'
import {
    closeStage,
    cycleVisualizerStyle,
    nextStyle,
    stageOpen,
    VISUALIZER_STYLE_LABELS,
    visualizerStyle,
    type VisualizerStyle,
} from '@/lib/visualizer'

export const LEAVE_STAGE_LABEL = 'Leave the spectrum'

/**
 * What pressing the style button does, said as the thing it will do.
 *
 * A control that cycles has to name where it is going or it is a button somebody presses to
 * find out. The visible mark is the same either way, so the whole of that sentence is the
 * accessible name rather than a label beside it.
 */
export function nextStyleLabel(style: VisualizerStyle): string {
    return `Draw the spectrum as ${VISUALIZER_STYLE_LABELS[nextStyle(style)].toLowerCase()}`
}

/** How many bars the whole screen gets. Enough to read as a spectrum at any width. */
const STAGE_BANDS = 64

/**
 * The spectrum, over everything.
 *
 * NOTHING HERE READS THE PLAYER UNTIL THE STAGE IS UP. Whether it is standing is one flag, and
 * the component that draws it is where every other subscription lives -- so a closed stage costs
 * one store and not four renders a second of a canvas nobody asked for.
 */
export function FullscreenVisualizer() {
    const open = useStore(stageOpen)
    if (!open) return null
    return <Stage />
}

/**
 * WHAT IS PLAYING, AT THE SIZE OF THE ROOM. The bar's spectrum is a 112px strip that says the
 * sound is coming out; this is the one somebody puts on and looks at, so it carries the cover,
 * the title, the clock and the transport, and nothing else at all.
 *
 * THE TRANSPORT IS HERE BECAUSE THE BAR IS NOT. The stage covers the app, so a screen with the
 * music on it and no way to change track is a screen somebody leaves to press pause and comes
 * back to. Previous, play, next and the star are the four things asked of what is playing while
 * looking at it -- and the star is the only one of them that a keyboard alone could reach.
 *
 * THE DRAWING IS THE SAME LOOP the strip runs, at more bands: which style is painted and how a
 * frame of bytes becomes geometry is decided once, in `hooks/use-spectrum` over `lib/visualizer`,
 * and the stage is a canvas the size of the room.
 *
 * ESCAPE LEAVES, the shell behind it is inert while it stands, and the control that opened it
 * gets the focus back -- all of which is `hooks/use-overlay`, because the words overlay is the
 * same dialog with different words in it.
 *
 * AND THE STYLE IS CHANGED FROM HERE. Which drawing the spectrum is is a thing somebody decides
 * while looking at it, so the choice is where the looking happens as well as on the settings
 * pane -- one button, cycling, naming the drawing it is about to put on.
 *
 * IT READS THE STORE RATHER THAN FACTS OUT OF IT. The clock is the position, four times a
 * second, and the title, the artist, the length and what a station is announcing are most of
 * what the player holds -- so five selectors would be ceremony around the same renders. It is
 * mounted only while the stage stands, which is what makes that affordable.
 */
function Stage() {
    const player = useStore(playerStore)
    const session = useStore(sessionStore)
    const marks = useStore(starMarks)
    const style = useStore(visualizerStyle)
    const stage = useRef<HTMLDivElement | null>(null)
    const song = currentSong()
    const playing = player.playing
    const canvas = useSpectrum(playing, STAGE_BANDS)
    useOverlay(stage, closeStage)

    // A book is on this stage the way it is on the bar: the chapter is what is playing and the
    // book is what it is out of, which is the same pair as a track and its artist.
    const book = player.book
    const chapter = currentChapter()
    const cover = book
        ? book.has_cover
            ? booksApi.coverUrl(book.id, 600)
            : null
        : song && session.music
          ? coverUrl(session.music, song.coverArt, 600)
          : null
    const duration = player.durationS || song?.duration || 0
    const station = player.station
    const starred = starredNow(marks, song)

    return (
        <div
            ref={stage}
            data-stage
            tabIndex={-1}
            className="fixed inset-0 z-50 flex flex-col bg-terminal text-terminal-foreground outline-none"
            role="dialog"
            aria-label="Spectrum"
            aria-modal="true"
        >
            {/* A STAGE IS A DARK ROOM, IN BOTH MODES AND UNDER EVERY PALETTE. The ground is
                the same near-black the door's brand pane stands on (`[data-stage]` in
                index.css takes it one rung deeper), and the spectrum is drawn at full strength
                in the accent: it is the show, and a canvas faded to fit a light page was a show
                with the lights half up. What sits over it is kept legible by a pool of the
                ground behind the words rather than by dimming the drawing. */}
            <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full text-terminal-accent" />
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_55%_at_50%_45%,var(--terminal)_0%,color-mix(in_oklab,var(--terminal)_70%,transparent)_45%,transparent_75%)]"
            />

            <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-8 p-8">
                {cover && (
                    <img
                        src={cover}
                        alt=""
                        className="size-56 rounded-xl object-cover shadow-[0_24px_80px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/10 md:size-80"
                    />
                )}
                <div className="max-w-3xl text-center">
                    <p className="truncate text-3xl font-semibold tracking-tight md:text-5xl">
                        {book ? (chapter?.title ?? book.title) : (song?.title ?? player.station?.name)}
                    </p>
                    <p className="mt-3 truncate text-lg text-terminal-muted md:text-xl">
                        {book
                            ? chapter
                                ? `${book.title} · ${book.author}`
                                : book.author
                            : station
                              ? player.stationTitle || 'Live'
                              : (song?.artist ?? '')}
                    </p>
                    {station === null && duration > 0 && (
                        <div className="mx-auto mt-6 flex w-full max-w-xl items-center gap-3">
                            <span className="shrink-0 font-mono text-sm text-terminal-muted tabular-nums">
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
                                className="stage-range w-full"
                            />
                            <span className="shrink-0 font-mono text-sm text-terminal-muted tabular-nums">
                                {clock(duration)}
                            </span>
                        </div>
                    )}

                    <div className="mt-6 flex items-center justify-center gap-3">
                        <Button
                            variant="ghost"
                            size="icon-lg"
                            aria-label="Previous"
                            onClick={previous}
                            disabled={station !== null}
                            className="stage-button"
                        >
                            <SkipBack className="size-6" aria-hidden />
                        </Button>
                        <button
                            type="button"
                            aria-label={playing ? 'Pause' : 'Play'}
                            onClick={toggle}
                            className="flex size-14 items-center justify-center rounded-full bg-terminal-accent text-terminal shadow-lg transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-terminal-accent/50 focus-visible:outline-none"
                        >
                            {playing ? (
                                <Pause className="size-6" aria-hidden />
                            ) : (
                                <Play className="ml-0.5 size-6" aria-hidden />
                            )}
                        </button>
                        <Button
                            variant="ghost"
                            size="icon-lg"
                            aria-label="Next"
                            onClick={next}
                            disabled={station !== null}
                            className="stage-button"
                        >
                            <SkipForward className="size-6" aria-hidden />
                        </Button>
                        {/* A station has nothing to star: what is playing is whatever it is
                            playing, and the library holds no row for it. */}
                        {song !== null && (
                            <Button
                                variant="ghost"
                                size="icon-lg"
                                aria-label={starred ? 'Unstar this track' : 'Star this track'}
                                aria-pressed={starred}
                                onClick={() => {
                                    toggleStar(session.music, song)
                                }}
                                className={cn('stage-button', starred && 'text-terminal-accent')}
                            >
                                <Star className={cn('size-6', starred && 'fill-current')} aria-hidden />
                            </Button>
                        )}
                    </div>
                </div>
            </div>

            {/* The two things the stage itself can do, in the corner and nowhere else: what a
                stage is for is looking at it, so anything standing over the canvas has to have
                earned the room. */}
            <div className="absolute top-4 right-4 flex items-center gap-1">
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={nextStyleLabel(style)}
                    onClick={() => {
                        cycleVisualizerStyle()
                    }}
                    className="stage-button"
                >
                    <AudioLines className="size-5" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={LEAVE_STAGE_LABEL}
                    onClick={closeStage}
                    className="stage-button"
                >
                    <X className="size-5" aria-hidden />
                </Button>
            </div>
        </div>
    )
}
