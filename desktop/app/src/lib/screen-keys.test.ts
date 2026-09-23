import { afterEach, describe, expect, it, vi } from 'vitest'

import { claimStageKey, forgetKeyClaims, stageKeyClaim } from '@/lib/screen-keys'

afterEach(() => {
    forgetKeyClaims()
})

describe('claimStageKey', () => {
    it('means the app until a screen says otherwise', () => {
        expect(stageKeyClaim()).toBeNull()
    })

    it('answers the screen that claimed it', () => {
        const run = vi.fn()
        claimStageKey(run)
        stageKeyClaim()?.()
        expect(run).toHaveBeenCalledOnce()
    })

    it('gives the key back when the screen releases it', () => {
        const release = claimStageKey(vi.fn())
        release()
        expect(stageKeyClaim()).toBeNull()
    })

    it('lets a later claim win', () => {
        const first = vi.fn()
        const second = vi.fn()
        claimStageKey(first)
        claimStageKey(second)
        stageKeyClaim()?.()
        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledOnce()
    })

    it('does not let an earlier release take a later claim away', () => {
        const second = vi.fn()
        const releaseFirst = claimStageKey(vi.fn())
        claimStageKey(second)
        // Both screens are mounted for a moment during a navigation, and the one leaving
        // releases last.
        releaseFirst()
        stageKeyClaim()?.()
        expect(second).toHaveBeenCalledOnce()
    })
})
