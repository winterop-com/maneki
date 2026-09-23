/**
 * What colour the spectrum is painted in.
 *
 * THE ONE PLACE IN THIS APP A COLOUR IS WRITTEN DOWN. Everything else is a token: a screen that
 * spelled a hex value would be a screen the palette cannot move. A spectrum theme is the
 * exception because it is not describing anything -- there is no state, no kind and no identity
 * in a bar, only a ramp somebody picked because they like looking at it -- and a ramp assembled
 * out of status and kind tokens would be borrowing meaning it does not have.
 *
 * FOLLOWING THE ACCENT IS THE DEFAULT AND STAYS THE DEFAULT. `accent` is not a theme with
 * colours of its own: it is painted in whatever the canvas already reads off its own element,
 * which is a token, in the palette in force. Anybody who wants a fixed ramp goes and asks for
 * one; nobody gets one by opening the app.
 *
 * THE STOPS RUN FROM THE FLOOR UP, quiet colour first, because that is the order somebody reads
 * a bar in. Which end of the gradient each lands on is the painter's, and it is not the same
 * end for a spectrum drawn up the canvas as for a scope drawn across it.
 */

import { createStore } from '@/lib/store'

/** The themes this build has. */
export type SpectrumTheme = 'accent' | 'fire' | 'ice' | 'aurora' | 'sunset' | 'mono'

/** One theme: what it is called, and the ramp it paints, floor first. */
export interface SpectrumThemeEntry {
    name: SpectrumTheme
    label: string
    /** Empty for the theme that has no colours of its own and follows the accent. */
    stops: readonly string[]
}

/** The themes, the one that follows the palette first. */
export const SPECTRUM_THEMES: readonly SpectrumThemeEntry[] = [
    { name: 'accent', label: 'Accent', stops: [] },
    { name: 'fire', label: 'Fire', stops: ['#ffd24a', '#ff7a1a', '#e02020'] },
    { name: 'ice', label: 'Ice', stops: ['#7fe8ff', '#4aa8f0', '#9a7af0'] },
    { name: 'aurora', label: 'Aurora', stops: ['#7cffb2', '#3cc6d8', '#c86cf0'] },
    { name: 'sunset', label: 'Sunset', stops: ['#ffe08a', '#ff9e64', '#ff5a8a'] },
    { name: 'mono', label: 'Mono', stops: ['#6b7280', '#c4c8ce', '#ffffff'] },
]

export const DEFAULT_SPECTRUM_THEME: SpectrumTheme = 'accent'

/** Where the choice is kept between visits. */
export const SPECTRUM_THEME_KEY = 'maneki.spectrum.theme'

export const SPECTRUM_THEME_NAMES: readonly SpectrumTheme[] = SPECTRUM_THEMES.map((one) => one.name)

/** Whether a string names a theme this build has. */
export function isSpectrumTheme(candidate: string | null): candidate is SpectrumTheme {
    return candidate !== null && (SPECTRUM_THEME_NAMES as readonly string[]).includes(candidate)
}

function readTheme(): SpectrumTheme {
    try {
        const stored = localStorage.getItem(SPECTRUM_THEME_KEY)
        return isSpectrumTheme(stored) ? stored : DEFAULT_SPECTRUM_THEME
    } catch {
        return DEFAULT_SPECTRUM_THEME
    }
}

/** Which theme both canvases paint in. */
export const spectrumTheme = createStore<SpectrumTheme>(readTheme())

export function chooseSpectrumTheme(theme: string): SpectrumTheme {
    const chosen = isSpectrumTheme(theme) ? theme : DEFAULT_SPECTRUM_THEME
    try {
        localStorage.setItem(SPECTRUM_THEME_KEY, chosen)
    } catch {
        // Storage denied: the choice holds for as long as this document is open.
    }
    spectrumTheme.set(chosen)
    return chosen
}

