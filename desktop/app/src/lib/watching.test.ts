import { afterEach, describe, expect, it } from 'vitest'

import { setTheater, THEATER_KEY, theaterOn, toggleTheater } from '@/lib/watching'

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
