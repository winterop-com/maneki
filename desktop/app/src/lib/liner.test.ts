import { describe, expect, test } from 'vitest'

import { announced } from '@/lib/liner'

describe('what a station announced', () => {
    test('loses the station introducing itself', () => {
        expect(announced('NRK mP3 - Alltid musikk: PILLOWTALK, ZAYN', 'NRK mP3')).toBe('PILLOWTALK, ZAYN')
        expect(announced('P3 Musikk: The Feeling, Steve Lacy', 'NRK P3 Musikk')).toBe(
            'The Feeling, Steve Lacy',
        )
    })

    test('keeps a colon that belongs to the song', () => {
        expect(announced('Daft Punk - Harder: Better', 'Nectarine Demoscene Radio')).toBe(
            'Daft Punk - Harder: Better',
        )
        expect(announced('Purple Motion - Satellite One', 'Nectarine Demoscene Radio')).toBe(
            'Purple Motion - Satellite One',
        )
    })

    test('keeps the whole line when nothing follows the colon', () => {
        expect(announced('NRK P3: ', 'NRK P3')).toBe('NRK P3: ')
    })
})
