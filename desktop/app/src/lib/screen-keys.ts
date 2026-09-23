/**
 * The keys the screen in front of somebody takes over for as long as it is there.
 *
 * ONE KEY, ONE MEANING PER SCREEN, RATHER THAN TWO KEYS. `f` is full screen, and what it puts
 * on the whole screen is whatever somebody is looking at: the spectrum while they are listening
 * to a record, and the picture while they are watching something. Binding a second letter for
 * the second case would be asking a reader to remember which screen they are on before they
 * press anything, and `lib/shortcuts` would have to grow a rule about screens, which is exactly
 * what it is not for -- it decides presses, not context.
 *
 * THE TRANSPORT IS THE SAME ARGUMENT AGAIN. Space, `n` and `p` mean what is playing, and a
 * screen with a video on it is a screen where what is playing is the video -- so Space stopped
 * the album somebody was not listening to and `n` moved that album on, while the picture they
 * were actually watching carried on regardless. The claim is what puts those three where the
 * eyes are; a screen that claims none of them leaves all three to the album, which is every
 * other screen in this app.
 *
 * AND `m` SILENCES WHATEVER IS MAKING THE SOUND. Only one thing in this app makes any at a time
 * -- a player starting stops the other, through `lib/sound` -- so a mute that always meant the
 * album meant the wrong player exactly when a video was the one playing, and somebody muting a
 * film got a film still talking and a record they could not hear when they went back to it.
 *
 * SO THE CLAIM IS A STORE AND THE PREDICATE STAYS PURE. A screen claims the key from an effect
 * and returns the release, the same shape as registering palette rows and for the same reason:
 * a key that still meant the video after the video had gone would be a key nothing answers.
 *
 * A LATER CLAIM WINS AND AN EARLIER RELEASE CANNOT TAKE IT. Two screens are mounted at once for
 * a moment during a navigation, so the one going away releases after the one arriving has
 * claimed -- and a release that cleared whatever happened to be held would leave the new screen
 * without its key.
 */

import { createStore } from '@/lib/store'

/** What a claimed key does when it is pressed. */
export type KeyAction = () => void

/** Who holds `f` right now, or null for the app's own meaning of it. */
export const stageKey = createStore<KeyAction | null>(null)

/** Take `f` until the returned function is called. */
export function claimStageKey(run: KeyAction): () => void {
    stageKey.set(run)
    return () => {
        if (stageKey.get() === run) stageKey.set(null)
    }
}

/** What `f` means right now, or null where nothing has claimed it. */
export function stageKeyClaim(): KeyAction | null {
    return stageKey.get()
}

/** Who holds `m` right now, or null for the album's own meaning of it. */
export const muteKey = createStore<KeyAction | null>(null)

/** Take `m` until the returned function is called. */
export function claimMuteKey(run: KeyAction): () => void {
    muteKey.set(run)
    return () => {
        if (muteKey.get() === run) muteKey.set(null)
    }
}

/** What `m` means right now, or null where nothing has claimed it. */
export function muteKeyClaim(): KeyAction | null {
    return muteKey.get()
}

/**
 * What Space, `n` and `p` do while a screen holds them.
 *
 * `next` and `previous` are nullable because a screen may be playing something with nothing
 * either side of it -- one video in a folder -- and a key that did nothing is better than a key
 * that quietly moved the album instead.
 */
export interface Transport {
    play: KeyAction
    next: KeyAction | null
    previous: KeyAction | null
}

/** Who holds the transport right now, or null for the queue's own meaning of it. */
export const transportKeys = createStore<Transport | null>(null)

/** Take Space, `n` and `p` until the returned function is called. */
export function claimTransport(transport: Transport): () => void {
    transportKeys.set(transport)
    return () => {
        if (transportKeys.get() === transport) transportKeys.set(null)
    }
}

/** What the transport means right now, or null where nothing has claimed it. */
export function transportClaim(): Transport | null {
    return transportKeys.get()
}

/** Give the keys back to whoever holds them. Tests, and nothing else, call this. */
export function forgetKeyClaims(): void {
    stageKey.set(null)
    muteKey.set(null)
    transportKeys.set(null)
}
