import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
    exitNativeFullscreen,
    inDesktopShell,
    isNativeFullscreen,
    requestNativeFullscreen,
} from '@/lib/desktop'
import { claimSound, registerSilencer } from '@/lib/sound'
import type { PlaybackSample } from '@/lib/video'

/**
 * The one player anything in this app watches video in.
 *
 * IT IS GIVEN A SOURCE AND NOTHING ELSE ABOUT WHERE IT CAME FROM. A file in the library and a
 * stream pulled off somewhere else are the same manifest by the time they reach here, so the
 * screen that knows which is which builds the URL and this component plays it. That is what
 * keeps one set of stall recoveries rather than one per source.
 *
 * VIDEO.JS ARRIVES WHEN A PLAYER DOES. It and its two stylesheets are half a megabyte and most
 * sessions in this app are music, so they are a dynamic import: the chunk is fetched the first
 * time somebody opens something to watch and never on any other screen.
 *
 * IT CLAIMS THE SOUND AND OFFERS TO BE SILENCED. Two players over each other is nobody's
 * intention, so starting here stops whatever the audio player was playing -- a record, a
 * station or a book -- and that player starting stops this, through `lib/sound`, with neither
 * side importing the other.
 */

/** video.js as the dynamic import hands it back. A type only: nothing here imports it eagerly. */
type VideoJs = (typeof import('video.js'))['default']
type Player = ReturnType<VideoJs>

/** One subtitle track as the player takes one. */
export interface PlayerSubtitle {
    label: string
    src: string
    lang?: string
    /** Whether it is on when playback starts. The server marks at most one. */
    default?: boolean
}

/** What the screen around a player can ask of it once it exists. */
export interface VideoHandle {
    /** Where the playhead is, in seconds. */
    positionS: () => number
    /** Start it, or stop it. What Space means while a video is the thing being played. */
    togglePlay: () => void
    /** Move the playhead, clamped to the video's own ends. */
    seekBy: (deltaS: number) => void
    /** Put the playhead somewhere, held until the media can take it. */
    seekTo: (positionS: number) => void
    /** Full screen, asked of whoever can actually give it -- see `fill` below. */
    toggleFullscreen: () => void
    /** Silence the picture, or give it its sound back. What `m` means while a video is open. */
    toggleMute: () => void
    /**
     * What the source is actually at, or null before the first frame has been decoded.
     *
     * The player is the only thing that knows: the listing carries no dimensions, and asking
     * the server would be an ffprobe per row for a fact only the open video needs.
     */
    frameSize: () => { width: number; height: number } | null
    /** What the player knows about how playback is going, for a stats overlay to read. */
    sample: () => PlaybackSample | null
}

export interface VideoPlayerProps {
    src: string
    /** `hls` is a manifest the player has to be told the type of; `file` is bytes it can sniff. */
    kind?: 'hls' | 'file'
    poster?: string
    subtitles?: PlayerSubtitle[]
    autoplay?: boolean
    onEnded?: () => void
    onError?: (message: string) => void
    /** Playback has stopped where it stands. Not called while the player is being taken down. */
    onPause?: () => void
    /** Whether the picture is filling the screen right now, so a control can say which. */
    onFullscreenChange?: (on: boolean) => void
    /** Handed the player once there is one, and null when it goes. */
    onReady?: (handle: VideoHandle | null) => void
}

/**
 * FULL SCREEN IS ASKED OF WHOEVER CAN ACTUALLY GIVE IT.
 *
 * Three things can fill a screen and only one of them is right per home. Inside a desktop shell
 * it is the shell: the HTML5 API fills the window the page is in, which there is the shell's own
 * window with its chrome still around it, so what somebody gets is a slightly larger picture in
 * the same frame. In a browser tab it is video.js's own `requestFullscreen`, which is the vendor
 * prefixes, the iOS case where only the video element can go full screen, and the player's own
 * `fullscreenchange` event -- all of which a bare `element.requestFullscreen()` is missing, and
 * which is why the button did nothing on a webview.
 *
 * AND SOMETIMES NOBODY WILL GIVE IT, WHICH IS NOT A BUG HERE. The Fullscreen API needs
 * transient user activation, and a Chromium started under automation -- `--headless`, a
 * WebDriver session, anything wearing the automation flag -- treats a click it synthesised as
 * not one, so the promise rejects with a `TypeError` and the window does not change. Nothing on
 * this side can fix that and there is nothing to chase: try the same press in an ordinary
 * window. The rejection is swallowed rather than drawn, because a refusal to fill the screen is
 * not something to put a banner over the picture for.
 */
