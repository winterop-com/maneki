import { afterEach, describe, expect, test } from 'vitest'

import {
    anyOpen,
    dialogsOpen,
    dialogUp,
    mayOpen,
    mayOpenPaletteOver,
    menuStanding,
    setDialogOpen,
    withDialog,
} from '@/lib/dialogs'

afterEach(() => {
    dialogsOpen.set(new Set())
})

describe('what is standing over the app', () => {
    test('is nothing until something says so', () => {
        expect(anyOpen(new Set())).toBe(false)
        expect(dialogUp()).toBe(false)
    })

    // Regression: the bare keys fired through an open dialog, so `/` opened the search over a
    // settings pane and `f` put the spectrum on the whole screen behind it.
    test('is true while either dialog is up, which is what stops a bare key', () => {
        setDialogOpen('settings', true)
        expect(dialogUp()).toBe(true)
        setDialogOpen('settings', false)
        expect(dialogUp()).toBe(false)
    })

    test('holds each dialog by name, so one closing does not answer for the other', () => {
        const both = withDialog(withDialog(new Set(), 'settings', true), 'palette', true)
        expect(anyOpen(withDialog(both, 'settings', false))).toBe(true)
        expect(anyOpen(withDialog(withDialog(both, 'settings', false), 'palette', false))).toBe(false)
    })
})

describe('writing a dialog down', () => {
    test('leaves the set it was given alone, so a store publishes on identity', () => {
        const before: ReadonlySet<'settings' | 'palette'> = new Set()
        const after = withDialog(before, 'settings', true)
        expect(before.size).toBe(0)
        expect(after.has('settings')).toBe(true)
        expect(after).not.toBe(before)
    })

    test('answers with itself when it already says what it is being told', () => {
        const open = withDialog(new Set(), 'settings', true)
        expect(withDialog(open, 'settings', true)).toBe(open)
        expect(withDialog(new Set(), 'settings', false)).toBeInstanceOf(Set)
        const shut: ReadonlySet<'settings' | 'palette'> = new Set()
        expect(withDialog(shut, 'settings', false)).toBe(shut)
    })
})

describe('a key that opens something over what is already open', () => {
    const nothing = { dialog: false, stage: false, lyrics: false, song: true }

    test('opens when nothing stands in front', () => {
        for (const opener of ['palette', 'search', 'shortcuts', 'lyrics', 'stage'] as const) {
            expect(mayOpen(opener, nothing)).toBe(true)
        }
    })

    test('does not stack the palette on a dialog, where Escape then left the dialog stuck', () => {
        expect(mayOpen('palette', { ...nothing, dialog: true })).toBe(false)
    })

    test('does not stack a dialog on the stage or on the lyrics', () => {
        for (const opener of ['palette', 'search', 'shortcuts', 'lyrics'] as const) {
            expect(mayOpen(opener, { ...nothing, stage: true })).toBe(false)
        }
        expect(mayOpen('stage', { ...nothing, lyrics: true })).toBe(false)
        expect(mayOpen('search', { ...nothing, lyrics: true })).toBe(false)
    })

    test('opens no lyrics over a station, which has none', () => {
        // `l` during a station put up a full-screen "Nothing is playing."
        expect(mayOpen('lyrics', { ...nothing, song: false })).toBe(false)
    })
})

describe('a menu standing open', () => {
    test('takes every key: the app answers none while one is open', () => {
        // Arrows in the account menu also seeked the track, Space played instead of choosing,
        // and type-ahead letters toggled shuffle and mute.
        const withMenu = {
            querySelector: (selector: string) => (selector.includes('dropdown-menu-content') ? {} : null),
        }
        const without = { querySelector: () => null }
        expect(menuStanding(withMenu)).toBe(true)
        expect(menuStanding(without)).toBe(false)
    })
})

describe('the palette over a layer', () => {
    // The search's results are a popover, which the shell counts as a layer: Cmd+K from the
    // field replaces them, and nothing else that stands over the page.
    const results = { querySelector: () => ({ id: 'r1-results' }) } as unknown as Element
    const settings = { querySelector: () => null } as unknown as Element
    const field = { getAttribute: () => 'r1-results' }
    const page = { querySelectorAll: () => [field] } as unknown as Document
    const standing = { dialog: false, stage: false, lyrics: false, song: false }

    test("opens over the library search's results, which it replaces", () => {
        expect(mayOpenPaletteOver(results, standing, page)).toBe(true)
    })

    test('opens over no other layer, such as Settings', () => {
        expect(mayOpenPaletteOver(settings, standing, page)).toBe(false)
        const noField = { querySelectorAll: () => [] } as unknown as Document
        expect(mayOpenPaletteOver(results, standing, noField)).toBe(false)
    })

    test('keeps to the app rules over nothing: not over the stage or the lyrics', () => {
        expect(mayOpenPaletteOver(null, standing, page)).toBe(true)
        expect(mayOpenPaletteOver(null, { ...standing, stage: true }, page)).toBe(false)
        expect(mayOpenPaletteOver(null, { ...standing, lyrics: true }, page)).toBe(false)
    })
})
