import { useLayoutEffect, type RefObject } from 'react'

import { recallScroll, rememberScroll } from '@/lib/scroll-memory'

/**
 * Put a long list back where it was left, once it has rows to scroll, and keep track as it moves.
 *
 * BACK TO A LIST IS BACK WHERE IT WAS LEFT, not at its first row: the screens share one scrolling
 * area, so the shelf, the artist list and an artist's albums all started at the top on the way
 * back. Kept as it moves rather than read on the way out: by the time the list is gone the area
 * holds the next screen, and its scroll is that screen's. See `lib/scroll-memory`.
 *
 * A list drawn inside a page that scrolls on its own, as the music library's pages do beside
 * the tree, names an element of its own: the area is then the nearest one marked
 * `data-scroll-area` around it, and the shell's otherwise.
 */
export function useScrollMemory(key: string, ready: boolean, within?: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        if (!ready) return
        const area = scrollArea(within)
        if (area === null) return
        area.scrollTop = recallScroll(key)
        const keep = () => {
            rememberScroll(key, area.scrollTop)
        }
        area.addEventListener('scroll', keep, { passive: true })
        return () => {
            area.removeEventListener('scroll', keep)
        }
    }, [key, ready, within])
}

/** The area a list scrolls in: the nearest marked one around the element named, else the shell's. */
function scrollArea(within: RefObject<HTMLElement | null> | undefined): HTMLElement | null {
    return within?.current?.closest<HTMLElement>('[data-scroll-area]') ?? document.querySelector('main')
}
