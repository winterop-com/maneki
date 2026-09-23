import { describe, expect, test } from 'vitest'

import { bandsFor } from '@/components/PlayerBar'

describe('how many bars the player bar draws', () => {
    test('follows the width, so a bar is the same width to the eye on any window', () => {
        expect(bandsFor(1100)).toBe(100)
        expect(bandsFor(1650)).toBe(150)
    })

    test('is held between what still reads as a spectrum and what the analyser has bins for', () => {
        expect(bandsFor(200)).toBe(48)
        expect(bandsFor(4000)).toBe(192)
    })
})
