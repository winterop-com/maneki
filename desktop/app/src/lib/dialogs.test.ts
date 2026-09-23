import { afterEach, describe, expect, test } from 'vitest'

import { anyOpen, dialogsOpen, dialogUp, setDialogOpen, withDialog } from '@/lib/dialogs'

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
        const both = withDialog(withDialog(new Set(), 'settings', true), 'shortcuts', true)
        expect(anyOpen(withDialog(both, 'settings', false))).toBe(true)
        expect(anyOpen(withDialog(withDialog(both, 'settings', false), 'shortcuts', false))).toBe(false)
    })
})

describe('writing a dialog down', () => {
    test('leaves the set it was given alone, so a store publishes on identity', () => {
        const before: ReadonlySet<'settings' | 'shortcuts'> = new Set()
        const after = withDialog(before, 'settings', true)
        expect(before.size).toBe(0)
        expect(after.has('settings')).toBe(true)
        expect(after).not.toBe(before)
    })

    test('answers with itself when it already says what it is being told', () => {
        const open = withDialog(new Set(), 'settings', true)
        expect(withDialog(open, 'settings', true)).toBe(open)
        expect(withDialog(new Set(), 'settings', false)).toBeInstanceOf(Set)
        const shut: ReadonlySet<'settings' | 'shortcuts'> = new Set()
        expect(withDialog(shut, 'settings', false)).toBe(shut)
    })
})
