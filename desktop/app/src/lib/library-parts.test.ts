import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * Parts the client takes from sokkel-ui, and the marks of an own copy coming back.
 *
 * Each pattern moved onto the library adds a row here in the same change, so a hand-built
 * version cannot return unnoticed. A part that needs to differ becomes an option in the
 * library, never a local copy.
 */
const LIBRARY_PARTS: { part: string; use: string; marks: RegExp[] }[] = [
    {
        part: 'the module store',
        use: '@winterop-com/sokkel-ui/lib/stored and @winterop-com/sokkel-ui/hooks/use-store',
        marks: [
            /\bfunction createStore\b/,
            /\bfunction useStore\b/,
            /\bfunction useStoreValue\b/,
            /from '@\/lib\/store'/,
            /from '@\/hooks\/use-store'/,
        ],
    },
]

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return sources(path)
        return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : []
    })
}

describe('parts taken from sokkel-ui', () => {
    const files = sources(SRC).map((path) => ({
        name: relative(SRC, path),
        text: readFileSync(path, 'utf8'),
    }))

    it.each(LIBRARY_PARTS)('$part has no copy in the client', ({ use, marks }) => {
        const copies = files.flatMap(({ name, text }) =>
            marks.filter((mark) => mark.test(text)).map((mark) => `${name}: ${String(mark)}`),
        )
        expect(copies, `use ${use}`).toEqual([])
    })
})
