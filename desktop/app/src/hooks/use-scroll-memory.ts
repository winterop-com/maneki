import { useLayoutEffect } from 'react'

import { recallScroll, rememberScroll } from '@/lib/scroll-memory'

/**
 * Put a long list back where it was left, once it has rows to scroll, and keep track as it moves.
 *
 * BACK TO A LIST IS BACK WHERE IT WAS LEFT, not at its first row: the screens share one scrolling
 * area, so the shelf, the artist list and an artist's albums all started at the top on the way
 * back. Kept as it moves rather than read on the way out: by the time the list is gone the area
 * holds the next screen, and its scroll is that screen's. See `lib/scroll-memory`.
 */
export function useScrollMemory(key: string, ready: boolean): void {
    useLayoutEffect(() => {
        if (!ready) return
        const area = document.querySelector('main')
        if (area === null) return
        area.scrollTop = recallScroll(key)
        const keep = () => {
            rememberScroll(key, area.scrollTop)
        }
        area.addEventListener('scroll', keep, { passive: true })
        return () => {
            area.removeEventListener('scroll', keep)
        }
    }, [key, ready])
}
