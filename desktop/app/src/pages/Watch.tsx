import { Activity, ChevronLeft, Maximize2, Minimize2, PanelRight, Play } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { StatsOverlay, STATS_LABEL } from '@/components/video/StatsOverlay'
import { VideoPlayer, type PlayerSubtitle, type VideoHandle } from '@/components/video/VideoPlayer'
import { Button } from '@/components/ui/button'
import { video as videoApi } from '@/lib/api'
import { clock } from '@/lib/format'
import { useStore } from '@/hooks/use-store'
import { registerActions, SCREEN_GROUP } from '@/lib/palette'
import { inDesktopShell } from '@/lib/desktop'
import { claimStageKey, claimTransport } from '@/lib/screen-keys'
import { clearScreenStatus, setScreenStatus } from '@/lib/screen-status'
import { seeks, togglesTheater, type FocusedField } from '@/lib/shortcuts'
import type { VideoEntry, VideoSubtitleTrack } from '@/lib/types'
import {
    browseHref,
    episodeName,
    fileSize,
    neighbours,
    parentOf,
    preferredSubtitles,
    resolutionLabel,
    resumeAt,
    subtitleLabel,
    subtitleNote,
    watchHref,
} from '@/lib/video'
import { cn } from '@/lib/utils'
import { autoplayNext, theaterOn, toggleTheater, UP_NEXT_SECONDS } from '@/lib/watching'

/** How often to look for the frame size before the first frame has been decoded. */
const SIZE_POLL_MS = 500

/** How often to ask whether the contact sheet behind the player has been made yet. */
const POSTER_POLL_MS = 4000

/** What a row's still frame is asked for at: 16:9, and twice the size it is drawn. */
const THUMB_WIDTH = 160
const THUMB_HEIGHT = 90

/** How often the playhead is read. Cheap, and nothing on the screen re-renders for it. */
const TICK_MS = 1000

/** How far the playhead has to move before the server is told again. */
const SAVE_EVERY_S = 10

export const THEATER_LABEL = 'Hide the list beside the video'
export const FULLSCREEN_LABEL = 'Put the video over the whole screen'
export const LEAVE_FULLSCREEN_LABEL = 'Leave full screen'

/**
 * One video, playing.
 *
 * WHAT IS BESIDE IT IS WHAT IS BESIDE IT ON THE DISK. A video in a library is almost always one
 * of a run -- the next episode, the next part -- so the folder it sits in is the list down the
 * side, and moving on is one click rather than a walk back up the trail and down again. It is
 * the folder rather than a queue because there is no queue here: nothing about watching is
 * played in order the way a record is.
 *
 * AND IT GOES AWAY ON ONE KEY. `t` takes the list off and the chrome with it, which is what
 * somebody watching rather than choosing wants; `f` fills the screen, claimed from the spectrum
 * for as long as this screen is open. Space, `n` and `p` are claimed the same way, because what
 * is playing while a video is on screen is the video.
 *
 * A ROW SAYS WHAT DIFFERS. Every file in a season begins with the same forty characters, so the
 * list beside the picture draws the frame, what the name does not share with its neighbours, and
 * how long it runs -- and marks the one that is playing.
 */
export function WatchPage() {
    const { videoId } = useParams()
    if (videoId === undefined) return <Notice>No video.</Notice>
    return <Watch key={videoId} id={videoId} />
}

