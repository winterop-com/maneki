/**
 * Everything the YouTube screen decides without a server.
 *
 * WHAT SOMEBODY PASTES IS NOT WHAT THE SERVER TAKES. A subscription is added by URL, and the
 * server will only fetch an http(s) address on a YouTube host -- so `youtube.com/@name` with no
 * scheme, a bare `@handle`, a bare `UC...` id and an address carrying a `?si=` share token are
 * all things a person will reasonably paste and all things that would come back as a refusal
 * from a round trip through yt-dlp. They are turned into the one form the server takes here,
 * before the request, and what cannot be is refused with a sentence rather than a status code.
 *
 * THE SAME ALLOWLIST THE SERVER HOLDS, for the same reason it holds it: the URL is handed to an
 * extractor that will fetch whatever host it is given. This copy is a courtesy to the reader
 * and never a substitute -- `is_allowed_channel_url` in `maneki.video.serve.youtube` is what
 * actually refuses, and it refuses again even for a URL this file built.
 *
 * ALL OF IT IS ARITHMETIC AND STRINGS, so the decisions that are actually easy to get wrong --
 * a host that merely contains "youtube.com", a count that rolls over from 999.9K to 1000.0K,
 * a quality cap that does not name a rung the server offers -- are pure functions with tests
 * rather than branches inside a component.
 */

import type { YouTubeCounts, YouTubeKind, YouTubeTab, YouTubeVideo } from '@/lib/types'

/** One of a channel's three tabs: what to ask the server for, and what to call it. */
export interface TabDefinition {
    tab: YouTubeTab
    label: string
    /** The `kind` the server stamps on an item listed from this tab. */
    kind: YouTubeKind
}

/**
 * The tabs, in the order they are drawn.
 *
 * Videos leads because that is what a channel is mostly read for, and the third is called Live
 * rather than Streams: the tab holds broadcasts, and most of them are over.
 */
export const TABS: readonly TabDefinition[] = [
    { tab: 'videos', label: 'Videos', kind: 'video' },
    { tab: 'shorts', label: 'Shorts', kind: 'short' },
    { tab: 'streams', label: 'Live', kind: 'live' },
]

/** Whether a string names one of the three tabs, which is what an address has to be checked as. */
export function isTab(value: string): value is YouTubeTab {
    return TABS.some((definition) => definition.tab === value)
}

// ---- Adding a channel ---------------------------------------------------

/** What a pasted address came to: an address the server will take, or the reason it will not. */
export type ChannelAddress = { ok: true; url: string } | { ok: false; refusal: string }

/**
 * The hosts a channel address may name, exactly as the server spells them.
 *
 * Matched against the parsed hostname and never as a substring: `youtube.com.evil.test` and
 * `https://youtube.com@evil.test/` both have to fail, and the second is why this is done on a
 * parsed URL rather than on the text.
 */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
])

/** The first path segment a channel address may open with. Anything else is not a channel. */
const CHANNEL_PREFIXES: ReadonlySet<string> = new Set(['channel', 'c', 'user'])

/** Segments that name a tab of a channel rather than the channel, which the server appends itself. */
const TAB_SEGMENTS: ReadonlySet<string> = new Set([
    'videos',
    'shorts',
    'streams',
    'live',
    'featured',
    'playlists',
    'community',
    'podcasts',
    'about',
])

/** A `UC...` channel id as YouTube writes them: two letters and twenty-two more characters. */
const CHANNEL_ID = /^UC[\w-]{22}$/

/** A handle is what follows the `@`, and YouTube allows letters, digits, dots, dashes and underscores. */
const HANDLE = /^[\w.-]+$/

/**
 * What to POST for a pasted channel address, or why it cannot be one.
 *
 * Every form the client this replaces let through is accepted, plus the three it let through to
 * a refusal: a missing scheme, a bare handle and a bare channel id. A share query is dropped,
 * because the server appends the tab it wants to the path and `.../@name?si=x/videos` is not an
 * address at all.
 *
 * A BARE WORD IS A HANDLE, and a word with a dot or a slash in it is an address. So `veritasium`
 * subscribes and `veritasium.com` is refused rather than quietly turned into a channel nobody
 * asked for -- a handle that genuinely holds a dot is pasted with its `@`, which is how it is
 * written everywhere it appears.
 */
