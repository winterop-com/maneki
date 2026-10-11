/**
 * Where the Radio screen's stations come from: a server, or this device alone.
 *
 * RADIO NEEDS NO SERVER. Signed in, the stations are the server's (shared, relayed, with their
 * logos and the song each announces). "Just listen to radio" has no server: the built-in list
 * ships here, stations added from search are kept on this device, and the open station
 * directory (radio-browser.info, which answers any origin) is asked directly. What is lost is
 * what only a relay can do: the song titles and, in a browser, the spectrum.
 *
 * ONE SHAPE FOR BOTH, so the screen does not branch on which it has: a list, a search, an add
 * and a remove.
 */

import {
    addStation,
    getStations,
    removeStation,
    searchStations,
    type Credentials,
    type FoundStation,
    type Station,
} from '@/lib/subsonic'

export interface RadioSource {
    stations: () => Promise<Station[]>
    search: (query: string) => Promise<FoundStation[]>
    add: (found: FoundStation) => Promise<void>
    remove: (station: Station) => Promise<void>
}

/** The server's stations, as the screen has always had them. */
export function serverRadio(credentials: Credentials): RadioSource {
    return {
        stations: () => getStations(credentials),
        search: (query) =>
            searchStations(credentials, query).catch((error: unknown) => {
                const reason = error instanceof Error ? error.message : String(error)
                throw new Error(`The station directory did not answer: ${reason}`)
            }),
        add: (found) => addStation(credentials, found),
        remove: (station) => removeStation(credentials, station),
    }
}

/** The built-in stations, the same list the server ships (without its logo files). */
export const DEVICE_STATIONS: readonly { name: string; streamUrl: string; homePageUrl: string }[] = [
    {
        name: 'NRK mP3',
        streamUrl: 'https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/mp3',
        homePageUrl: 'https://radio.nrk.no/direkte/mp3',
    },
    {
        name: 'NRK P3',
        streamUrl: 'https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/p3',
        homePageUrl: 'https://radio.nrk.no/direkte/p3',
    },
    {
        name: 'NRK P3 Musikk',
        streamUrl: 'https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/p3musikk',
        homePageUrl: 'https://radio.nrk.no/direkte/p3musikk',
    },
    {
        name: 'NRK Nyheter',
        streamUrl: 'https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/nyheter',
        homePageUrl: 'https://radio.nrk.no/direkte/nyheter',
    },
    {
        name: 'Nectarine Demoscene Radio',
        streamUrl: 'http://nectarine.from-de.com/necta192',
        homePageUrl: 'https://scenestream.net/demovibes/',
    },
    {
        name: 'SceneSat Radio',
        streamUrl: 'https://streams.scenesat.com/main/hq.mp3',
        homePageUrl: 'https://scenesat.com/',
    },
    {
        name: 'Kohina',
        streamUrl: 'https://player.kohina.com/icecast/stream.aac',
        homePageUrl: 'https://kohina.com/',
    },
    {
        name: 'SLAY Radio',
        streamUrl: 'http://relay3.slayradio.org:8000/',
        homePageUrl: 'https://www.slayradio.org/',
    },
    {
        name: 'CVGM',
        streamUrl: 'https://slacker.cvgm.net/cvgm192',
        homePageUrl: 'https://radio.cvgm.net/demovibes/',
    },
    { name: 'HYPR', streamUrl: 'https://hypr.website/hypr.mp3', homePageUrl: 'https://hypr.website/' },
]

/** Where this device keeps the stations added from search. */
export const DEVICE_STATIONS_KEY = 'maneki.radioStations'

/** The directory's API, asked directly; it allows any origin. */
const DIRECTORY = 'https://de1.api.radio-browser.info/json/stations/search'

/** What a search says when the directory cannot be reached or does not answer. */
export const DIRECTORY_SILENT = 'The station directory did not answer. Try again in a moment.'

/** As many results as the server's search returns. */
const DIRECTORY_LIMIT = 30

interface KeptStation {
    name: string
    streamUrl: string
    homePageUrl?: string
}

