import { describe, expect, test } from 'vitest'

import {
    PALETTE_RAMPS,
    rampForPalette,
    soundRampFor,
    SPECTRUM_THEMES,
    themeStops,
    type SpectrumTheme,
} from '@/lib/spectrum-themes'
import { PALETTE_NAMES } from '@/lib/theme'

describe('the ramps on offer', () => {
    test('names each one once, and each one has something to call it', () => {
        expect(new Set(SPECTRUM_THEMES.map((one) => one.name)).size).toBe(SPECTRUM_THEMES.length)
        for (const theme of SPECTRUM_THEMES) expect(theme.label).toBeTruthy()
    })
})

describe('the ramp a palette carries', () => {
    // The whole point of the table: a palette without a ramp is a palette whose spectrum would
    // have to fall back to something, and falling back is how the two disagreed in the first place.
    test('answers for every palette this build has, and with a ramp this build has', () => {
        const names = SPECTRUM_THEMES.map((one) => one.name)
        for (const palette of PALETTE_NAMES) {
            expect(names).toContain(rampForPalette(palette))
        }
        expect(Object.keys(PALETTE_RAMPS).toSorted()).toEqual(PALETTE_NAMES.toSorted())
    })

    test("burns for the app's own palette, which is what a stage is for", () => {
        expect(rampForPalette('amber')).toBe('fire')
    })

    test('follows the accent where the palette is too quiet to carry a ramp', () => {
        expect(rampForPalette('paper')).toBe('accent')
        expect(themeStops(rampForPalette('paper'), '#abcdef')).toEqual(['#abcdef'])
    })

    test('spends the accent it was drawn around, cold for tokyo and grey for contrast', () => {
        expect(rampForPalette('tidevann')).toBe('ice')
        expect(rampForPalette('tokyo')).toBe('ice')
        expect(rampForPalette('contrast')).toBe('mono')
        expect(rampForPalette('neon')).toBe('aurora')
    })
})

describe('the stops a ramp paints', () => {
    test('is the theme it was asked for, floor first', () => {
        expect(themeStops('fire', '#000000')).toEqual(['#ffd24a', '#ff7a1a', '#e02020'])
    })

    test('is the colour it was handed, where the theme is to follow the accent', () => {
        expect(themeStops('accent', 'oklch(0.8 0.15 80)')).toEqual(['oklch(0.8 0.15 80)'])
    })

    test('is the accent for a name this build does not have, rather than nothing to paint with', () => {
        expect(themeStops('tokyo' as SpectrumTheme, '#abcdef')).toEqual(['#abcdef'])
    })
})

describe('the ramp the library draws', () => {
    test("is the palette's stops as they were, quiet first", () => {
        expect(soundRampFor('amber')).toEqual(['#ffd24a', '#ff7a1a', '#e02020'])
        expect(soundRampFor('vinyl')).toEqual(['#ffd24a', '#ff7a1a', '#e02020'])
        expect(soundRampFor('tokyo')).toEqual(['#7fe8ff', '#4aa8f0', '#9a7af0'])
        expect(soundRampFor('tidevann')).toEqual(['#7fe8ff', '#4aa8f0', '#9a7af0'])
        expect(soundRampFor('neon')).toEqual(['#7cffb2', '#3cc6d8', '#c86cf0'])
        expect(soundRampFor('cassette')).toEqual(['#ffe08a', '#ff9e64', '#ff5a8a'])
        expect(soundRampFor('contrast')).toEqual(['#6b7280', '#c4c8ce', '#ffffff'])
    })

    test('is none for the palette that follows the accent, which is inked in the one colour', () => {
        expect(soundRampFor('paper')).toBeUndefined()
    })
})
