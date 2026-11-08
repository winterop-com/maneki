/**
 * What colour the spectrum is painted in.
 *
 * THE ONE PLACE IN THIS APP A COLOUR IS WRITTEN DOWN. Everything else is a token: a screen that
 * spelled a hex value would be a screen the palette cannot move. A spectrum theme is the
 * exception because it is not describing anything -- there is no state, no kind and no identity
 * in a bar, only a ramp somebody picked because they like looking at it -- and a ramp assembled
 * out of status and kind tokens would be borrowing meaning it does not have.
 *
 * THE PALETTE CARRIES THE RAMP; THERE IS NO SECOND CHOICE. A ramp picked apart from the palette
 * is a ramp that can disagree with it, and an ice-blue spectrum under an amber app is what that
 * looked like. `PALETTE_RAMPS` below says which ramp belongs with which palette, so choosing the
 * look chooses the colour the bars burn in, once.
 *
 * `accent` is not a ramp with colours of its own: it is painted in whatever the canvas already
 * reads off its own element, which is a token, in the palette in force. It is what a palette
 * quiet enough to want one ink on the page carries.
 *
 * THE STOPS RUN FROM THE FLOOR UP, quiet colour first, because that is the order somebody reads
 * a bar in, and the order `SoundVisualizer` takes a ramp in.
 */

import type { PaletteName } from '@/lib/theme'

/** The themes this build has. */
export type SpectrumTheme = 'accent' | 'fire' | 'ice' | 'aurora' | 'sunset' | 'mono'

/** One theme: what it is called, and the ramp it paints, floor first. */
export interface SpectrumThemeEntry {
    name: SpectrumTheme
    label: string
    /** Empty for the theme that has no colours of its own and follows the accent. */
    stops: readonly string[]
}

/** The ramps, the one that follows the palette first. */
export const SPECTRUM_THEMES: readonly SpectrumThemeEntry[] = [
    { name: 'accent', label: 'Accent', stops: [] },
    { name: 'fire', label: 'Fire', stops: ['#ffd24a', '#ff7a1a', '#e02020'] },
    { name: 'ice', label: 'Ice', stops: ['#7fe8ff', '#4aa8f0', '#9a7af0'] },
    { name: 'aurora', label: 'Aurora', stops: ['#7cffb2', '#3cc6d8', '#c86cf0'] },
    { name: 'sunset', label: 'Sunset', stops: ['#ffe08a', '#ff9e64', '#ff5a8a'] },
    { name: 'mono', label: 'Mono', stops: ['#6b7280', '#c4c8ce', '#ffffff'] },
]

/**
 * The ramp each palette carries, read off the accent that palette is drawn around in index.css.
 *
 * WHICH RAMP AND WHY, one line each, because the reason is the whole point of the table:
 *  - tidevann, sokkel-ui's base and the default, is blue at hue 240: `ice`, cyan through blue
 *    into violet, is the accent's own hue with the two either side of it.
 *  - amber, the app's own at hue 80, burns: `fire` runs amber to red through the accent
 *    it already is, and a stage that reads as heat is what amber should look like.
 *  - paper is a printed page and its amber is the ink on it, so it carries `accent`: one colour,
 *    the palette's own, rather than a ramp shouting over a palette drawn to be quiet.
 *  - contrast spends no colour it does not need, so the bars are grey to white: `mono` is the
 *    only ramp that does not undo the legibility the palette is for.
 *  - tokyo's indigo at hue 262 is `ice`, cyan through blue into violet: the accent's own hue
 *    with the two either side of it.
 *  - vinyl's deep red at hue 30 is where `fire` ends, so the ramp arrives at the accent instead
 *    of crossing it, and the warm side is the only side this palette has.
 *  - cassette is orange at hue 50 and faded rather than hot: `sunset` is cream to peach to pink,
 *    which is the tape's own warmth without fire's red.
 *  - neon's magenta at hue 358 is `aurora`, green through cyan into violet: the cold half of the
 *    wheel the accent leaves unspent, which is what makes the two read as lit.
 */
export const PALETTE_RAMPS: Record<PaletteName, SpectrumTheme> = {
    tidevann: 'ice',
    amber: 'fire',
    paper: 'accent',
    contrast: 'mono',
    tokyo: 'ice',
    vinyl: 'fire',
    cassette: 'sunset',
    neon: 'aurora',
}

/** The ramp a palette paints its spectrum in. */
export function rampForPalette(palette: PaletteName): SpectrumTheme {
    return PALETTE_RAMPS[palette]
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

/**
 * The ramp a palette hands sokkel-ui's `SoundVisualizer`, quiet first as it reads them: the
 * palette's stops, or nothing for one that follows the accent and is inked in `primary` alone.
 */
export function soundRampFor(palette: PaletteName): readonly string[] | undefined {
    const stops = SPECTRUM_THEMES.find((one) => one.name === rampForPalette(palette))?.stops ?? []
    return stops.length === 0 ? undefined : stops
}
