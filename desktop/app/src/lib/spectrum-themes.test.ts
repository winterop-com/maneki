import { describe, expect, test } from 'vitest'

import {
    DEFAULT_SPECTRUM_THEME,
    isSpectrumTheme,
    SPECTRUM_THEMES,
    spectrumTheme,
    spectrumThemeAfter,
    themeGradient,
    themeStops,
    themeSweep,
    type SpectrumTheme,
} from '@/lib/spectrum-themes'

/** A gradient that remembers what was asked of it, because Node has no canvas. */
function makeGradient(box: readonly number[]) {
    const stops: [number, string][] = []
    return {
        box,
        stops,
        addColorStop: (offset: number, colour: string) => {
            stops.push([offset, colour])
        },
    }
}

/** The little of a canvas context this module touches. */
function fakeContext() {
    const made: ReturnType<typeof makeGradient>[] = []
    return {
        made,
        createLinearGradient: (x0: number, y0: number, x1: number, y1: number) => {
            const gradient = makeGradient([x0, y0, x1, y1])
            made.push(gradient)
            return gradient
        },
    }
}

describe('the themes on offer', () => {
    test('names each one once, and each one has something to call it', () => {
        expect(new Set(SPECTRUM_THEMES.map((one) => one.name)).size).toBe(SPECTRUM_THEMES.length)
        for (const theme of SPECTRUM_THEMES) expect(theme.label).toBeTruthy()
    })

    test('follows the accent by default, and offers that first', () => {
        expect(DEFAULT_SPECTRUM_THEME).toBe('accent')
        expect(SPECTRUM_THEMES[0].name).toBe('accent')
        expect(spectrumTheme.get()).toBe('accent')
    })

    test('knows its own names and nothing else', () => {
        expect(isSpectrumTheme('fire')).toBe(true)
        expect(isSpectrumTheme('maneki')).toBe(false)
        expect(isSpectrumTheme(null)).toBe(false)
    })
})

describe('moving through the swatches', () => {
    test('goes either way and wraps at both ends, because the cards are a radio group', () => {
        const last = SPECTRUM_THEMES.at(-1)!.name
        expect(spectrumThemeAfter('accent', 'ArrowRight')).toBe('fire')
        expect(spectrumThemeAfter('accent', 'ArrowLeft')).toBe(last)
        expect(spectrumThemeAfter(last, 'ArrowRight')).toBe('accent')
    })

    test('answers down and up the same as right and left, for a row that has wrapped', () => {
        expect(spectrumThemeAfter('accent', 'ArrowDown')).toBe('fire')
        expect(spectrumThemeAfter('fire', 'ArrowUp')).toBe('accent')
    })

    test('says nothing about a key this control does not answer', () => {
        expect(spectrumThemeAfter('fire', 'Enter')).toBeNull()
        expect(spectrumThemeAfter('fire', 'Tab')).toBeNull()
    })
})

describe('the ramp a theme paints', () => {
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

describe('the gradient a frame is painted with', () => {
    test('puts the quiet colour on the floor and the loud one at the top', () => {
        const context = fakeContext()
        const gradient = themeGradient('fire', context, 40, '#000000')
        expect(gradient.box).toEqual([0, 0, 0, 40])
        expect(gradient.stops).toEqual([
            [1, '#ffd24a'],
            [0.5, '#ff7a1a'],
            [0, '#e02020'],
        ])
    })

    test('lays the same ramp left to right for a scope, which has no height to read', () => {
        const context = fakeContext()
        const gradient = themeSweep('fire', context, 200, '#000000')
        expect(gradient.box).toEqual([0, 0, 200, 0])
        expect(gradient.stops.map(([offset]) => offset)).toEqual([0, 0.5, 1])
    })

    test('paints the accent it is handed, at both ends, when the theme follows it', () => {
        const context = fakeContext()
        expect(themeGradient('accent', context, 40, 'rgb(1, 2, 3)').stops).toEqual([
            [0, 'rgb(1, 2, 3)'],
            [1, 'rgb(1, 2, 3)'],
        ])
    })

    test('builds one and hands it back, because a gradient a frame is the expensive call', () => {
        const context = fakeContext()
        const first = themeGradient('ice', context, 40, '#000000')
        expect(themeGradient('ice', context, 40, '#000000')).toBe(first)
        expect(context.made).toHaveLength(1)
    })

    test('builds another when the theme, the size or the accent moves', () => {
        const context = fakeContext()
        themeGradient('ice', context, 40, '#000000')
        themeGradient('fire', context, 40, '#000000')
        themeGradient('ice', context, 41, '#000000')
        themeGradient('ice', context, 40, '#ffffff')
        themeSweep('ice', context, 40, '#000000')
        expect(context.made).toHaveLength(5)
    })

    test('keeps each canvas to its own, so the strip cannot hand the stage a gradient', () => {
        const strip = fakeContext()
        const stage = fakeContext()
        expect(themeGradient('ice', strip, 40, '#000000')).not.toBe(
            themeGradient('ice', stage, 40, '#000000'),
        )
    })
})
