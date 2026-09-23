import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
    DEFAULT_DENSITY,
    DEFAULT_FONT_SCALE,
    DENSITIES,
    DENSITY_ATTRIBUTE,
    DENSITY_STORAGE_KEY,
    FONT_SCALE_MAX,
    FONT_SCALE_MIN,
    FONT_SCALE_PROPERTY,
    FONT_SCALE_STORAGE_KEY,
    formatFontScale,
    isDensity,
    normalizeFontScale,
} from '@/lib/preferences'

describe('a density', () => {
    test('is one of the two this build has', () => {
        for (const density of DENSITIES) expect(isDensity(density)).toBe(true)
    })

    test('is not a word from somewhere else', () => {
        expect(isDensity('comfy')).toBe(false)
        expect(isDensity('')).toBe(false)
        expect(isDensity(null)).toBe(false)
    })
})

describe('a text scale', () => {
    test('keeps a value the slider could have produced', () => {
        expect(normalizeFontScale(0.85)).toBe(0.85)
        expect(normalizeFontScale(1)).toBe(1)
        expect(normalizeFontScale(1.2)).toBe(1.2)
    })

    test('is clamped into what the app can be drawn at', () => {
        expect(normalizeFontScale(0.1)).toBe(FONT_SCALE_MIN)
        expect(normalizeFontScale(4)).toBe(FONT_SCALE_MAX)
    })

    test('snaps to the step, so a hand-edited value lands where the slider can pick it up', () => {
        expect(normalizeFontScale(1.07)).toBe(1.05)
        expect(normalizeFontScale(1.13)).toBe(1.15)
    })

    test('reads a string, because that is what storage answers with', () => {
        expect(normalizeFontScale('1.1')).toBe(1.1)
    })

    test('answers the default for anything it cannot draw', () => {
        expect(normalizeFontScale('large')).toBe(DEFAULT_FONT_SCALE)
        expect(normalizeFontScale(null)).toBe(DEFAULT_FONT_SCALE)
        expect(normalizeFontScale(undefined)).toBe(DEFAULT_FONT_SCALE)
        expect(normalizeFontScale(Number.NaN)).toBe(DEFAULT_FONT_SCALE)
        expect(normalizeFontScale(-1)).toBe(DEFAULT_FONT_SCALE)
    })

    test('carries no floating-point tail, whatever the arithmetic did', () => {
        for (let scale = FONT_SCALE_MIN; scale <= FONT_SCALE_MAX + 0.001; scale += 0.05) {
            const value = normalizeFontScale(scale)
            expect(Number(value.toFixed(2))).toBe(value)
        }
    })

    test('reads as a percentage of what the browser was set to', () => {
        expect(formatFontScale(1)).toBe('100%')
        expect(formatFontScale(0.85)).toBe('85%')
        expect(formatFontScale(1.2)).toBe('120%')
    })
})

/**
 * Both axes are applied before the first paint by the inline script in index.html, which cannot
 * import this module. These assert the two copies say the same thing.
 */
describe('the pre-paint script', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

    test('reads the keys this module writes', () => {
        expect(html).toContain(DENSITY_STORAGE_KEY)
        expect(html).toContain(FONT_SCALE_STORAGE_KEY)
    })

    test('writes the attribute and the property the sizes hang off', () => {
        expect(html).toContain(`'${DENSITY_ATTRIBUTE}', density`)
        expect(html).toContain(`'${FONT_SCALE_PROPERTY}', String(scale)`)
    })

    test('starts on the defaults, which is what storage saying nothing means', () => {
        expect(html).toContain(`var density = '${DEFAULT_DENSITY}'`)
        expect(html).toContain(`var scale = ${String(DEFAULT_FONT_SCALE)}`)
    })

    test('knows the bounds a stored scale has to be inside', () => {
        expect(html).toContain(`size >= ${String(FONT_SCALE_MIN)} && size <= ${String(FONT_SCALE_MAX)}`)
    })
})
