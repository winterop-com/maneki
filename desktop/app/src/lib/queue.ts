/**
 * The order a queue is played in, and what happens when it runs out.
 *
 * TWO LISTS, NOT ONE SHUFFLED LIST. The queue keeps the album's own order -- that is what the
 * side panel draws and what "track 4 of 12" means -- and the play order is a separate list of
 * positions into it. Shuffling rearranges the second list and leaves the first alone, so
 * turning shuffle off mid-album carries on from where you are in the album rather than from
 * wherever the shuffled copy had got to.
 *
 * THE CURRENT TRACK STAYS PUT when the order is rebuilt. Pressing shuffle is a statement about
 * what comes next, not a request to skip what is playing.
 *
 * All of it is arithmetic over numbers, so the decisions that are actually hard -- what the end
 * of a shuffled queue does under each repeat mode, what previous means when you are on the
 * first track -- are pure functions with tests rather than branches inside an audio callback.
 */

/** What happens at the end of the queue. */
export type Repeat = 'off' | 'all' | 'one'

export const REPEATS: readonly Repeat[] = ['off', 'all', 'one']

/** What each mode is called, for the control that cycles them. */
export const REPEAT_LABELS: Record<Repeat, string> = {
    off: 'Repeat off',
    all: 'Repeat the queue',
    one: 'Repeat this track',
}

/** The mode one press moves to: off, then the whole queue, then this track, then off again. */
export function nextRepeat(current: Repeat): Repeat {
    const at = REPEATS.indexOf(current)
    return REPEATS[(at + 1) % REPEATS.length]!
}

/**
 * The order `count` tracks are played in, starting at `start`.
 *
 * In order, that is simply 0..count-1. Shuffled, the track being played leads and the rest
 * follow in a Fisher-Yates shuffle of what is left -- so shuffle is not "start somewhere else",
 * it is "what comes after this is a surprise".
 *
 * `random` is injected so a test can say what the shuffle did.
 */
export function buildOrder(count: number, start: number, shuffle: boolean, random = Math.random): number[] {
    if (count <= 0) return []
    const at = Math.min(Math.max(0, start), count - 1)
    const all = Array.from({ length: count }, (_, index) => index)
    if (!shuffle) return all
    const rest = all.filter((index) => index !== at)
    for (let i = rest.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1))
        ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
    }
    return [at, ...rest]
}

/**
 * Where the order stands after a track ends, or null when the queue is finished.
 *
 * `one` repeats the same position, which is what a listener means by repeat-one -- the track
 * plays again rather than the queue restarting. `all` wraps. `off` ends, and ending is a real
 * answer: the player stops rather than silently returning to the top.
 */
export function afterTrack(order: readonly number[], at: number, repeat: Repeat): number | null {
    if (order.length === 0) return null
    if (repeat === 'one') return at
    if (at + 1 < order.length) return at + 1
    return repeat === 'all' ? 0 : null
}

/**
 * Where the order stands when somebody presses skip-forward.
 *
 * NOT THE SAME AS A TRACK ENDING. Repeat-one exists so a track loops on its own; pressing next
 * under it means "I have heard enough of this one", so it moves along. At the end of the queue
 * a press wraps under `all` and stays put under `off`, because stopping the music is not what
 * pressing next asks for.
 */
export function afterSkip(order: readonly number[], at: number, repeat: Repeat): number | null {
    if (order.length === 0) return null
    if (at + 1 < order.length) return at + 1
    return repeat === 'off' ? null : 0
}

/**
 * Where the order stands when somebody presses skip-back.
 *
 * Before the first track there is nothing to go back to, so it stays -- the caller turns that
 * into "start this one again", which is what every player does. Under `all` it wraps to the
 * end, because a queue that repeats has no first track.
 */
export function beforeTrack(order: readonly number[], at: number, repeat: Repeat): number | null {
    if (order.length === 0) return null
    if (at - 1 >= 0) return at - 1
    return repeat === 'all' ? order.length - 1 : null
}

/**
 * The order rebuilt around the track playing now, keeping that track where it is.
 *
 * This is what pressing shuffle does mid-queue: the rest is rearranged (or put back in the
 * album's order), and what is playing goes on playing.
 */
export function reorderAround(
    order: readonly number[],
    at: number,
    shuffle: boolean,
    random = Math.random,
): { order: number[]; at: number } {
    const playing = order[at]
    if (playing === undefined) return { order: [...order], at }
    const rebuilt = buildOrder(order.length, playing, shuffle, random)
    // In order, the current track sits at its own index; shuffled, it leads.
    return { order: rebuilt, at: shuffle ? 0 : rebuilt.indexOf(playing) }
}
