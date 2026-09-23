import { useSpectrum } from '@/hooks/use-spectrum'
import { useStore, useStoreValue } from '@/hooks/use-store'
import { playerStore } from '@/lib/player'
import { BAND_COUNT, visualizerShown } from '@/lib/visualizer'

/**
 * What is playing, as a spectrum.
 *
 * A CANVAS RATHER THAN ELEMENTS. Thirty-two bars redrawn sixty times a second is thirty-two
 * style writes per frame through React, and the browser lays out the whole bar each time. One
 * canvas is one paint, and the loop never touches React at all: it reads the analyser, works
 * out the heights, and draws them.
 *
 * IT STOPS WHEN THERE IS NOTHING TO SHOW. A loop running while the music is paused, or while
 * the spectrum is hidden, is a wakeup a laptop pays for and nobody sees. The frame is cancelled
 * when playback stops and started again when it resumes, and a frame of silence while a track
 * is playing is not painted at all.
 *
 * THE COLOUR IS THE THEME'S. It reads the computed `currentColor` off its own element, so the
 * spectrum is painted in whatever the palette in force says, including one chosen after this
 * component mounted.
 *
 * WHAT IT DRAWS IS `hooks/use-spectrum`, which the stage uses as well: the four styles are one
 * loop at two sizes rather than two loops that can disagree about what a style means.
 */
const selectPlaying = (state: { playing: boolean }) => state.playing

export function Visualizer({ className }: { className?: string }) {
    const shown = useStore(visualizerShown)
    // Only whether it is playing: the position changes four times a second and means nothing
    // to a canvas that reads the analyser itself.
    const playing = useStoreValue(playerStore, selectPlaying)
    const canvas = useSpectrum(shown && playing, BAND_COUNT)

    if (!shown) return null
    return <canvas ref={canvas} aria-hidden className={className} />
}
