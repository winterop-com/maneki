import { X } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { useSpectrum } from '@/hooks/use-spectrum'
import { useStore } from '@/hooks/use-store'
import { clock } from '@/lib/format'
import { currentSong, playerStore } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'
import { closeStage, stageOpen } from '@/lib/visualizer'

export const LEAVE_STAGE_LABEL = 'Leave the spectrum'

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
 */
export function FullscreenVisualizer() {
    const open = useStore(stageOpen)
    const player = useStore(playerStore)
    const session = useStore(sessionStore)
    const song = currentSong()
    const playing = player.playing
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

    const cover = song && session.music ? coverUrl(session.music, song.coverArt, 600) : null
    const duration = player.durationS || song?.duration || 0

    return (
        <div
            data-stage
            className="fixed inset-0 z-50 flex flex-col bg-background"
            role="dialog"
            aria-label="Spectrum"
            aria-modal="true"
        >
            <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full text-primary/40" />

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
                        {song?.title ?? player.station?.name}
                    </p>
                    <p className="mt-2 truncate text-base text-muted-foreground md:text-lg">
                        {player.station ? player.stationTitle || 'Live' : (song?.artist ?? '')}
                    </p>
                    {player.station === null && duration > 0 && (
                        <p className="mt-4 font-mono text-sm text-muted-foreground tabular-nums">
                            {clock(player.positionS)} / {clock(duration)}
                        </p>
                    )}
                </div>
            </div>

            <Button
                variant="ghost"
                size="icon"
                aria-label={LEAVE_STAGE_LABEL}
                onClick={closeStage}
                className="absolute top-4 right-4 text-muted-foreground"
            >
                <X className="size-5" aria-hidden />
            </Button>
        </div>
    )
}
