import { useEffect } from 'react'
import { toast } from 'sonner'

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
import { REPEAT_LABELS } from '@/lib/queue'
import { dialogUp, mayOpen, menuStanding, type Standing } from '@/lib/dialogs'
import { paletteOpen } from '@/lib/palette'
import { toggleRail } from '@/lib/panels'
import { lyricsOpen, toggleLyrics } from '@/lib/lyrics'
import { muteKeyClaim, stageKeyClaim, transportClaim, volumeKeysClaim } from '@/lib/screen-keys'
import { closeSearch, openSearch, searchOpen } from '@/lib/search'
import { sessionStore } from '@/lib/session'
import {
    adjustsVolume,
    applePlatform,
    cyclesRepeat,
    focusedFieldOf,
    type FocusedField,
    opensLyrics,
    opensPalette,
    opensSearch,
    opensShortcuts,
    opensStage,
    REPEAT_KEY,
    seeks,
    starsCurrent,
    steps,
    toggleNotice,
    togglesMute,
    togglesPlayback,
    togglesRail,
    togglesShuffle,
    togglesVisualizer,
} from '@/lib/shortcuts'
import { toggleStar } from '@/lib/star'
import { stageOpen, toggleStage, toggleVisualizer, visualizerShown } from '@/lib/visualizer'

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
            return focusedFieldOf(element)
        }

        // What is standing over the app when a key is pressed; see `mayOpen`.
        function standing(): Standing {
            return {
                dialog: dialogUp(),
                stage: stageOpen.get(),
                lyrics: lyricsOpen.get(),
                song: currentSong() !== null,
            }
        }

        function onKeyDown(event: KeyboardEvent): void {
            // Every key belongs to an open menu; see `menuStanding`.
            if (menuStanding(document)) return
            const press = {
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
            }
            if (opensPalette(press)) {
                event.preventDefault()
                // One surface at a time; see `mayOpen`.
                if (!mayOpen('palette', standing())) return
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
            // A chord is answered wherever focus is; a bare key is not answered at all while
            // anything is standing over the app -- the palette or the search, where every press
            // belongs to its own box and the arrows walk the rows under it, and the settings
            // and shortcuts dialogs, where a key that opened a second surface would be two
            // things at once in a place that can hold one.
            if (paletteOpen.get() || searchOpen.get() || dialogUp()) return
            if (opensSearch(press, focused())) {
                event.preventDefault()
                // Radio-only has no library to search: the key is left alone there.
                if (sessionStore.get().phase !== 'radio' && mayOpen('search', standing())) openSearch()
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
                // A lasting change made by one letter says so; see `toggleNotice`.
                toast(toggleNotice('spectrum', visualizerShown.get()))
                return
            }
            if (opensStage(press, focused())) {
                event.preventDefault()
                // What goes on the whole screen is whatever somebody is looking at, so a
                // screen playing a video takes this key while it is open and the spectrum
                // has it everywhere else.
                const claimed = stageKeyClaim()
                if (claimed !== null) claimed()
                else if (stageOpen.get() || mayOpen('stage', standing())) toggleStage()
                return
            }
            // A station has no queue and a book is read in one order: the bar offers neither
            // shuffle nor repeat for them, and the keys did not change one behind its back.
            const queueless = playerStore.get().station !== null || playerStore.get().book !== null
            if (togglesShuffle(press, focused())) {
                event.preventDefault()
                if (queueless) return
                toggleShuffle()
                toast(toggleNotice('shuffle', playerStore.get().shuffle))
                return
            }
            if (cyclesRepeat(press, focused())) {
                event.preventDefault()
                if (queueless) return
                cycleRepeat()
                toast(
                    `${REPEAT_LABELS[playerStore.get().repeat]}. Press ${REPEAT_KEY.toUpperCase()} for the next.`,
                )
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
                // A screen with a video on it turns the video up; see `claimVolumeKeys`.
                const claimed = volumeKeysClaim()
                // setVolume unmutes, which is what asking to hear more of it means.
                if (claimed === null) setVolume(playerStore.get().volume + louder)
                else claimed(louder)
                return
            }
            if (togglesMute(press, focused())) {
                event.preventDefault()
                // What `m` silences is whatever is making the sound, and only one thing is:
                // a screen with a video on it claims this while it is open, so `m` muted the
                // album under a film that went on talking, and the record somebody came back
                // to was the silent one.
                const claimed = muteKeyClaim()
                if (claimed === null) {
                    toggleMuted()
                    toast(toggleNotice('mute', playerStore.get().muted))
                } else claimed()
                return
            }
            if (opensLyrics(press, focused())) {
                event.preventDefault()
                // Closing is always allowed; opening only where it can be seen and has words.
                if (lyricsOpen.get() || mayOpen('lyrics', standing())) toggleLyrics()
                return
            }
            if (starsCurrent(press, focused())) {
                event.preventDefault()
                const starred = toggleStar(sessionStore.get().music, currentSong())
                if (starred !== null) toast(toggleNotice('star', starred))
                return
            }
            if (opensShortcuts(press, focused())) {
                event.preventDefault()
                if (mayOpen('shortcuts', standing())) onShortcuts()
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
