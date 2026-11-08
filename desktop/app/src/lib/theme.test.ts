import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
    DEFAULT_PALETTE,
    PALETTE_ATTRIBUTE,
    PALETTE_NAMES,
    PALETTE_STORAGE_KEY,
    paletteAfter,
    RENAMED_PALETTES,
    storedPalette,
} from '@/lib/theme'

/**
 * The palette is applied before the first paint by an inline script in
 * index.html, which cannot import this module. These assert the two copies
 * of the names say the same thing.
 */
describe('the pre-paint script', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

    test('knows every palette', () => {
        for (const name of PALETTE_NAMES) expect(html).toContain(`'${name}'`)
    })

    test('reads the key this module writes', () => {
        expect(html).toContain(PALETTE_STORAGE_KEY)
    })

    test('falls back to the default palette when storage says nothing usable', () => {
        expect(html).toContain(`var palette = '${DEFAULT_PALETTE}'`)
    })

    test('reads a renamed palette as the one it is now', () => {
        for (const [old, now] of Object.entries(RENAMED_PALETTES)) {
            expect(html).toContain(`if (stored === '${old}') stored = '${now}'`)
        }
    })

    test('writes the attribute the palettes hang off', () => {
        expect(html).toContain(`'${PALETTE_ATTRIBUTE}', palette`)
    })
})

/**
 * Every palette but tidevann is a sokkel-ui theme file. The tokens in it, and the rule that both
 * modes name the same ones, are the library's to hold; what is left here is that each palette
 * this build offers is imported, so choosing one never paints the library's base under its name.
 * Tidevann is that base: it ships in styles.css with no file of its own.
 */
describe('every palette', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const BASE = 'tidevann'

    test.each(PALETTE_NAMES.filter((name) => name !== BASE))('%s is imported from sokkel-ui', (name) => {
        expect(css).toContain(`@import '@winterop-com/sokkel-ui/themes/${name}.css';`)
    })

    test('tidevann is the base, worn from the styles every palette starts from', () => {
        expect(PALETTE_NAMES).toContain(BASE)
        expect(css).toContain(`@import '@winterop-com/sokkel-ui/styles.css';`)
        expect(css).not.toContain(`themes/${BASE}.css`)
    })

    test('no renamed palette is offered under its old name', () => {
        for (const old of Object.keys(RENAMED_PALETTES)) expect(PALETTE_NAMES).not.toContain(old)
    })
})

/** The palette a load starts on, with `value` in storage. */
function storing(value: string | null) {
    vi.stubGlobal('localStorage', { getItem: () => value })
    return storedPalette()
}

describe('the palette a load starts on', () => {
    afterEach(() => vi.unstubAllGlobals())

    test('is tidevann when nothing is stored', () => {
        expect(storing(null)).toBe('tidevann')
    })

    test('keeps a palette somebody chose', () => {
        expect(storing('amber')).toBe('amber')
        expect(storing('tokyo')).toBe('tokyo')
    })

    test('keeps amber for a stored maneki, the name the old default was kept under', () => {
        expect(storing('maneki')).toBe('amber')
    })
})

describe('the arrows over the swatch cards', () => {
    test('walk the row in the order it is drawn', () => {
        expect(paletteAfter('tidevann', 'ArrowRight')).toBe('amber')
        expect(paletteAfter('amber', 'ArrowRight')).toBe('paper')
        expect(paletteAfter('paper', 'ArrowLeft')).toBe('amber')
        expect(paletteAfter('tokyo', 'ArrowDown')).toBe('vinyl')
    })

    test('wrap at both ends, so no card is a dead stop', () => {
        expect(paletteAfter(PALETTE_NAMES[PALETTE_NAMES.length - 1], 'ArrowRight')).toBe('tidevann')
        expect(paletteAfter('tidevann', 'ArrowLeft')).toBe(PALETTE_NAMES[PALETTE_NAMES.length - 1])
    })

    test('answer nothing to a key this control does not own', () => {
        expect(paletteAfter('amber', 'Enter')).toBeNull()
    })
})
