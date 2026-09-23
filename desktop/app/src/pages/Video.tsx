import { ChevronRight, Folder, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useStore } from '@/hooks/use-store'
import { video as videoApi } from '@/lib/api'
import { clock, progressRatio } from '@/lib/format'
import { registerActions, SCREEN_GROUP } from '@/lib/palette'
import { clearScreenStatus, scanNote, setScreenStatus } from '@/lib/screen-status'
import { sessionStore } from '@/lib/session'
import type { VideoBrowse, VideoEntry, VideoProgress, VideoScanState } from '@/lib/types'
import {
    browseHref,
    crumbsOf,
    episodeName,
    fileSize,
    rowsOf,
    scanProgress,
    started,
    subtitleNote,
    watchHref,
} from '@/lib/video'
import { cn } from '@/lib/utils'

/** How often to ask what the server is doing while it is doing it. */
const SCAN_POLL_MS = 1000

/** How often to ask which thumbnails have been made, while any on screen are still missing. */
const THUMB_POLL_MS = 4000

/** How long after the last keystroke the server is asked. */
const SEARCH_DEBOUNCE_MS = 200

export const RESCAN_LABEL = 'Rescan the video library'

/** What a row's still frame is asked for at: 16:9, and twice the size it is drawn. */
const THUMB_WIDTH = 160
const THUMB_HEIGHT = 90

export function VideoPage() {
    const session = useStore(sessionStore)
    const params = useParams()
    // The splat holds the whole of the folder's path, separators and all.
    const path = params['*'] ?? ''
    if (session.capabilities?.video !== true) return <Notice>This server has no video library.</Notice>
    return <Browser path={path} />
}

/**
 * The library as folders, which is how a video library is actually kept.
 *
 * NOT ONE FLAT LISTING. A film library is a folder per title and a television library is a
 * folder per season, and the names inside those folders are only meaningful under them -- a
 * thousand rows reading `S01E04` is not a library anybody can read. So the screen browses what
 * the server walked, one folder at a time, and the address says which one, so a season is a
 * link somebody can send.
 *
 * WHAT IS ON SCREEN STAYS WHILE THE SERVER IS BUSY. A rescan does not empty the listing: the
 * status bar says a scan is running and the strip counts it off, and the rows are replaced once
 * there are new ones. A screen that blanked itself every time the library was re-read would
 * make a rescan feel like a fault.
 */
