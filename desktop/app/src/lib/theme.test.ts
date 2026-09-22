import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import { DEFAULT_PALETTE, PALETTE_ATTRIBUTE, PALETTE_NAMES, PALETTE_STORAGE_KEY } from '@/lib/theme'

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
        expect(html).toContain(`'data-theme', '${DEFAULT_PALETTE}'`)
        expect(html).toContain(`'${DEFAULT_PALETTE}' : stored`)
    })

    test('writes the attribute the palettes hang off', () => {
        expect(html).toContain(`'${PALETTE_ATTRIBUTE}'`)
    })
})
