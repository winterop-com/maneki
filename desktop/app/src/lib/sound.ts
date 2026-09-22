/**
 * One thing makes sound at a time.
 *
 * There are two players in this app: the queue that follows you between screens, and the book
 * player on a book's own screen, which has its own speed, its own skip and its own saved
 * place. Both are real, and neither can be folded into the other -- but starting one while the
 * other is playing puts a novel underneath an album, which is nobody's intention.
 *
 * SO STARTING IS A CLAIM. Each player registers a way to be silenced and claims the sound
 * before it plays; claiming silences everyone else. That is the whole protocol, it is a Set of
 * functions, and it is tested in plain Node -- no element, no React, no import from either
 * player, so neither has to know the other exists.
 */

/** What a player offers so something else can stop it. */
export type Silencer = () => void

const registered = new Set<Silencer>()

/**
 * Offer a way to be silenced until the returned function is called.
 *
 * A player registers once, when it is built, rather than per track: the callback is asked to
 * stop whatever is playing, which is a question it can always answer.
 */
export function registerSilencer(silence: Silencer): () => void {
    registered.add(silence)
    return () => {
        registered.delete(silence)
    }
}

/**
 * Take the sound: everything else is stopped, and `mine` is left alone.
 *
 * A silencer that throws does not stop the others being asked -- one player failing to pause
 * must not leave a second one playing over it.
 */
export function claimSound(mine?: Silencer): void {
    for (const silence of registered) {
        if (silence === mine) continue
        try {
            silence()
        } catch {
            // A player that cannot be paused is not a reason to leave the rest playing.
        }
    }
}

/** Forget every registered player. Tests, and nothing else, call this. */
export function forgetSilencers(): void {
    registered.clear()
}

/** How many players are registered. Tests read this; nothing else needs it. */
export function silencerCount(): number {
    return registered.size
}