function Browser({ path }: { path: string }) {
    const [browse, setBrowse] = useState<VideoBrowse | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const [scan, setScan] = useState<VideoScanState | null>(null)
    const [tokens, setTokens] = useState<Record<string, number>>({})
    const [query, setQuery] = useState('')
    const [found, setFound] = useState<{ query: string; rows: VideoEntry[] } | null>(null)
    const [watched, setWatched] = useState<Record<string, VideoProgress>>({})
    const navigate = useNavigate()

    // Whether this screen is still the one in front of somebody, and which folder it is
    // waiting on. An answer to a question nobody is asking any more is dropped rather than
    // drawn, which is what stops a slow root landing on top of the season somebody opened.
    const mounted = useRef(true)
    const wanted = useRef(path)
    useEffect(() => {
        mounted.current = true
        return () => {
            mounted.current = false
        }
    }, [])

    const readFolder = useCallback((at: string): void => {
        wanted.current = at
        void videoApi.browse(at).then(
            (answer) => {
                if (!mounted.current || wanted.current !== at) return
                setBrowse(answer)
                setRefusal(null)
            },
            (error: Error) => {
                if (mounted.current && wanted.current === at) setRefusal(error.message)
            },
        )
        /**
         * Where this account got to comes with the folder.
         *
         * ONE REQUEST RATHER THAN ONE PER ROW. A season is twenty-six rows and the answer is a
         * handful of them, so the whole of an account's positions costs less than twenty-six
         * reads that mostly say zero. It is asked again with every folder read, because coming
         * back from an episode is what has just changed one of them.
         */
        void videoApi.progress().then(
            (rows) => {
                if (mounted.current) setWatched(Object.fromEntries(rows.map((row) => [row.video_id, row])))
            },
            () => {
                // No store on this server: a row says how long a video is, as it always did.
            },
        )
    }, [])

    // The folder, whenever the address names another one.
    useEffect(() => {
        readFolder(path)
    }, [path, readFolder])

    /**
     * What the server is doing to the library, for as long as it is doing something.
     *
     * A cold library is read on the server's own first request and can take minutes, so the
     * screen asks rather than guesses -- and when a scan it was watching finishes, it reads the
     * folder again, because what the listing is showing was walked before the scan ran.
     *
     * The loop stops itself as soon as the server says it has finished, so a screen standing
     * open on a settled library asks nothing at all. Starting it again is what Rescan does.
     */
    const scanned = useRef(false)
    const polling = useRef<ReturnType<typeof setTimeout> | null>(null)
    const watchScan = useCallback((): void => {
        if (polling.current !== null) clearTimeout(polling.current)
        const look = async (): Promise<void> => {
            let status: VideoScanState | null = null
            try {
                status = await videoApi.scanStatus()
            } catch {
                // A server that is not answering is what the folder read reports; a second
                // sentence about the same silence is not worth a line on the screen.
            }
            if (!mounted.current) return
            setScan(status)
            if (status?.scanning === true) {
                scanned.current = true
                polling.current = setTimeout(() => void look(), SCAN_POLL_MS)
                return
            }
            if (!scanned.current) return
            scanned.current = false
            readFolder(wanted.current)
        }
        void look()
    }, [readFolder])

    useEffect(() => {
        watchScan()
        return () => {
            if (polling.current !== null) clearTimeout(polling.current)
        }
    }, [watchScan])

    // The screen's one fact along the foot: a scan counting up, and nothing at all once it has
    // stopped, because the listing itself is then what says what was found.
    useEffect(() => {
        const note = scanNote(scan?.scanning ?? false, scan?.scanned ?? 0)
        setScreenStatus({ note: note.note, tone: note.tone, identifier: null })
    }, [scan])
    useEffect(() => clearScreenStatus, [])

    /**
     * Swap a placeholder for the frame the moment there is one.
     *
     * A folder opened before ffmpeg has caught up answers a placeholder per row, and nothing
     * would ever replace it: the URL has not changed, so the browser has no reason to ask
     * again. Asking which ids are ready and bumping a token on the ones that newly are changes
     * the URL, which is the whole of the mechanism. It stops as soon as every row on screen has
     * its own frame.
     */
    useEffect(() => {
        const videos = browse?.videos ?? []
        if (videos.length === 0) return
        let live = true
        let timer: ReturnType<typeof setTimeout>
        const look = async (): Promise<void> => {
            try {
                const answer = await videoApi.thumbnailsReady()
                if (!live) return
                const ready = new Set(answer.ready)
                setTokens((held) => {
                    let changed = false
                    const next = { ...held }
                    for (const one of videos) {
                        if (ready.has(one.id) && next[one.id] === undefined) {
                            next[one.id] = 1
                            changed = true
                        }
                    }
                    return changed ? next : held
                })
                if (videos.every((one) => ready.has(one.id))) return
            } catch {
                // A poll that failed is one the next tick asks again.
            }
            if (live) timer = setTimeout(() => void look(), THUMB_POLL_MS)
        }
        void look()
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [browse])

    // The search is the server's, over the whole library rather than over the folder that
    // happens to be open -- which is what somebody typing a title is asking for.
    useEffect(() => {
        const typed = query.trim()
        if (typed === '') return
        let live = true
        const timer = setTimeout(() => {
            void videoApi.search(typed).then(
                (rows) => {
                    if (live) setFound({ query: typed, rows })
                },
                () => {
                    if (live) setFound({ query: typed, rows: [] })
                },
            )
        }, SEARCH_DEBOUNCE_MS)
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [query])

    const rescan = useCallback(() => {
        void videoApi.scan().then(
            (answer) => {
                setScan(answer.status)
                // The walk runs out of band, so the snapshot that comes back is where the
                // server was rather than where it is going. Watching it is how the screen finds
                // out, and the flag is what makes the end of it re-read this folder.
                scanned.current = true
                watchScan()
            },
            (error: Error) => {
                toast.error(error.message)
            },
        )
    }, [watchScan])

    useEffect(
        () =>
            registerActions([
                {
                    id: 'video:rescan',
                    title: RESCAN_LABEL,
                    group: SCREEN_GROUP,
                    screen: true,
                    icon: RefreshCw,
                    keywords: ['scan', 'refresh', 'reload', 'library', 'video'],
                    run: rescan,
                },
            ]),
        [rescan],
    )

    const searching = query.trim() !== ''
    const results = found !== null && found.query === query.trim() ? found.rows : null
    const scanning = scan?.scanning === true
    const rows = browse === null ? [] : rowsOf(browse)
    // A season is twenty-six names that begin with the same forty characters, so what a row
    // draws is what it does not share with the rest of the folder.
    const siblings = (browse?.videos ?? []).map((one) => one.name)

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
            <div className="flex items-center gap-2">
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    aria-label="Search the video library"
                    placeholder="Search"
                    className="min-w-0 flex-1"
                />
                <Button
                    variant="outline"
                    size="sm"
                    aria-label={RESCAN_LABEL}
                    title={scanning ? 'A scan is already running' : RESCAN_LABEL}
                    disabled={scanning}
                    onClick={rescan}
                >
                    <RefreshCw className="size-4" aria-hidden />
                </Button>
            </div>

            {searching ? (
                <SearchResults query={query.trim()} rows={results} tokens={tokens} />
            ) : (
                <>
                    <Crumbs path={path} />
                    {scanning && browse !== null && <ScanBar scan={scan} compact />}
                    {refusal !== null && <Notice>{refusal}</Notice>}
                    {refusal === null &&
                        browse === null &&
                        (scanning ? <ScanBar scan={scan} /> : <Notice>Reading the library.</Notice>)}
                    {refusal === null && browse !== null && rows.length === 0 && (
                        <Notice>
                            {path === ''
                                ? 'No videos. Add files under the library root on the server.'
                                : 'This folder is empty.'}
                        </Notice>
                    )}
                    {rows.length > 0 && (
                        <ul className="grid min-h-0 flex-1 grid-cols-2 content-start gap-4 overflow-y-auto p-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                            {rows.map((row) =>
                                row.kind === 'folder' ? (
                                    <li key={row.key}>
                                        {/* A FOLDER IS A SLEEVE TOO. A series or a season is what
                                            somebody reaches for by look, the way they reach for a
                                            record; a tile the size of a video's keeps the shelf
                                            one shelf, and the mark says which folder it is. */}
                                        <button
                                            type="button"
                                            onClick={() => void navigate(browseHref(row.folder.rel_path))}
                                            className="row-hover w-full rounded-lg p-2 text-left"
                                        >
                                            <span className="flex aspect-video w-full items-center justify-center rounded-md bg-muted">
                                                <Folder
                                                    className="size-8 text-muted-foreground"
                                                    aria-hidden
                                                />
                                            </span>
                                            <span
                                                className="mt-2 block truncate text-sm font-medium"
                                                title={row.name}
                                            >
                                                {row.name}
                                            </span>
                                            <span className="block text-xs text-muted-foreground">
                                                {row.folder.video_count}{' '}
                                                {row.folder.video_count === 1 ? 'video' : 'videos'}
                                            </span>
                                        </button>
                                    </li>
                                ) : (
                                    <li key={row.key}>
                                        <VideoRow
                                            video={row.video}
                                            token={tokens[row.video.id]}
                                            siblings={siblings}
                                            progress={watched[row.video.id]}
                                            onOpen={() => void navigate(watchHref(row.video.id))}
                                        />
                                    </li>
                                ),
                            )}
                        </ul>
                    )}
                </>
            )}
        </div>
    )
}