export function parseChannelAddress(input: string): ChannelAddress {
    const text = input.trim()
    if (text === '') return { ok: false, refusal: 'Paste a channel address, a handle, or a channel id.' }
    if (CHANNEL_ID.test(text)) return { ok: true, url: `https://www.youtube.com/channel/${text}` }
    if (text.startsWith('@')) {
        if (!HANDLE.test(text.slice(1)) && !text.includes('/')) {
            return { ok: false, refusal: 'That is not a handle YouTube would give out.' }
        }
        return fromUrl(`https://www.youtube.com/${text}`)
    }
    if (!text.includes('/') && !text.includes('.') && !text.includes(':')) {
        if (!HANDLE.test(text)) return { ok: false, refusal: 'That is not a handle YouTube would give out.' }
        return fromUrl(`https://www.youtube.com/@${text}`)
    }
    // A scheme with a dot in it is a host and a port, not a scheme -- `youtube.com:8080/@name`
    // reads as one either way, and the reading that makes it an address is the right one.
    const scheme = /^([a-z][\w+.-]*):/i.exec(text)?.[1]
    if (scheme !== undefined && !scheme.includes('.')) {
        const named = scheme.toLowerCase()
        if (named !== 'http' && named !== 'https') {
            return { ok: false, refusal: 'Only http and https addresses.' }
        }
        return fromUrl(text)
    }
    // A pasted address is as likely to have had its scheme eaten by whatever showed it as not,
    // and https is the only scheme YouTube answers on anyway.
    return fromUrl(`https://${text}`)
}

function fromUrl(candidate: string): ChannelAddress {
    let parsed: URL
    try {
        parsed = new URL(candidate)
    } catch {
        return { ok: false, refusal: 'That is not an address.' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, refusal: 'Only http and https addresses.' }
    }
    const host = parsed.hostname.toLowerCase()
    if (!ALLOWED_HOSTS.has(host)) return { ok: false, refusal: 'That address is not on YouTube.' }
    // A `youtu.be` link is a share link for one video; there is no channel behind the path.
    if (host === 'youtu.be') return { ok: false, refusal: 'That is a video, not a channel.' }

    const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
    const first = segments[0]
    if (first === undefined) return { ok: false, refusal: 'That address names no channel.' }
    if (first === 'watch' || (first === 'shorts' && segments.length > 1) || first === 'embed') {
        return { ok: false, refusal: 'That is a video, not a channel. Open the channel it is on.' }
    }
    if (first === 'playlist') return { ok: false, refusal: 'That is a playlist, not a channel.' }

    let path: string[]
    if (first.startsWith('@')) {
        path = [first]
    } else if (CHANNEL_PREFIXES.has(first) && segments[1] !== undefined) {
        path = [first, segments[1]]
    } else {
        return { ok: false, refusal: 'That does not look like a channel address.' }
    }
    // Whatever tab the address was copied from is dropped: the server appends the tab it is
    // listing, so a tab left on the end would ask for `/@name/videos/shorts`.
    const rest = segments.slice(path.length).filter((segment) => !TAB_SEGMENTS.has(segment.toLowerCase()))
    if (rest.length > 0) return { ok: false, refusal: 'That does not look like a channel address.' }
    // One host, whatever was pasted: the server keys its cache on the URL, and `m.` and `www.`
    // reaching the same channel as two entries is the same extraction run twice.
    return { ok: true, url: `https://www.youtube.com/${path.join('/')}` }
}

// ---- Counts -------------------------------------------------------------

/** The units a large count is written in, largest first. */
const UNITS: readonly { divisor: number; suffix: string }[] = [
    { divisor: 1e9, suffix: 'B' },
    { divisor: 1e6, suffix: 'M' },
    { divisor: 1e3, suffix: 'K' },
]

/**
 * A count, short enough to sit on a row.
 *
 * TRUNCATED, NOT ROUNDED, which is both what YouTube itself does and what stops 999,999 being
 * written "1000.0K" -- a unit the next one up exists for. A trailing `.0` is dropped, so a
 * round million is "1M" rather than "1.0M".
 *
 * `capped` says the number is the size of a capped listing rather than a total, and it is
 * written with a `+` after it: "60+" is the channel having at least sixty, which is the honest
 * reading of a listing that stopped counting.
 */
export function formatCount(count: number, capped = false): string {
    if (!Number.isFinite(count) || count <= 0) return '0'
    const whole = Math.floor(count)
    const unit = UNITS.find((candidate) => whole >= candidate.divisor)
    const written =
        unit === undefined
            ? String(whole)
            : `${String(Math.floor((whole / unit.divisor) * 10) / 10)}${unit.suffix}`
    return capped ? `${written}+` : written
}

