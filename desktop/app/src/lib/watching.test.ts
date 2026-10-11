import { afterEach, describe, expect, it } from 'vitest'

import {
    AUTOPLAY_NEXT_KEY,
    autoplayNext,
    barOnScreen,
    onWatchScreen,
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

describe('the player bar under a picture', () => {
    it('knows a watch screen from the lists that lead to one', () => {
        expect(onWatchScreen('/video/v/abc')).toBe(true)
        expect(onWatchScreen('/youtube/v/abc')).toBe(true)
        expect(onWatchScreen('/video')).toBe(false)
        expect(onWatchScreen('/video/browse/Series')).toBe(false)
        expect(onWatchScreen('/youtube')).toBe(false)
        expect(onWatchScreen('/music')).toBe(false)
    })

    it('goes away under a picture while the music is stopped, as a station paused to watch is', () => {
        expect(barOnScreen('/video/v/abc', false)).toBe('none')
        expect(barOnScreen('/youtube/v/abc', false)).toBe('none')
    })

    it('is the strip under a picture while the music plays, so it can still be stopped', () => {
        expect(barOnScreen('/video/v/abc', true)).toBe('strip')
    })

    it('is the whole bar everywhere else, playing or not', () => {
        expect(barOnScreen('/radio', false)).toBe('full')
        expect(barOnScreen('/video', true)).toBe('full')
    })
})