/** A stable id from the stream address, so a row keeps its identity across starts. */
function deviceId(streamUrl: string): string {
    let hash = 0
    for (const char of streamUrl) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0
    return `dev_${(hash >>> 0).toString(16)}`
}

/** Radio with no server: the built-in list, stations kept on this device, the directory asked directly. */
export function deviceRadio(
    storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
    fetcher: (address: string) => Promise<Response> = (address) => fetch(address),
): RadioSource {
    const kept = (): KeptStation[] => {
        try {
            const raw = storage.getItem(DEVICE_STATIONS_KEY)
            const parsed: unknown = raw === null ? [] : JSON.parse(raw)
            return Array.isArray(parsed) ? (parsed as KeptStation[]) : []
        } catch {
            return []
        }
    }
    const keep = (stations: KeptStation[]) => {
        try {
            storage.setItem(DEVICE_STATIONS_KEY, JSON.stringify(stations))
        } catch {
            // Storage refused: the station lasts as long as this page does.
        }
    }
    const all = (): Station[] => [
        ...kept().map((one) => ({ id: deviceId(one.streamUrl), ...one, custom: true })),
        ...DEVICE_STATIONS.filter((one) => !kept().some((added) => added.streamUrl === one.streamUrl)).map(
            (one) => ({ id: deviceId(one.streamUrl), ...one }),
        ),
    ]
    return {
        stations: async () => all(),
        search: async (query) => {
            const address = `${DIRECTORY}?${new URLSearchParams({
                name: query,
                limit: String(DIRECTORY_LIMIT),
                hidebroken: 'true',
                order: 'clickcount',
                reverse: 'true',
            }).toString()}`
            // The network's own words ("Load failed", "Failed to fetch") say nothing to anybody.
            const answer = await fetcher(address).catch(() => null)
            if (answer === null || !answer.ok) throw new Error(DIRECTORY_SILENT)
            const rows = (await answer.json()) as Record<string, unknown>[]
            const listed = new Set(all().map((one) => one.streamUrl))
            return rows.flatMap((row) => {
                const found = foundOf(row, listed)
                return found === null ? [] : [found]
            })
        },
        add: async (found) => {
            if (all().some((one) => one.streamUrl === found.streamUrl)) {
                throw new Error(`${found.name} is already in the list`)
            }
            keep([
                { name: found.name, streamUrl: found.streamUrl, homePageUrl: found.homepageUrl },
                ...kept(),
            ])
        },
        remove: async (station) => {
            keep(kept().filter((one) => one.streamUrl !== station.streamUrl))
        },
    }
}

/**
 * One directory row as a found station, or null for one that cannot play here.
 *
 * The same rules the server's search applies: an http(s) stream with a name, no HLS (its
 * segments are named relative to a playlist), and a logo only when it is an address.
 */
function foundOf(row: Record<string, unknown>, listed: ReadonlySet<string>): FoundStation | null {
    const text = (key: string): string | undefined => {
        const value = typeof row[key] === 'string' ? (row[key] as string).trim() : ''
        return value === '' ? undefined : value
    }
    const stream = text('url_resolved') ?? text('url') ?? ''
    const name = text('name') ?? ''
    if (!/^https?:\/\//.test(stream) || name === '') return null
    const hls = row.hls === 1 || row.hls === '1' || row.hls === true
    if (hls || /\.m3u8?$/i.test(stream.split('?', 1)[0]!)) return null
    const logo = text('favicon')
    const bitrate = typeof row.bitrate === 'number' && row.bitrate > 0 ? row.bitrate : undefined
    return {
        id: text('stationuuid') ?? stream,
        name,
        streamUrl: stream,
        homepageUrl: text('homepage'),
        logo: logo !== undefined && /^https?:\/\//.test(logo) ? logo : undefined,
        country: text('country'),
        countryCode: text('countrycode'),
        tags: (text('tags') ?? '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 6),
        codec: text('codec'),
        bitrate,
        added: listed.has(stream),
    }
}
