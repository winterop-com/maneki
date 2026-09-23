import { afterEach, describe, expect, it } from 'vitest'

import {
    AUTOPLAY_NEXT_KEY,
    autoplayNext,
    setAutoplayNext,
    setTheater,
    THEATER_KEY,
    theaterOn,
    toggleTheater,
    UP_NEXT_SECONDS,
} from '@/lib/watching'

afterEach(() => {
    setTheater(false)
})

describe('the theater choice', () => {
    it('starts with the list beside the picture, which is how somebody finds the next episode', () => {
        expect(theaterOn.get()).toBe(false)
    })

    it('flips, and tells whoever is watching', () => {
        let heard = 0
        const stop = theaterOn.subscribe(() => {
            heard += 1
        })
        toggleTheater()
        expect(theaterOn.get()).toBe(true)
        toggleTheater()
        expect(theaterOn.get()).toBe(false)
        expect(heard).toBe(2)
        stop()
    })

    it('says nothing twice: setting what is already set notifies nobody', () => {
        let heard = 0
        const stop = theaterOn.subscribe(() => {
            heard += 1
        })
        setTheater(false)
        expect(heard).toBe(0)
        stop()
    })

    it('keeps the choice under one key, which is what the next visit reads', () => {
        expect(THEATER_KEY).toBe('maneki.theater')
    })
})

describe('the up-next choice', () => {
    it('plays the next one by default, which is what a season is for', () => {
        expect(autoplayNext.get()).toBe(true)
    })

    it('can be turned off, and the card then waits instead of counting', () => {
        setAutoplayNext(false)
        expect(autoplayNext.get()).toBe(false)
        setAutoplayNext(true)
    })

    it('counts down where somebody can see it', () => {
        expect(UP_NEXT_SECONDS).toBeGreaterThan(0)
        expect(AUTOPLAY_NEXT_KEY).toBe('maneki.autoplay-next')
    })
})
