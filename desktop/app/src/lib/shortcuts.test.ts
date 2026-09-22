import { describe, expect, test } from 'vitest'

import {
    applePlatform,
    isTypingField,
    opensPalette,
    opensShortcuts,
    shortcuts,
    togglesPanel,
    togglesPlayback,
    togglesRail,
    togglesVisualizer,
    steps,
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

    test('none of them is claimed by anything else this app binds', () => {
        for (const key of [' ', 'n', 'p', 'v']) {
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
