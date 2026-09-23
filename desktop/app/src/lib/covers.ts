/**
 * What stands in for a cover nothing has.
 *
 * A SHELF OF GREY SQUARES IS A SHELF NOBODY CAN READ. A library assembled from ripped discs and
 * downloaded files has plenty of records with no art, and drawn as the flat muted square they
 * used to be, two hundred of them are two hundred of the same thing: the eye has nothing to
 * catch, scrolling back to a row is reading every title again, and a cover that failed to load
 * looks exactly like one that was never there.
 *
 * SO THE PLACEHOLDER IS THE RECORD'S OWN MARK. It is derived from the thing's id and nothing
 * else, which makes it stable: the same album is the same drawing on the shelf, in the player
 * bar and on its own screen, in this session and the next one, on this machine and another. A
 * reader learns it the way they learn a sleeve. That is what keeps it information rather than
 * the decoration this design system otherwise has none of -- it stands for the thing beside it,
 * and it is the only shape in the app that does its job by being recognised.
 *
 * NO COLOUR IS WRITTEN HERE OR IN THE COMPONENT. The reference client these are ported from
 * hardcoded a hex per sleeve, which is a colour outside the tokens and a drawing that cannot
 * follow a palette. The shapes are drawn in `currentColor` over the surface ladder's own wash,
 * so a cover reads in every palette and in both modes without anything being kept in step.
 *
 * ALL OF IT IS ARITHMETIC OVER A STRING, which is what puts it here rather than in the
 * component: what a given id is drawn as is a decision a Node test can make.
 */

/** The eight faces a placeholder can wear. */
export type CoverKind = 'rings' | 'wave' | 'peaks' | 'orb' | 'bars' | 'grid' | 'sun' | 'frame'

export const COVER_KINDS: readonly CoverKind[] = [
    'rings',
    'wave',
    'peaks',
    'orb',
    'bars',
    'grid',
    'sun',
    'frame',
]

/**
 * How strongly a face is inked, as an alpha on the surface's own foreground.
 *
 * Three ramps rather than one, so two albums that landed on the same shape are still told
 * apart, and all three are quiet: a placeholder is a mark beside a title, and a shelf where the
 * covers are the loudest thing on the screen is a shelf whose titles nobody reads.
 */
export const COVER_TINTS: readonly number[] = [0.12, 0.18, 0.26]

/** The square every face is drawn on. */
export const COVER_VIEWBOX = 64

/**
 * A string as one number, the same number every time.
 *
 * FNV-1a, because what is wanted is a cheap avalanche rather than a cryptographic anything: two
 * ids differing in one character have to land on different faces, and the same id has to land on
 * the same face in every build this app ever ships. `Math.imul` is what keeps the multiply
 * 32-bit, since a plain `*` overflows into a float and stops being the same hash everywhere.
 */
export function hashOf(id: string): number {
    let hash = 0x81_1c_9d_c5
    for (let at = 0; at < id.length; at += 1) {
        hash ^= id.charCodeAt(at)
        hash = Math.imul(hash, 0x01_00_01_93)
    }
    return hash >>> 0
}

/** Which face one thing wears, and how strongly it is drawn. */
export interface CoverFace {
    kind: CoverKind
    /** Which of `COVER_TINTS` inks it. */
    tint: number
    /** The id's hash, for the faces whose own shape is derived from it. */
    hash: number
}

/**
 * The face an id wears.
 *
 * The shape comes off the low bits and the ink off the bits above them, so the two choices are
 * independent: an id that moved to the neighbouring shape does not drag its ink along with it,
 * and the twenty-four combinations are spread rather than paired up.
 */
export function coverFace(id: string): CoverFace {
    const hash = hashOf(id)
    return {
        hash,
        kind: COVER_KINDS[hash % COVER_KINDS.length],
        tint: Math.floor(hash / COVER_KINDS.length) % COVER_TINTS.length,
    }
}

/**
 * The bars of the `bars` face, as fractions of the square's height.
 *
 * A row of bars whose heights were fixed would be one drawing worn by every eighth record, so
 * the heights are walked out of the hash itself -- a linear congruential step, which is enough
 * to look unplanned and is exactly reproducible. Nothing falls below a third of the height: a
 * bar drawn as a stub reads as a rendering fault rather than as a quiet band.
 */
export function barHeights(hash: number, count = 7): number[] {
    const heights: number[] = []
    let state = hash === 0 ? 1 : hash
    for (let at = 0; at < count; at += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
        heights.push(0.32 + ((state % 1000) / 1000) * 0.62)
    }
    return heights
}