async function fill(live: Player): Promise<boolean> {
    if (inDesktopShell()) {
        const already = await isNativeFullscreen()
        return already ? !(await exitNativeFullscreen()) : await requestNativeFullscreen()
    }
    // AND IN A BROWSER, NOT BEFORE THERE IS A PICTURE. With the poster still up there is no
    // decoded frame and no source loaded, and `requestFullscreen` on the player root falls
    // through to the poster image -- which Chrome answers by opening the image, which is `f`
    // before play appearing to throw somebody out of the app. There is nothing to fill yet.
    if (started(live) === false) return false
    if (live.isFullscreen() === true) {
        await live.exitFullscreen()
        return false
    }
    await live.requestFullscreen()
    return true
}

/**
 * Whether playback has ever started, as far as the player will say.
 *
 * Asked through a cast because video.js declares `hasStarted` as the setter it also is, and a
 * build that has dropped it answers `undefined` -- which is read as started rather than as not,
 * so a missing method is a full screen that works rather than a key that does nothing.
 */
function started(live: Player): boolean {
    return (live as unknown as HasStarted).hasStarted?.() !== false
}

/** How long a `waiting` is allowed to last before the buffer is nudged out of it. */
const STALL_PATIENCE_MS = 5000

/** One recovery per window per player: the reload can itself fail, and a loop is worse. */
const RECOVERY_COOLDOWN_MS = 8000

/** How often a filled desktop window is asked whether it is still filled -- see the poll below. */
const FILLED_POLL_MS = 1000

/** What the stage is shaped like before the first frame has been decoded. */
const DEFAULT_ASPECT = 16 / 9

/** The manifest type video.js cannot work out from a URL. */
const HLS_TYPE = 'application/x-mpegURL'

/** `HTMLMediaElement.HAVE_METADATA`: the point at which a seek is not thrown away. */
const HAVE_METADATA = 1

/**
 * Captions at video.js's own default size fill a third of a 1080p screen.
 *
 * The baseline scales with the player's height, so what is readable in a pane is a wall of
 * text in full screen. This is the smallest the captions menu itself offers, written only
 * where nobody has chosen for themselves -- anything picked from the menu afterwards wins,
 * and keeps winning, because the choices are persisted.
 */
const SMALLEST_CAPTIONS = '0.50'
const CAPTION_SETTINGS_KEY = 'vjs-text-track-settings'

