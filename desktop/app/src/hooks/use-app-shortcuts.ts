import { useEffect } from 'react'

import {
    currentSong,
    cycleRepeat,
    next,
    playerStore,
    previous,
    seek,
    setVolume,
    toggle,
    toggleMuted,
    toggleShuffle,
} from '@/lib/player'
import { dialogUp } from '@/lib/dialogs'
import { paletteOpen } from '@/lib/palette'
import { togglePanel, toggleRail } from '@/lib/panels'
import { toggleLyrics } from '@/lib/lyrics'
import { muteKeyClaim, stageKeyClaim, transportClaim } from '@/lib/screen-keys'
import { closeSearch, openSearch, searchOpen } from '@/lib/search'
import { sessionStore } from '@/lib/session'
import {
    adjustsVolume,
    applePlatform,
    opensPalette,
    cyclesRepeat,
    opensLyrics,
    opensSearch,
    opensShortcuts,
    opensStage,
    seeks,
    starsCurrent,
    steps,
    togglesMute,
    togglesShuffle,
    togglesPanel,
    togglesPlayback,
    togglesRail,
    togglesVisualizer,
    type FocusedField,
} from '@/lib/shortcuts'
import { toggleStar } from '@/lib/star'
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
                // One dialog at a time: the chord is answered wherever focus is, so it is
                // answered inside the search too, and two modals stacked is one scrim over
                // the thing the other is about.
                closeSearch()
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
            // A chord is answered wherever focus is; a bare key is not answered at all while
            // anything is standing over the app -- the palette or the search, where every press
            // belongs to its own box and the arrows walk the rows under it, and the settings
            // and shortcuts dialogs, where a key that opened a second surface would be two
            // things at once in a place that can hold one.
            if (paletteOpen.get() || searchOpen.get() || dialogUp()) return
            if (opensSearch(press, focused())) {
                event.preventDefault()
                openSearch()
                return
            }
            // What is playing is what somebody is looking at. A screen with a video on it
            // claims these three while it is open, so Space stops the picture rather than the
            // album nobody is listening to, and the same keys mean the queue everywhere else.
            if (togglesPlayback(press, focused())) {
                event.preventDefault()
                const claimed = transportClaim()
                if (claimed === null) toggle()
                else claimed.play()
                return
            }
            const step = steps(press, focused())
            if (step !== null) {
                event.preventDefault()
                const claimed = transportClaim()
                if (claimed === null) {
                    if (step === 'next') next()
                    else previous()
                    return
                }
                // A claim with nothing either side of what is open answers with nothing, which
                // is the point: stepping the album instead would be the wrong thing moving.
                if (step === 'next') claimed.next?.()
                else claimed.previous?.()
                return
            }
            if (togglesVisualizer(press, focused())) {
                event.preventDefault()
                toggleVisualizer()
                return
            }
            if (opensStage(press, focused())) {
                event.preventDefault()
                // What goes on the whole screen is whatever somebody is looking at, so a
                // screen playing a video takes this key while it is open and the spectrum
                // has it everywhere else.
                const claimed = stageKeyClaim()
                if (claimed === null) toggleStage()
                else claimed()
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
            // The player's own numbers, read at the instant of the press rather than held: the
            // store publishes four times a second and a hook that subscribed to it would bind
            // this listener again as often.
            const moved = seeks(press, focused())
            if (moved !== null) {
                const { positionS, durationS, station, book } = playerStore.get()
                // A station has no length and nothing to scrub, and a seek against nothing
                // would build an audio element for a press with no track behind it. A book is
                // not a track and answers `currentSong` with nothing, so it is asked for by
                // name.
                if (station !== null || (book === null && currentSong() === null)) return
                event.preventDefault()
                const wanted = positionS + moved
                seek(durationS > 0 ? Math.min(durationS, Math.max(0, wanted)) : Math.max(0, wanted))
                return
            }
            const louder = adjustsVolume(press, focused())
            if (louder !== null) {
                event.preventDefault()
                // setVolume unmutes, which is what asking to hear more of it means.
                setVolume(playerStore.get().volume + louder)
                return
            }
            if (togglesMute(press, focused())) {
                event.preventDefault()
                // What `m` silences is whatever is making the sound, and only one thing is:
                // a screen with a video on it claims this while it is open, so `m` muted the
                // album under a film that went on talking, and the record somebody came back
                // to was the silent one.
                const claimed = muteKeyClaim()
                if (claimed === null) toggleMuted()
                else claimed()
                return
            }
            if (opensLyrics(press, focused())) {
                event.preventDefault()
                toggleLyrics()
                return
            }
            if (starsCurrent(press, focused())) {
                event.preventDefault()
                toggleStar(sessionStore.get().music, currentSong())
                return
            }
            if (opensShortcuts(press, focused())) {
                event.preventDefault()
                onShortcuts()
            }
        }

        // IN THE CAPTURE PHASE, WHICH IS ABOUT THE VIDEO PLAYER AND NOTHING ELSE. video.js
        // answers a keydown it has no use for by calling `stopPropagation` on it, so a
        // bubble-phase listener here heard nothing at all while the picture had focus -- which
        // is where focus is from the moment somebody clicks play, and why `f` did not fill the
        // screen while watching. Capture runs from the document down to whatever was pressed
        // on, so the press is read before anything can swallow it.
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
            document.removeEventListener('keydown', onKeyDown, true)
        }
    }, [onShortcuts])
}
