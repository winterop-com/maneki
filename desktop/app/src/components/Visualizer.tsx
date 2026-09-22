import { useEffect, useRef } from 'react'

import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { useStore } from '@/hooks/use-store'
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
export function Visualizer({ className }: { className?: string }) {
    const shown = useStore(visualizerShown)
    const player = useStore(playerStore)
    const still = usePrefersReducedMotion()
    const canvas = useRef<HTMLCanvasElement | null>(null)
    const playing = player.playing

    useEffect(() => {
        const element = canvas.current
        if (!element || !shown || !playing || still) return
        const analyser = spectrum()
        if (!analyser) return
        const context = element.getContext('2d')
        if (!context) return
        const frequencies = new Uint8Array(analyser.frequencyBinCount)
        let frame = 0

        const draw = () => {
            frame = requestAnimationFrame(draw)
            // The canvas follows its box: a bar that changed width with the window would
            // otherwise be drawn stretched until something else forced a resize.
            const ratio = window.devicePixelRatio || 1
            const width = element.clientWidth
            const height = element.clientHeight
            if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio)
            if (element.height !== Math.round(height * ratio)) element.height = Math.round(height * ratio)
            context.setTransform(ratio, 0, 0, ratio, 0, 0)
            context.clearRect(0, 0, width, height)
            analyser.getByteFrequencyData(frequencies)
            const heights = bars(frequencies, BAND_COUNT)
            const gap = 2
            const bar = Math.max(1, (width - gap * (heights.length - 1)) / heights.length)
            context.fillStyle = getComputedStyle(element).color
            heights.forEach((level, index) => {
                const tall = Math.max(1, level * height)
                context.fillRect(index * (bar + gap), height - tall, bar, tall)
            })
        }

        frame = requestAnimationFrame(draw)
        return () => {
            cancelAnimationFrame(frame)
            context.clearRect(0, 0, element.clientWidth, element.clientHeight)
        }
    }, [playing, shown, still])

    if (!shown) return null
    return <canvas ref={canvas} aria-hidden className={className} />
}