export function VideoPlayer({
    src,
    kind = 'hls',
    poster,
    subtitles,
    autoplay = false,
    onEnded,
    onError,
    onPause,
    onFullscreenChange,
    onReady,
}: VideoPlayerProps) {
    const frame = useRef<HTMLDivElement | null>(null)
    const element = useRef<HTMLVideoElement | null>(null)
    const player = useRef<Player | null>(null)
    const [videojs, setVideojs] = useState<VideoJs | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const [aspect, setAspect] = useState<number | null>(null)
    // Whether the picture is filling the screen, which this component has to know as well as
    // say: it is what the poll below is armed by. See `report`.
    const [filled, setFilled] = useState(false)

    // What the player has to be pointed at, readable from a handler that was registered once.
    const source = useRef({ src, kind })
    // The callbacks, likewise: a parent that re-renders must not tear the player down.
    const told = useRef({ onEnded, onError, onPause, onFullscreenChange, onReady })
    useEffect(() => {
        source.current = { src, kind }
        told.current = { onEnded, onError, onPause, onFullscreenChange, onReady }
    })

    /** The one way the picture is ever said to be filling the screen, or to have stopped. */
    const report = useCallback((on: boolean): void => {
        setFilled(on)
        told.current.onFullscreenChange?.(on)
    }, [])

    /**
     * A WINDOW THAT LEFT FULL SCREEN BY ITSELF SAYS NOTHING.
     *
     * Native window fullscreen is the shell's, not the document's, so nothing fires a
     * `fullscreenchange` when somebody presses the green button or the Escape macOS answers
     * itself -- and the screen around this player goes on believing it is filled, which is the
     * picture still pinned over the whole app with the window back in its frame around it.
     * There is no event to listen for, so the window is asked, about once a second, and only
     * while it is supposed to be filled: nothing polls on any other screen or in a browser tab.
     */
    useEffect(() => {
        if (!filled || !inDesktopShell()) return
        const timer = setInterval(() => {
            void isNativeFullscreen().then(
                (on) => {
                    if (!on) report(false)
                },
                () => {
                    // A shell that will not answer is not a reason to unpin the picture.
                },
            )
        }, FILLED_POLL_MS)
        return () => {
            clearInterval(timer)
        }
    }, [filled, report])

    /**
     * Point the player at the source it has.
     *
     * `resume` is what a reload after a failure asks for: carry on from where the playhead was
     * and start playing. It plays unconditionally rather than only where it was playing before,
     * because an error leaves the player paused -- so reading the flag back would make every
     * recovery, and the Retry button with it, something that puts the picture back and nothing
     * else. Without it this is a different video, from the top, stopped.
     */
    const load = useCallback((resume: boolean): void => {
        const current = player.current
        if (current === null) return
        const { src: at, kind: as } = source.current
        const was = resume ? current.currentTime() : 0
        current.error(null)
        current.src(as === 'hls' ? { src: at, type: HLS_TYPE } : { src: at })
        current.one('loadedmetadata', () => {
            if (was !== undefined && Number.isFinite(was) && was > 0) current.currentTime(was)
            if (resume) void current.play()?.catch(() => undefined)
        })
    }, [])

    const retry = useCallback((): void => {
        setRefusal(null)
        load(true)
    }, [load])

    // video.js and its stylesheets, asked for only here. The sheets come through one module so
    // the theme always lands after the base -- see `videojs-styles`.
    useEffect(() => {
        let watching = true
        void Promise.all([import('video.js'), import('./videojs-styles')])
            .then(([module]) => {
                if (watching) setVideojs(() => module.default)
            })
            .catch(() => {
                if (watching) setRefusal('the player could not be loaded')
            })
        return () => {
            watching = false
        }
    }, [])

    // Build the player once the chunk has landed, and take it down with the screen. Neither the
    // source nor the poster is in the deps: pointing an existing player somewhere else is a
    // swap, not a reason to throw away a decoder and every buffer behind it.
    useEffect(() => {
        const node = element.current
        if (videojs === null || node === null) return

        try {
            if (localStorage.getItem(CAPTION_SETTINGS_KEY) === null) {
                localStorage.setItem(CAPTION_SETTINGS_KEY, JSON.stringify({ fontPercent: SMALLEST_CAPTIONS }))
            }
        } catch {
            // Private browsing, or no quota: the size below covers this player anyway.
        }

        // WEBKIT PLAYS HLS NATIVELY AND CANNOT PLAY IT THROUGH MSE. Safari and every webview on
        // macOS and iOS refuse the blob URL the JS engine hands the video element, and what the
        // reader sees is the player saying there is no working playlist. Chromium is the other
        // way round: the JS engine transmuxes cleanly and is the only thing that can report the
        // bandwidth the stats overlay reads. So each gets the path it is good at.
        const webkit = videojs.browser.IS_ANY_SAFARI === true
        const built = videojs(node, {
            controls: true,
            autoplay,
            preload: 'auto',
            // The box owns the shape; the player fills whatever it is given. A player that
            // sized itself would push its own control bar under the fold on a 4:3 title.
            fill: true,
            // Otherwise a browser keeps its URL bar over a player that says it is full screen.
            fullscreen: { options: { navigationUI: 'hide' } },
            // Off, and said rather than left to a default. video.js would otherwise answer some
            // of the same letters this app binds -- and it answers them at the player, where
            // the screen's own listener has already decided what a press means.
            userActions: { hotkeys: false },
            // What somebody picks in the captions menu -- size, colour, face -- survives the
            // video, and the next one, and a reload. Off by default in video.js, which is why
            // a caption size that was chosen never seemed to stick.
            persistTextTrackSettings: true,
            html5: {
                vhs: { overrideNative: !webkit },
                // video.js's own captions menu rather than the browser's: the native one
                // varies per browser and puts no visible control on the bar.
                nativeTextTracks: false,
            },
            controlBar: { subsCapsButton: true, skipButtons: { forward: 10, backward: 10 } },
        })
        player.current = built

        try {
            const settings = (built as unknown as { textTrackSettings?: CaptionSettings }).textTrackSettings
            settings?.setValues?.({ fontPercent: SMALLEST_CAPTIONS })
            settings?.updateDisplay?.()
        } catch {
            // A build without the settings component still plays; the captions are just bigger.
        }

        // Only one thing makes sound at a time. Starting this stops the music, and the music
        // starting stops this, without either side knowing the other exists.
        const silence = (): void => {
            built.pause()
        }
        const unregister = registerSilencer(silence)

        const onPlay = (): void => {
            claimSound(silence)
        }

        /**
         * RAPID SCRUBBING BLACKLISTS THE ONLY PLAYLIST THERE IS.
         *
         * Holding the seek key asks for segments faster than ffmpeg makes them, and the JS
         * engine answers a failed segment by dropping the playlist it came from and looking
         * for another. For a single-variant recording there is no other, so what was a slow
         * segment becomes a player stuck in an error state forever. There is nothing to fall
         * back to and therefore nothing for the blacklist to buy: clear it and reload the same
         * source at the position the seek was heading for.
         *
         * Once per window, because the reload can fail during its own init -- a manifest fetch,
         * a first segment nothing has transcoded yet -- and a handler that answered that by
         * reloading again is a loop rather than a recovery.
         */
        let recoveredAt = 0
        const onFailure = (): void => {
            const failure = built.error()
            if (failure === null || failure === undefined) return
            const said = String(failure.message ?? '').trim()
            const message = said === '' ? 'playback error' : said
            told.current.onError?.(message)
            setRefusal(message)
            if (!/playlists?|MEDIA_ERR_NETWORK|exhausted/i.test(message)) return
            const now = Date.now()
            if (now - recoveredAt < RECOVERY_COOLDOWN_MS) return
            recoveredAt = now
            load(true)
        }

        const onRecovered = (): void => {
            setRefusal(null)
        }

        const onMetadata = (): void => {
            const width = built.videoWidth()
            const height = built.videoHeight()
            if (width > 0 && height > 0) setAspect(width / height)
        }

        const onFinished = (): void => {
            told.current.onEnded?.()
        }

        // The picture can be put on the whole screen from the control bar, from the screen's own
        // button and by pressing Escape, so what the button says about itself is read off the
        // player rather than remembered by whoever asked last.
        const onFilled = (): void => {
            report(built.isFullscreen() === true)
        }

        /**
         * A PAUSED FILM MUST NOT LEAVE FFMPEG ENCODING AHEAD OF IT.
         *
         * Segments are made speculatively either side of the one last asked for, so a player
         * stopped mid-film goes on costing a core for as long as somebody is away. The screen
         * around this is what knows which session that is, so it is told and decides.
         *
         * NOT WHILE THE PLAYER IS BEING TAKEN DOWN: `dispose` pauses on its way out, and a
         * teardown that also ran this would be the screen's own unmount cancel twice over, on a
         * handler the screen may already have swapped for the next video's.
         */
        let going = false
        const onPaused = (): void => {
            if (going) return
            told.current.onPause?.()
        }

        /**
         * NUDGE THE PLAYHEAD BY A HUNDREDTH OF A SECOND.
         *
         * Two ways a buffer locks up and one fix for both: a tab in the background has its
         * media source throttled and comes back stuck, and mid-playback an append can simply
         * never resolve, leaving a spinner that would still be there in an hour. Moving the
         * playhead at all makes the engine throw away what it is holding and ask again.
         */
        const nudge = (): void => {
            // Inside a try because of where this is called from: a `visibilitychange` landing
            // between the screen going and `dispose` finishing would otherwise throw out of a
            // document-level listener, over a hundredth of a second nobody is waiting for.
            try {
                if (built.paused() || built.readyState() >= 3) return
                const at = built.currentTime()
                if (at !== undefined && Number.isFinite(at)) built.currentTime(at + 0.01)
            } catch {
                // A player taken down mid-tick. There is nothing left to nudge.
            }
        }

        let stall: ReturnType<typeof setTimeout> | null = null
        const armStall = (): void => {
            if (stall !== null) clearTimeout(stall)
            stall = setTimeout(nudge, STALL_PATIENCE_MS)
        }
        const cancelStall = (): void => {
            if (stall === null) return
            clearTimeout(stall)
            stall = null
        }
        const onVisible = (): void => {
            if (document.visibilityState === 'visible') nudge()
        }

        built.on('play', onPlay)
        built.on('error', onFailure)
        built.on('playing', onRecovered)
        built.on('loadeddata', onRecovered)
        built.on('loadedmetadata', onMetadata)
        built.on('ended', onFinished)
        built.on('fullscreenchange', onFilled)
        built.on('pause', onPaused)
        built.on('waiting', armStall)
        built.on('playing', cancelStall)
        built.on('pause', cancelStall)
        built.on('ended', cancelStall)
        document.addEventListener('visibilitychange', onVisible)

        told.current.onReady?.({
            positionS: () => built.currentTime() ?? 0,
            togglePlay: () => {
                if (built.paused()) void built.play()?.catch(() => undefined)
                else built.pause()
            },
            seekBy: (deltaS) => {
                const at = built.currentTime() ?? 0
                const end = built.duration() ?? 0
                const next = at + deltaS
                built.currentTime(Math.max(0, end > 0 ? Math.min(end, next) : next))
            },
            seekTo: (positionS) => {
                const at = Math.max(0, positionS)
                // A write before the media has its metadata is discarded silently, and the
                // player then sits at the top of the file looking like a resume that did not
                // happen. So it is held until the element can take it.
                if (built.readyState() >= HAVE_METADATA) built.currentTime(at)
                else built.one('loadedmetadata', () => built.currentTime(at))
            },
            toggleFullscreen: () => {
                void fill(built).then(report, () => {
                    // Refused: see `fill`. The button goes back to saying what it says.
                    report(built.isFullscreen() === true)
                })
            },
            toggleMute: () => {
                built.muted(built.muted() !== true)
            },
            frameSize: () => {
                const width = built.videoWidth()
                const height = built.videoHeight()
                return width > 0 && height > 0 ? { width, height } : null
            },
            sample: () => sampleOf(built),
        })

        return () => {
            going = true
            cancelStall()
            document.removeEventListener('visibilitychange', onVisible)
            unregister()
            /**
             * LEAVING THE PLAYER LEAVES FULL SCREEN.
             *
             * A shell asked to fill the display holds it until it is asked not to, and nothing
             * about a navigation tells it anything -- so Back out of a film left the window
             * over the whole screen with the library sitting in it, which reads as an app that
             * will not close. The browser has nothing to undo here: its own fullscreen ends
             * with the element that was in it.
             */
            if (inDesktopShell()) {
                void isNativeFullscreen()
                    .then(async (on) => {
                        if (on) await exitNativeFullscreen()
                    })
                    .catch(() => {
                        // A shell that will not say is a shell that will not be told either.
                    })
            }
            // And the screen is told, because a screen that outlives one player -- the YouTube
            // one rebuilds it to change quality -- would otherwise go on pinning a picture over
            // an app whose window is back in its frame.
            report(false)
            told.current.onReady?.(null)
            player.current = null
            built.dispose()
        }
    }, [autoplay, load, report, videojs])

    /**
     * A new source is a swap rather than a rebuild, so the player, its decoder and its control
     * bar all survive it. The position is not kept: this is a different video.
     *
     * `videojs` is in the deps because the player does not exist until the chunk has landed,
     * and this is what points it somewhere the first time as well as every time after.
     */
    useEffect(() => {
        source.current = { src, kind }
        if (videojs === null || player.current === null) return
        setRefusal(null)
        setAspect(null)
        load(false)
    }, [kind, load, src, videojs])

    // The poster arrives late on a cold library -- the server answers a placeholder while
    // ffmpeg is still making the contact sheet -- so it is set whenever it changes rather than
    // once at build, and the player is built without one.
    useEffect(() => {
        if (videojs === null || player.current === null || poster === undefined) return
        player.current.poster(poster)
    }, [poster, videojs])

    /**
     * Register the tracks, and take them off again when the list changes.
     *
     * They are added through the player rather than written as `<track>` children: JSX children
     * race the player's own init, and a track added before video.js has taken the element over
     * is a track its captions menu never sees.
     */
    useEffect(() => {
        const current = videojs === null ? null : player.current
        if (current === null || subtitles === undefined || subtitles.length === 0) return
        const added = subtitles.map((track) =>
            current.addRemoteTextTrack(
                {
                    // `captions` rather than `subtitles`, which is what puts the size and
                    // colour submenu under the track list.
                    kind: 'captions',
                    src: track.src,
                    srclang: track.lang ?? '',
                    label: track.label,
                    default: track.default === true,
                },
                false,
            ),
        )
        return () => {
            for (const track of added) current.removeRemoteTextTrack(track)
        }
    }, [subtitles, videojs])

    return (
        <div className="flex min-h-0 w-full flex-1 items-center justify-center bg-black">
            <div
                ref={frame}
                className="relative max-h-full w-full"
                style={{ aspectRatio: String(aspect ?? DEFAULT_ASPECT) }}
            >
                {/* video.js rewrites the class on whatever it is given, so the shape is on the
                    box outside it rather than on the element it takes over. */}
                <div data-vjs-player className="size-full">
                    <video
                        ref={element}
                        className="video-js vjs-theme-city vjs-big-play-centered"
                        playsInline
                        crossOrigin="anonymous"
                    />
                </div>
                {refusal !== null && (
                    <div
                        role="alert"
                        className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 border-b border-critical bg-card/95 px-3 py-2"
                    >
                        <p className="min-w-0 flex-1 truncate text-sm text-critical-ink" title={refusal}>
                            {refusal}
                        </p>
                        <Button size="sm" variant="outline" onClick={retry}>
                            Retry
                        </Button>
                    </div>
                )}
            </div>
        </div>
    )
}

