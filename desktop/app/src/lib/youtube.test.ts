import { describe, expect, test } from 'vitest'

import type { YouTubeCounts, YouTubeKind, YouTubeVideo } from '@/lib/types'
import {
    AUTO_HEIGHT,
    countOn,
    countsSummary,
    emptyTabNote,
    formatCount,
    isPlayable,
    isTab,
    itemsOn,
    parseChannelAddress,
    qualityLadder,
    snapHeight,
    TABS,
} from '@/lib/youtube'

/** The URL a parse was supposed to reach, or the refusal it gave instead. */
function addressOf(input: string): string {
    const parsed = parseChannelAddress(input)
    return parsed.ok ? parsed.url : `refused: ${parsed.refusal}`
}

const REDLETTER = 'https://www.youtube.com/@RedLetterMedia'
const BY_ID = 'https://www.youtube.com/channel/UCz_6l1LrahwnXQBRSE-Cslw'

describe('a pasted channel address', () => {
    test('takes the form the address bar shows', () => {
        expect(addressOf('https://www.youtube.com/@RedLetterMedia')).toBe(REDLETTER)
        expect(addressOf('http://www.youtube.com/@RedLetterMedia')).toBe(REDLETTER)
    })

    test('takes one whose scheme was eaten by whatever showed it', () => {
        expect(addressOf('www.youtube.com/@RedLetterMedia')).toBe(REDLETTER)
        expect(addressOf('youtube.com/@RedLetterMedia')).toBe(REDLETTER)
    })

    test('takes a bare handle, with the @ and without it', () => {
        expect(addressOf('@RedLetterMedia')).toBe(REDLETTER)
        expect(addressOf('RedLetterMedia')).toBe(REDLETTER)
        expect(addressOf('  @RedLetterMedia  ')).toBe(REDLETTER)
    })

    test('takes a bare channel id, which is what the rest of the API is addressed by', () => {
        expect(addressOf('UCz_6l1LrahwnXQBRSE-Cslw')).toBe(BY_ID)
    })

    test('takes the older /channel, /c and /user forms', () => {
        expect(addressOf('https://www.youtube.com/channel/UCz_6l1LrahwnXQBRSE-Cslw')).toBe(BY_ID)
        expect(addressOf('youtube.com/c/RedLetterMedia')).toBe('https://www.youtube.com/c/RedLetterMedia')
        expect(addressOf('youtube.com/user/RedLetterMedia')).toBe(
            'https://www.youtube.com/user/RedLetterMedia',
        )
    })

    test('drops the tab the address was copied from, which the server appends itself', () => {
        expect(addressOf('https://www.youtube.com/@RedLetterMedia/videos')).toBe(REDLETTER)
        expect(addressOf('https://www.youtube.com/@RedLetterMedia/shorts')).toBe(REDLETTER)
        expect(addressOf('https://www.youtube.com/@RedLetterMedia/streams/')).toBe(REDLETTER)
        expect(addressOf('https://www.youtube.com/channel/UCz_6l1LrahwnXQBRSE-Cslw/featured')).toBe(BY_ID)
    })

    test('drops a share query, which would otherwise land in the middle of the path', () => {
        expect(addressOf('https://www.youtube.com/@RedLetterMedia?si=abcd1234')).toBe(REDLETTER)
        expect(addressOf('https://www.youtube.com/@RedLetterMedia/videos#top')).toBe(REDLETTER)
    })

    test('says one host whatever was pasted, so one channel is not cached twice', () => {
        expect(addressOf('https://m.youtube.com/@RedLetterMedia')).toBe(REDLETTER)
        expect(addressOf('https://music.youtube.com/channel/UCz_6l1LrahwnXQBRSE-Cslw')).toBe(BY_ID)
    })

    test('refuses a host that merely contains youtube.com', () => {
        expect(addressOf('https://youtube.com.evil.test/@RedLetterMedia')).toBe(
            'refused: That address is not on YouTube.',
        )
        expect(addressOf('https://evil.test/youtube.com/@RedLetterMedia')).toBe(
            'refused: That address is not on YouTube.',
        )
    })

    test('refuses a userinfo prefix, which parses to a host nobody meant to name', () => {
        expect(addressOf('https://youtube.com@evil.test/@RedLetterMedia')).toBe(
            'refused: That address is not on YouTube.',
        )
    })

    test('refuses a scheme the server would not fetch', () => {
        expect(addressOf('ftp://youtube.com/@RedLetterMedia')).toBe('refused: Only http and https addresses.')
        expect(addressOf('javascript:alert(1)')).toBe('refused: Only http and https addresses.')
    })

    test('refuses a video where a channel was asked for, rather than sending it to fail', () => {
        expect(addressOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
            'refused: That is a video, not a channel. Open the channel it is on.',
        )
        expect(addressOf('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
            'refused: That is a video, not a channel. Open the channel it is on.',
        )
        expect(addressOf('https://youtu.be/dQw4w9WgXcQ')).toBe('refused: That is a video, not a channel.')
    })

    test('refuses a playlist, which is not something this screen subscribes to', () => {
        expect(addressOf('https://www.youtube.com/playlist?list=PL123')).toBe(
            'refused: That is a playlist, not a channel.',
        )
    })

    test('refuses an address with no channel in it at all', () => {
        expect(addressOf('https://www.youtube.com/')).toBe('refused: That address names no channel.')
        expect(addressOf('https://www.youtube.com/feed/subscriptions')).toBe(
            'refused: That does not look like a channel address.',
        )
    })

    test('asks rather than guesses when nothing was typed', () => {
        expect(addressOf('')).toBe('refused: Paste a channel address, a handle, or a channel id.')
        expect(addressOf('   ')).toBe('refused: Paste a channel address, a handle, or a channel id.')
    })

    test('a word with a dot in it is an address, not a handle with a dot in it', () => {
        expect(addressOf('veritasium')).toBe('https://www.youtube.com/@veritasium')
        expect(addressOf('veritasium.com')).toBe('refused: That address is not on YouTube.')
        expect(addressOf('@red.letter.media')).toBe('https://www.youtube.com/@red.letter.media')
    })
})

describe('a count on a row', () => {
    test('is written out below a thousand', () => {
        expect(formatCount(0)).toBe('0')
        expect(formatCount(1)).toBe('1')
        expect(formatCount(999)).toBe('999')
    })

    test('carries a plus where the listing it came from stopped counting', () => {
        expect(formatCount(60, true)).toBe('60+')
        expect(formatCount(0, true)).toBe('0')
    })

    test('is shortened to a unit past a thousand', () => {
        expect(formatCount(1000)).toBe('1K')
        expect(formatCount(1200)).toBe('1.2K')
        expect(formatCount(12_340)).toBe('12.3K')
        expect(formatCount(1_200_000)).toBe('1.2M')
        expect(formatCount(1_000_000)).toBe('1M')
        expect(formatCount(2_400_000_000)).toBe('2.4B')
    })

    test('is truncated rather than rounded, so nothing rolls into a unit that exists', () => {
        expect(formatCount(999_999)).toBe('999.9K')
        expect(formatCount(1_999_999)).toBe('1.9M')
    })

    test('says nothing clever about a number that is not one', () => {
        expect(formatCount(Number.NaN)).toBe('0')
        expect(formatCount(-5)).toBe('0')
    })
})

function someCounts(has: Partial<YouTubeCounts> = {}): YouTubeCounts {
    return {
        videos: 0,
        shorts: 0,
        live: 0,
        videos_capped: false,
        shorts_capped: false,
        live_capped: false,
        ...has,
    }
}

describe('what a channel row says it holds', () => {
    test('reads each tab off the shape the server sends, live included', () => {
        const counts = someCounts({ videos: 60, videos_capped: true, shorts: 3, live: 1 })
        expect(countOn(counts, 'videos')).toEqual({ total: 60, capped: true })
        expect(countOn(counts, 'shorts')).toEqual({ total: 3, capped: false })
        expect(countOn(counts, 'streams')).toEqual({ total: 1, capped: false })
    })

    test('states videos even at nothing, because an empty channel is worth knowing', () => {
        expect(countsSummary(someCounts())).toEqual(['0 videos'])
    })

    test('leaves out a tab the channel has nothing on', () => {
        expect(countsSummary(someCounts({ videos: 12, shorts: 4 }))).toEqual(['12 videos', '4 shorts'])
        expect(countsSummary(someCounts({ videos: 60, videos_capped: true, live: 2 }))).toEqual([
            '60+ videos',
            '2 live',
        ])
    })
})

function item(id: string, kind: YouTubeKind, live = false): YouTubeVideo {
    return {
        id,
        title: id,
        duration_s: live ? null : 120,
        thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        kind,
        is_live: live,
        upload_date: null,
    }
}

describe('the items on a tab', () => {
    test('keeps the order the server listed them in, which is newest first', () => {
        const listed = [item('a', 'video'), item('b', 'video'), item('c', 'video')]
        expect(itemsOn(listed, 'videos').map((each) => each.id)).toEqual(['a', 'b', 'c'])
    })

    test('puts a broadcast that is on air now at the top of the live tab', () => {
        const listed = [item('past', 'live'), item('now', 'live', true), item('older', 'live')]
        expect(itemsOn(listed, 'streams').map((each) => each.id)).toEqual(['now', 'past', 'older'])
    })

    test('draws an item on the tab its kind belongs to and not another', () => {
        const listed = [item('long', 'video'), item('quick', 'short')]
        expect(itemsOn(listed, 'shorts').map((each) => each.id)).toEqual(['quick'])
        expect(itemsOn(listed, 'videos').map((each) => each.id)).toEqual(['long'])
    })

    test('a broadcast still running will not play, and everything else will', () => {
        expect(isPlayable(item('now', 'live', true))).toBe(false)
        expect(isPlayable(item('past', 'live'))).toBe(true)
        expect(isPlayable(item('a', 'video'))).toBe(true)
    })

    test('an empty tab says which tab is empty', () => {
        expect(emptyTabNote('videos')).toBe('This channel has no videos.')
        expect(emptyTabNote('shorts')).toBe('This channel has no shorts.')
        expect(emptyTabNote('streams')).toBe('This channel has no live streams.')
    })

    test('the three tabs are the three the server lists, in reading order', () => {
        expect(TABS.map((definition) => definition.tab)).toEqual(['videos', 'shorts', 'streams'])
        expect(TABS.map((definition) => definition.label)).toEqual(['Videos', 'Shorts', 'Live'])
        expect(isTab('shorts')).toBe(true)
        expect(isTab('live')).toBe(false)
    })
})

describe('the quality ladder', () => {
    test('offers auto first, then the server rungs tallest first', () => {
        expect(qualityLadder([480, 720, 1080, 1440, 2160])).toEqual([
            { height: 0, label: 'Auto' },
            { height: 2160, label: '2160p' },
            { height: 1440, label: '1440p' },
            { height: 1080, label: '1080p' },
            { height: 720, label: '720p' },
            { height: 480, label: '480p' },
        ])
    })

    test('draws a rung once however many times the server listed it', () => {
        expect(qualityLadder([720, 720, 480]).map((choice) => choice.height)).toEqual([0, 720, 480])
    })

    test('is still a control on a server that offers no rungs, and it says auto', () => {
        expect(qualityLadder([])).toEqual([{ height: AUTO_HEIGHT, label: 'Auto' }])
    })

    test('snaps a remembered height onto the ladder this server has', () => {
        const heights = [480, 720, 1080]
        expect(snapHeight(heights, 1080)).toBe(1080)
        expect(snapHeight(heights, 1440)).toBe(1080)
        expect(snapHeight(heights, 500)).toBe(480)
    })

    test('a tie goes to the shorter rung, the way the server resolves the same tie', () => {
        expect(snapHeight([480, 720], 600)).toBe(480)
    })

    test('anything that is not a height at all is auto', () => {
        expect(snapHeight([480, 720], 0)).toBe(AUTO_HEIGHT)
        expect(snapHeight([480, 720], -1)).toBe(AUTO_HEIGHT)
        expect(snapHeight([], 1080)).toBe(AUTO_HEIGHT)
    })
})
