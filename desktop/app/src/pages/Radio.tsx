import { Play, Plus, Radio as RadioIcon, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { useStore, useStoreValue } from '@/hooks/use-store'
import { playerStore, playStation } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import {
    addStation,
    coverUrl,
    getStations,
    removeStation,
    searchStations,
    type Credentials,
    type FoundStation,
    type Station,
} from '@/lib/subsonic'
import { cn } from '@/lib/utils'

export const FIND_STATIONS_LABEL = 'Find stations'

/** How much has to be typed before the directory is asked, and how long to wait after typing. */
const FIND_MIN = 2
const FIND_DEBOUNCE_MS = 300

/**
 * Which station is playing.
 *
 * ONE FACT, NOT THE STORE. The player publishes four times a second while something is
 * sounding -- the position moved, which is what a scrub bar is for -- and a screen that read
 * the whole of it rebuilt every row of this list on every one of those ticks.
 */
const selectStationId = (state: { station: { id: string } | null }) => state.station?.id ?? null

/** What a found station is called while it plays, before it is anybody's: never a list id. */
function previewId(found: FoundStation): string {
    return `found:${found.id}`
}

/** The facts a found station is chosen by: where it is from, how it is sent, what it plays. */
function foundLine(found: FoundStation): string {
    const format = [found.codec, found.bitrate ? `${String(found.bitrate)}k` : undefined]
        .filter(Boolean)
        .join(' ')
    return [found.country, format, found.tags.slice(0, 3).join(', ')].filter(Boolean).join(' · ')
}

/**
 * The stations this server carries, and the open directory to find more in.
 *
 * FIND, TRY, KEEP. The search asks radio-browser.info through the server; a result plays at
 * once, before it is kept, because a station is chosen by listening to it; Add keeps it on
 * this server for every client, its logo with it. A station added here can be taken off again;
 * the built-in ones cannot.
 */
export function RadioPage() {
    const session = useStore(sessionStore)
    const playingId = useStoreValue(playerStore, selectStationId)
    const [stations, setStations] = useState<Station[] | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [found, setFound] = useState<{ query: string; stations: FoundStation[] } | null>(null)
    const [finding, setFinding] = useState(false)
    const credentials = session.music

    const reload = (music: Credentials) => {
        loadStations(music, setStations, setRefusal)
    }

    useEffect(() => {
        if (credentials) loadStations(credentials, setStations, setRefusal)
    }, [credentials])

    // Asked once per pause in the typing, and an answer to a query that has since changed is
    // dropped: the flag rather than the timer, because the timer cannot stop a request in flight.
    useEffect(() => {
        const text = query.trim()
        if (!credentials || text.length < FIND_MIN) return
        let live = true
        const timer = setTimeout(() => {
            setFinding(true)
            searchStations(credentials, text)
                .then((answer) => {
                    if (live) setFound({ query: text, stations: answer })
                })
                .catch((error: Error) => {
                    if (live) toast.error(`The station directory did not answer: ${error.message}`)
                })
                .finally(() => {
                    if (live) setFinding(false)
                })
        }, FIND_DEBOUNCE_MS)
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [credentials, query])

    if (!credentials) return <Notice>This server has no stations.</Notice>
    if (refusal) return <Notice>{refusal}</Notice>

    const searching = query.trim().length >= FIND_MIN
    const results = searching && found !== null && found.query === query.trim() ? found.stations : null

    const keep = (station: FoundStation) => {
        addStation(credentials, station)
            .then(() => {
                toast.success(`Added ${station.name}`)
                setFound((held) =>
                    held === null
                        ? held
                        : {
                              ...held,
                              stations: held.stations.map((one) =>
                                  one.id === station.id ? { ...one, added: true } : one,
                              ),
                          },
                )
                reload(credentials)
            })
            .catch((error: Error) => toast.error(`Could not add ${station.name}: ${error.message}`))
    }

    const drop = (station: Station) => {
        removeStation(credentials, station)
            .then(() => {
                toast.success(`Removed ${station.name}`)
                reload(credentials)
            })
            .catch((error: Error) => toast.error(`Could not remove ${station.name}: ${error.message}`))
    }

    return (
        <div className="p-2">
            <div className="p-2">
                <InputGroup className="max-w-md">
                    <InputGroupAddon>
                        <Search aria-hidden />
                    </InputGroupAddon>
                    <InputGroupInput
                        type="search"
                        aria-label={FIND_STATIONS_LABEL}
                        placeholder="Find stations: a name, a city, a genre"
                        spellCheck={false}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value)
                        }}
                    />
                </InputGroup>
            </div>

            {searching && (
                <section className="mb-4">
                    <h2 className="px-3 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        From radio-browser.info
                    </h2>
                    {results === null ? (
                        finding ? (
                            <Skeleton rows={4} />
                        ) : null
                    ) : results.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-muted-foreground">No station answers to that.</p>
                    ) : (
                        <ul>
                            {results.map((station) => {
                                const live = playingId === previewId(station)
                                return (
                                    <li
                                        key={station.id}
                                        className={cn(
                                            'flex min-h-finger items-center gap-3 rounded-md px-3',
                                            live && 'bg-muted',
                                        )}
                                    >
                                        <FoundLogo station={station} />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm">{station.name}</p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {foundLine(station)}
                                            </p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-label={`Try ${station.name}`}
                                            title={`Try ${station.name}`}
                                            onClick={() => {
                                                playStation({
                                                    id: previewId(station),
                                                    name: station.name,
                                                    streamUrl: station.streamUrl,
                                                })
                                            }}
                                        >
                                            <Play aria-hidden />
                                        </Button>
                                        {station.added ? (
                                            <span className="w-16 shrink-0 text-center text-xs text-muted-foreground">
                                                Added
                                            </span>
                                        ) : (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="w-16 shrink-0"
                                                onClick={() => {
                                                    keep(station)
                                                }}
                                            >
                                                <Plus aria-hidden />
                                                Add
                                            </Button>
                                        )}
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                    <h2 className="px-3 pt-4 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        Your stations
                    </h2>
                </section>
            )}

            {stations === null ? (
                <Skeleton rows={8} />
            ) : stations.length === 0 ? (
                <Notice>No stations.</Notice>
            ) : (
                <ul>
                    {stations.map((station) => {
                        const live = playingId === station.id
                        return (
                            <li key={station.id} className="flex items-center">
                                <button
                                    type="button"
                                    onClick={() => playStation(station)}
                                    aria-current={live ? 'true' : undefined}
                                    className={cn(
                                        'row-hover flex min-h-finger w-full min-w-0 items-center gap-3 rounded-md px-3 text-left text-sm',
                                        live && 'bg-muted font-medium',
                                    )}
                                >
                                    {/* The station's own logo where it has one; the glyph where it has not. */}
                                    {station.coverArt ? (
                                        <img
                                            src={coverUrl(credentials, station.coverArt, 96) ?? undefined}
                                            alt=""
                                            className="size-8 shrink-0 rounded-md object-cover"
                                        />
                                    ) : (
                                        <span className="flex size-8 shrink-0 items-center justify-center">
                                            <RadioIcon className="size-4 text-muted-foreground" aria-hidden />
                                        </span>
                                    )}
                                    <span className="min-w-0 flex-1 truncate">{station.name}</span>
                                    {live && (
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            playing
                                        </span>
                                    )}
                                </button>
                                {station.custom && (
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`Remove ${station.name}`}
                                        title={`Remove ${station.name}`}
                                        className="ml-1 shrink-0 text-muted-foreground"
                                        onClick={() => {
                                            drop(station)
                                        }}
                                    >
                                        <X aria-hidden />
                                    </Button>
                                )}
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}

/**
 * A found station's logo, straight from wherever the directory says it is.
 *
 * Not through the server: the station is not this server's yet, so there is nothing for its
 * cover endpoint to serve. A logo that does not load gives way to the glyph instead of the
 * browser's broken-image mark, and no referrer goes with the request.
 */
function FoundLogo({ station }: { station: FoundStation }) {
    const [broken, setBroken] = useState(false)
    if (!station.logo || broken) {
        return (
            <span className="flex size-8 shrink-0 items-center justify-center">
                <RadioIcon className="size-4 text-muted-foreground" aria-hidden />
            </span>
        )
    }
    return (
        <img
            src={station.logo}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => {
                setBroken(true)
            }}
            className="size-8 shrink-0 rounded-md bg-muted object-contain"
        />
    )
}

/** Read the server's stations into the screen, or the reason it would not say. */
function loadStations(
    music: Credentials,
    setStations: (stations: Station[]) => void,
    setRefusal: (refusal: string) => void,
): void {
    getStations(music)
        .then(setStations)
        .catch((error: Error) => {
            setRefusal(error.message)
        })
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">{children}</p>
        </div>
    )
}
