/**
 * The loop that moves the deck's meters.
 *
 * THE SAME DISCIPLINE THE SPECTRUM'S LOOP HAS, and for the same reasons: it runs only while
 * there is something to meter, it does not run at all for somebody who has asked their machine
 * for less movement, and what a frame of bytes means is `lib/lcd`'s rather than this file's.
 * What is here is the part that needs a browser.
 *
 * IT PUBLISHES A SEGMENT, NOT A FRAME. The spectrum's loop paints a canvas and never touches
 * React; a meter is eighteen spans a row, so a level published sixty times a second would be
 * sixty reconciliations of thirty-six elements for a bar that has eighteen positions. The level
 * is quantised to what it would actually light, and the state is written only when that changes
 * -- so a bar holding still costs nothing at all.
 *
 * AND IT READS THE FRAME THE SPECTRUM IS PAINTING. Both go through the delay line in `lib/sync`,
 * or the needles beside the bars would lead them by however far the output is behind.
 */

import { useEffect, useState } from 'react'

import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { vuLevels, vuSegments, VU_QUIET, type VuLevels } from '@/lib/lcd'
import { spectrum, spectrumContext } from '@/lib/player'
import { makeDelayLine, outputDelayMs, spectrumDelayMs } from '@/lib/sync'

/** Follow the analyser for as long as `active` holds. Both needles rest when it does not. */
export function useVuLevels(active: boolean): VuLevels {
    const [levels, setLevels] = useState<VuLevels>(VU_QUIET)
    // A meter is movement and nothing else -- the clocks beside it say what it says -- so
    // somebody who asked for less of it gets a dark meter rather than a slower one.
    const still = usePrefersReducedMotion()

    useEffect(() => {
        if (!active || still) return
        const analyser = spectrum()
        if (!analyser) return

        const frame = new Uint8Array(analyser.frequencyBinCount)
        const line = makeDelayLine(frame.length)
        const graph = spectrumContext()
        let request = 0
        let lowLit = -1
        let highLit = -1

        const read = () => {
            request = requestAnimationFrame(read)
            analyser.getByteFrequencyData(frame)
            // The graph's own clock, because that is what the latency is measured against; a
            // page clock where there is no graph, which only happens before anything has played.
            line.push(frame, graph === null ? performance.now() : graph.currentTime * 1000)
            const heard = vuLevels(line.read(outputDelayMs(graph) + spectrumDelayMs.get()))
            const low = vuSegments(heard.low)
            const high = vuSegments(heard.high)
            if (low === lowLit && high === highLit) return
            lowLit = low
            highLit = high
            setLevels(heard)
        }

        request = requestAnimationFrame(read)
        return () => {
            cancelAnimationFrame(request)
        }
    }, [active, still])

    // A STOPPED DECK RESTS ITS NEEDLES, and that is answered during render rather than by an
    // effect writing zeroes on the way out: what the last frame happened to say is not a reading
    // of anything once the loop has gone, and the first frame of the next one publishes afresh.
    return active && !still ? levels : VU_QUIET
}
