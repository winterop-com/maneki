import { ChevronLeft, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VideoPlayer } from '@/components/video/VideoPlayer'
import { useStore } from '@/hooks/use-store'
import { youtube as youtubeApi } from '@/lib/api'
import { clock } from '@/lib/format'
import { registerActions, SCREEN_GROUP, type PaletteAction } from '@/lib/palette'
import { clearScreenStatus, setScreenStatus, type StatusTone } from '@/lib/screen-status'
import { sessionStore } from '@/lib/session'
import { countsHeld, rememberCounts, uncounted } from '@/lib/youtube-counts'
import type { YouTubeChannel, YouTubeTab, YouTubeVideo } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
    AUTO_HEIGHT,
    countsSummary,
    emptyTabNote,
    isPlayable,
    isTab,
    itemsOn,
    parseChannelAddress,
    qualityLadder,
    snapHeight,
    TABS,
} from '@/lib/youtube'

/** Where the chosen quality is kept: a decision about this connection, not about this video. */
const QUALITY_KEY = 'maneki.youtubeQuality'

/**
 * The subscribed channels, one channel, or one video.
 *
 * THREE ADDRESSES RATHER THAN ONE PANE WITH A SELECTION. The client this replaces held the
 * channel it was reading in a variable, so a channel somebody wanted to show another person was
 * a set of directions rather than a link. Here a channel is `/youtube/c/<id>` and a video is
 * `/youtube/v/<id>`, and both survive a reload.
 */
export function YouTubePage() {
    const { channelId, videoId } = useParams()
    const session = useStore(sessionStore)
    if (session.capabilities !== undefined && !session.capabilities.youtube) {
        return <Notice>This server has no YouTube.</Notice>
    }
    if (videoId) return <Watch id={videoId} />
    if (channelId) return <Channel id={channelId} />
    return <Channels />
}

/**
 * Say what this screen is doing along the foot of the shell, and stop saying it when it goes.
 *
 * Both facts the bar takes are the screen's: the note while something slow is in flight, and
 * the identifier, which here is the channel or video id the address is holding anyway.
 */
function useScreenNote(note: string | null, identifier: string | null): void {
    useEffect(() => {
        const tone: StatusTone = note === null ? 'quiet' : 'live'
        setScreenStatus({ note, tone, identifier })
        return clearScreenStatus
    }, [note, identifier])
}

/**
 * A read this screen can be asked to make again.
 *
 * `round` is what makes a second press a second question rather than the same one.
 * `refreshing` names the read a refresh was asked of, and is how the flag stops applying to
 * the next one: pressing refresh on a channel's Videos tab and then moving to its Shorts tab
 * is one re-listing, not two, and the second would be several seconds of yt-dlp nobody asked
 * for.
 */
interface Ask {
    round: number
    refreshing: string | null
}

const FIRST_ASK: Ask = { round: 0, refreshing: null }

/** Ask `read` again, with the server told to go and look rather than answer from what it holds. */
function again(read: string): (current: Ask) => Ask {
    return (current) => ({ round: current.round + 1, refreshing: read })
}

/** Ask again from whatever the server already holds, which is what a write that landed needs. */
function reread(current: Ask): Ask {
    return { round: current.round + 1, refreshing: null }
}

/**
 * An answer, and the question it answers.
 *
 * WHAT IS HELD IS TAGGED WITH WHAT WAS ASKED, so an answer to a question nobody is asking any
 * more -- the tab moved on while a listing was in flight -- is discarded on the next render
 * rather than drawn under the wrong heading. It is also what keeps the effects free of a
 * synchronous "clear what is on screen": the screen is empty because the key changed.
 */
interface Answer<T> {
    key: string
    value: T | null
    refusal: string | null
}

// ---- The channels ------------------------------------------------------

/** What the listing's own refresh is asked of, which is the whole of this screen. */
const CHANNELS_READ = 'channels'

