import { Activity, ChevronLeft, Maximize2, PanelRight } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { StatsOverlay, STATS_LABEL } from '@/components/video/StatsOverlay'
import { VideoPlayer, type PlayerSubtitle, type VideoHandle } from '@/components/video/VideoPlayer'
import { Button } from '@/components/ui/button'
import { video as videoApi } from '@/lib/api'
import { clock } from '@/lib/format'
import { registerActions, SCREEN_GROUP } from '@/lib/palette'
import { claimStageKey } from '@/lib/screen-keys'
import { clearScreenStatus, setScreenStatus } from '@/lib/screen-status'
import { seeks, togglesTheater, type FocusedField } from '@/lib/shortcuts'
import type { VideoEntry, VideoSubtitleTrack } from '@/lib/types'
import {
    browseHref,
    fileSize,
    parentOf,
    preferredSubtitles,
    resolutionLabel,
    subtitleLabel,
    watchHref,
} from '@/lib/video'
import { cn } from '@/lib/utils'

/** How often to look for the frame size before the first frame has been decoded. */
const SIZE_POLL_MS = 500

/** How often to ask whether the contact sheet behind the player has been made yet. */
const POSTER_POLL_MS = 4000

export const THEATER_LABEL = 'Hide the list beside the video'
export const FULLSCREEN_LABEL = 'Put the video over the whole screen'

/**
 * One video, playing.
 *
 * WHAT IS BESIDE IT IS WHAT IS BESIDE IT ON THE DISK. A video in a library is almost always one
 * of a run -- the next episode, the next part -- so the folder it sits in is the list down the
 * side, and moving on is one click rather than a walk back up the trail and down again. It is
 * the folder rather than a queue because there is no queue here: nothing about watching is
 * played in order the way a record is.
 *
 * AND IT GOES AWAY ON ONE KEY. `t` takes the list off and gives the width to the picture, which
 * is what somebody watching rather than choosing wants; `f` is the browser's own full screen on
 * the player, claimed from the spectrum for as long as this screen is open.
 */
export function WatchPage() {
    const { videoId } = useParams()
    if (videoId === undefined) return <Notice>No video.</Notice>
    return <Watch key={videoId} id={videoId} />
}

