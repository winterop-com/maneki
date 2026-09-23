import { useEffect, type RefObject } from 'react'

/**
 * What a full-screen overlay does to the shell behind it.
 *
 * THE REST OF THE APP IS INERT WHILE ONE STANDS. An `aria-modal` dialog that traps nothing is a
 * claim rather than a behaviour: the transport, the rail and every row of whatever screen is
 * underneath stay in the tab order, so a keyboard walks straight out of the overlay and into a
 * screen nobody can see. `inert` takes the focus, the pointer and the accessibility tree away in
 * one attribute, which is the whole of what a trap is trying to do by hand.
 *
 * WHAT IS MADE INERT IS THE OVERLAY'S SIBLINGS, NOT THE SHELL'S ROOT. The overlay is drawn
 * inside that root, so an `inert` written on it would take the overlay with it. A sibling that
 * was already inert is left alone and put back nowhere: what this undoes is exactly what it did.
 *
 * AND THE FOCUS GOES BACK WHERE IT CAME FROM. The overlay takes the focus when it opens, because
 * a dialog nothing has focus inside is one a screen reader is still outside of, and on the way
 * out the control that opened it gets it back -- unless that control has gone with the screen it
 * was on, which is why it is asked whether it is still in the document.
 *
 * ESCAPE LEAVES, and it is bound here for the same reason the rest is: every overlay in this app
 * answers it, and three copies of the listener are three places it can be forgotten.
 */
export function useOverlay(container: RefObject<HTMLElement | null>, close: () => void): void {
    useEffect(() => {
        const element = container.current
        if (!element) return

        const opener = document.activeElement
        // WHETHER THE OPENER WAS WEARING A RING. A row that was clicked holds focus without one;
        // focus handed back to it after a key press would draw one, because the browser judges
        // by the last input rather than by how the element came to be focused. So what it wore
        // going in is what it wears coming out.
        const ringed = opener instanceof HTMLElement && opener.matches(':focus-visible')
        const muted: HTMLElement[] = []
        const siblings = element.parentElement?.children
        for (let at = 0; at < (siblings?.length ?? 0); at += 1) {
            const sibling = siblings?.item(at)
            if (sibling === element || !(sibling instanceof HTMLElement) || sibling.inert) continue
            sibling.inert = true
            muted.push(sibling)
        }
        element.focus()

        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close()
        }
        document.addEventListener('keydown', escape)

        return () => {
            document.removeEventListener('keydown', escape)
            for (const sibling of muted) sibling.inert = false
            // Put back after the inert goes, not before: focus on an inert element is focus the
            // browser refuses.
            if (opener instanceof HTMLElement && opener.isConnected) {
                opener.focus()
                if (!ringed) quieten(opener)
            }
        }
    }, [close, container])
}

/**
 * Keep focus on `element` without the ring, until the keyboard is used again.
 *
 * The ring is a keyboard user's, and the next key press gives it back: the attribute the
 * stylesheet reads is dropped on the first keydown, or when focus moves on.
 */
function quieten(element: HTMLElement): void {
    element.setAttribute('data-focus-quiet', '')
    const restore = () => {
        element.removeAttribute('data-focus-quiet')
        document.removeEventListener('keydown', restore, true)
        element.removeEventListener('blur', restore)
    }
    document.addEventListener('keydown', restore, true)
    element.addEventListener('blur', restore)
}