/** What the search found, in the same rows the folder draws, so nothing jumps on the way back. */
function SearchResults({
    query,
    rows,
    tokens,
}: {
    query: string
    rows: VideoEntry[] | null
    tokens: Record<string, number>
}) {
    const navigate = useNavigate()
    if (rows === null) return <Notice>Searching.</Notice>
    if (rows.length === 0) return <Notice>Nothing in the library matches &ldquo;{query}&rdquo;.</Notice>
    return (
        <ul className="min-h-0 flex-1 overflow-y-auto">
            {rows.map((one) => (
                <li key={one.id}>
                    <VideoRow
                        video={one}
                        token={tokens[one.id]}
                        showPath
                        onOpen={() => void navigate(watchHref(one.id))}
                    />
                </li>
            ))}
        </ul>
    )
}

/** One video: its still frame, its name, and how long and how large it is. */
function VideoRow({
    video,
    token,
    siblings,
    progress,
    showPath = false,
    onOpen,
}: {
    video: VideoEntry
    token?: number
    /** Where this account stopped in it, where they have. */
    progress?: VideoProgress
    /**
     * What else is in this folder, which is what the row's name is shortened against.
     *
     * Absent for a search result, where the rows come from all over the library and the whole
     * name is the answer: a hit shortened against its neighbours in the result set would lose
     * the half that says which show it is.
     */
    siblings?: readonly string[]
    /** Where it sits, drawn under the name only where the name is not the whole answer. */
    showPath?: boolean
    onOpen: () => void
}) {
    const folder = showPath ? video.rel_path.slice(0, video.rel_path.lastIndexOf('/')) : ''
    const name = siblings === undefined ? video.name : episodeName(video.name, siblings)
    return (
        <button
            type="button"
            onClick={onOpen}
            className="row-hover flex w-full flex-col rounded-lg p-2 text-left text-sm"
        >
            <img
                src={videoApi.thumbnailUrl(video.id, token)}
                alt=""
                loading="lazy"
                decoding="async"
                width={THUMB_WIDTH}
                height={THUMB_HEIGHT}
                className="aspect-video w-full rounded-md bg-muted object-cover"
            />
            <span className="mt-2 block w-full min-w-0">
                <span className="block truncate font-medium" title={video.rel_path}>
                    {name}
                </span>
                {folder !== '' && (
                    <span className="block truncate text-xs text-faint" title={folder}>
                        {folder}
                    </span>
                )}
                {/* A bar under the row somebody stopped halfway through, and a word for one
                    they got to the end of -- a full bar and a finished video look alike, and
                    only one of them is worth opening again. */}
                {started(progress) && video.duration_s !== null && (
                    <Meter ratio={progressRatio(video.duration_s, progress?.position_s ?? 0)} />
                )}
            </span>
            {/* The facts in one quiet line under the name: how long, how big, what captions it
                carries, and whether it has been watched -- a full bar and a finished video look
                alike, and only one of them is worth opening again. */}
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="font-mono">
                    {video.duration_s === null ? '--:--' : clock(video.duration_s)}
                </span>
                <span>{fileSize(video.size_bytes)}</span>
                <span>{subtitleNote(video.subtitles.length)}</span>
                {progress?.finished === true && <span>Watched</span>}
            </span>
        </button>
    )
}

