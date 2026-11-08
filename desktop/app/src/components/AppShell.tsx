import {
    AudioLines,
    Cat,
    Gauge,
    FastForward,
    Keyboard,
    ListMusic,
    LogIn,
    LogOut,
    Pause,
    PanelLeft,
    Play,
    Maximize2,
    MicVocal,
    RefreshCw,
    RotateCcw,
    RotateCw,
    Rewind,
    Search,
    Settings,
    Repeat,
    Shuffle,
    SkipBack,
    SkipForward,
    Star,
    Volume1,
    Volume2,
    VolumeX,
} from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'

import { AccountMenu } from '@winterop-com/sokkel-ui/AccountMenu'
import type { PaletteCommand, PaletteGroup } from '@winterop-com/sokkel-ui/CommandPalette'
import { Rail, type RailEntry, type RailGroup } from '@winterop-com/sokkel-ui/Rail'
import { SchemeToggle } from '@winterop-com/sokkel-ui/SchemeToggle'
import { Shell, type ShortcutGroup } from '@winterop-com/sokkel-ui/Shell'
import { StatusItem, StatusLine } from '@winterop-com/sokkel-ui/StatusLine'
import { TopBar } from '@winterop-com/sokkel-ui/TopBar'
import { useScheme } from '@winterop-com/sokkel-ui/hooks/use-scheme'
import { useStore, useStoreValue } from '@winterop-com/sokkel-ui/hooks/use-store'
import { appearanceCommands } from '@winterop-com/sokkel-ui/lib/commands'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { PlayerBar } from '@/components/PlayerBar'
import { LibrarySearch, paletteSearchOf, SEARCH_TITLE, useLibrarySearch } from '@/components/LibrarySearch'
import { standingNow, useAppShortcuts } from '@/hooks/use-app-shortcuts'
import { serverHost } from '@/lib/account'
import { recoveries } from '@/lib/connection'
import { useDesktopWindow } from '@/lib/desktop'
import { mayOpenPaletteOver, setDialogOpen } from '@/lib/dialogs'
import { openLyrics } from '@/lib/lyrics'
import { entriesFor, homePath, marks, sectionsFor } from '@/lib/nav'
import {
    RAIL_MAX_WIDTH,
    RAIL_MIN_WIDTH,
    RAIL_WIDTH,
    railCollapsed,
    railWidth,
    setRailCollapsed,
    setRailWidth,
    toggleRail,
} from '@/lib/panels'
import { RESCAN_LABEL, rescan } from '@/lib/rescan'
import {
    currentSong,
    cycleRepeat,
    next,
    playerStore,
    previous,
    seek,
    setSpeed,
    setVolume,
    skipBy,
    SKIP_S,
    SPEEDS,
    toggle,
    toggleMuted,
    toggleShuffle,
} from '@/lib/player'
import { REPEAT_LABELS } from '@/lib/queue'
import { nextRepeat } from '@winterop-com/sokkel-ui-media/queue'
import { screenStatus } from '@/lib/screen-status'
import { closeSearch, openSearch } from '@/lib/search'
import { isAdmin, sessionStore, signOut } from '@/lib/session'
import { applePlatform, SEEK_STEP_S, shortcuts, VOLUME_STEP } from '@/lib/shortcuts'
import { toggleStar } from '@/lib/star'
import { choosePalette, paletteStore, PALETTES } from '@/lib/theme'
import { cycleVisualizerStyle, openStage, toggleVisualizer, visualizerShown } from '@/lib/visualizer'

/** The facts the shell reads off the player. Module scope, so each is one stable function. */
const selectPlaying = (state: { playing: boolean }) => state.playing
const selectQueueLength = (state: { queue: unknown[] }) => state.queue.length
const selectStation = (state: { station: unknown }) => state.station
const selectShuffle = (state: { shuffle: boolean }) => state.shuffle
const selectRepeat = (state: { repeat: 'off' | 'all' | 'one' }) => state.repeat
const selectBookId = (state: { book: { id: string } | null }) => state.book?.id ?? null
const selectChapterCount = (state: { book: { chapter_list: unknown[] } | null }) =>
    state.book?.chapter_list.length ?? 0

