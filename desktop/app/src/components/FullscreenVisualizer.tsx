import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { useStore } from '@/hooks/use-store'
import { clock } from '@/lib/format'
import { currentSong, playerStore, spectrum } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'
import { bars, closeStage, stageOpen } from '@/lib/visualizer'

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
 * THE DRAWING IS THE SAME FUNCTION the strip uses, at more bands: how bytes become heights is
 * decided once, in `lib/visualizer`, and both canvases only paint the answer.
 *
 * MIRRORED ABOUT THE FLOOR, which the strip is not. A bar growing from the bottom of a 46px
 * strip reads as a level; the same bar on a full screen reads as a column of nothing above it,
 * so the stage draws each band up and down from the middle.
 *
 * ESCAPE LEAVES, and so does the control in the corner, because a screen with no way out that
 * is obvious is a screen somebody reloads the tab to get out of.
 */
export function FullscreenVisualizer() {
    const open = useStore(stageOpen)
    const player = useStore(playerStore)
    const session = useStore(sessionStore)
    const still = usePrefersReducedMotion()
    const canvas = useRef<HTMLCanvasElement | null>(null)
    const song = currentSong()
    const playing = player.playing

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

    useEffect(() => {
        const element = canvas.current
        if (!open || !element || !playing || still) return
        const analyser = spectrum()
        if (!analyser) return
        const context = element.getContext('2d')
        if (!context) return
        const frequencies = new Uint8Array(analyser.frequencyBinCount)
        let frame = 0

        const draw = () => {
            frame = requestAnimationFrame(draw)
            const ratio = window.devicePixelRatio || 1
            const width = element.clientWidth
            const height = element.clientHeight
            if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio)
            if (element.height !== Math.round(height * ratio)) element.height = Math.round(height * ratio)
            context.setTransform(ratio, 0, 0, ratio, 0, 0)
            context.clearRect(0, 0, width, height)
            analyser.getByteFrequencyData(frequencies)
            const heights = bars(frequencies, STAGE_BANDS)
            const gap = Math.max(2, width / 400)
            const bar = Math.max(1, (width - gap * (heights.length - 1)) / heights.length)
            const middle = height / 2
            context.fillStyle = getComputedStyle(element).color
            heights.forEach((level, index) => {
                // Half the height each way, so a full-scale band fills the screen and a quiet
                // one is a line through the middle rather than a stub on the floor.
                const reach = Math.max(1, (level * height) / 2)
                context.fillRect(index * (bar + gap), middle - reach, bar, reach * 2)
            })
        }

        frame = requestAnimationFrame(draw)
        return () => {
            cancelAnimationFrame(frame)
        }
    }, [open, playing, still])

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
                        {player.station ? 'Live' : (song?.artist ?? '')}
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
