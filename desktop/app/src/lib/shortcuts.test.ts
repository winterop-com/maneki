import { describe, expect, test } from 'vitest'

import {
    adjustsVolume,
    applePlatform,
    isTypingField,
    opensLyrics,
    opensPalette,
    opensSearch,
    opensShortcuts,
    opensStage,
    seeks,
    shortcuts,
    starsCurrent,
    togglesMute,
    togglesPanel,
    togglesPlayback,
    togglesRail,
    togglesVisualizer,
    steps,
    SEEK_STEP_S,
    VOLUME_STEP,
} from '@/lib/shortcuts'

function press(
    key: string,
    modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) {
    return { key, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

const TEXT_BOX = { tagName: 'INPUT', isContentEditable: false }
const PROSE = { tagName: 'DIV', isContentEditable: true }

describe('the palette chord', () => {
    test('answers either modifier, because both mean the palette everywhere it exists', () => {
        expect(opensPalette(press('k', { metaKey: true }))).toBe(true)
        expect(opensPalette(press('k', { ctrlKey: true }))).toBe(true)
    })

    test('is a letter, matched by the character the press produced', () => {
        expect(opensPalette(press('K', { metaKey: true }))).toBe(true)
    })

    test('needs a modifier, so typing k into a box is typing', () => {
        expect(opensPalette(press('k'))).toBe(false)
    })

    test('refuses Alt, which a Nordic layout needs for other characters entirely', () => {
        expect(opensPalette(press('k', { metaKey: true, altKey: true }))).toBe(false)
    })
})

describe('the rail chord', () => {
    test('is Cmd on an Apple keyboard and Ctrl everywhere else', () => {
        expect(togglesRail(press('b', { metaKey: true }), null, true)).toBe(true)
        expect(togglesRail(press('b', { ctrlKey: true }), null, false)).toBe(true)
    })

    test('leaves Ctrl+B alone on macOS, where every text field answers it', () => {
        expect(togglesRail(press('b', { ctrlKey: true }), null, true)).toBe(false)
    })

    test('fires while a box has focus, because that is when clearing the screen is worth most', () => {
        expect(togglesRail(press('b', { metaKey: true }), TEXT_BOX, true)).toBe(true)
    })

    test('leaves a rich-text region alone, where the chord has meant bold for forty years', () => {
        expect(togglesRail(press('b', { metaKey: true }), PROSE, true)).toBe(false)
    })
})

describe('the shortcuts key', () => {
    test('is the character, whatever the layout pressed to make it', () => {
        expect(opensShortcuts(press('?'), null)).toBe(true)
    })

    test('never interrupts something being typed into', () => {
        expect(opensShortcuts(press('?'), TEXT_BOX)).toBe(false)
        expect(opensShortcuts(press('?'), PROSE)).toBe(false)
    })

    test('refuses every chord modifier, each of which means something else somewhere', () => {
        expect(opensShortcuts(press('?', { metaKey: true }), null)).toBe(false)
        expect(opensShortcuts(press('?', { altKey: true }), null)).toBe(false)
    })
})

describe('the transport keys', () => {
    test('space starts and stops, whatever the layout', () => {
        expect(togglesPlayback(press(' '), null)).toBe(true)
        // Some browsers still name the key rather than the character it produced.
        expect(togglesPlayback(press('Spacebar'), null)).toBe(true)
    })

    test('space belongs to whatever has focus when that is something to press', () => {
        expect(togglesPlayback(press(' '), { tagName: 'BUTTON', isContentEditable: false })).toBe(false)
        expect(togglesPlayback(press(' '), { tagName: 'A', isContentEditable: false })).toBe(false)
        expect(togglesPlayback(press(' '), TEXT_BOX)).toBe(false)
        expect(togglesPlayback(press(' '), PROSE)).toBe(false)
    })

    test("space under a modifier is the browser's, not this app's", () => {
        expect(togglesPlayback(press(' ', { metaKey: true }), null)).toBe(false)
        expect(togglesPlayback(press(' ', { ctrlKey: true }), null)).toBe(false)
        expect(togglesPlayback(press(' ', { altKey: true }), null)).toBe(false)
    })

    test('n and p move along the queue, in either case', () => {
        expect(steps(press('n'), null)).toBe('next')
        expect(steps(press('N'), null)).toBe('next')
        expect(steps(press('p'), null)).toBe('previous')
        expect(steps(press('P'), null)).toBe('previous')
        expect(steps(press('q'), null)).toBeNull()
    })

    test('a letter typed into a box is a letter', () => {
        expect(steps(press('n'), TEXT_BOX)).toBeNull()
        expect(steps(press('p'), PROSE)).toBeNull()
        expect(steps(press('n', { metaKey: true }), null)).toBeNull()
    })

    test('v shows and hides the spectrum, bare and outside a box', () => {
        expect(togglesVisualizer(press('v'), null)).toBe(true)
        expect(togglesVisualizer(press('V'), null)).toBe(true)
        expect(togglesVisualizer(press('v'), TEXT_BOX)).toBe(false)
        expect(togglesVisualizer(press('v', { ctrlKey: true }), null)).toBe(false)
    })

    test('f puts the spectrum over the whole screen, bare and outside a box', () => {
        expect(opensStage(press('f'), null)).toBe(true)
        expect(opensStage(press('F'), null)).toBe(true)
        expect(opensStage(press('f'), TEXT_BOX)).toBe(false)
        // Cmd+F is the browser's find, and taking it would be taking that away.
        expect(opensStage(press('f', { metaKey: true }), null)).toBe(false)
    })

    test('none of them is claimed by anything else this app binds', () => {
        for (const key of [' ', 'n', 'p', 'v', 'f']) {
            expect(opensPalette(press(key))).toBe(false)
            expect(togglesRail(press(key), null, true)).toBe(false)
            expect(opensShortcuts(press(key), null)).toBe(false)
        }
    })
})

describe('the panel chord', () => {
    test('is the platform modifier and J, never the other one', () => {
        expect(togglesPanel(press('j', { metaKey: true }), null, true)).toBe(true)
        expect(togglesPanel(press('j', { ctrlKey: true }), null, true)).toBe(false)
        expect(togglesPanel(press('j', { ctrlKey: true }), null, false)).toBe(true)
        expect(togglesPanel(press('j', { metaKey: true }), null, false)).toBe(false)
    })

    test('leaves prose alone, where the browser claims the letter', () => {
        expect(togglesPanel(press('j', { metaKey: true }), PROSE, true)).toBe(false)
    })
})
describe('the list of shortcuts', () => {
    test('binds letters and nothing else, because a bracket needs Alt on a Nordic layout', () => {
        const bound = shortcuts(true).flatMap((row) => row.keys)
        expect(bound.filter((key) => /^[[\]{}|\\]$/.test(key))).toEqual([])
    })

    test('spells the modifier the way the platform spells it', () => {
        expect(shortcuts(true)[0].keys[0]).toBe('⌘')
        expect(shortcuts(false)[0].keys[0]).toBe('Ctrl')
    })
})

describe('what counts as typing', () => {
    test('is a field, a text area, a select, or a rich-text region', () => {
        expect(isTypingField(TEXT_BOX)).toBe(true)
        expect(isTypingField({ tagName: 'TEXTAREA', isContentEditable: false })).toBe(true)
        expect(isTypingField(PROSE)).toBe(true)
        expect(isTypingField({ tagName: 'BUTTON', isContentEditable: false })).toBe(false)
        expect(isTypingField(null)).toBe(false)
    })
})

describe('the platform', () => {
    test('is read off the user agent, which is what decides how a chord is spelled', () => {
        expect(applePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true)
        expect(applePlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false)
    })
})

describe('the arrows', () => {
    test('seek five seconds either way, and nothing else does', () => {
        expect(seeks(press('ArrowLeft'), null)).toBe(-SEEK_STEP_S)
        expect(seeks(press('ArrowRight'), null)).toBe(SEEK_STEP_S)
        expect(seeks(press('ArrowUp'), null)).toBeNull()
        expect(seeks(press('a'), null)).toBeNull()
    })

    test('move the volume the other way about, by a twentieth', () => {
        expect(adjustsVolume(press('ArrowUp'), null)).toBe(VOLUME_STEP)
        expect(adjustsVolume(press('ArrowDown'), null)).toBe(-VOLUME_STEP)
        expect(adjustsVolume(press('ArrowLeft'), null)).toBeNull()
    })

    test('belong to a range input that has focus, which is the scrubber and the level', () => {
        const slider = { tagName: 'INPUT', isContentEditable: false }
        expect(seeks(press('ArrowLeft'), slider)).toBeNull()
        expect(adjustsVolume(press('ArrowUp'), slider)).toBeNull()
    })

    test('belong to a box being typed into, and to the browser under a modifier', () => {
        expect(seeks(press('ArrowLeft'), PROSE)).toBeNull()
        expect(adjustsVolume(press('ArrowUp'), PROSE)).toBeNull()
        expect(seeks(press('ArrowLeft', { metaKey: true }), null)).toBeNull()
        expect(adjustsVolume(press('ArrowUp', { altKey: true }), null)).toBeNull()
    })
})

describe('the rest of the listening keys', () => {
    test('m silences it, bare and outside a box', () => {
        expect(togglesMute(press('m'), null)).toBe(true)
        expect(togglesMute(press('M'), null)).toBe(true)
        expect(togglesMute(press('m'), TEXT_BOX)).toBe(false)
        expect(togglesMute(press('m', { metaKey: true }), null)).toBe(false)
    })

    test('the star is the character, whatever the layout pressed to make it', () => {
        expect(starsCurrent(press('*'), null)).toBe(true)
        expect(starsCurrent(press('8'), null)).toBe(false)
        expect(starsCurrent(press('*'), TEXT_BOX)).toBe(false)
        expect(starsCurrent(press('*', { ctrlKey: true }), null)).toBe(false)
    })

    test('the slash opens the search, and typed into a box it is a slash', () => {
        expect(opensSearch(press('/'), null)).toBe(true)
        // Including inside the search it opened, where the box already has the focus.
        expect(opensSearch(press('/'), TEXT_BOX)).toBe(false)
        expect(opensSearch(press('/', { metaKey: true }), null)).toBe(false)
    })

    test('l puts the words on screen, bare and outside a box', () => {
        expect(opensLyrics(press('l'), null)).toBe(true)
        expect(opensLyrics(press('L'), null)).toBe(true)
        expect(opensLyrics(press('l'), PROSE)).toBe(false)
        expect(opensLyrics(press('l', { ctrlKey: true }), null)).toBe(false)
    })

    test('no two of them answer the same press', () => {
        for (const key of ['m', 'l', '*', '/', 'ArrowLeft', 'ArrowUp']) {
            const answered = [
                togglesMute(press(key), null),
                opensLyrics(press(key), null),
                starsCurrent(press(key), null),
                opensSearch(press(key), null),
                seeks(press(key), null) !== null,
                adjustsVolume(press(key), null) !== null,
            ].filter(Boolean)
            expect(answered).toHaveLength(1)
        }
    })

    test('none of them is claimed by a key this app already bound', () => {
        for (const key of ['m', 'l', '*', '/', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
            expect(steps(press(key), null)).toBeNull()
            expect(togglesPlayback(press(key), null)).toBe(false)
            expect(togglesVisualizer(press(key), null)).toBe(false)
            expect(opensStage(press(key), null)).toBe(false)
            expect(opensShortcuts(press(key), null)).toBe(false)
        }
    })
})
