/**
 * How close together this app sits, and how large it is read.
 *
 * TWO AXES, AND NEITHER IS A COLOUR. `lib/theme` owns what the app is painted in; this owns
 * what size it is drawn at. The arrangement is the same one, for the same reason: a value
 * persisted per browser, written onto `<html>` -- `data-density` as an attribute, the scale as
 * the `--font-scale` custom property -- and applied by the inline script in index.html before
 * the first paint, because a size read in a React effect arrives a frame after the document and
 * every load would reflow under the reader's eyes.
 *
 * WHERE THE SIZES ARE. Nowhere near here. Compact is a block of rules in index.css hung off
 * `html[data-density='compact']`, and the scale is one `font-size` on the root that everything
 * measured in rem follows. This module carries the values and nothing else.
 *
 * THE SCALE IS A PERCENTAGE OF THE BROWSER'S OWN SIZE, not a multiple of sixteen pixels.
 * Somebody who has set their browser to read large has already answered this question once, and
 * an app that wrote an absolute size would be overruling them to honour its own slider.
 */

import { createStore } from '@/lib/store'

/** How tall a row stands: `comfortable` is the design's own spacing, `compact` closes it up. */
export type Density = 'compact' | 'comfortable'

export const DENSITIES: readonly Density[] = ['comfortable', 'compact']

export const DENSITY_LABELS: Record<Density, string> = {
    comfortable: 'Comfortable',
    compact: 'Compact',
}

export const DEFAULT_DENSITY: Density = 'comfortable'

/** Where the chosen density is kept, and the key the inline script in index.html reads. */
export const DENSITY_STORAGE_KEY = 'maneki.density'

/** The attribute on `<html>` the compact rules hang off. */
export const DENSITY_ATTRIBUTE = 'data-density'

/**
 * The bounds of the text scale, and the step the slider moves in.
 *
 * Under 0.85 the twelve-pixel rung stops being legible and over 1.2 the shell's strips -- which
 * are stated in pixels, because every column has to wear the same one -- stop holding a line of
 * their own text. The range is what can be chosen without the app coming apart, rather than
 * every number a slider could produce.
 */
export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.2
export const FONT_SCALE_STEP = 0.05
export const DEFAULT_FONT_SCALE = 1

/** Where the chosen scale is kept, and the key the inline script in index.html reads. */
export const FONT_SCALE_STORAGE_KEY = 'maneki.font-scale'

/** The custom property on `<html>` the root's own `font-size` is a percentage of. */
export const FONT_SCALE_PROPERTY = '--font-scale'

/** Whether a string names a density this build has. */
export function isDensity(candidate: string | null): candidate is Density {
    return candidate !== null && (DENSITIES as readonly string[]).includes(candidate)
}

/**
 * One number turned into a scale this app will actually draw at.
 *
 * ANYTHING UNUSABLE IS THE DEFAULT, not a refusal: what arrives here is whatever a previous
 * build, a hand-edited storage entry or a slider put there, and the only sensible answer to a
 * value the app cannot draw is the one it was designed at. What is usable is clamped into the
 * bounds and snapped to the step, so a scale that came from somewhere other than the slider
 * still lands where the slider can pick it up again.
 */
export function normalizeFontScale(candidate: unknown): number {
    const value = typeof candidate === 'number' ? candidate : Number(candidate)
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_FONT_SCALE
    const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value))
    const steps = Math.round((clamped - FONT_SCALE_MIN) / FONT_SCALE_STEP)
    // Two decimals, because the step is a twentieth and floating point makes 1.0500000000000003
    // out of otherwise exact arithmetic.
    return Number((FONT_SCALE_MIN + steps * FONT_SCALE_STEP).toFixed(2))
}

/** The scale as somebody reads it on the row: a percentage of what their browser was set to. */
export function formatFontScale(scale: number): string {
    return `${String(Math.round(normalizeFontScale(scale) * 100))}%`
}

/**
 * The density and the scale this browser last chose, or the defaults.
 *
 * Storage that refuses to be read -- a private window, a browser with it denied -- is the same
 * answer as storage that holds nothing: the app is drawn at its own size and the choice simply
 * does not survive the reload.
 */
export function storedDensity(): Density {
    try {
        const stored = localStorage.getItem(DENSITY_STORAGE_KEY)
        return isDensity(stored) ? stored : DEFAULT_DENSITY
    } catch {
        return DEFAULT_DENSITY
    }
}

export function storedFontScale(): number {
    try {
        const stored = localStorage.getItem(FONT_SCALE_STORAGE_KEY)
        return stored === null ? DEFAULT_FONT_SCALE : normalizeFontScale(stored)
    } catch {
        return DEFAULT_FONT_SCALE
    }
}

/**
 * What the document is already wearing, for the controls that offer the choice.
 *
 * The pre-paint script put it there before this module was fetched, so these start where it
 * left off rather than deciding anything.
 */
export const densityStore = createStore<Density>(storedDensity())
export const fontScaleStore = createStore<number>(storedFontScale())

/** Choose a density: persist it, write it onto the document, and tell whoever is watching. */
export function chooseDensity(name: string): Density {
    const chosen = isDensity(name) ? name : DEFAULT_DENSITY
    try {
        localStorage.setItem(DENSITY_STORAGE_KEY, chosen)
    } catch {
        // Storage denied: the choice holds for as long as this document is open, and only
        // surviving the reload is lost.
    }
    document.documentElement.setAttribute(DENSITY_ATTRIBUTE, chosen)
    densityStore.set(chosen)
    return chosen
}

/** Choose a text scale, the same way. */
export function chooseFontScale(value: number): number {
    const chosen = normalizeFontScale(value)
    try {
        localStorage.setItem(FONT_SCALE_STORAGE_KEY, String(chosen))
    } catch {
        // Same as above: the size holds until the tab closes.
    }
    document.documentElement.style.setProperty(FONT_SCALE_PROPERTY, String(chosen))
    fontScaleStore.set(chosen)
    return chosen
}
