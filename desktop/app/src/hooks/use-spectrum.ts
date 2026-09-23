/**
 * The loop that paints the spectrum, for whichever canvas asks for it.
 *
 * ONE LOOP, TWO CANVASES. The strip on the player bar and the stage over the whole screen are
 * the same reading of the same analyser at different sizes, so the measuring, the frame clock
 * and the four drawings live here and each component is a canvas with a ref on it. Two copies
 * of this loop would be two places a style has to be added to.
 *
 * THE GEOMETRY IS NOT HERE. What a frame of bytes looks like -- the band heights, the smoothed
 * ridge, the scope's trace, whether the frame is worth painting -- is `lib/visualizer`, which is
 * exercised in plain Node. This file is the part that needs a canvas: it turns those points into
 * calls and nothing else.
 *
 * MEASURED ON RESIZE, NOT PER FRAME. Reading `clientWidth` forces the browser to lay the page
 * out and `getComputedStyle` forces it to recalculate style; doing both sixty times a second on
 * a page with a long list in it is felt as a pointer that will not keep up. Both are read when
 * the box actually changes, and again when the palette or the mode is written onto `<html>`.
 *
 * THE COLOUR IS THE PALETTE'S, NOT A SECOND CHOICE. The ramp comes from whichever palette is in
 * force, and a palette quiet enough to carry no ramp is painted in what the canvas reads off its
 * own element, which is the accent token. `lib/spectrum-themes` holds that table, and the reason
 * a fixed colour is allowed there at all.
 *
 * WHAT IS DRAWN IS WHAT IS AUDIBLE, NOT WHAT THE ANALYSER JUST READ. The two are the same thing
 * over a cable and a third of a second apart over Bluetooth, so every frame goes through the
 * delay line in `lib/sync` and what gets painted is the frame from as long ago as the output is
 * behind.
 */

import { useEffect, useRef, type RefObject } from 'react'

import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { useStore } from '@/hooks/use-store'
import { spectrum, spectrumContext } from '@/lib/player'
import { rampForPalette, themeGradient, themeStops, themeSweep } from '@/lib/spectrum-themes'
import { makeDelayLine, outputDelayMs, spectrumDelayMs } from '@/lib/sync'
import { paletteStore } from '@/lib/theme'
import {
    bars,
    barLayout,
    isFlat,
    isIdle,
    ridgeFromTops,
    settle,
    scopePoints,
    spectrumEffect,
    visualizerStyle,
    type VisualizerStyle,
} from '@/lib/visualizer'

/** How far the glow reaches from a bar. */
const GLOW_BLUR = 12

/** The wash the trails effect lays over the last frame: the stage's ground, part strength. */
const TRAIL_WASH = 'rgba(0, 0, 0, 0.35)'

/**
 * Paint the analyser into a canvas for as long as `active` holds.
 *
 * `bands` is how many bars the caller's width can carry: the strip is 112px and the stage is a
 * screen, and a band count that suited both would be wrong for one of them.
 */