/** What one tab's number is, and whether the listing it came from was capped. */
export function countOn(counts: YouTubeCounts, tab: YouTubeTab): { total: number; capped: boolean } {
    if (tab === 'shorts') return { total: counts.shorts, capped: counts.shorts_capped }
    if (tab === 'streams') return { total: counts.live, capped: counts.live_capped }
    return { total: counts.videos, capped: counts.videos_capped }
}

/**
 * The counts a channel row says out loud.
 *
 * Videos is always stated, even at zero, because a channel with none is a fact worth having on
 * the row. Shorts and live are stated only where there are some: most channels have neither,
 * and three quarters of a listing reading "0 shorts · 0 live" is a column of noise.
 */
export function countsSummary(counts: YouTubeCounts): string[] {
    return TABS.filter(
        (definition) => definition.tab === 'videos' || countOn(counts, definition.tab).total > 0,
    ).map((definition) => {
        const { total, capped } = countOn(counts, definition.tab)
        return `${formatCount(total, capped)} ${definition.label.toLowerCase()}`
    })
}

// ---- The items on a tab -------------------------------------------------

/** Whether an item will play. A broadcast still running has no fixed length and no VOD stream. */
export function isPlayable(item: YouTubeVideo): boolean {
    return !item.is_live
}

/**
 * The items one tab draws, in the order it draws them.
 *
 * The server answers a tab with that tab's items already newest first, so nothing is re-sorted:
 * an upload order somebody recognises is worth more than any order this client could invent.
 * What does move is a broadcast that is on air now, which goes to the top of the Live tab --
 * it is the one item on the screen that is happening rather than sitting there, even though it
 * is the one item that will not play yet.
 *
 * The filter is what makes this a grouping rather than a pass-through: an item is on the tab
 * whose kind it carries, so a listing that came back holding more than it was asked for draws
 * on the tab it belongs to instead of under the wrong heading.
 */
export function itemsOn(items: readonly YouTubeVideo[], tab: YouTubeTab): YouTubeVideo[] {
    const definition = TABS.find((candidate) => candidate.tab === tab)
    const mine = definition === undefined ? [...items] : items.filter((item) => item.kind === definition.kind)
    return [...mine.filter((item) => item.is_live), ...mine.filter((item) => !item.is_live)]
}

/** What an empty tab says, in that tab's own words. */
export function emptyTabNote(tab: YouTubeTab): string {
    if (tab === 'shorts') return 'This channel has no shorts.'
    if (tab === 'streams') return 'This channel has no live streams.'
    return 'This channel has no videos.'
}

// ---- The quality ladder -------------------------------------------------

/** The cap that asks for no cap at all, which is the server deciding. */
export const AUTO_HEIGHT = 0

/** One rung: the cap to send, and what it is called. */
export interface QualityChoice {
    height: number
    label: string
}

/**
 * The qualities to offer, tallest first, with Auto at the head.
 *
 * AUTO IS NOT A HEIGHT. Sending no cap lets the server use whatever it was configured with,
 * which is the right answer for almost everybody and the only one that keeps working when an
 * instance is re-configured -- so it is the first row and it is not a number.
 *
 * Tallest first because the list is read as "how good", and duplicates are dropped: the heights
 * come off the wire and a server that listed one twice would draw two identical rows.
 */
export function qualityLadder(heights: readonly number[]): QualityChoice[] {
    const rungs = [...new Set(heights.filter((height) => Number.isFinite(height) && height > 0))].toSorted(
        (left, right) => right - left,
    )
    return [
        { height: AUTO_HEIGHT, label: 'Auto' },
        ...rungs.map((height) => ({ height, label: `${String(height)}p` })),
    ]
}

/**
 * The rung nearest a remembered height, or Auto.
 *
 * A choice is kept between videos and a server's ladder is its own, so a height that was on the
 * ladder last week may not be on it today. Snapping rather than falling back to Auto keeps the
 * intention: somebody who asked for 1440 on a server that now tops out at 1080 wanted the top.
 * A tie goes to the shorter rung, which is what the server does with the same arithmetic.
 */
export function snapHeight(heights: readonly number[], height: number): number {
    if (!Number.isFinite(height) || height <= 0) return AUTO_HEIGHT
    const rungs = heights
        .filter((rung) => Number.isFinite(rung) && rung > 0)
        .toSorted((left, right) => left - right)
    if (rungs.length === 0) return AUTO_HEIGHT
    return rungs.reduce((best, rung) => (Math.abs(rung - height) < Math.abs(best - height) ? rung : best))
}