/** How far through a video, as a bar under its row. The shelf's meter, drawn in a listing. */
function Meter({ ratio }: { ratio: number }) {
    return (
        <span className="mt-1 block h-0.5 w-full rounded-sm bg-muted" role="presentation">
            <span
                className="block h-full rounded-sm bg-primary"
                style={{ width: `${String(Math.round(ratio * 100))}%` }}
            />
        </span>
    )
}

/** The trail above the folder that is open, the section's own name at the head of it. */
function Crumbs({ path }: { path: string }) {
    const navigate = useNavigate()
    const crumbs = crumbsOf(path)
    return (
        <nav aria-label="Folder" className="flex min-w-0 items-center gap-1 px-1 text-xs">
            <button
                type="button"
                onClick={() => void navigate('/video')}
                disabled={crumbs.length === 0}
                className={cn(
                    'shrink-0 rounded-sm px-1',
                    crumbs.length === 0 ? 'text-foreground' : 'text-primary-ink hover:underline',
                )}
            >
                Video
            </button>
            {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1
                return (
                    <span key={crumb.path} className="flex min-w-0 items-center gap-1">
                        <ChevronRight className="size-3 shrink-0 text-faint" aria-hidden />
                        <button
                            type="button"
                            onClick={() => void navigate(browseHref(crumb.path))}
                            disabled={last}
                            title={crumb.path}
                            className={cn(
                                'min-w-0 truncate rounded-sm px-1',
                                last ? 'text-foreground' : 'text-primary-ink hover:underline',
                            )}
                        >
                            {crumb.name}
                        </button>
                    </span>
                )
            })}
        </nav>
    )
}

/**
 * How far through the library the server is.
 *
 * TWO PHASES AND ONLY ONE OF THEM HAS A DENOMINATOR. The walk is still finding the files, so
 * the bar stays empty and the line counts what has been found; the probe is the long one and
 * has a real fraction, which is what somebody opening a large library for the first time
 * actually wants to watch.
 */
function ScanBar({ scan, compact = false }: { scan: VideoScanState | null; compact?: boolean }) {
    const progress = scanProgress(scan)
    return (
        <div className={cn('rounded-md px-3', compact ? 'py-1' : 'my-8 py-4 text-center')}>
            <p className="text-sm">{progress.title}</p>
            <div className="my-2 h-1 w-full overflow-hidden rounded-sm bg-muted">
                <div
                    className="h-full rounded-sm bg-primary transition-[width] duration-300"
                    style={{ width: `${String(Math.round(progress.ratio * 100))}%` }}
                />
            </div>
            <p className="font-mono text-xs text-muted-foreground">{progress.detail}</p>
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
