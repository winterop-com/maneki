import { beforeEach, describe, expect, test, vi } from 'vitest'

import { claimSound, forgetSilencers, registerSilencer, silencerCount } from '@/lib/sound'

beforeEach(forgetSilencers)

describe('one thing makes sound at a time', () => {
    test('claiming stops everyone else', () => {
        const music = vi.fn()
        const book = vi.fn()
        registerSilencer(music)
        registerSilencer(book)
        claimSound(book)
        expect(music).toHaveBeenCalledOnce()
        expect(book).not.toHaveBeenCalled()
    })

    test('claiming without saying who stops everything, which is what leaving a screen does', () => {
        const music = vi.fn()
        const book = vi.fn()
        registerSilencer(music)
        registerSilencer(book)
        claimSound()
        expect(music).toHaveBeenCalledOnce()
        expect(book).toHaveBeenCalledOnce()
    })

    test('a player that has gone is not asked to stop', () => {
        const gone = vi.fn()
        const stop = registerSilencer(gone)
        stop()
        claimSound()
        expect(gone).not.toHaveBeenCalled()
        expect(silencerCount()).toBe(0)
    })

    test('one player that cannot be paused does not leave the rest playing', () => {
        const angry = vi.fn(() => {
            throw new Error('no')
        })
        const other = vi.fn()
        registerSilencer(angry)
        registerSilencer(other)
        expect(() => claimSound()).not.toThrow()
        expect(other).toHaveBeenCalledOnce()
    })

    test('registering the same player twice is registering it once', () => {
        const one = vi.fn()
        registerSilencer(one)
        registerSilencer(one)
        expect(silencerCount()).toBe(1)
    })
})
