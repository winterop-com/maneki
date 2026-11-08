/**
 * What a station says it is playing, as the player bar, the deck face and the OS show it.
 *
 * PURE, so the wording is tested without a DOM.
 */

/**
 * What a station says it is playing, without the station saying its own name first.
 *
 * NRK sends "NRK mP3 - Alltid musikk: PILLOWTALK, ZAYN" and "P3 Musikk: The Feeling, Steve
 * Lacy": the part before the last colon is the station introducing itself, which the screen
 * already says. It goes when it names the station (shares a word of two letters or more with
 * the station's name); a colon that is part of a song title stays.
 */
export function announced(stationTitle: string, stationName: string): string {
    const at = stationTitle.lastIndexOf(': ')
    if (at < 0) return stationTitle
    const head = stationTitle.slice(0, at).toLowerCase()
    const words = stationName
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 2)
    const rest = stationTitle.slice(at + 2).trim()
    return rest && words.some((word) => head.includes(word)) ? rest : stationTitle
}