function Channels() {
    const [channels, setChannels] = useState<YouTubeChannel[] | null>(null)
    const counts = useStore(countsHeld)
    const [refusal, setRefusal] = useState<string | null>(null)
    const [problem, setProblem] = useState<string | null>(null)
    const [typed, setTyped] = useState('')
    const [adding, setAdding] = useState(false)
    const [reading, setReading] = useState(true)
    const [counting, setCounting] = useState(false)
    const [ask, setAsk] = useState<Ask>(FIRST_ASK)
    const box = useRef<HTMLInputElement>(null)
    const navigate = useNavigate()

    /**
     * The channels, and then what each one holds.
     *
     * THE COUNTS COME AFTER THE LIST AND ONE AT A TIME. Each is three listings behind yt-dlp,
     * so asking for all of them at once is a burst YouTube answers with its bot check -- and
     * waiting for them before drawing anything would leave the screen empty for the several
     * seconds they take. The list paints, and the numbers fill in under it.
     *
     * AND THE SWEEP IS NOT RUN TWICE FOR THE SAME ANSWER. What was counted is held in
     * `lib/youtube-counts`, which outlives this screen, so Back out of a channel finds the
     * numbers already there instead of spending another minute of somebody's rate limit on
     * figures that have not moved. A refresh asks about every channel again, because that is
     * the reader saying they think there is something new.
     */
    useEffect(() => {
        let live = true
        const refreshing = ask.refreshing === CHANNELS_READ

        const load = async (): Promise<void> => {
            let listed: YouTubeChannel[]
            try {
                listed = await youtubeApi.channels(refreshing)
            } catch (error) {
                if (live) {
                    setRefusal(error instanceof Error ? error.message : 'the server did not answer')
                    setReading(false)
                }
                return
            }
            if (!live) return
            setChannels(listed)
            setRefusal(null)
            setReading(false)
            const ids = listed.map((channel) => channel.id)
            const wanted = refreshing ? ids : uncounted(countsHeld.get(), ids)
            setCounting(wanted.length > 0)
            for (const id of wanted) {
                if (!live) return
                try {
                    // oxlint-disable-next-line no-await-in-loop -- the sequence is the point
                    const held = await youtubeApi.counts(id, refreshing)
                    if (!live) return
                    rememberCounts(id, held)
                } catch {
                    // A channel whose numbers will not come just draws without them.
                }
            }
            if (live) setCounting(false)
        }

        void load()
        return () => {
            live = false
        }
    }, [ask])

    useScreenNote(reading ? 'reading your channels' : counting ? 'counting what each holds' : null, null)

    const focusBox = useCallback(() => {
        box.current?.focus()
    }, [])

    const refresh = useCallback(() => {
        setReading(true)
        setAsk(again(CHANNELS_READ))
    }, [])

    const actions = useMemo<PaletteAction[]>(
        () => [
            {
                id: 'youtube:add',
                title: 'Add a channel',
                group: SCREEN_GROUP,
                screen: true,
                icon: Plus,
                keywords: ['subscribe', 'channel', 'youtube', 'follow'],
                run: focusBox,
            },
            {
                id: 'youtube:refresh',
                title: 'Check the channels for new uploads',
                group: SCREEN_GROUP,
                screen: true,
                icon: RefreshCw,
                keywords: ['reload', 'refresh', 'again', 'uploads'],
                run: refresh,
            },
        ],
        [focusBox, refresh],
    )
    useEffect(() => registerActions(actions), [actions])

    /**
     * Subscribe to whatever was pasted.
     *
     * The address is put into the one form the server takes before anything is sent, so a
     * handle with no scheme on it is a subscription rather than a refusal several seconds
     * later, and a watch link is a sentence rather than a 502 out of yt-dlp.
     */
    const add = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault()
        if (adding) return
        const parsed = parseChannelAddress(typed)
        if (!parsed.ok) {
            setProblem(parsed.refusal)
            return
        }
        setAdding(true)
        setProblem(null)
        try {
            await youtubeApi.addChannel(parsed.url)
            setTyped('')
            setAsk(reread)
        } catch (error) {
            setProblem(error instanceof Error ? error.message : 'the server did not answer')
        } finally {
            setAdding(false)
        }
    }

    const remove = async (channel: YouTubeChannel): Promise<void> => {
        setProblem(null)
        try {
            await youtubeApi.removeChannel(channel.id)
        } catch (error) {
            setProblem(error instanceof Error ? error.message : 'the server did not answer')
            return
        }
        setAsk(reread)
    }

    return (
        <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
                <h1 className="flex-1 text-base">Channels</h1>
                <Refresh onClick={refresh} busy={reading || counting} label="Check for new uploads" />
            </div>

            <form className="flex items-start gap-2" onSubmit={(event) => void add(event)}>
                <div className="flex-1">
                    <Input
                        ref={box}
                        value={typed}
                        onChange={(event) => {
                            setTyped(event.target.value)
                            setProblem(null)
                        }}
                        spellCheck={false}
                        aria-label="Channel address"
                        aria-invalid={problem === null ? undefined : true}
                        placeholder="youtube.com/@RedLetterMedia, or a handle"
                    />
                    {problem !== null && <p className="mt-1 text-xs text-critical-ink">{problem}</p>}
                </div>
                <Button type="submit" disabled={adding || typed.trim() === ''}>
                    <Plus className="size-4" aria-hidden />
                    {adding ? 'Adding' : 'Add'}
                </Button>
            </form>

            {refusal !== null && <Notice>{refusal}</Notice>}
            {refusal === null && channels === null && <Notice>Reading your channels.</Notice>}
            {refusal === null && channels?.length === 0 && (
                <Notice>No channels yet. Paste a channel address above.</Notice>
            )}
            {channels !== null && channels.length > 0 && (
                <ul className="max-h-full overflow-y-auto rounded-lg border">
                    {channels.map((channel) => {
                        const held = counts.get(channel.id)
                        return (
                            <li key={channel.id} className="row-hover flex items-center gap-3 pr-2">
                                <button
                                    type="button"
                                    onClick={() => {
                                        navigate(`/youtube/c/${encodeURIComponent(channel.id)}`, {
                                            state: { channel },
                                        })
                                    }}
                                    className="flex min-h-finger min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                                >
                                    <Avatar channel={channel} />
                                    <span className="min-w-0 flex-1">
                                        <span
                                            className="block truncate text-sm font-medium"
                                            title={channel.title}
                                        >
                                            {channel.title}
                                        </span>
                                        {channel.handle !== null && (
                                            <span className="block truncate font-mono text-xs text-faint">
                                                {channel.handle}
                                            </span>
                                        )}
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {held === undefined
                                                ? 'counting'
                                                : countsSummary(held).join(' · ')}
                                        </span>
                                    </span>
                                </button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="destructive-action shrink-0"
                                    aria-label={`Unsubscribe from ${channel.title}`}
                                    onClick={() => void remove(channel)}
                                >
                                    <Trash2 className="size-4" aria-hidden />
                                </Button>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}

function Avatar({ channel }: { channel: YouTubeChannel }) {
    if (channel.thumbnail_url === null) {
        return <span className="size-10 shrink-0 rounded-full bg-muted" aria-hidden />
    }
    return (
        <img
            src={channel.thumbnail_url}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-10 shrink-0 rounded-full bg-muted object-cover"
        />
    )
}

// ---- One channel -------------------------------------------------------

/**
 * A channel's own screen: its three tabs, and what is on the one being read.
 *
 * THE TAB IS IN THE ADDRESS, replaced rather than pushed. A channel's Shorts tab is a link
 * somebody can send, and moving between three tabs of one channel is one destination rather
 * than three entries somebody then has to press Back through.
 *
 * THE HEADING ARRIVES WITH THE ROW THAT WAS PRESSED. There is no endpoint for one channel --
 * the identity comes off the listing -- so a press hands the channel along in the navigation's
 * own state, and a deep link reads the listing once to find it. Neither holds up the items.
 */
function Channel({ id }: { id: string }) {
    const location = useLocation()
    const [channel, setChannel] = useState<YouTubeChannel | null>(() => channelIn(location.state, id))
    const [answer, setAnswer] = useState<Answer<YouTubeVideo[]> | null>(null)
    const [ask, setAsk] = useState<Ask>(FIRST_ASK)
    const [params, setParams] = useSearchParams()
    const navigate = useNavigate()
    const asked = params.get('tab') ?? ''
    const tab: YouTubeTab = isTab(asked) ? asked : 'videos'
    const read = `${id}|${tab}`
    const key = `${read}|${String(ask.round)}`
    const held = answer?.key === key ? answer : null

    useEffect(() => {
        if (channel !== null) return
        let live = true
        youtubeApi.channels().then(
            (listed) => {
                if (live) setChannel(listed.find((each) => each.id === id) ?? null)
            },
            () => {
                // The heading falls back to the id, which the address is carrying anyway.
            },
        )
        return () => {
            live = false
        }
    }, [channel, id])

    useEffect(() => {
        let live = true
        youtubeApi.videos(id, tab, ask.refreshing === read).then(
            (listed) => {
                if (live) setAnswer({ key, value: listed, refusal: null })
            },
            (error: Error) => {
                if (live) setAnswer({ key, value: null, refusal: error.message })
            },
        )
        return () => {
            live = false
        }
    }, [ask.refreshing, id, key, read, tab])

    useScreenNote(held === null ? 'reading the channel' : null, id)

    const refresh = useCallback(() => {
        setAsk(again(read))
    }, [read])

    const actions = useMemo<PaletteAction[]>(
        () => [
            {
                id: 'youtube:refresh',
                title: 'Check this channel for new uploads',
                group: SCREEN_GROUP,
                screen: true,
                icon: RefreshCw,
                keywords: ['reload', 'refresh', 'again', 'uploads'],
                run: refresh,
            },
            {
                id: 'youtube:add',
                title: 'Add a channel',
                group: SCREEN_GROUP,
                screen: true,
                icon: Plus,
                keywords: ['subscribe', 'channel', 'youtube', 'follow'],
                run: () => {
                    navigate('/youtube')
                },
            },
        ],
        [navigate, refresh],
    )
    useEffect(() => registerActions(actions), [actions])

    const shown = held?.value === undefined || held.value === null ? null : itemsOn(held.value, tab)
    const refusal = held?.refusal ?? null

    return (
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 p-4">
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Back to the channels"
                    onClick={() => {
                        navigate('/youtube')
                    }}
                >
                    <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <h1 className="min-w-0 flex-1 truncate text-base" title={channel?.title ?? id}>
                    {channel?.title ?? id}
                </h1>
                <Refresh onClick={refresh} busy={held === null} label="Check for new uploads" />
            </div>

            <Tabs
                value={tab}
                onValueChange={(next) => {
                    if (typeof next !== 'string' || !isTab(next)) return
                    // REPLACED, NOT PUSHED: reading three tabs of one channel is one visit, and
                    // pushing each would put three presses of Back between here and the listing.
                    setParams(next === 'videos' ? {} : { tab: next }, { replace: true })
                }}
                className="min-h-0 flex-1"
            >
                <TabsList>
                    {TABS.map((definition) => (
                        <TabsTrigger key={definition.tab} value={definition.tab}>
                            {definition.label}
                        </TabsTrigger>
                    ))}
                </TabsList>
                {TABS.map((definition) => (
                    <TabsContent
                        key={definition.tab}
                        value={definition.tab}
                        className="min-h-0 overflow-y-auto"
                    >
                        {refusal !== null && <Notice>{refusal}</Notice>}
                        {refusal === null && shown === null && <Notice>Reading the channel.</Notice>}
                        {refusal === null && shown?.length === 0 && <Notice>{emptyTabNote(tab)}</Notice>}
                        {shown !== null && shown.length > 0 && (
                            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {shown.map((item) => (
                                    <li key={item.id}>
                                        <Item
                                            item={item}
                                            onOpen={() => {
                                                navigate(`/youtube/v/${encodeURIComponent(item.id)}`, {
                                                    state: { item },
                                                })
                                            }}
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </TabsContent>
                ))}
            </Tabs>
        </div>
    )
}

/**
 * One item on a channel's tab.
 *
 * A BROADCAST STILL RUNNING IS DRAWN AND NOT OFFERED. It has no fixed length and nothing to
 * transcode from one end to the other, so the card says LIVE, says why it cannot be opened, and
 * is not a button: a card that opened onto an error is a promise the pipeline cannot keep.
 */
function Item({ item, onOpen }: { item: YouTubeVideo; onOpen: () => void }) {
    const length = item.duration_s === null ? null : clock(item.duration_s)

    const inside = (
        <>
            <span className="relative block">
                <img
                    src={item.thumbnail_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="aspect-video w-full rounded-md bg-muted object-cover"
                />
                {item.is_live ? (
                    <span className="absolute right-1 bottom-1 rounded-sm bg-critical/15 px-1 text-xs text-critical-ink">
                        LIVE
                    </span>
                ) : (
                    length !== null && (
                        <span className="absolute right-1 bottom-1 rounded-sm bg-background/80 px-1 font-mono text-xs">
                            {length}
                        </span>
                    )
                )}
            </span>
            <span className="mt-2 line-clamp-2 block text-sm font-medium">{item.title}</span>
        </>
    )

    if (!isPlayable(item)) {
        return (
            <div
                className="w-full rounded-lg p-2 text-left opacity-60"
                title={`${item.title} (on air now, which is not something this server can play yet)`}
            >
                {inside}
            </div>
        )
    }
    return (
        <button
            type="button"
            onClick={onOpen}
            title={item.title}
            className="row-hover w-full rounded-lg p-2 text-left"
        >
            {inside}
        </button>
    )
}

// ---- One video ---------------------------------------------------------

/**
 * Watching one video.
 *
 * WHAT PLAYS IS MANEKI'S HLS, not YouTube's. The server resolves the stream with yt-dlp and
 * transcodes it through the same pipeline a local file goes through, so the player is the
 * player -- and the quality control is a cap handed to that resolver rather than a track this
 * client picks between.
 *
 * A CHANGE OF QUALITY IS A NEW PLAYER. The cap is part of the manifest's address and of the
 * session the server keys its segments on, so the element is remounted rather than re-pointed:
 * a player told to swap its source mid-stream is a player holding segments from two sessions.
 */
function Watch({ id }: { id: string }) {
    const location = useLocation()
    const [resolved, setResolved] = useState<Answer<YouTubeVideo> | null>(null)
    const [heights, setHeights] = useState<number[]>([])
    const [height, setHeight] = useState<number>(rememberedHeight)
    const navigate = useNavigate()
    const held = resolved?.key === id ? resolved : null
    // What the card that was pressed already knew, so the title is on screen before the
    // resolver has finished. A deep link has none, and waits.
    const video = held?.value ?? itemIn(location.state, id)
    const refusal = held?.refusal ?? null

    useEffect(() => {
        let live = true
        youtubeApi.quality().then(
            (offered) => {
                if (!live) return
                setHeights(offered.heights)
                setHeight((current) => snapHeight(offered.heights, current))
            },
            () => {
                // No ladder means Auto, which is the server deciding, which is the default.
            },
        )
        return () => {
            live = false
        }
    }, [])

    /**
     * The title and the length.
     *
     * This is also what resolves the stream server-side, so the manifest the player asks for a
     * moment later is answered out of a cache rather than by a second yt-dlp run -- and a video
     * that has been taken down is a sentence here rather than a player that never starts.
     */
    useEffect(() => {
        let live = true
        youtubeApi.video(id).then(
            (got) => {
                if (live) setResolved({ key: id, value: got, refusal: null })
            },
            (error: Error) => {
                if (live) setResolved({ key: id, value: null, refusal: error.message })
            },
        )
        return () => {
            live = false
        }
    }, [id])

    useScreenNote(held === null ? 'resolving the stream' : null, id)

    const ladder = qualityLadder(heights)
    const length = video === null || video.duration_s === null ? null : clock(video.duration_s)

    const choose = (next: number): void => {
        setHeight(next)
        try {
            localStorage.setItem(QUALITY_KEY, String(next))
        } catch {
            // Not being able to remember is survivable; the next video opens on Auto.
        }
    }

    return (
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Back"
                    onClick={() => {
                        navigate(-1)
                    }}
                >
                    <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <h1 className="min-w-0 flex-1 truncate text-base" title={video?.title ?? id}>
                    {video?.title ?? id}
                </h1>
                {ladder.length > 1 && (
                    <select
                        aria-label="Quality"
                        value={height}
                        onChange={(event) => {
                            choose(Number(event.target.value))
                        }}
                        className="h-8 rounded-md border bg-field px-2 text-xs"
                    >
                        {ladder.map((choice) => (
                            <option key={choice.height} value={choice.height}>
                                {choice.label}
                            </option>
                        ))}
                    </select>
                )}
            </div>

            {refusal !== null ? (
                <Notice>{refusal}</Notice>
            ) : (
                <div className="aspect-video w-full overflow-hidden rounded-lg bg-background">
                    <VideoPlayer
                        key={height}
                        src={youtubeApi.hlsUrl(id, height === AUTO_HEIGHT ? undefined : height)}
                        kind="hls"
                        poster={youtubeApi.posterUrl(id)}
                        autoplay
                        onError={(message) => {
                            setResolved({ key: id, value: video, refusal: message })
                        }}
                    />
                </div>
            )}

            {length !== null && <p className="font-mono text-xs text-muted-foreground">{length}</p>}
        </div>
    )
}

/**
 * The cap chosen last time.
 *
 * Snapped against the ladder this bundle was built knowing, and snapped again once the server
 * has said what it actually offers -- a number out of storage is not a promise about a server.
 */
function rememberedHeight(): number {
    try {
        return snapHeight([480, 720, 1080, 1440, 2160], Number(localStorage.getItem(QUALITY_KEY)))
    } catch {
        return AUTO_HEIGHT
    }
}

// ---- What a press handed along -----------------------------------------

/** The channel the listing put in the navigation's state, when it is the one being opened. */
function channelIn(state: unknown, id: string): YouTubeChannel | null {
    if (typeof state !== 'object' || state === null) return null
    const held = (state as { channel?: YouTubeChannel }).channel
    return held !== undefined && held.id === id ? held : null
}

/** The item a channel's card put in the navigation's state, when it is the one being opened. */
function itemIn(state: unknown, id: string): YouTubeVideo | null {
    if (typeof state !== 'object' || state === null) return null
    const held = (state as { item?: YouTubeVideo }).item
    return held !== undefined && held.id === id ? held : null
}

function Refresh({ onClick, busy, label }: { onClick: () => void; busy: boolean; label: string }) {
    return (
        <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            disabled={busy}
            onClick={onClick}
            className="shrink-0"
        >
            <RefreshCw className={cn('size-4', busy && 'animate-spin')} aria-hidden />
        </Button>
    )
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">{children}</p>
        </div>
    )
}
