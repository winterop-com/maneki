import { useEffect } from 'react'

import { cycleRepeat, next, previous, toggle, toggleShuffle } from '@/lib/player'
import { paletteOpen } from '@/lib/palette'
import { togglePanel, toggleRail } from '@/lib/panels'
import {
    applePlatform,
    opensPalette,
    cyclesRepeat,
    opensShortcuts,
    opensStage,
    steps,
    togglesShuffle,
    togglesPanel,
    togglesPlayback,
    togglesRail,
    togglesVisualizer,
    type FocusedField,
} from '@/lib/shortcuts'
import { toggleStage, toggleVisualizer } from '@/lib/visualizer'

/**
 * The one place a real `KeyboardEvent` is read.
 *
 * All it does is describe the press and the focused element to `lib/shortcuts`, which decides.
 * Bound on the document rather than on the shell, so a chord works with focus anywhere --
 * inside the palette, inside a dialog, on the page's own body.
 *
 * THE TRANSPORT IS BOUND HERE AS WELL, because what is playing is the app's rather than any one
 * screen's: Space pauses the album while somebody is reading a book's chapter list, which is
 * the behaviour every player has and the reason the keys are not the player bar's own.
 */
export function useAppShortcuts(onShortcuts: () => void): void {
    useEffect(() => {
        const apple = applePlatform(navigator.userAgent)

        function focused(): FocusedField | null {
            const element = document.activeElement
            if (!(element instanceof HTMLElement)) return null
            return { tagName: element.tagName, isContentEditable: element.isContentEditable }
        }

        function onKeyDown(event: KeyboardEvent): void {
            const press = {
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
            }
            if (opensPalette(press)) {
                event.preventDefault()
                paletteOpen.update((open) => !open)
                return
            }
            if (togglesRail(press, focused(), apple)) {
                event.preventDefault()
                toggleRail()
                return
            }
            if (togglesPanel(press, focused(), apple)) {
                event.preventDefault()
                togglePanel()
                return
            }
            // A chord is answered wherever focus is; a bare key is not answered at all while the
            // palette is up, where every press belongs to its match box.
            if (paletteOpen.get()) return
            if (togglesPlayback(press, focused())) {
                event.preventDefault()
                toggle()
                return
            }
            const step = steps(press, focused())
            if (step !== null) {
                event.preventDefault()
                if (step === 'next') next()
                else previous()
                return
            }
            if (togglesVisualizer(press, focused())) {
                event.preventDefault()
                toggleVisualizer()
                return
            }
            if (opensStage(press, focused())) {
                event.preventDefault()
                toggleStage()
                return
            }
            if (togglesShuffle(press, focused())) {
                event.preventDefault()
                toggleShuffle()
                return
            }
            if (cyclesRepeat(press, focused())) {
                event.preventDefault()
                cycleRepeat()
                return
            }
            if (opensShortcuts(press, focused())) {
                event.preventDefault()
                onShortcuts()
            }
        }

        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [onShortcuts])
}