export const SIGN_OUT_LABEL = 'Sign out'
export const SIGN_IN_LABEL = 'Sign in to a server'

/** The palette's headings, in the order the app's own groups are listed. */
const GO_GROUP = 'Go to'
/** The transport, which is the app's whatever screen is in front of somebody. */
const PLAYBACK_GROUP = 'Playback'
const VIEW_GROUP = 'View'
const APPEARANCE_GROUP = 'Appearance'
/** The palette's own heading for the palettes, which the library calls themes. */
const PALETTE_GROUP = 'Palette'
const SESSION_GROUP = 'Session'

/**
 * The heading the app's own keys are listed under in the frame's shortcuts dialog: the one the
 * shell lists the palette's chord and `?` under, so the list reads as one.
 */
const SHORTCUTS_GROUP = 'General'

/**
 * The settings dialog is fetched the first time somebody asks for it.
 *
 * It carries five panes and most sessions never open it, so it is mounted only once it has
 * been opened: its chunk stays out of the entry bundle and the closing animation still has
 * something to animate.
 */
const SettingsDialog = lazy(() =>
    import('@/components/settings/SettingsDialog').then((module) => ({ default: module.SettingsDialog })),
)

/**
 * The chassis, drawn by sokkel-ui's `Shell`: the rail on the left, the top bar, the screen in the
 * middle, the transport across the foot and the status line under all of it.
 *
 * THE TRANSPORT SPANS THE WHOLE WIDTH, under the rail as well as under the screen, as the
 * shell's `bottom` strip. What is playing is the app's rather than one screen's: it survives
 * navigation, the keys that drive it are bound on the document, and a bar that stopped at the
 * rail's edge would read as the screen's own furniture.
 *
 * WHAT IS LEFT HERE IS MANEKI'S: what the rail offers this server, the palette's rows, the keys
 * the shell lists beside its own, and when the palette may open at all.
 */
