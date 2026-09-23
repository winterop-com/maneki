/**
 * A key the screen in front of somebody takes over for as long as it is there.
 *
 * ONE KEY, ONE MEANING PER SCREEN, RATHER THAN TWO KEYS. `f` is full screen, and what it puts
 * on the whole screen is whatever somebody is looking at: the spectrum while they are listening
 * to a record, and the picture while they are watching something. Binding a second letter for
 * the second case would be asking a reader to remember which screen they are on before they
 * press anything, and `lib/shortcuts` would have to grow a rule about screens, which is exactly
 * what it is not for -- it decides presses, not context.
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

/** Give the key back whoever holds it. Tests, and nothing else, call this. */
export function forgetKeyClaims(): void {
    stageKey.set(null)
}
