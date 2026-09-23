/**
 * Grabbing the top of the window moves the window.
 *
 * Both desktop shells hide the native title bar, so the strip across the top of the app is the
 * only title bar there is -- and a title bar that cannot be dragged is a window that can only
 * be moved by its own traffic lights.
 *
 * ELECTRON NEEDS NO CODE. Chromium honours `-webkit-app-region: drag`, which index.css puts on
 * the same strips this module watches, and its own controls opt back out of it there.
 *
 * TAURI NEEDS ALL OF IT. WKWebView ignores `-webkit-app-region` entirely, and Tauri's own
 * `data-tauri-drag-region` attribute is read when the element is created rather than when it is
 * pressed, which a tree React renders after mount does not satisfy reliably. So one delegated
 * `mousedown` on the document asks the window to start dragging itself, which is the same
 * gesture by another route.
 *
 * WHAT IS PURE IS SEPARATE. Whether a press is a drag is a decision about a button and two
 * facts read off the DOM around it, and it is the part worth a test -- so it takes those three
 * as values and the listener is what goes looking for them.
 */

import { currentShell, startNativeWindowDrag } from '@/lib/desktop'

/**
 * The strips a press moves the window from.
 *
 * `data-shell-strip="top"` is already what the rail's head, the top bar and the panel's tab
 * strip mark themselves with -- between them they are the shell's top strip, which is the title
 * bar. `data-window-drag` is the opt-in for anything that is a title bar without being one of
 * those, such as a screen that draws its own.
 */
const DRAG_REGION = '[data-window-drag], [data-shell-strip="top"]'

/**
 * What a press does its own job with, so it is not a drag.
 *
 * `data-window-no-drag` is the escape hatch for something interactive that is none of these,
 * and index.css exempts exactly this list from Electron's drag region.
 */
const INTERACTIVE =
    'a, button, input, label, select, textarea, [role="button"], [role="slider"], [role="tab"], [contenteditable="true"], [data-window-no-drag]'

/** The one button that moves a window. A right-click on a title bar is the window menu. */
const PRIMARY = 0

/** A press, as the decision below needs it: which button, and what it landed on. */
export interface Press {
    button: number
    /** Whether it landed inside a strip that stands for the window's own title bar. */
    region: boolean
    /** Whether it landed on something that already does something with a press. */
    interactive: boolean
}

/** Whether this press should move the window rather than reach the page. */
export function movesTheWindow({ button, region, interactive }: Press): boolean {
    return button === PRIMARY && region && !interactive
}

/** Watch the document for the presses that move the window. Installed once, from `main`. */
export function installWindowDrag(): void {
    if (currentShell() !== 'tauri') return
    document.addEventListener('mousedown', (event) => {
        const target = event.target instanceof Element ? event.target : null
        if (target === null) return
        const press = {
            button: event.button,
            region: target.closest(DRAG_REGION) !== null,
            interactive: target.closest(INTERACTIVE) !== null,
        }
        if (!movesTheWindow(press)) return
        startNativeWindowDrag().catch((error: unknown) => {
            // A window that will not move is the shell's business and not the app's: the press
            // is already spent, and there is nothing a screen could do about it.
            console.warn('the window did not take the drag', error)
        })
    })
}
