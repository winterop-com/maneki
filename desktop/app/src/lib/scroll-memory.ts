/**
 * Where a long list was scrolled to when somebody left it, for when they come back.
 *
 * The screens share one scrolling area, so a list that is left and returned to starts at the
 * top unless it says where it was: back from a book, the 2313-book shelf was always at its first
 * row. Kept for the session only; a fresh visit starting at the top is what a fresh visit is.
 */

const left = new Map<string, number>()

export function rememberScroll(key: string, top: number): void {
    left.set(key, top)
}

export function recallScroll(key: string): number {
    return left.get(key) ?? 0
}
