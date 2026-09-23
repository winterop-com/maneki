import { AudioLines, X } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { useSpectrum } from '@/hooks/use-spectrum'
import { useStore } from '@/hooks/use-store'
import { books as booksApi } from '@/lib/api'
import { clock } from '@/lib/format'
import { currentChapter, currentSong, playerStore } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'
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
 * WHAT IS PLAYING, AT THE SIZE OF THE ROOM. The bar's spectrum is a 112px strip that says the
 * sound is coming out; this is the one somebody puts on and looks at, so it carries the cover,
 * the title and the clock as well, and nothing else at all.
 *
 * THE DRAWING IS THE SAME LOOP the strip runs, at more bands: which style is painted and how a
 * frame of bytes becomes geometry is decided once, in `hooks/use-spectrum` over `lib/visualizer`,
 * and the stage is a canvas the size of the room.
 *
 * ESCAPE LEAVES, and so does the control in the corner, because a screen with no way out that
 * is obvious is a screen somebody reloads the tab to get out of.
 *
 * AND THE STYLE IS CHANGED FROM HERE. Which drawing the spectrum is is a thing somebody decides
 * while looking at it, so the choice is where the looking happens as well as on the settings
 * pane -- one button, cycling, naming the drawing it is about to put on.
 */
export function FullscreenVisualizer() {
    const open = useStore(stageOpen)
    const player = useStore(playerStore)
    const session = useStore(sessionStore)
    const song = currentSong()
    const playing = player.playing
    const style = useStore(visualizerStyle)
    const canvas = useSpectrum(open && playing, STAGE_BANDS)

    useEffect(() => {
        if (!open) return
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeStage()
        }
        document.addEventListener('keydown', escape)
        return () => {
            document.removeEventListener('keydown', escape)
        }
    }, [open])

    if (!open) return null

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

    return (
        <div
            data-stage
            className="fixed inset-0 z-50 flex flex-col bg-background"
            role="dialog"
            aria-label="Spectrum"
            aria-modal="true"
        >
            {/* HOW FAINT IT IS BELONGS TO THE ELEMENT, NOT TO THE COLOUR. The canvas stands
                behind the cover and the title, and a ramp somebody chose is spelled opaque --
                so the quiet is `opacity`, which every theme wears alike, rather than an alpha
                on a token only the accent would carry. */}
            <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full text-primary opacity-40" />

            <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-8">
                {cover && (
                    <img
                        src={cover}
                        alt=""
                        className="size-48 rounded-lg object-cover shadow-2xl md:size-72"
                    />
                )}
                <div className="max-w-2xl text-center">
                    <p className="truncate text-2xl font-semibold md:text-4xl">
                        {book ? (chapter?.title ?? book.title) : (song?.title ?? player.station?.name)}
                    </p>
                    <p className="mt-2 truncate text-base text-muted-foreground md:text-lg">
                        {book
                            ? chapter
                                ? `${book.title} · ${book.author}`
                                : book.author
                            : player.station
                              ? player.stationTitle || 'Live'
                              : (song?.artist ?? '')}
                    </p>
                    {player.station === null && duration > 0 && (
                        <p className="mt-4 font-mono text-sm text-muted-foreground tabular-nums">
                            {clock(player.positionS)} / {clock(duration)}
                        </p>
                    )}
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
                    className="text-muted-foreground"
                >
                    <AudioLines className="size-5" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={LEAVE_STAGE_LABEL}
                    onClick={closeStage}
                    className="text-muted-foreground"
                >
                    <X className="size-5" aria-hidden />
                </Button>
            </div>
        </div>
    )
}
