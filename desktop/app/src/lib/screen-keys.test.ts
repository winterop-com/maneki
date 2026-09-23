import { afterEach, describe, expect, it, vi } from 'vitest'

import {
    claimStageKey,
    claimTransport,
    forgetKeyClaims,
    stageKeyClaim,
    transportClaim,
} from '@/lib/screen-keys'

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

describe('claimTransport', () => {
    it('means the queue until a screen says otherwise', () => {
        expect(transportClaim()).toBeNull()
    })

    it('puts Space, N and P where the eyes are', () => {
        const play = vi.fn()
        const next = vi.fn()
        const previous = vi.fn()
        claimTransport({ play, next, previous })
        transportClaim()?.play()
        transportClaim()?.next?.()
        transportClaim()?.previous?.()
        expect(play).toHaveBeenCalledOnce()
        expect(next).toHaveBeenCalledOnce()
        expect(previous).toHaveBeenCalledOnce()
    })

    it('takes a step nowhere rather than stepping the queue instead', () => {
        claimTransport({ play: vi.fn(), next: null, previous: null })
        expect(transportClaim()?.next).toBeNull()
    })

    it('gives the keys back when the screen releases them', () => {
        const release = claimTransport({ play: vi.fn(), next: null, previous: null })
        release()
        expect(transportClaim()).toBeNull()
    })

    it('does not let an earlier release take a later claim away', () => {
        const second = { play: vi.fn(), next: null, previous: null }
        const releaseFirst = claimTransport({ play: vi.fn(), next: null, previous: null })
        claimTransport(second)
        releaseFirst()
        expect(transportClaim()).toBe(second)
    })
})