/** What one part of the JS HLS engine exposes that nothing on the player itself does. */
interface BandwidthTech {
    vhs?: { bandwidth?: number }
}

/** `hasStarted` read as the question it also is, which the player's own type does not offer. */
interface HasStarted {
    hasStarted?: () => boolean
}

/** The captions size control, which video.js ships and does not declare on its player type. */
interface CaptionSettings {
    setValues?: (values: Record<string, string>) => void
    updateDisplay?: () => void
}

/**
 * One reading of how playback is going.
 *
 * Everything here can be absent: the bandwidth exists only where the JS engine is doing the
 * streaming, and the frame counters only where the browser keeps them. Each is answered as null
 * rather than as a zero, because a zero in the overlay reads as a measurement.
 */
function sampleOf(live: Player): PlaybackSample | null {
    try {
        const at = live.currentTime() ?? 0
        const buffered = live.bufferedEnd() ?? 0
        const tech = live.tech(true) as unknown as BandwidthTech | undefined
        const bandwidth = tech?.vhs?.bandwidth
        const quality = live.getVideoPlaybackQuality()
        return {
            paused: live.paused(),
            bufferAheadS: Math.max(0, buffered - at),
            bandwidthBps: typeof bandwidth === 'number' ? bandwidth : null,
            readyState: live.readyState(),
            droppedFrames: quality.droppedVideoFrames ?? null,
            totalFrames: quality.totalVideoFrames ?? null,
        }
    } catch {
        // A player taken down between the tick being scheduled and it running.
        return null
    }
}
