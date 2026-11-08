import { describe, expect, test } from 'vitest'

import { clampDelayMs, outputDelayMs, SPECTRUM_DELAY_MAX_MS, spectrumDelayMs } from '@/lib/sync'

describe('how far behind the speakers are', () => {
    test('is both halves of what the browser reports, in milliseconds', () => {
        expect(outputDelayMs({ baseLatency: 0.005, outputLatency: 0.2 })).toBeCloseTo(205, 6)
    })

    test('is nothing at all where there is no graph to ask', () => {
        expect(outputDelayMs(null)).toBe(0)
        expect(outputDelayMs(undefined)).toBe(0)
    })

    test('reads each half for itself, so a browser that has only one still counts', () => {
        expect(outputDelayMs({ baseLatency: 0.01 })).toBeCloseTo(10, 6)
        expect(outputDelayMs({ outputLatency: 0.01 })).toBeCloseTo(10, 6)
    })

    test('counts nonsense as nothing rather than letting it poison the sum', () => {
        expect(outputDelayMs({ baseLatency: Number.NaN, outputLatency: 0.1 })).toBeCloseTo(100, 6)
        expect(outputDelayMs({ baseLatency: -1, outputLatency: 0.1 })).toBeCloseTo(100, 6)
        expect(outputDelayMs({})).toBe(0)
    })
})

describe('the delay somebody dials in', () => {
    test('starts at nothing, because most output has nothing to compensate for', () => {
        expect(spectrumDelayMs.get()).toBe(0)
    })

    test('stays inside its bounds whatever it is handed', () => {
        expect(clampDelayMs(-50)).toBe(0)
        expect(clampDelayMs(SPECTRUM_DELAY_MAX_MS + 500)).toBe(SPECTRUM_DELAY_MAX_MS)
        expect(clampDelayMs(Number.NaN)).toBe(0)
        expect(clampDelayMs(120.4)).toBe(120)
    })
})