export function useSpectrum(
    active: boolean,
    bands: number,
    /** Whether the chosen effect is applied: the stage's, where the spectrum is the show. */
    withEffect = false,
): RefObject<HTMLCanvasElement | null> {
    const canvas = useRef<HTMLCanvasElement | null>(null)
    const style = useStore(visualizerStyle)
    // The ramp is the palette's, not a choice of its own: see `lib/spectrum-themes`.
    const palette = useStore(paletteStore)
    const theme = rampForPalette(palette)
    const chosenEffect = useStore(spectrumEffect)
    const effect = withEffect ? chosenEffect : 'none'
    // A reader who has asked their system for less movement gets the still bar the player
    // already has, and no loop at all.
    const still = usePrefersReducedMotion()

    useEffect(() => {
        const element = canvas.current
        if (!element || !active || still) return
        const analyser = spectrum()
        if (!analyser) return
        const context = element.getContext('2d')
        if (!context) return

        // The scope reads the samples themselves and every other style reads the FFT, so only
        // the one the chosen style asks for is ever read: the time domain is a copy, but the
        // frequency data is the transform, and asking for both is paying for it twice.
        const wave = style === 'scope'
        const frame = new Uint8Array(wave ? analyser.fftSize : analyser.frequencyBinCount)
        // What is read off the analyser is not what is audible yet -- see `lib/sync`. Every
        // frame goes through the line whatever the delay is, so dialling one in mid-track has a
        // history to read back from rather than starting empty.
        const line = makeDelayLine(frame.length)
        const graph = spectrumContext()
        let request = 0

        let width = element.clientWidth
        let height = element.clientHeight
        let ink = getComputedStyle(element).color
        // The frame most recently painted, so a resize can paint it again without a new read.
        let last: Uint8Array | null = null

        const measure = () => {
            width = element.clientWidth
            height = element.clientHeight
            ink = getComputedStyle(element).color
            const ratio = window.devicePixelRatio || 1
            element.width = Math.round(width * ratio)
            element.height = Math.round(height * ratio)
            context.setTransform(ratio, 0, 0, ratio, 0, 0)
            // RESIZING A CANVAS BLANKS IT, and the next frame is up to a frame away -- which
            // under a drag, where every pointer move is a resize, is a run of black frames
            // between paints. So the last frame is painted again at the new size at once.
            if (last !== null) paintFrame(last, false)
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

        // Whether the quiet has already been drawn once. The frame that crosses into silence is
        // painted, so what is left on screen is the floor rather than the middle of a note; from
        // the one after it the paint is skipped and only the bookkeeping runs.
        let settled = false
        // Last frame's heights, so this frame's can rise fast and fall slowly against them.
        let previous: number[] = []

        const draw = () => {
            request = requestAnimationFrame(draw)
            if (wave) analyser.getByteTimeDomainData(frame)
            else analyser.getByteFrequencyData(frame)
            // The graph's own clock, because that is what the latency is measured against; a
            // page clock where there is no graph, which only happens before anything has played.
            line.push(frame, graph === null ? performance.now() : graph.currentTime * 1000)
            // Read again every frame rather than held: the setting moves under a dragged slider,
            // and what the browser reports changes the moment the output device does.
            const shown = line.read(outputDelayMs(graph) + spectrumDelayMs.get())
            const quiet = wave ? isFlat(shown) : isIdle(shown)
            if (quiet && settled) return
            settled = quiet
            last = shown
            paintFrame(shown, quiet)
        }

        const paintFrame = (shown: Uint8Array, quiet: boolean) => {
            // TRAILS ARE THE LAST FRAME NOT QUITE WIPED. Instead of clearing, the canvas is
            // washed with the ground at part strength, so what was drawn a moment ago is still
            // faintly there under what is drawn now. A quiet frame is cleared outright, so the
            // floor is a floor rather than a slowly fading memory of the last note.
            if (effect === 'trails' && !quiet) {
                context.shadowBlur = 0
                context.fillStyle = TRAIL_WASH
                context.fillRect(0, 0, width, height)
            } else {
                context.clearRect(0, 0, width, height)
            }
            // Built once per ramp, size and accent rather than per frame -- and `accent`, the
            // ramp a palette with none of its own carries, is a gradient of the one colour the
            // canvas read off its own element, which is a token.
            const ramp = wave
                ? themeSweep(theme, context, width, ink)
                : themeGradient(theme, context, height, ink)
            context.fillStyle = ramp
            context.strokeStyle = ramp
            // GLOW IS A SHADOW IN THE RAMP'S OWN TOP COLOUR under every bar, which reads as heat
            // coming off the drawing. Kept modest: at twice this it read as a smeared screen.
            context.shadowBlur = effect === 'glow' ? GLOW_BLUR : 0
            context.shadowColor = effect === 'glow' ? themeStops(theme, ink)[0] : 'transparent'
            if (wave) {
                paintScope(context, shown, width, height)
            } else {
                previous = settle(previous, bars(shown, bands))
                paint(context, style, previous, width, height)
            }
        }

        request = requestAnimationFrame(draw)
        return () => {
            cancelAnimationFrame(request)
            watcher.disconnect()
            painted.disconnect()
            context.clearRect(0, 0, width, height)
        }
    }, [active, bands, effect, still, style, theme])

    return canvas
}

/** One settled frame of heights, in whichever column drawing is chosen. */
function paint(
    context: CanvasRenderingContext2D,
    style: VisualizerStyle,
    heights: readonly number[],
    width: number,
    height: number,
): void {
    switch (style) {
        case 'ridge':
            return paintRidge(context, heights, width, height)
        case 'mirror':
            return paintColumns(context, heights, width, height, true)
        default:
            return paintColumns(context, heights, width, height, false)
    }
}

/**
 * Bars, stood on the floor or about the middle.
 *
 * MIRRORING IS WHERE THE BAR STANDS, NOT A DIFFERENT READING. Both draw the same heights, so
 * the two styles are one loop with the baseline moved -- and a band that reaches full scale
 * fills the canvas either way.
 */
function paintColumns(
    context: CanvasRenderingContext2D,
    heights: readonly number[],
    width: number,
    height: number,
    mirrored: boolean,
): void {
    const { bar, gap } = barLayout(width, heights.length)
    const middle = height / 2
    heights.forEach((level, index) => {
        const x = index * (bar + gap)
        if (mirrored) {
            const reach = Math.max(1, (level * height) / 2)
            context.fillRect(x, middle - reach, bar, reach * 2)
        } else {
            const tall = Math.max(1, level * height)
            context.fillRect(x, height - tall, bar, tall)
        }
    })
}

/** The band tops as a filled curve: the bars melted into one line. */
function paintRidge(
    context: CanvasRenderingContext2D,
    heights: readonly number[],
    width: number,
    height: number,
): void {
    const line = ridgeFromTops(heights, width, height)
    if (line.length === 0) return
    context.beginPath()
    // The curve is the top of a shape rather than a line: it is closed down to the floor at
    // both ends, which is the area under the spectrum and what gets filled.
    context.moveTo(0, height)
    for (const point of line) context.lineTo(point.x, point.y)
    context.lineTo(width, height)
    context.closePath()
    context.fill()
}

/** The waveform, stroked rather than filled: a scope draws a line and has no area under it. */
function paintScope(
    context: CanvasRenderingContext2D,
    frame: Uint8Array,
    width: number,
    height: number,
): void {
    const line = scopePoints(frame, width, height)
    if (line.length === 0) return
    context.lineWidth = Math.max(1.5, height * 0.012)
    context.lineJoin = 'round'
    context.lineCap = 'round'
    context.beginPath()
    context.moveTo(line[0].x, line[0].y)
    for (let at = 1; at < line.length; at += 1) context.lineTo(line[at].x, line[at].y)
    context.stroke()
}
