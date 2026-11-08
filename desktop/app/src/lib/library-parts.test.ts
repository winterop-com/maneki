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
    {
        part: 'the player bar',
        use: '@winterop-com/sokkel-ui-media/MediaBar over the player store',
        marks: [
            /aria-label="Position"/,
            /\bfunction VolumeGlyph\b/,
            /\bfunction useDragSize\b/,
            /\bfunction bandsFor\b/,
        ],
    },
    {
        part: "the player's fullscreen view",
        use: "MediaBar's own fullscreen view, held open by `stageOpen` and `lyricsOpen`",
        marks: [/\bfunction FullscreenVisualizer\b/, /\bfunction LyricsOverlay\b/],
    },
    {
        part: 'the spectrum drawing',
        use: '@winterop-com/sokkel-ui/media/SoundVisualizer on the player analyser',
        marks: [
            /\bfunction useSpectrum\b/,
            /\bfunction ridgeFromTops\b/,
            /\bfunction scopePoints\b/,
            /\bfunction paintColumns\b/,
        ],
    },
    {
        part: 'the lyrics parser and view',
        use: '@winterop-com/sokkel-ui-media/lrc and Lyrics',
        marks: [/\bfunction fromText\b/, /\bfunction lineAt\b/, /\bconst TIMESTAMP = /],
    },
    {
        part: 'the media session',
        use: '@winterop-com/sokkel-ui-media/use-media-session',
        marks: [/\bsetActionHandler\(/, /\bsetPositionState\(/, /\bfunction installMediaSession\b/],
    },
    {
        part: 'the play order, shuffle and repeat',
        use: '@winterop-com/sokkel-ui-media/queue',
        marks: [
            /\bfunction buildOrder\b/,
            /\bfunction afterSkip\b/,
            /\bfunction reorderAround\b/,
            /\bfunction nextRepeat\b/,
        ],
    },
    {
        part: 'the book timeline arithmetic',
        use: '@winterop-com/sokkel-ui-media/timeline and chapters, read through lib/book-timeline',
        marks: [/wanted < file\.offset_s/, /\(file\?\.offset_s \?\? 0\)/],
    },
    {
        part: 'the drawn cover',
        use: '@winterop-com/sokkel-ui-media/Artwork with `seed`',
        marks: [/\bfunction CoverArt\b/, /\bfunction coverFace\b/, /from '@\/lib\/covers'/],
    },
    {
        part: "a book's chapter list",
        use: '@winterop-com/sokkel-ui-media/ChapterList',
        marks: [/<ol ref=\{chapters\}/],
    },
    {
        part: "the library's private modules",
        use: 'the public parts only: Shell, hooks/use-shortcuts, MediaBar and its rowsHeightFor',
        marks: [
            /from '@winterop-com\/sokkel-ui\/lib\/shortcuts'/,
            /from '@winterop-com\/sokkel-ui\/shell-context'/,
            /from '@winterop-com\/sokkel-ui-media\/bar-growth'/,
        ],
    },
    {
        part: "the top bar's search field",
        use: "@winterop-com/sokkel-ui/SearchField in TopBar's `search`, which binds `/`",
        marks: [/\bfunction SearchBox\b/, /from '@\/components\/SearchBox'/],
    },
    {
        part: "the shell's shortcuts and content key",
        use: "the Shell's `shortcutsOpen` and `contentKey`",
        marks: [/\bfunction ShellBridge\b/, /\bShellShortcuts\b/, /<div key=\{recovered\}/],
    },
    {
        part: "the palette's term filter and scheme and palette rows",
        use: 'the Shell\'s `paletteFilter="terms"` and lib/commands\' appearanceCommands',
        marks: [/\bfunction filterActions\b/, /id: `appearance:palette-/, /id: `appearance:\$\{mode\}`/],
    },
    {
        part: "the spectrum's ramp, mirror and stage effects",
        use: "SoundVisualizer's `ramp`, `align` and `effect`",
        marks: [
            /\bfunction themeGradient\b/,
            /\bfunction themeSweep\b/,
            /\bcreateLinearGradient\(/,
            /\.shadowBlur = /,
        ],
    },
    {
        part: "the bar's frame clock",
        use: "MediaBar's `getPosition`, and use-frame-position for the deck's readout",
        marks: [/requestAnimationFrame\(tick\)/],
    },
    {
        part: "the fullscreen view's star",
        use: "@winterop-com/sokkel-ui/StarButton in MediaBar's `fullscreenActions`",
        marks: [/aria-label=\{starred \? 'Unstar this track'/],
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
