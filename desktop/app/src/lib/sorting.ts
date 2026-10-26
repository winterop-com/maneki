/**
 * The order a list of names is read in.
 *
 * AN ARTICLE IS NOT PART OF A NAME, for sorting. "The Beatles" belongs under B, next to Beck,
 * and a library that files it under T scatters half the shelf into one letter. Which words
 * count as articles is the server's answer -- `getArtists` carries `ignoredArticles`, and a
 * Norwegian library's list is not an English one's -- so it is passed in rather than written
 * down here.
 *
 * SORTING IS A PURE FUNCTION over rows, because the failures worth catching are quiet ones: a
 * name that sorts by its article, a comparison that puts `Ø` after `Z`, a count that ties and
 * scrambles. All three are checked in Node, and the screen only draws the answer.
 */

/**
 * A string as a search matches it: lower case, and without the marks over its letters.
 *
 * "royk" has to find "Röyksopp". The ö is not on a Norwegian keyboard, half the tags in a real
 * library spell a name without its marks anyway, and the server already answers this way -- its
 * index is built with `remove_diacritics`, so a client filter that did not fold would disagree
 * with the results printed underneath it.
 */
export function fold(text: string): string {
    return text
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLocaleLowerCase()
}

/** How a list of artists is ordered. */
export type SortMode = 'name' | 'name-desc' | 'albums'

export const SORT_MODES: readonly SortMode[] = ['name', 'name-desc', 'albums']

/** What each mode is called on the control that chooses it. */
export const SORT_LABELS: Record<SortMode, string> = {
    name: 'A-Z',
    'name-desc': 'Z-A',
    albums: 'Albums',
}

/** The articles to ignore when the server has not said. English, which is what most tags are. */
export const DEFAULT_ARTICLES = ['The', 'El', 'La', 'Los', 'Las', 'Le', 'Les']

/**
 * A name with its leading article taken off, for sorting only.
 *
 * The article has to be a whole word: "Theatre of Tragedy" is not "The" plus a name, and a
 * prefix match would file it under A.
 */
export function sortName(name: string, articles: readonly string[] = DEFAULT_ARTICLES): string {
    const trimmed = name.trim()
    for (const article of articles) {
        const prefix = `${article} `
        if (trimmed.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) {
            return trimmed.slice(prefix.length).trim()
        }
    }
    return trimmed
}

/** The articles a Subsonic server says to ignore, as a list. It sends them space-separated. */
export function articlesOf(ignoredArticles: string | undefined): string[] {
    if (!ignoredArticles) return DEFAULT_ARTICLES
    const words = ignoredArticles.split(/\s+/).filter(Boolean)
    return words.length > 0 ? words : DEFAULT_ARTICLES
}

/** The letters a Norwegian reader files after Z, which folding would otherwise merge into A and O. */
const OWN_LETTERS = ['Æ', 'Ø', 'Å']

/**
 * The letter a name is filed under on the artist grid: its first letter once the article is off
 * and the marks are folded away, so "The Beatles" is a B and "Émilie" an E. Æ, Ø and Å keep their
 * own sections, as they do in a Norwegian index, and anything that does not start with a letter
 * goes under `#`.
 */
export function letterOf(name: string, articles: readonly string[] = DEFAULT_ARTICLES): string {
    const first = sortName(name, articles).charAt(0).toLocaleUpperCase()
    if (OWN_LETTERS.includes(first)) return first
    const base = fold(first).toLocaleUpperCase()
    return /^[A-Z]$/.test(base) ? base : '#'
}

/** One section of the artist grid: a letter and the rows filed under it, in the order given. */
export interface LetterSection<T> {
    letter: string
    rows: T[]
}

/**
 * Rows already in reading order, cut into sections by `letterOf`. The sections come out in the
 * order their first row does, so A-Z and Z-A both read the right way without a second sort.
 */
export function sectionsByLetter<T extends Sortable>(
    rows: readonly T[],
    articles: readonly string[] = DEFAULT_ARTICLES,
): LetterSection<T>[] {
    const sections: LetterSection<T>[] = []
    for (const row of rows) {
        const letter = letterOf(row.name, articles)
        const last = sections.at(-1)
        if (last?.letter === letter) last.rows.push(row)
        else sections.push({ letter, rows: [row] })
    }
    return sections
}

/**
 * The jump strip's letters: `#` first when the library has one, as the grid sorts a leading digit
 * before any letter, then A to Z, then any of Æ, Ø and Å it has.
 */
export function jumpLetters(present: readonly string[]): string[] {
    const latin = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const digits = present.includes('#') ? ['#'] : []
    const extra = OWN_LETTERS.filter((letter) => present.includes(letter))
    return [...digits, ...latin, ...extra]
}

/** One row of anything that sorts by a name and a count. */
export interface Sortable {
    name: string
    albumCount?: number
}

/**
 * The rows in the order asked for.
 *
 * `localeCompare` rather than `<`, so `Ø` sorts where a Norwegian reader expects it and case is
 * not a second alphabet. Counting sorts most-first, and ties fall back to the name, because a
 * hundred artists with one album each in arbitrary order is not a list anybody can use.
 */
export function sortArtists<T extends Sortable>(
    rows: readonly T[],
    mode: SortMode,
    articles: readonly string[] = DEFAULT_ARTICLES,
): T[] {
    const byName = (left: T, right: T) =>
        sortName(left.name, articles).localeCompare(sortName(right.name, articles), undefined, {
            sensitivity: 'base',
            numeric: true,
        })
    switch (mode) {
        case 'name':
            return rows.toSorted(byName)
        case 'name-desc':
            return rows.toSorted((left, right) => byName(right, left))
        case 'albums':
            return rows.toSorted(
                (left, right) => (right.albumCount ?? 0) - (left.albumCount ?? 0) || byName(left, right),
            )
    }
}