function Watch({ id }: { id: string }) {
    const [video, setVideo] = useState<VideoEntry | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const [tracks, setTracks] = useState<VideoSubtitleTrack[]>([])
    const [beside, setBeside] = useState<VideoEntry[]>([])
    const [size, setSize] = useState<{ width: number; height: number } | null>(null)
    const [posterToken, setPosterToken] = useState<number | undefined>(undefined)
    const [theater, setTheater] = useState(false)
    const [stats, setStats] = useState(false)
    const player = useRef<VideoHandle | null>(null)
    const navigate = useNavigate()

    // The video itself. A link somebody was sent names an id and nothing else, so the screen
    // reads the whole entry rather than expecting to have walked into its folder first.
    useEffect(() => {
        let live = true
        void videoApi.detail(id).then(
            (entry) => {
                if (live) setVideo(entry)
            },
            (error: Error) => {
                if (live) setRefusal(error.message)
            },
        )
        return () => {
            live = false
        }
    }, [id])

    // Every track the file offers. The listing's own summary is a count, and what the captions
    // menu needs is a label and an address per track.
    useEffect(() => {
        let live = true
        void videoApi.subtitles(id).then(
            (found) => {
                if (live) setTracks(found)
            },
            () => {
                // A file with no subtitles answers a refusal on some servers and an empty list
                // on others, and either way there is nothing to put in the menu.
            },
        )
        return () => {
            live = false
        }
    }, [id])

    // What else is in the folder, which is the list down the side.
    const folder = video === null ? null : parentOf(video.rel_path)
    useEffect(() => {
        if (folder === null) return
        let live = true
        void videoApi.browse(folder).then(
            (answer) => {
                if (live) setBeside(answer.videos)
            },
            () => {
                // The list beside the player is a convenience; the video plays without it.
            },
        )
        return () => {
            live = false
        }
    }, [folder])

    /**
     * The frame size, which only the player knows.
     *
     * The listing carries no dimensions and asking the server for them would be an ffprobe per
     * row for a fact only the open video needs. So it is read off the player, and the reading
     * stops the moment there is one -- this is a handful of ticks at the head of a film.
     */
    useEffect(() => {
        if (size !== null) return
        const timer = setInterval(() => {
            const found = player.current?.frameSize() ?? null
            if (found !== null) setSize(found)
        }, SIZE_POLL_MS)
        return () => {
            clearInterval(timer)
        }
    }, [size])

    /**
     * The contact sheet arrives late on a video nobody has opened before.
     *
     * The server answers a placeholder while ffmpeg makes it, and the player would hold that
     * placeholder for as long as it is open -- so the screen asks whether it has landed and
     * changes the URL when it has, which is what makes the browser fetch it.
     */
    useEffect(() => {
        if (posterToken !== undefined) return
        let live = true
        let timer: ReturnType<typeof setTimeout>
        const look = async (): Promise<void> => {
            try {
                const answer = await videoApi.thumbnailsReady()
                if (!live) return
                if (answer.posters_ready.includes(id)) {
                    setPosterToken(1)
                    return
                }
            } catch {
                // The next tick asks again.
            }
            if (live) timer = setTimeout(() => void look(), POSTER_POLL_MS)
        }
        timer = setTimeout(() => void look(), POSTER_POLL_MS)
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [id, posterToken])

    /**
     * Stop the server transcoding a film nobody is watching.
     *
     * Segments are made speculatively either side of the one last asked for and each completion
     * starts the next, so closing the player without saying so leaves the machine encoding to
     * the end of the file. This is the one thing this screen has to tell the server.
     */
    useEffect(
        () => () => {
            videoApi.cancelSession(id)
        },
        [id],
    )

    // The id is a machine's string and belongs in the bar's mono cell, not in the heading.
    useEffect(() => {
        setScreenStatus({ note: null, tone: 'quiet', identifier: id })
    }, [id])
    useEffect(() => clearScreenStatus, [])

    const onReady = useCallback((handle: VideoHandle | null) => {
        player.current = handle
    }, [])

    const toggleTheater = useCallback(() => {
        setTheater((on) => !on)
    }, [])

    const toggleStats = useCallback(() => {
        setStats((on) => !on)
    }, [])

    const fullscreen = useCallback(() => {
        player.current?.toggleFullscreen()
    }, [])

    // `f` is the spectrum's everywhere else in the app; here it is the picture's.
    useEffect(() => claimStageKey(fullscreen), [fullscreen])

    /**
     * The keys that only mean something while a video is on screen.
     *
     * Bound here rather than in the shell, because that is what they are: the arrows belong to
     * whatever is in front of somebody -- a list walks its rows with them -- and a screen that
     * is not playing anything has nothing for them to do.
     */
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            const press = {
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
            }
            const element = document.activeElement
            const focused: FocusedField | null =
                element instanceof HTMLElement
                    ? { tagName: element.tagName, isContentEditable: element.isContentEditable }
                    : null
            if (togglesTheater(press, focused)) {
                event.preventDefault()
                toggleTheater()
                return
            }
            const seek = seeks(press, focused)
            if (seek === null) return
            event.preventDefault()
            player.current?.seekBy(seek)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [toggleTheater])

    useEffect(
        () =>
            registerActions([
                {
                    id: 'video:theater',
                    title: theater ? 'Show the list beside the video' : THEATER_LABEL,
                    group: SCREEN_GROUP,
                    screen: true,
                    icon: PanelRight,
                    keywords: ['theater', 'theatre', 'wide', 'list'],
                    run: toggleTheater,
                },
                {
                    id: 'video:fullscreen',
                    title: FULLSCREEN_LABEL,
                    group: SCREEN_GROUP,
                    screen: true,
                    icon: Maximize2,
                    keywords: ['full screen', 'fullscreen', 'stage'],
                    run: fullscreen,
                },
                {
                    id: 'video:stats',
                    title: stats ? 'Hide the stream stats' : STATS_LABEL,
                    group: SCREEN_GROUP,
                    screen: true,
                    icon: Activity,
                    keywords: ['transcode', 'buffer', 'encoder', 'bandwidth', 'diagnostics'],
                    run: toggleStats,
                },
            ]),
        [fullscreen, stats, theater, toggleStats, toggleTheater],
    )

    /**
     * The tracks the player is handed, which is not all of them.
     *
     * Memoised because the list is what the player registers against: a fresh array every
     * render would take every track off and put it back on, and each of those is an ffmpeg
     * extraction on the server.
     */
    const subtitles = useMemo<PlayerSubtitle[]>(
        () =>
            preferredSubtitles(tracks).map((track) => ({
                label: subtitleLabel(track.track_id, track.lang, track.label),
                src: videoApi.subtitleUrl(id, track.track_id),
                lang: track.lang === 'und' ? '' : track.lang,
                default: track.default,
            })),
        [id, tracks],
    )

    const sample = useCallback(() => player.current?.sample() ?? null, [])

    if (refusal !== null) return <Notice>{refusal}</Notice>

    const meta = [
        video === null || video.duration_s === null ? null : clock(video.duration_s),
        size === null ? null : resolutionLabel(size.width, size.height),
        video === null ? null : fileSize(video.size_bytes),
        tracks.length === 0 ? null : `${String(tracks.length)} subtitle${tracks.length === 1 ? '' : 's'}`,
    ].filter((fact) => fact !== null)

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 p-2">
                <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Back to the folder"
                    onClick={() => void navigate(browseHref(folder ?? ''))}
                >
                    <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-base" title={video?.rel_path}>
                        {video?.name ?? 'Video'}
                    </h1>
                    {meta.length > 0 && (
                        <p className="truncate text-xs text-muted-foreground">{meta.join(' · ')}</p>
                    )}
                </div>
                <Button
                    variant={stats ? 'default' : 'outline'}
                    size="sm"
                    aria-label={stats ? 'Hide the stream stats' : STATS_LABEL}
                    onClick={toggleStats}
                >
                    <Activity className="size-4" aria-hidden />
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    aria-label={theater ? 'Show the list beside the video' : THEATER_LABEL}
                    onClick={toggleTheater}
                    className="hidden lg:inline-flex"
                >
                    <PanelRight className="size-4" aria-hidden />
                </Button>
                <Button variant="outline" size="sm" aria-label={FULLSCREEN_LABEL} onClick={fullscreen}>
                    <Maximize2 className="size-4" aria-hidden />
                </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    {video !== null && (
                        <VideoPlayer
                            src={videoApi.hlsUrl(video.id)}
                            kind="hls"
                            poster={videoApi.posterUrl(video.id, posterToken)}
                            subtitles={subtitles}
                            autoplay
                            onReady={onReady}
                        />
                    )}
                    {stats && video !== null && (
                        <StatsOverlay videoId={video.id} sample={sample} onClose={toggleStats} />
                    )}
                </div>
                {/* The list is beside the player above the breakpoint and under it below one,
                    where there is no width to put anything beside anything. */}
                {!theater && beside.length > 1 && (
                    <aside className="min-h-0 shrink-0 overflow-y-auto border-t lg:w-72 lg:border-t-0 lg:border-l">
                        <ul className="p-1">
                            {beside.map((one) => (
                                <li key={one.id}>
                                    <button
                                        type="button"
                                        onClick={() => void navigate(watchHref(one.id))}
                                        aria-current={one.id === id ? 'true' : undefined}
                                        className={cn(
                                            'row-hover flex min-h-finger w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                                            one.id === id && 'bg-muted font-medium',
                                        )}
                                    >
                                        <span className="min-w-0 flex-1 truncate" title={one.name}>
                                            {one.name}
                                        </span>
                                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                            {one.duration_s === null ? '--:--' : clock(one.duration_s)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </aside>
                )}
            </div>
        </div>
    )
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex flex-1 items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">{children}</p>
        </div>
    )
}
