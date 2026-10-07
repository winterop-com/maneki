import { describe, expect, test } from 'vitest'

import { RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, clampRailWidth, railWidth, setRailWidth } from '@/lib/panels'

describe('the rail width', () => {
    test('clamps a drag to what the labels need and the screen affords', () => {
        expect(clampRailWidth(20)).toBe(RAIL_MIN_WIDTH)
        expect(clampRailWidth(9000)).toBe(RAIL_MAX_WIDTH)
        expect(clampRailWidth(228.6)).toBe(229)
    })

    test('keeps the dragged width and clamps what it stores', () => {
        setRailWidth(500)
        expect(railWidth.get()).toBe(RAIL_MAX_WIDTH)
        setRailWidth(240)
        expect(railWidth.get()).toBe(240)
    })
})