export function AppShell({ children }: { children: ReactNode }) {
    const session = useStore(sessionStore)
    const recovered = useStore(recoveries)
    // Rescanning is the whole library's disk; a listener is not offered it. See `isAdmin`.
    const admin = isAdmin(session)
    const collapsed = useStore(railCollapsed)
    const width = useStore(railWidth)
    const status = useStore(screenStatus)
    // One fact each, not the whole player: its store publishes four times a second while a
    // track plays, and the shell has no business re-rendering the screen under it that often.
    const playing = useStoreValue(playerStore, selectPlaying)
    const queuedCount = useStoreValue(playerStore, selectQueueLength)
    const station = useStoreValue(playerStore, selectStation)
    const shuffle = useStoreValue(playerStore, selectShuffle)
    const repeat = useStoreValue(playerStore, selectRepeat)
    const bookId = useStoreValue(playerStore, selectBookId)
    const chapterCount = useStoreValue(playerStore, selectChapterCount)
    const spectrum = useStore(visualizerShown)
    const navigate = useNavigate()
    const { pathname } = useLocation()
    const { scheme, setScheme } = useScheme()
    const chosenPalette = useStore(paletteStore)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [settingsAsked, setSettingsAsked] = useState(false)
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [shortcutsOpen, setShortcutsOpen] = useState(false)
    const caps = session.capabilities ?? null
    // Listening without a server: no library to search, no spectrum to draw, no account to leave.
    const radioOnly = session.phase === 'radio'
    const music = session.music ?? null
    const apple = applePlatform(navigator.userAgent)
    // The window's own full screen, which every part that goes full screen is handed by the Shell.
    const desktop = useDesktopWindow()
    // Radio-only has no library to search: no field, and nothing of it in the palette.
    const library = useLibrarySearch()
    const librarySearch = radioOnly ? null : library
    const paletteSearch = useMemo(() => paletteSearchOf(librarySearch), [librarySearch])

    const openSettings = useCallback(() => {
        setSettingsAsked(true)
        setSettingsOpen(true)
    }, [])

    useAppShortcuts()

    // A bare key belongs to whatever is in front of somebody, and while one of these is up
    // that is the dialog rather than the app. `lib/dialogs` is what the key listener reads.
    useEffect(() => setDialogOpen('settings', settingsOpen), [settingsOpen])
    useEffect(() => setDialogOpen('palette', paletteOpen), [paletteOpen])

    // One surface at a time: the palette opens over nothing else but the search's results, which
    // it replaces; see `mayOpenPaletteOver`.
    const mayOpenPalette = useCallback((over: Element | null) => mayOpenPaletteOver(over, standingNow()), [])
    const choosePaletteOpen = useCallback((open: boolean) => {
        // Two modals stacked is one scrim over the thing the other is about.
        if (open) closeSearch()
        setPaletteOpen(open)
    }, [])

    const rail = useMemo<RailGroup[]>(
        () =>
            sectionsFor(caps).map((section) => ({
                id: section.id,
                title: section.label ?? undefined,
                entries: section.entries.map((entry) => ({
                    id: entry.path,
                    label: entry.label,
                    icon: entry.icon,
                    href: entry.path,
                    keywords: [entry.hint],
                    // What is marked is `lib/nav`'s decision, not the router's; see `marks`.
                    active: marks(entry.path, pathname),
                })),
            })),
        [caps, pathname],
    )

    // Radio-only draws no search field, so `/` answers nothing there.
    const keys = useMemo<ShortcutGroup[]>(
        () => [
            {
                title: SHORTCUTS_GROUP,
                shortcuts: shortcuts(apple).filter((one) => !radioOnly || one.id !== 'search'),
            },
        ],
        [apple, radioOnly],
    )

    const palette = useMemo<PaletteGroup[]>(() => {
        const pages: PaletteCommand[] = entriesFor(caps).map((entry) => ({
            id: `go:${entry.path}`,
            label: entry.label,
            icon: entry.icon,
            // Found by what the place holds, never drawn: the rows read as places.
            keywords: [entry.path, entry.hint],
            onSelect: () => {
                void navigate(entry.path)
            },
        }))
        // WHAT THE PALETTE OFFERS IS WHAT IS PLAYING. A book steps by chapters and jumps by
        // fifteen seconds and is read at a speed; a record shuffles and repeats. Offering both
        // sets at once would be a list of rows half of which do nothing to the thing sounding.
        const bookRows: PaletteCommand[] = [
            ...(chapterCount > 0
                ? [
                      {
                          id: 'play:next',
                          label: 'Next chapter',
                          icon: SkipForward,
                          keywords: ['skip', 'forward', 'chapter'],
                          onSelect: next,
                      },
                      {
                          id: 'play:previous',
                          label: 'Previous chapter',
                          icon: SkipBack,
                          keywords: ['back', 'again', 'chapter'],
                          onSelect: previous,
                      },
                  ]
                : []),
            {
                id: 'play:forward',
                label: `Forward ${String(SKIP_S)} seconds`,
                icon: RotateCw,
                keywords: ['skip', 'jump', 'ahead'],
                onSelect: () => {
                    skipBy(SKIP_S)
                },
            },
            {
                id: 'play:back',
                label: `Back ${String(SKIP_S)} seconds`,
                icon: RotateCcw,
                keywords: ['skip', 'jump', 'again', 'missed'],
                onSelect: () => {
                    skipBy(-SKIP_S)
                },
            },
            // Every speed rather than a row that cycles: a reader who wants it at one and a
            // half is asking for one and a half, not for four presses of "a bit faster".
            ...SPEEDS.map((speed) => ({
                id: `play:speed-${String(speed)}`,
                label: `Read at ${String(speed)}x`,
                icon: Gauge,
                keywords: ['speed', 'rate', 'faster', 'slower', 'narration'],
                onSelect: () => {
                    setSpeed(speed)
                },
            })),
        ]
        const transport: PaletteCommand[] =
            queuedCount > 0 || station !== null || bookId !== null
                ? [
                      {
                          id: 'play:toggle',
                          label: playing ? 'Pause' : 'Play',
                          icon: playing ? Pause : Play,
                          keywords: ['stop', 'resume', 'transport'],
                          onSelect: toggle,
                      },
                      ...(bookId !== null ? bookRows : []),
                      ...(bookId === null && station === null
                          ? [
                                {
                                    id: 'play:next',
                                    label: 'Next track',
                                    icon: SkipForward,
                                    keywords: ['skip', 'forward'],
                                    onSelect: next,
                                },
                                {
                                    id: 'play:previous',
                                    label: 'Previous track',
                                    icon: SkipBack,
                                    keywords: ['back', 'again'],
                                    onSelect: previous,
                                },
                                {
                                    id: 'play:shuffle',
                                    label: shuffle ? 'Play in the album order' : 'Shuffle the queue',
                                    icon: Shuffle,
                                    keywords: ['random', 'mix'],
                                    onSelect: toggleShuffle,
                                },
                                {
                                    id: 'play:repeat',
                                    label: REPEAT_LABELS[nextRepeat(repeat)],
                                    icon: Repeat,
                                    keywords: ['loop', 'again', 'repeat'],
                                    onSelect: cycleRepeat,
                                },
                                // WHAT ONLY A KEYBOARD COULD DO, OFFERED TO EVERYBODY. The star
                                // and the two arrows were a chord each and nothing on any
                                // screen, so a pointer could not reach them at all. A station
                                // has no row in the library to star and nothing to seek in.
                                {
                                    id: 'play:star',
                                    label: 'Star what is playing',
                                    icon: Star,
                                    keywords: ['favourite', 'favorite', 'love', 'mark', 'unstar'],
                                    onSelect: () => {
                                        toggleStar(music ?? undefined, currentSong())
                                    },
                                },
                                {
                                    id: 'play:seek-back',
                                    label: `Move ${String(SEEK_STEP_S)} seconds back`,
                                    icon: Rewind,
                                    keywords: ['seek', 'rewind', 'scrub', 'position'],
                                    onSelect: () => {
                                        seek(playerStore.get().positionS - SEEK_STEP_S)
                                    },
                                },
                                {
                                    id: 'play:seek-forward',
                                    label: `Move ${String(SEEK_STEP_S)} seconds forward`,
                                    icon: FastForward,
                                    keywords: ['seek', 'skip', 'scrub', 'position'],
                                    onSelect: () => {
                                        seek(playerStore.get().positionS + SEEK_STEP_S)
                                    },
                                },
                            ]
                          : []),
                      // The level is the room's rather than the track's, so these are offered
                      // for a station as much as for a queue. Each reads the level it is
                      // stepping from when it runs: subscribing the shell to a number that
                      // moves under a dragged slider is what `useStoreValue` exists to avoid.
                      {
                          id: 'play:louder',
                          label: 'Turn it up',
                          icon: Volume2,
                          keywords: ['volume', 'loud', 'level', 'up'],
                          onSelect: () => {
                              setVolume(playerStore.get().volume + VOLUME_STEP)
                          },
                      },
                      {
                          id: 'play:quieter',
                          label: 'Turn it down',
                          icon: Volume1,
                          keywords: ['volume', 'quiet', 'level', 'down'],
                          onSelect: () => {
                              setVolume(playerStore.get().volume - VOLUME_STEP)
                          },
                      },
                      {
                          // Named for what it does either way round, because the shell does not
                          // read whether it is muted and a row that said "Unmute" to somebody
                          // who is not muted would be worse than one that says neither.
                          id: 'play:mute',
                          label: 'Silence it, or bring it back',
                          icon: VolumeX,
                          keywords: ['mute', 'unmute', 'quiet', 'silence', 'volume'],
                          onSelect: toggleMuted,
                      },
                  ]
                : []
        const view: PaletteCommand[] = [
            {
                id: 'view:rail',
                label: collapsed ? 'Expand the navigation' : 'Collapse the navigation',
                icon: PanelLeft,
                keywords: ['sidebar', 'rail'],
                onSelect: toggleRail,
            },
            ...(radioOnly
                ? []
                : [
                      {
                          id: 'view:search',
                          label: SEARCH_TITLE,
                          icon: Search,
                          keywords: ['find', 'artist', 'album', 'track', 'song'],
                          onSelect: () => {
                              openSearch()
                          },
                      },
                  ]),
            // The words are a track's, so the row is offered while there is one. A station has
            // no id to ask about and nothing to ask for it with.
            ...(queuedCount > 0
                ? [
                      {
                          id: 'view:lyrics',
                          label: 'Show the words of what is playing',
                          icon: MicVocal,
                          keywords: ['lyrics', 'words', 'sing', 'along'],
                          onSelect: openLyrics,
                      },
                  ]
                : []),
            ...(radioOnly
                ? []
                : [
                      {
                          id: 'view:visualizer',
                          label: spectrum ? 'Hide the spectrum' : 'Show the spectrum',
                          icon: ListMusic,
                          keywords: ['visualiser', 'visualizer', 'bars', 'analyser'],
                          onSelect: toggleVisualizer,
                      },
                      {
                          id: 'view:stage',
                          label: 'Put the spectrum over the whole screen',
                          icon: Maximize2,
                          keywords: ['fullscreen', 'full screen', 'stage', 'visualiser', 'visualizer'],
                          onSelect: openStage,
                      },
                  ]),
            {
                id: 'view:settings',
                label: 'Open settings',
                icon: Settings,
                keywords: ['preferences', 'appearance', 'volume', 'account', 'server'],
                onSelect: openSettings,
            },
            // Offered only where there is a library to walk: a row that asked a server with no
            // music to reindex its music would be a row that can only fail.
            ...(music && admin
                ? [
                      {
                          id: 'view:rescan',
                          label: RESCAN_LABEL,
                          icon: RefreshCw,
                          keywords: ['scan', 'refresh', 'reindex', 'library', 'reload', 'new albums'],
                          onSelect: () => {
                              void rescan(music)
                          },
                      },
                  ]
                : []),
            {
                id: 'view:shortcuts',
                label: 'Keyboard shortcuts',
                icon: Keyboard,
                keywords: ['keys', 'chords', 'help'],
                onSelect: () => {
                    setShortcutsOpen(true)
                },
            },
        ]
        const appearance: PaletteCommand[] = [
            {
                id: 'appearance:spectrum-style',
                label: 'Next spectrum style',
                icon: AudioLines,
                // Every style, not the one that happens to be next: a row found by typing
                // "scope" is a row that answers whichever style is in front of somebody.
                keywords: ['spectrum', 'visualiser', 'visualizer', 'bars', 'area', 'wave', 'ring', 'scope'],
                onSelect: () => {
                    cycleVisualizerStyle()
                },
            },
        ]
        // The scheme and the palette through maneki's own callbacks, so the palette stays under
        // maneki's key. The palette carries the spectrum's ramp: it is the one colour choice.
        const look = appearanceCommands(
            {
                scheme,
                onSchemeChange: setScheme,
                theme: chosenPalette,
                onThemeChange: (name) => {
                    choosePalette(name)
                },
            },
            {
                themes: PALETTES.map((one) => ({ value: one.name, label: one.label })),
                words: { theme: PALETTE_GROUP },
            },
        )
        const leaving: PaletteCommand[] = [
            {
                id: 'session:sign-out',
                label: radioOnly ? SIGN_IN_LABEL : SIGN_OUT_LABEL,
                icon: radioOnly ? LogIn : LogOut,
                keywords: ['logout', 'leave', 'server'],
                onSelect: signOut,
            },
        ]
        return [
            { title: GO_GROUP, commands: pages },
            { title: PLAYBACK_GROUP, commands: transport },
            { title: VIEW_GROUP, commands: view },
            { title: APPEARANCE_GROUP, commands: appearance },
            ...look,
            { title: SESSION_GROUP, commands: leaving },
        ]
    }, [
        admin,
        bookId,
        caps,
        chapterCount,
        chosenPalette,
        collapsed,
        music,
        navigate,
        openSettings,
        playing,
        queuedCount,
        radioOnly,
        repeat,
        shuffle,
        scheme,
        station,
        setScheme,
        spectrum,
    ])

    // Listening without a server there is no account: the corner says so, and the way out is
    // to sign in to one rather than to sign out of nothing.
    const name = radioOnly ? 'Radio only' : (session.username ?? 'Signed in')
    const host = radioOnly ? 'No server' : serverHost(session.baseUrl)
    const saying = status.note !== null || status.identifier !== null

    return (
        <>
            <Shell
                rail={
                    <Rail
                        mark={<Cat className="size-4" aria-hidden />}
                        name="maneki"
                        markHref={homePath(caps)}
                        groups={rail}
                        collapsed={collapsed}
                        // A collapsed rail drags open from its edge, as an expanded one resizes.
                        onCollapsedChange={setRailCollapsed}
                        resizable
                        size={width}
                        onSizeChange={setRailWidth}
                        minSize={RAIL_MIN_WIDTH}
                        maxSize={RAIL_MAX_WIDTH}
                        defaultSize={RAIL_WIDTH}
                        renderLink={railLink}
                        foot={
                            <AccountMenu
                                name={name}
                                where={host === '' ? undefined : host}
                                collapsed={collapsed}
                                onSettings={openSettings}
                                scheme={scheme}
                                onSchemeChange={setScheme}
                                // Radio-only has no account to leave: leaving it is signing in.
                                onSignOut={radioOnly ? undefined : signOut}
                                onSignIn={radioOnly ? signOut : undefined}
                                words={{ signOut: SIGN_OUT_LABEL, signIn: SIGN_IN_LABEL }}
                            />
                        }
                    />
                }
                top={
                    <TopBar
                        search={
                            librarySearch === null ? undefined : (
                                // On a phone the field gives way to the palette's button, and the
                                // palette, which finds the library too, is where the row leads.
                                <LibrarySearch
                                    source={librarySearch}
                                    onUnreachable={() => choosePaletteOpen(true)}
                                />
                            )
                        }
                        actions={
                            <>
                                {caps !== null && (
                                    <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                                        {caps.server} {caps.version}
                                    </span>
                                )}
                                <SchemeToggle />
                            </>
                        }
                    />
                }
                // A server that has stopped answering is the app's news, not one screen's, so
                // it is said once above the work rather than by each screen in turn.
                banner={<ConnectionBanner />}
                bottom={<PlayerBar />}
                // On a phone a foot with nothing to say is a strip of nothing under the player,
                // so the status line is drawn only while a screen has something to state.
                foot={
                    saying ? (
                        <StatusLine note={status.note ?? undefined} tone={status.tone}>
                            {status.identifier !== null && <StatusItem code>{status.identifier}</StatusItem>}
                        </StatusLine>
                    ) : undefined
                }
                route={pathname}
                palette={palette}
                paletteOpen={paletteOpen}
                onPaletteOpenChange={choosePaletteOpen}
                mayOpenPalette={mayOpenPalette}
                paletteSearch={paletteSearch}
                paletteFilter="terms"
                shortcuts={keys}
                shortcutsOpen={shortcutsOpen}
                onShortcutsOpenChange={setShortcutsOpen}
                desktop={desktop}
                // Keyed on the server coming back, so a screen that failed while it was gone
                // loads again instead of keeping the sentence; see `recoveries`.
                contentKey={recovered}
            >
                {/* As tall as the content, so a screen that fills the height it was given (the
                    watch and video screens grow with `flex-1`) still can. */}
                <div className="flex h-full w-full flex-col">{children}</div>
            </Shell>

            {/* The spectrum and the lyrics are the player bar's own fullscreen view. */}
            {settingsAsked && (
                <Suspense fallback={null}>
                    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
                </Suspense>
            )}
        </>
    )
}

/**
 * A rail entry as the router's link, so a hash route is followed rather than reloaded.
 *
 * WebKit (the macOS app, Safari) leaves links out of the Tab order unless the reader turned a
 * system setting on, so without `tabIndex` the rail could not be reached from the keyboard.
 */
function railLink(entry: RailEntry, children: ReactNode, className: string): ReactNode {
    return (
        <Link
            to={entry.href ?? '/'}
            tabIndex={0}
            className={className}
            aria-current={entry.active === true ? 'page' : undefined}
        >
            {children}
        </Link>
    )
}

/** Where a reader with no address of their own lands, which the router asks for. */
export { homePath }
