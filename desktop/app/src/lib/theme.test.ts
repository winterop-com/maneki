import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import {
    DEFAULT_PALETTE,
    PALETTE_ATTRIBUTE,
    PALETTE_NAMES,
    PALETTE_STORAGE_KEY,
    PALETTES,
    paletteAfter,
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

    test('writes the attribute the palettes hang off', () => {
        expect(html).toContain(`'${PALETTE_ATTRIBUTE}', palette`)
    })
})

/**
 * A palette is two blocks of CSS and one row, and these are the two blocks.
 *
 * WHY A TEST READS A STYLESHEET. Because a palette's selector outranks `.dark`, a token named in
 * the light half alone is a light value leaking into the dark mode -- and nothing about that
 * fails to compile, fails to lint or looks wrong until somebody switches the appearance on the
 * one screen that draws it. The rule is mechanical, so it is checked mechanically.
 *
 * The default is not in here. `:root` and `.dark` are the base rather than a palette: they are
 * what every palette falls through to, so they are allowed to say things in one half that the
 * other has no need of.
 */
describe('every palette beside the default', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8').replaceAll(
        /\/\*[\s\S]*?\*\//g,
        '',
    )
    const beside = PALETTES.filter((palette) => palette.name !== DEFAULT_PALETTE)

    /** The tokens one block names, for the block whose selector list starts with `head`. */
    const tokens = (head: string) => {
        const at = css.indexOf(head)
        if (at === -1) return null
        const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
        return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((found) => found[1]))
    }

    /** The five the swatch card draws, and the two the identity is spent through. */
    const REQUIRED = [
        '--background',
        '--card',
        '--border',
        '--foreground',
        '--primary',
        '--primary-foreground',
        '--ring',
    ]

    test.each(beside)('$name has both halves, each answering to data-palette', ({ name }) => {
        expect(css).toContain(`html[data-theme='${name}'],\n[data-palette='${name}'] {`)
        expect(css).toContain(`html.dark[data-theme='${name}'],\n.dark [data-palette='${name}'] {`)
    })

    test.each(beside)('$name names the same tokens in both modes', ({ name }) => {
        const light = tokens(`html[data-theme='${name}']`)
        const dark = tokens(`html.dark[data-theme='${name}']`)
        expect(light).not.toBeNull()
        expect(dark).not.toBeNull()
        // Sorted, so a failure names the tokens rather than reporting two sets of unequal size.
        expect([...(light ?? [])].toSorted()).toEqual([...(dark ?? [])].toSorted())
    })

    test.each(beside)('$name paints the ground, the line, the ink and the accent', ({ name }) => {
        for (const half of [`html[data-theme='${name}']`, `html.dark[data-theme='${name}']`]) {
            for (const token of REQUIRED) expect(tokens(half)).toContain(token)
        }
    })
})

describe('the arrows over the swatch cards', () => {
    test('walk the row in the order it is drawn', () => {
        expect(paletteAfter('maneki', 'ArrowRight')).toBe('paper')
        expect(paletteAfter('paper', 'ArrowLeft')).toBe('maneki')
        expect(paletteAfter('tokyo', 'ArrowDown')).toBe('vinyl')
    })

    test('wrap at both ends, so no card is a dead stop', () => {
        expect(paletteAfter(PALETTE_NAMES[PALETTE_NAMES.length - 1], 'ArrowRight')).toBe('maneki')
        expect(paletteAfter('maneki', 'ArrowLeft')).toBe(PALETTE_NAMES[PALETTE_NAMES.length - 1])
    })

    test('answer nothing to a key this control does not own', () => {
        expect(paletteAfter('maneki', 'Enter')).toBeNull()
    })
})
