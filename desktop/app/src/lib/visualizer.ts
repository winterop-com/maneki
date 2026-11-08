/**
 * Whether the spectrum is drawn, which drawing it is, what the stage does to it, and how tall the
 * player bar is.
 *
 * The drawing itself is sokkel-ui's `SoundVisualizer`, in the player bar and its fullscreen
 * view; what is kept here is the choices somebody makes about it, and which engines can hear a
 * live station at all.
 */

import type { SoundAlign, SoundEffect, SoundKind } from '@winterop-com/sokkel-ui/media/sound'
import { rowsHeightFor } from '@winterop-com/sokkel-ui-media/MediaBar'
import { createStore } from '@winterop-com/sokkel-ui/lib/stored'

/** Where the choice is kept between visits. */
export const VISUALIZER_KEY = 'maneki.visualizer'

/** Which drawing the spectrum is: the library's kinds, and the bars about the middle. */
export type VisualizerStyle = SoundKind | 'mirror'

/** The drawings, in the order the control lays them out and the cycle steps through them. */
export const VISUALIZER_STYLES: readonly VisualizerStyle[] = ['spectrum', 'mirror', 'area', 'wave', 'ring']

/** What each drawing is called. One word each, because the control is a row of them. */
export const VISUALIZER_STYLE_LABELS: Record<VisualizerStyle, string> = {
    spectrum: 'Bars',
    mirror: 'Mirror',
    area: 'Area',
    wave: 'Wave',
    ring: 'Ring',
}

/** How the library draws a style: Mirror is its bars standing about the middle. */
export function soundLook(style: VisualizerStyle): { kind: SoundKind; align: SoundAlign } {
    return style === 'mirror' ? { kind: 'spectrum', align: 'center' } : { kind: style, align: 'bottom' }
}

/** The drawing a fresh browser gets: the one the bar has always had. */
export const DEFAULT_STYLE: VisualizerStyle = 'spectrum'

function readFlag(fallback: boolean): boolean {
    try {
        const stored = localStorage.getItem(VISUALIZER_KEY)
        return stored === null ? fallback : stored === 'true'
    } catch {
        return fallback
    }
}

/**
 * Whether the spectrum is shown.
 *
 * On by default: it is the one thing on the bar that says the sound is actually coming out,
 * and somebody who does not want it turns it off once and it stays off.
 */
export const visualizerShown = createStore(readFlag(true))

/**
 * Whether this engine lets Web Audio hear a live station at all.
 *
 * WEBKIT HANDS WEB AUDIO SILENCE FROM A STREAM WITH NO END. Safari, the macOS app's webview and
 * every browser on an iPhone play a station perfectly well and give the analyser nothing but
 * zeroes for it, while a track with a length reads fine on the same element -- so under a
 * station the spectrum was a flat line that said the sound had stopped when it had not. A
 * Chromium agent names itself (Electron, Chrome, Edge, Android's webview); an Apple WebKit one
 * that does not is the engine that cannot.
 */
export function liveSpectrumReadable(userAgent: string): boolean {
    if (!userAgent.includes('AppleWebKit/')) return true
    // No word boundary: a headless Chromium names itself `HeadlessChrome/`.
    return /(Chrome|Chromium|Edg|Electron)\//.test(userAgent)
}

/** This document's answer to `liveSpectrumReadable`, read once: the engine does not change. */
const LIVE_SPECTRUM_READABLE =
    typeof navigator === 'undefined' ? true : liveSpectrumReadable(navigator.userAgent)

/**
 * Whether there is a spectrum to draw for what is playing: always for a track or a book, and for
 * a station only where the engine can hear one. Where it cannot, nothing is drawn rather than
 * a line that lies about the sound. A station played with no relay (listening without a server)
 * is fetched without CORS, and Web Audio hears nothing from it on any engine.
 */
export function spectrumReadable(
    playingStation: boolean,
    readable = LIVE_SPECTRUM_READABLE,
    relayed = true,
): boolean {
    return !playingStation || (readable && relayed)
}

export function setVisualizer(shown: boolean): void {
    try {
        localStorage.setItem(VISUALIZER_KEY, String(shown))
    } catch {
        // Storage denied: the choice holds for as long as this document is open.
    }
    visualizerShown.set(shown)
}

export function toggleVisualizer(): void {
    setVisualizer(!visualizerShown.get())
}

/** Whether a string names a drawing this build has. */
export function isVisualizerStyle(candidate: string | null): candidate is VisualizerStyle {
    return candidate !== null && (VISUALIZER_STYLES as readonly string[]).includes(candidate)
}

/**
 * Which drawing the fullscreen view paints. NOT KEPT BETWEEN VISITS: every launch starts on the
 * plain bars, and a switch to another drawing lasts until the app is closed. A drawing chosen
 * once and saved came back on every launch as a surprise, long after it was picked.
 */
export const visualizerStyle = createStore<VisualizerStyle>(DEFAULT_STYLE)

export function setVisualizerStyle(style: VisualizerStyle): void {
    visualizerStyle.set(style)
}

/** The drawing after this one, wrapping at the end. A pure step, so the cycle has a test. */
export function nextStyle(current: VisualizerStyle): VisualizerStyle {
    const at = VISUALIZER_STYLES.indexOf(current)
    return VISUALIZER_STYLES[(at + 1) % VISUALIZER_STYLES.length]!
}