function Watch({ id }: { id: string }) {
    const [video, setVideo] = useState<VideoEntry | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    // Null until the server has answered: a file with no tracks and a file nobody has asked
    // about yet say different things on the meta line, and one empty array cannot be both.
    const [tracks, setTracks] = useState<VideoSubtitleTrack[] | null>(null)
    const [beside, setBeside] = useState<VideoEntry[]>([])
    const [size, setSize] = useState<{ width: number; height: number } | null>(null)
    const [posterToken, setPosterToken] = useState<number | undefined>(undefined)
    const theater = useStore(theaterOn)
    const [stats, setStats] = useState(false)
    const [filled, setFilled] = useState(false)
    // Read by the key handler, which is bound once and would otherwise hold the first value.
    const filledNow = useRef(false)
    const onFilled = useCallback((on: boolean) => {
        filledNow.current = on
        setFilled(on)
    }, [])
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
                if (live) setTracks([])
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

    // The bar's right-hand cell names what is playing. An id would be the honest machine's
    // string, but it means nothing to the person reading the foot of the window.
    const name = video?.name ?? null
    useEffect(() => {
        setScreenStatus({ note: null, tone: 'quiet', identifier: name })
    }, [name])
    useEffect(() => clearScreenStatus, [])

    /**
     * WHERE THIS ACCOUNT STOPPED, ASKED FOR BEFORE THE PLAYER EXISTS.
     *
     * The read and the player race: the chunk may land first or the answer may. So the position
     * is held here and a second effect applies it once both are in, and the handle's own seek
     * waits on the media besides -- a `currentTime` written before there is metadata is
     * discarded, and what somebody sees then is a resume that did not happen.
     */
    const [resume, setResume] = useState<number | null>(null)
    useEffect(() => {
        let live = true
        void videoApi.readProgress(id).then(
            (saved) => {
                if (live) setResume(resumeAt(saved))
            },
            () => {
                // No store on this server, or it refused: the video starts at the top, which is
                // what it did before there was a store at all.
                if (live) setResume(0)
            },
        )
        return () => {
            live = false
        }
    }, [id])

    const applied = useRef<string | null>(null)
    const [havePlayer, setHavePlayer] = useState(false)
    const onReady = useCallback((handle: VideoHandle | null) => {
        player.current = handle
        setHavePlayer(handle !== null)
    }, [])
    useEffect(() => {
        if (!havePlayer || resume === null || resume <= 0 || applied.current === id) return
        applied.current = id
        player.current?.seekTo(resume)
    }, [havePlayer, id, resume])

    /**
     * SAVED WHILE WATCHING, NOT ONLY AT THE END. The books player's rules, for the same reason:
     * forty minutes in, a closed laptop must not cost the forty minutes. One tick a second reads
     * the playhead into a ref -- cheap, and nothing re-renders -- and a report goes out every
     * `SAVE_EVERY_S` of movement, when playback pauses, and when the screen or the tab goes.
     *
     * A seek backwards is movement too, which is why the comparison is on distance rather than
     * on having climbed: somebody who skips back to rewatch a scene has moved their position.
     */
    const at = useRef(0)
    const savedAt = useRef(0)
    const paused = useRef(true)
    const save = useCallback(
        (positionS: number, finished?: boolean) => {
            if (positionS <= 0 && finished !== true) return
            savedAt.current = positionS
            void videoApi.saveProgress(id, positionS, finished).catch(() => {
                // A lost report is one the next tick makes again; nothing to say on screen.
            })
        },
        [id],
    )

    useEffect(() => {
        const tick = setInterval(() => {
            const reading = player.current?.sample() ?? null
            if (reading === null) return
            const now = player.current?.positionS() ?? 0
            at.current = now
            const stopped = reading.paused
            // The transition, not the state: a paused player would otherwise report once a
            // second for as long as somebody left the room.
            if (stopped && !paused.current) save(now)
            paused.current = stopped
            if (!stopped && Math.abs(now - savedAt.current) >= SAVE_EVERY_S) save(now)
        }, TICK_MS)
        return () => {
            clearInterval(tick)
        }
    }, [save])

    useEffect(() => {
        const keep = (): void => save(at.current)
        window.addEventListener('pagehide', keep)
        return () => {
            window.removeEventListener('pagehide', keep)
            keep()
        }
    }, [save])

    const toggleStats = useCallback(() => {
        setStats((on) => !on)
    }, [])

    const fullscreen = useCallback(() => {
        player.current?.toggleFullscreen()
    }, [])

    /**
     * The end of a video is the one moment the player says outright that it is finished.
     *
     * Everything else the screen reports is a position and the server decides from the tail; a
     * video that actually ran out has been watched, whatever its length, and saying so is what
     * keeps the row marked after somebody sat through the credits.
     */
    const [ended, setEnded] = useState(false)
    const onEnded = useCallback(() => {
        save(video?.duration_s ?? at.current, true)
        setEnded(true)
    }, [save, video])

    // `f` is the spectrum's everywhere else in the app; here it is the picture's.
    useEffect(() => claimStageKey(fullscreen), [fullscreen])

    /**
     * Space, `n` and `p` mean the picture while there is one.
     *
     * They are the queue's keys everywhere else, and they stayed the queue's here: Space stopped
     * an album nobody was listening to and `n` moved it on, while the episode somebody was
     * actually watching carried on regardless. What is playing is what is in front of them.
     *
     * The step is the folder's, in the order the list beside the picture draws it, and a folder
     * with nothing after this episode answers `n` with nothing rather than with the album.
     */
    // What the folder holds, which is what a row's name is shortened against.
    const besideNames = useMemo(() => beside.map((one) => one.name), [beside])
    const around = useMemo(() => neighbours(beside, id), [beside, id])
    const nextId = around.next?.id ?? null
    const previousId = around.previous?.id ?? null
    const autoplay = useStore(autoplayNext)
    const playNext = useCallback(() => {
        if (nextId !== null) void navigate(watchHref(nextId))
    }, [navigate, nextId])
    useEffect(() => {
        const step = (to: string | null): (() => void) | null =>
            to === null
                ? null
                : () => {
                      void navigate(watchHref(to))
                  }
        return claimTransport({
            play: () => player.current?.togglePlay(),
            next: step(nextId),
            previous: step(previousId),
        })
    }, [navigate, nextId, previousId])

    /**
     * The keys that only mean something while a video is on screen.
     *
     * Bound here rather than in the shell, because that is what they are: the arrows belong to
     * whatever is in front of somebody -- a list walks its rows with them -- and a screen that
     * is not playing anything has nothing for them to do.
     *
     * ON THE WINDOW, IN THE CAPTURE PHASE, AND THAT IS THE WHOLE OF WHY `t` DID NOTHING. Every
     * video.js component answers a keydown it has no use for by calling `stopPropagation` on
     * it, so a listener on the document never hears a press made while the picture has focus --
     * which is where focus is from the moment somebody clicks play. Capture runs from the window
     * down to whatever was pressed on, so this reads the press before the player can swallow it.
     *
     * AND IT STOPS WHAT IT ANSWERS. The shell binds the arrows to the track that is playing, and
     * a screen with a video on it is a screen where an arrow means the video -- so a press this
     * screen takes goes no further.
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
            // IN A SHELL, ESCAPE IS THE WAY BACK. A browser leaves element fullscreen on
            // Escape by itself; a desktop window that was asked to fill the display does
            // not, and a picture pinned over the whole app with no way out is a trap.
            if (event.key === 'Escape' && filledNow.current) {
                event.preventDefault()
                event.stopPropagation()
                player.current?.toggleFullscreen()
                return
            }
            if (togglesTheater(press, focused)) {
                event.preventDefault()
                event.stopPropagation()
                toggleTheater()
                return
            }
            const seek = seeks(press, focused)
            if (seek === null) return
            event.preventDefault()
            event.stopPropagation()
            player.current?.seekBy(seek)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
            window.removeEventListener('keydown', onKeyDown, true)
        }
    }, [])

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
                    title: filled ? LEAVE_FULLSCREEN_LABEL : FULLSCREEN_LABEL,
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
        [filled, fullscreen, stats, theater, toggleStats],
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
            preferredSubtitles(tracks ?? []).map((track) => ({
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
        subtitleNote(tracks === null ? null : tracks.length),
    ].filter((fact) => fact !== null)

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            {/* THEATER TAKES THE CHROME AS WELL AS THE LIST. Hiding the column beside the picture
                buys width, and on a 16:9 title at a desk width the picture is bounded by its
                height rather than by its width -- so width alone moved the frame by a few
                percent and read as a button that does nothing. The strip goes over the picture
                instead of above it, which gives the same gesture the height back too. */}
            <div
                className={cn(
                    'flex shrink-0 items-center gap-2 p-2',
                    theater && 'absolute inset-x-0 top-0 z-20 bg-background/75',
                )}
            >
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
                    variant={theater ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={theater}
                    aria-label={theater ? 'Show the list beside the video' : THEATER_LABEL}
                    onClick={toggleTheater}
                >
                    <PanelRight className="size-4" aria-hidden />
                </Button>
                <Button
                    variant={filled ? 'default' : 'outline'}
                    size="sm"
                    aria-pressed={filled}
                    aria-label={filled ? LEAVE_FULLSCREEN_LABEL : FULLSCREEN_LABEL}
                    onClick={fullscreen}
                >
                    {filled ? (
                        <Minimize2 className="size-4" aria-hidden />
                    ) : (
                        <Maximize2 className="size-4" aria-hidden />
                    )}
                </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                {/* FULL SCREEN IN A SHELL IS THE WINDOW'S, SO THE PICTURE PINS ITSELF. A browser
                    puts the video element alone on the display; a desktop shell can only fill
                    the display with its window, and the rail, the bars and the list would stay
                    around the picture. So while the shell says it is filled, this column stands
                    over the whole window instead, which is what the old client did too. */}
                <div
                    className={
                        filled && inDesktopShell()
                            ? 'fixed inset-0 z-[60] flex flex-col bg-black'
                            : 'relative flex min-h-0 min-w-0 flex-1 flex-col'
                    }
                >
                    {video !== null && (
                        <VideoPlayer
                            src={videoApi.hlsUrl(video.id)}
                            kind="hls"
                            poster={videoApi.posterUrl(video.id, posterToken)}
                            subtitles={subtitles}
                            autoplay
                            onEnded={onEnded}
                            onFullscreenChange={onFilled}
                            onReady={onReady}
                        />
                    )}
                    {stats && video !== null && (
                        <StatsOverlay
                            videoId={video.id}
                            sample={sample}
                            onClose={toggleStats}
                            below={theater}
                        />
                    )}
                    {ended && around.next !== null && (
                        <UpNext
                            title={episodeName(around.next.name, besideNames)}
                            countdown={autoplay}
                            onPlay={playNext}
                            onDismiss={() => setEnded(false)}
                        />
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
                                            'row-hover flex min-h-finger w-full items-center gap-2 rounded-md p-1 text-left text-sm',
                                            one.id === id && 'bg-muted font-medium',
                                        )}
                                    >
                                        {/* The frame says what an episode is before the words do,
                                            and the mark on it says which one is playing -- a row
                                            in the wash alone is a state somebody has to compare
                                            rows to read. */}
                                        <span className="relative shrink-0">
                                            <img
                                                src={videoApi.thumbnailUrl(one.id)}
                                                alt=""
                                                loading="lazy"
                                                decoding="async"
                                                width={THUMB_WIDTH}
                                                height={THUMB_HEIGHT}
                                                className="h-9 w-16 rounded-sm bg-muted object-cover"
                                            />
                                            {one.id === id && (
                                                <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-background/60">
                                                    <Play className="size-4 fill-current" aria-hidden />
                                                </span>
                                            )}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate" title={one.name}>
                                            {episodeName(one.name, besideNames)}
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

/**
 * What comes after this one, offered rather than simply done.
 *
 * A SEASON IS A RUN AND THE END OF AN EPISODE IS THE MIDDLE OF IT, so the folder's next video
 * starts by itself after a few seconds. The card is what makes that a thing somebody agreed to
 * rather than something the screen did while they were getting up: it says which episode, it
 * counts down where they can see it, and Stay puts it away and leaves the picture where it is.
 *
 * WITH AUTOPLAY OFF THE CARD STILL STANDS, and waits instead of counting. The offer is worth
 * making either way -- what the setting decides is whether it answers itself.
 */
function UpNext({
    title,
    countdown,
    onPlay,
    onDismiss,
}: {
    title: string
    countdown: boolean
    onPlay: () => void
    onDismiss: () => void
}) {
    const [left, setLeft] = useState(UP_NEXT_SECONDS)

    useEffect(() => {
        if (!countdown) return
        const timer = setInterval(() => {
            setLeft((seconds) => seconds - 1)
        }, 1000)
        return () => {
            clearInterval(timer)
        }
    }, [countdown])

    useEffect(() => {
        if (countdown && left <= 0) onPlay()
    }, [countdown, left, onPlay])

    return (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 p-4">
            <div className="w-full max-w-sm rounded-lg border bg-card p-4">
                <p className="truncate text-sm" title={title}>
                    Up next: <span className="font-medium">{title}</span>
                </p>
                {countdown && (
                    <p className="mt-1 text-xs text-muted-foreground">Playing in {Math.max(0, left)}s</p>
                )}
                <div className="mt-3 flex items-center gap-2">
                    <Button size="sm" onClick={onPlay}>
                        Play
                    </Button>
                    <Button size="sm" variant="outline" onClick={onDismiss}>
                        Stay
                    </Button>
                </div>
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
