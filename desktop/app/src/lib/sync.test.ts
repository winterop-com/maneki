import { describe, expect, test } from 'vitest'

import {
    clampDelayMs,
    DELAY_FLOOR_MS,
    makeDelayLine,
    outputDelayMs,
    SPECTRUM_DELAY_MAX_MS,
    spectrumDelayMs,
} from '@/lib/sync'

/** A frame every bin of which says the same thing, so a frame can be named by its level. */
function frame(level: number, width = 4): Uint8Array {
    return new Uint8Array(width).fill(level)
}

/** What a frame says, which is how a test names the one it got back. */
function levelOf(read: Uint8Array): number {
    return read[0]
}

describe('the delay line', () => {
    test('hands back the freshest frame when nothing is behind', () => {
        const line = makeDelayLine(4)
        line.push(frame(10), 0)
        line.push(frame(20), 16)
        expect(levelOf(line.read(0))).toBe(20)
    })

    test('hands back the frame from as long ago as the output is behind', () => {
        const line = makeDelayLine(4)
        // One frame every 16ms, counting up, and the newest is the one at 160ms.
        for (let at = 0; at <= 10; at += 1) line.push(frame(at), at * 16)
        // 100ms back from 160 is 60ms, and the first frame at or before that is the one at 48.
        expect(levelOf(line.read(100))).toBe(3)
    })

    test('ignores a delay too small to see, because the freshest frame is the honest one', () => {
        const line = makeDelayLine(4)
        line.push(frame(1), 0)
        line.push(frame(2), 16)
        expect(levelOf(line.read(DELAY_FLOOR_MS))).toBe(2)
        expect(levelOf(line.read(DELAY_FLOOR_MS + 1))).toBe(1)
    })

    test('answers with the oldest it holds when the ring is not deep enough yet', () => {
        const line = makeDelayLine(4)
        line.push(frame(7), 0)
        line.push(frame(8), 16)
        expect(levelOf(line.read(900))).toBe(7)
    })

    test('keeps going round, so a long track does not grow the ring', () => {
        const line = makeDelayLine(4, 8)
        for (let at = 0; at < 100; at += 1) line.push(frame(at % 256), at * 16)
        expect(levelOf(line.read(0))).toBe(99)
        // Eight slots at 16ms is 112ms of history, and further back than that is the oldest.
        expect(levelOf(line.read(64))).toBe(95)
        expect(levelOf(line.read(5000))).toBe(92)
    })

    test('copies what it is handed, because the caller reads every frame into one buffer', () => {
        const line = makeDelayLine(4)
        const reused = frame(5)
        line.push(reused, 0)
        reused.fill(200)
        line.push(reused, 16)
        expect(levelOf(line.read(100))).toBe(5)
    })

    test('answers a frame of nothing before anything has been pushed', () => {
        const line = makeDelayLine(4)
        expect(Array.from(line.read(0))).toEqual([0, 0, 0, 0])
        expect(Array.from(line.read(500))).toEqual([0, 0, 0, 0])
    })

    test('holds frames the width it was asked for, whatever it is handed', () => {
        const line = makeDelayLine(4)
        line.push(frame(9, 8), 0)
        expect(line.read(0)).toHaveLength(4)
        expect(levelOf(line.read(0))).toBe(9)
    })
})

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