/**
 * Which theme an arrow key moves to, or null for a key this control does not answer.
 *
 * The swatch cards are a radio group, the same as the palette's, so the arrows move and choose
 * in one gesture and the ends wrap. What the keys decide is a pure function; focusing the card
 * that won is the component's.
 */
export function spectrumThemeAfter(current: SpectrumTheme, key: string): SpectrumTheme | null {
    const forward = key === 'ArrowRight' || key === 'ArrowDown'
    const back = key === 'ArrowLeft' || key === 'ArrowUp'
    if (!forward && !back) return null
    const at = SPECTRUM_THEME_NAMES.indexOf(current)
    const next = (at + (forward ? 1 : -1) + SPECTRUM_THEME_NAMES.length) % SPECTRUM_THEME_NAMES.length
    return SPECTRUM_THEME_NAMES[next]
}

/**
 * The ramp a theme paints, floor first, given what the accent is at this moment.
 *
 * A theme with no colours of its own -- and a name from a build that had one this build does
 * not -- answers with the accent alone, which paints flat in the app's own colour.
 */
export function themeStops(theme: SpectrumTheme, accent: string): readonly string[] {
    const found = SPECTRUM_THEMES.find((one) => one.name === theme)
    if (found === undefined || found.stops.length === 0) return [accent]
    return found.stops
}

/** The little a canvas gradient has to be for this module to fill one, so a test can watch. */
export interface ColourStops {
    addColorStop: (offset: number, colour: string) => void
}

/** The little a canvas context has to be to make one. */
export interface GradientMaker<G extends ColourStops> {
    createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => G
}

/**
 * Gradients already built, per context, per theme, per size, per accent.
 *
 * ONE GRADIENT A FRAME AT MOST, NEVER ONE PER BAR. Building a gradient is the expensive call in
 * a canvas frame, and the client this replaces was allocating one for every bar of every frame
 * until it started keying them. A gradient down the whole canvas is a pure function of the
 * theme, the height and the accent, so it is built once and handed back until one of those
 * three moves -- and a bar's colour then says how loud it is, which is what an analyser is read
 * for.
 *
 * Held against the context rather than in one map for the app, so the strip's gradients go when
 * the strip does and the two canvases cannot hand each other a gradient the other one made.
 */
const built = new WeakMap<object, Map<string, ColourStops>>()

/** Up the canvas: the quiet colour on the floor, the loud one at the top. */
export function themeGradient<G extends ColourStops>(
    theme: SpectrumTheme,
    context: GradientMaker<G>,
    height: number,
    accent: string,
): G {
    return gradient(theme, context, 'up', height, accent)
}

/**
 * Across the canvas: the quiet colour on the left, the loud one on the right.
 *
 * The scope is a line about the middle rather than a height, so a ramp up the canvas would
 * paint the same trace two colours depending on which way the wave happened to go.
 */
export function themeSweep<G extends ColourStops>(
    theme: SpectrumTheme,
    context: GradientMaker<G>,
    width: number,
    accent: string,
): G {
    return gradient(theme, context, 'across', width, accent)
}

function gradient<G extends ColourStops>(
    theme: SpectrumTheme,
    context: GradientMaker<G>,
    axis: 'up' | 'across',
    size: number,
    accent: string,
): G {
    const held = built.get(context) ?? new Map<string, ColourStops>()
    built.set(context, held)
    const key = `${axis}:${theme}:${Math.round(size)}:${accent}`
    const known = held.get(key)
    if (known !== undefined) return known as G
    const made =
        axis === 'up'
            ? context.createLinearGradient(0, 0, 0, size)
            : context.createLinearGradient(0, 0, size, 0)
    const stops = themeStops(theme, accent)
    if (stops.length === 1) {
        made.addColorStop(0, stops[0])
        made.addColorStop(1, stops[0])
    } else {
        stops.forEach((colour, index) => {
            const along = index / (stops.length - 1)
            // Up the canvas, zero is the top: the last stop is the loudest and belongs there.
            made.addColorStop(axis === 'up' ? 1 - along : along, colour)
        })
    }
    held.set(key, made)
    return made
}
