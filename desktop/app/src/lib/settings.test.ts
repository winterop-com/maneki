import { filterSettings } from '@winterop-com/sokkel-ui/SettingsDialog'
import { describe, expect, test } from 'vitest'

import {
    FIRST_CATEGORY,
    SETTINGS_CATEGORIES,
    SETTINGS_GROUPS,
    settingsGroups,
    settingsRows,
    type SettingsRow,
} from '@/lib/settings'
import { shortcuts } from '@/lib/shortcuts'

const ROWS = settingsRows(false)

/** The groups the dialog draws, with no controls: the search reads only the words. */
function groupsOf(rows: readonly SettingsRow[]) {
    return settingsGroups(rows, (row) => ({
        id: row.id,
        title: row.label,
        description: row.description,
        keywords: row.keywords,
        control: null,
    }))
}

const GROUPS = groupsOf(ROWS)

/** The ids of the rows sokkel-ui's search keeps for `search`, in the order they are drawn. */
function found(search: string): string[] {
    return filterSettings(GROUPS, search)
        .flatMap((group) => group.sections)
        .flatMap((section) => section.settings)
        .map((setting) => setting.id)
}

/** The ids of the sections the navigation lists while `search` narrows. */
function sectionsFor(search: string): string[] {
    return filterSettings(GROUPS, search)
        .flatMap((group) => group.sections)
        .map((section) => section.id)
}

/** The rows of one category, as one section of the dialog. */
function rowsOf(rows: readonly SettingsRow[], category: string): SettingsRow[] {
    return rows.filter((row) => row.category === category)
}

describe('the settings registry', () => {
    test('files every row under a category the left nav has', () => {
        const known = new Set(SETTINGS_CATEGORIES.map((category) => category.id))
        for (const row of ROWS) expect(known.has(row.category)).toBe(true)
    })

    test('files every category under a group the left nav has', () => {
        const known = new Set(SETTINGS_GROUPS.map((group) => group.id))
        for (const category of SETTINGS_CATEGORIES) expect(known.has(category.group)).toBe(true)
    })

    test('opens on a category that exists', () => {
        expect(SETTINGS_CATEGORIES.map((category) => category.id)).toContain(FIRST_CATEGORY)
    })

    // The palette carries the spectrum's ramp, so a second colour row would be a second answer
    // to one question -- which is how an ice-blue spectrum ended up under an amber app.
    test('offers the colours in one row, the palette, and nowhere else', () => {
        expect(ROWS.map((row) => row.id)).not.toContain('general:spectrum-theme')
        expect(found('spectrum colour')).toEqual(['theme:palette'])
    })

    test('gives every row an id of its own, because the control on its right is keyed by it', () => {
        expect(new Set(ROWS.map((row) => row.id)).size).toBe(ROWS.length)
    })

    // The shortcut rows are derived rather than written down: a shortcut added to lib/shortcuts
    // appears here without anybody editing this registry, and this fails if it stops being so.
    test('lists exactly the shortcuts this app answers, and does not hold its own list', () => {
        const listed = rowsOf(ROWS, 'shortcuts').map((row) => row.label)
        expect(listed).toEqual(shortcuts(false).map((one) => one.action))
    })

    // The keys are drawn as chips by the pane and are searchable here, which is why they are
    // keywords rather than a description: a row's description is a fact, or it is absent.
    test('spells a chord the way the keyboard in front of somebody spells it', () => {
        const apple = rowsOf(settingsRows(true), 'shortcuts')
        const other = rowsOf(settingsRows(false), 'shortcuts')
        expect(apple[0].keywords).toContain('⌘')
        expect(other[0].keywords).toContain('Ctrl')
    })

    test('carries a description only where it states a fact the control cannot', () => {
        const described = ROWS.filter((row) => row.description !== undefined).map((row) => row.id)
        expect(described).toEqual([
            'general:visualizer',
            'general:spectrum-delay',
            'general:density',
            'general:font-scale',
            'general:autoplay-next',
            'server:address',
            'server:subsonic',
            'server:libraries',
        ])
    })
})

describe('the search box', () => {
    test('an empty search is not a filter and answers every row in order', () => {
        expect(found('')).toEqual(ROWS.map((row) => row.id))
        expect(found('   ')).toHaveLength(ROWS.length)
    })

    test('finds a row by a word in its own name', () => {
        expect(found('appearance')).toEqual(['theme:appearance'])
    })

    test('finds a row by a word nothing renders', () => {
        expect(found('oscilloscope')).toEqual(['general:visualizer-style'])
    })

    test('finds every row of a section by the section name', () => {
        expect(found('account')).toEqual(rowsOf(ROWS, 'account').map((row) => row.id))
    })

    test('reaches across categories, which is the whole point of one box', () => {
        expect(new Set(sectionsFor('palette'))).toEqual(new Set(['theme', 'shortcuts']))
    })

    test('every term has to match, so typing more words narrows', () => {
        expect(found('colour paper').length).toBeLessThan(found('colour').length)
        expect(found('colour paper')).toEqual(['theme:palette'])
    })

    test('is not case sensitive', () => {
        expect(found('UTC')).toEqual(found('utc'))
    })

    test('a search nothing matches answers nothing rather than everything', () => {
        expect(found('stroopwafel')).toEqual([])
    })

    test('does not reorder what it keeps, because a row sits under the heading that explains it', () => {
        const kept = found('the')
        expect(kept).toEqual(ROWS.map((row) => row.id).filter((id) => kept.includes(id)))
    })
})

describe('the navigation while a search narrows', () => {
    test('lists only the sections that still hold a row', () => {
        expect(sectionsFor('appearance')).toEqual(['theme'])
    })

    test('lists nothing when nothing matches', () => {
        expect(sectionsFor('stroopwafel')).toEqual([])
    })

    test('keeps the nav order rather than the order rows happened to match in', () => {
        expect(sectionsFor('')).toEqual(SETTINGS_CATEGORIES.map((category) => category.id))
    })

    test('lays the sections under the group titles they are filed under', () => {
        expect(GROUPS.map((group) => group.title)).toEqual(SETTINGS_GROUPS.map((group) => group.label))
    })
})

describe('the phone row', () => {
    test('is findable by the app somebody is holding', () => {
        for (const app of ['amperfy', 'play:sub', 'symfonium', 'dsub']) {
            expect(found(app)).toContain('server:subsonic')
        }
    })

    test('is findable by what somebody is trying to do', () => {
        expect(found('phone')).toContain('server:subsonic')
        expect(found('offline')).toContain('server:subsonic')
    })
})

describe('listening without a server', () => {
    test('has no account and no server to describe, so neither is offered', () => {
        // Radio-only said "Signed in as: nobody", "Address: this origin" and an empty version.
        const radioOnly = settingsRows(false, { server: false })
        expect(radioOnly.some((row) => row.category === 'account' || row.category === 'server')).toBe(false)
        expect(radioOnly.some((row) => row.category === 'general')).toBe(true)
        expect(settingsRows(false).some((row) => row.category === 'server')).toBe(true)
        expect(groupsOf(radioOnly).map((group) => group.id)).toEqual(['preferences'])
    })
})

describe("the app's own version", () => {
    test('is a row wherever settings open, radio-only too, apart from the server it talks to', () => {
        for (const rows of [settingsRows(false), settingsRows(false, { server: false })]) {
            const row = rows.find((one) => one.id === 'general:app-version')
            expect(row?.category).toBe('general')
        }
    })
})
