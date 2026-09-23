/**
 * Which press moves the window, and which one belongs to whatever it landed on.
 *
 * The listener that reads these facts off the DOM is the shell's; the decision it makes with
 * them is the part that can be wrong in a way nobody notices until a button in the title bar
 * stops working, or until the window will not move at all.
 */

import { describe, expect, test } from 'vitest'

import { movesTheWindow } from '@/lib/window-drag'

describe('a press on the top of the window', () => {
    test('moves it when it landed on the strip and on nothing else', () => {
        expect(movesTheWindow({ button: 0, region: true, interactive: false })).toBe(true)
    })

    test('does nothing where it landed outside the strip', () => {
        expect(movesTheWindow({ button: 0, region: false, interactive: false })).toBe(false)
    })

    // The search box, the palette button and the theme toggle all live in the top strip, and a
    // strip that swallowed their presses would be a title bar with dead controls in it.
    test('leaves a control in the strip to do its own job', () => {
        expect(movesTheWindow({ button: 0, region: true, interactive: true })).toBe(false)
    })

    test('is the primary button and no other, because the others open menus', () => {
        expect(movesTheWindow({ button: 1, region: true, interactive: false })).toBe(false)
        expect(movesTheWindow({ button: 2, region: true, interactive: false })).toBe(false)
    })
})
