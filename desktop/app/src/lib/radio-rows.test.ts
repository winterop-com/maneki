import { describe, expect, test } from 'vitest'

import { stationIsPlaying } from '@/lib/radio-rows'

const row = { id: 'st_1', streamUrl: 'https://s.example/live' }

describe('whether a station row is the one playing', () => {
    test('is the station the player holds', () => {
        expect(stationIsPlaying(row, { id: 'st_1', streamUrl: row.streamUrl }, false, true)).toBe(true)
        expect(stationIsPlaying(row, { id: 'st_2', streamUrl: 'https://other' }, false, true)).toBe(false)
        expect(stationIsPlaying(row, null, false, true)).toBe(false)
    })

    test('is the station tried from search and then kept, under its new id', () => {
        // The preview played as `found:<uuid>`, so the saved station never lit up.
        expect(stationIsPlaying(row, { id: 'found:abc', streamUrl: row.streamUrl }, false, true)).toBe(true)
    })

    test('is not a station that would not play', () => {
        // A dead station said "playing" next to the bar saying "No sound from".
        expect(stationIsPlaying(row, { id: 'st_1', streamUrl: row.streamUrl }, true, true)).toBe(false)
    })
})

describe('a station paused', () => {
    test('is not playing, though it is still the one held', () => {
        // After Pause the row kept saying "playing" beside a bar offering Play.
        expect(stationIsPlaying(row, { id: 'st_1', streamUrl: row.streamUrl }, false, false)).toBe(false)
    })
})
