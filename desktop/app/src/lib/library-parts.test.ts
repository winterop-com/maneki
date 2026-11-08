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
    {
        part: 'the download button',
        use: '@winterop-com/sokkel-ui/DownloadButton',
        marks: [/\bfunction DownloadButton\b/, /aria-label="Download this album/],
    },
    {
        part: 'the look: Tailwind, the tokens and the palettes',
        use: '@winterop-com/sokkel-ui/styles.css and its themes/<name>.css, imported by index.css',
        marks: [/^@import 'tailwindcss'/m, /^@theme\b/m, /^(html(\.dark)?)?\[data-theme='[a-z]+'\][^{]*\{/m],
    },
    {
        part: 'the rail and its phone drawer',
        use: '@winterop-com/sokkel-ui/Rail in the Shell, which draws the drawer itself',
        marks: [/\bfunction Rail\b/, /\bfunction RailEntry\b/, /\bfunction NavDrawer\b/],
    },
    {
        part: 'the account menu',
        use: '@winterop-com/sokkel-ui/AccountMenu in the rail foot',
        marks: [/\bfunction AccountMenu\b/],
    },
    {
        part: 'the status line',
        use: "@winterop-com/sokkel-ui/StatusLine as the Shell's foot",
        marks: [/\bfunction StatusBar\b/],
    },
    {
        part: 'the command palette',
        use: "the Shell's palette, with @winterop-com/sokkel-ui/hooks/use-commands for a screen's rows",
        marks: [/\bfunction CommandPalette\b/, /\bfunction registerActions\b/, /\bfunction shelve\b/],
    },
    {
        part: 'the shortcuts dialog',
        use: "the Shell's `shortcuts`, which binds `?` once",
        marks: [/\bfunction ShortcutsDialog\b/],
    },
    {
        part: 'the light and dark switch',
        use: '@winterop-com/sokkel-ui/SchemeToggle and hooks/use-scheme',
        marks: [/\bfunction ThemeToggle\b/, /from ['"]next-themes['"]/],
    },
    {
        part: 'the desktop title strip',
        use: "the Shell's `desktop`, which marks the strips and hands a press to the window",
        marks: [/\binstallWindowDrag\b/, /-webkit-app-region:\s*drag\s*;/],
    },
]

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return sources(path)
        return /\.(tsx?|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : []
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