/** Step to the next drawing and answer what it is, for the control and the palette row. */
export function cycleVisualizerStyle(): VisualizerStyle {
    const wanted = nextStyle(visualizerStyle.get())
    setVisualizerStyle(wanted)
    return wanted
}

/**
 * What is done to the drawing on the stage, over and above drawing it.
 *
 * AN EFFECT IS CHOSEN, NEVER IMPOSED. A bloom under every bar reads as heat to one person and
 * as a smeared screen to the next, so it is one of a short list somebody picks from, kept
 * between visits like the drawing itself, and the list starts on nothing. Only the stage
 * applies it: the bar's faint backdrop is read behind words rather than looked at.
 */
export type SpectrumEffect = SoundEffect

export const SPECTRUM_EFFECTS: readonly SpectrumEffect[] = ['none', 'glow', 'trails']

export const SPECTRUM_EFFECT_LABELS: Record<SpectrumEffect, string> = {
    none: 'No effect',
    glow: 'Glow',
    trails: 'Trails',
}

export const DEFAULT_EFFECT: SpectrumEffect = 'none'

export const SPECTRUM_EFFECT_KEY = 'maneki.spectrum.effect'

/** Whether a string names an effect this build has. */
export function isSpectrumEffect(candidate: string | null): candidate is SpectrumEffect {
    return candidate !== null && (SPECTRUM_EFFECTS as readonly string[]).includes(candidate)
}

function readEffect(): SpectrumEffect {
    try {
        const stored = localStorage.getItem(SPECTRUM_EFFECT_KEY)
        return isSpectrumEffect(stored) ? stored : DEFAULT_EFFECT
    } catch {
        return DEFAULT_EFFECT
    }
}

/** Which effect the stage wears. Kept between visits, like the drawing. */
export const spectrumEffect = createStore<SpectrumEffect>(readEffect())

/** Choose an effect by name; a name this build does not know is the plain drawing. */
export function setSpectrumEffect(effect: string): SpectrumEffect {
    const chosen = isSpectrumEffect(effect) ? effect : DEFAULT_EFFECT
    try {
        localStorage.setItem(SPECTRUM_EFFECT_KEY, chosen)
    } catch {
        // Storage denied: the choice holds for as long as this document is open.
    }
    spectrumEffect.set(chosen)
    return chosen
}

/**
 * How tall the player bar has been dragged, in pixels. The pixels somebody dragged it to are
 * kept; the bar itself never takes less than its one line or more than half the window.
 */
export const BAR_SIZE_KEY = 'maneki.playerBarSize'
export const BAR_SIZE_MAX = 360

/** Where an undragged bar starts: grown, with the 158 px cover the client before this one opened with. */
export const BAR_COVER_DEFAULT = 158
export const BAR_SIZE_DEFAULT = rowsHeightFor(BAR_COVER_DEFAULT)

/**
 * The previous bar's key: the room above its controls, whose cover was that room plus the
 * controls' row, 158 px at its default room of 112.
 */
export const OLD_BAR_ROOM_KEY = 'maneki.playerBarRoom'
const OLD_ROOM_TO_COVER = BAR_COVER_DEFAULT - 112

export function clampBarSize(size: number): number {
    if (!Number.isFinite(size)) return BAR_SIZE_DEFAULT
    return Math.round(Math.min(BAR_SIZE_MAX, Math.max(0, size)))
}

/** The height that gives the old bar's room the same cover, for carrying a dragged height over. */
export function sizeFromRoom(room: number): number {
    return clampBarSize(rowsHeightFor(room + OLD_ROOM_TO_COVER))
}

function readBarSize(): number {
    try {
        const stored = localStorage.getItem(BAR_SIZE_KEY)
        if (stored !== null) return clampBarSize(Number(stored))
        // Carried over once from the previous bar, then kept under the new key.
        const room = localStorage.getItem(OLD_BAR_ROOM_KEY)
        if (room === null || !Number.isFinite(Number(room))) return BAR_SIZE_DEFAULT
        const size = sizeFromRoom(Number(room))
        localStorage.setItem(BAR_SIZE_KEY, String(size))
        localStorage.removeItem(OLD_BAR_ROOM_KEY)
        return size
    } catch {
        return BAR_SIZE_DEFAULT
    }
}

export const barSize = createStore(readBarSize())

export function setBarSize(size: number): void {
    const held = clampBarSize(size)
    try {
        localStorage.setItem(BAR_SIZE_KEY, String(held))
    } catch {
        // Storage denied: the height holds for as long as this document is open.
    }
    barSize.set(held)
}

/**
 * Whether the player's fullscreen view is up.
 *
 * NOT KEPT BETWEEN VISITS, unlike whether the spectrum is drawn. The stage is something somebody
 * puts on for as long as they are looking at it, and an app that opened behind a full-screen
 * canvas because of what happened yesterday is an app somebody has to escape before using.
 */
export const stageOpen = createStore(false)

export function openStage(): void {
    stageOpen.set(true)
}

export function closeStage(): void {
    stageOpen.set(false)
}

export function toggleStage(): void {
    stageOpen.update((open) => !open)
}
