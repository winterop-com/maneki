import { useEffect, useRef } from 'react'

import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { useStore, useStoreValue } from '@/hooks/use-store'
import { playerStore, spectrum } from '@/lib/player'
import { bars, BAND_COUNT, visualizerShown } from '@/lib/visualizer'

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
 * when playback stops and started again when it resumes.
 *
 * REDUCED MOTION IS NOT A SETTING TO ARGUE WITH. A reader who has asked their system for less
 * movement gets the still bar the player already has, and no animation at all.
 *
 * THE COLOUR IS THE THEME'S. It reads the computed `currentColor` off its own element, so the
 * spectrum is painted in whatever the palette in force says, including one chosen after this
 * component mounted.
 */
const selectPlaying = (state: { playing: boolean }) => state.playing

export function Visualizer({ className }: { className?: string }) {
    const shown = useStore(visualizerShown)
    // Only whether it is playing: the position changes four times a second and means nothing
    // to a canvas that reads the analyser itself.
    const playing = useStoreValue(playerStore, selectPlaying)
    const still = usePrefersReducedMotion()
    const canvas = useRef<HTMLCanvasElement | null>(null)

    useEffect(() => {
        const element = canvas.current
        if (!element || !shown || !playing || still) return
        const analyser = spectrum()
        if (!analyser) return
        const context = element.getContext('2d')
        if (!context) return
        const frequencies = new Uint8Array(analyser.frequencyBinCount)
        let frame = 0

        // MEASURED ON RESIZE, NOT PER FRAME. Reading `clientWidth` forces the browser to lay
        // the page out, and `getComputedStyle` forces it to recalculate style; doing both
        // sixty times a second on a page with a long list in it is felt as a pointer that
        // will not keep up. Both are read when the box actually changes, and cached.
        let width = element.clientWidth
        let height = element.clientHeight
        let ink = getComputedStyle(element).color
        const measure = () => {
            width = element.clientWidth
            height = element.clientHeight
            ink = getComputedStyle(element).color
            const ratio = window.devicePixelRatio || 1
            element.width = Math.round(width * ratio)
            element.height = Math.round(height * ratio)
            context.setTransform(ratio, 0, 0, ratio, 0, 0)
        }
        measure()
        const watcher = new ResizeObserver(measure)
        watcher.observe(element)
        // The palette and the mode are written onto <html>, and the ink is one of their tokens.
        const painted = new MutationObserver(measure)
        painted.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'data-theme'],
        })

        const draw = () => {
            frame = requestAnimationFrame(draw)
            context.clearRect(0, 0, width, height)
            analyser.getByteFrequencyData(frequencies)
            const heights = bars(frequencies, BAND_COUNT)
            const gap = 2
            const bar = Math.max(1, (width - gap * (heights.length - 1)) / heights.length)
            context.fillStyle = ink
            heights.forEach((level, index) => {
                const tall = Math.max(1, level * height)
                context.fillRect(index * (bar + gap), height - tall, bar, tall)
            })
        }

        frame = requestAnimationFrame(draw)
        return () => {
            cancelAnimationFrame(frame)
            watcher.disconnect()
            painted.disconnect()
            context.clearRect(0, 0, width, height)
        }
    }, [playing, shown, still])

    if (!shown) return null
    return <canvas ref={canvas} aria-hidden className={className} />
}
