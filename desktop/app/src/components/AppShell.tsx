import {
    AudioLines,
    Gauge,
    FastForward,
    Keyboard,
    ListMusic,
    LogOut,
    Menu,
    Monitor,
    Moon,
    Pause,
    PanelLeft,
    PanelRight,
    Palette,
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
    Sun,
    Volume1,
    Volume2,
    VolumeX,
} from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useTheme } from 'next-themes'

import { CommandPalette } from '@/components/CommandPalette'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { FullscreenVisualizer } from '@/components/FullscreenVisualizer'
import { LyricsOverlay } from '@/components/LyricsOverlay'
import { NavDrawer, OPEN_NAV_LABEL } from '@/components/NavDrawer'
import { NowPlayingPanel, NOW_PLAYING_LABEL } from '@/components/NowPlayingPanel'
import { PanelSheet } from '@/components/PanelSheet'
import { PlayerBar, QUEUE_LABEL } from '@/components/PlayerBar'
import { QueuePanel } from '@/components/QueuePanel'
import { Rail } from '@/components/Rail'
import { RightPanel } from '@/components/RightPanel'
import { SearchBox } from '@/components/SearchBox'
import { SearchOverlay, SEARCH_TITLE } from '@/components/SearchOverlay'
import { ShortcutsDialog } from '@/components/ShortcutsDialog'
import { StatusBar } from '@/components/StatusBar'
import { MODES, MODE_LABELS, ThemeToggle } from '@/components/ThemeToggle'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppShortcuts } from '@/hooks/use-app-shortcuts'
import { smallScreenNow } from '@/hooks/use-small-screen'
import { useStore, useStoreValue } from '@/hooks/use-store'
import { entriesFor, homePath } from '@/lib/nav'
import {
    APPEARANCE_GROUP,
    GO_GROUP,
    PLAYBACK_GROUP,
    SESSION_GROUP,
    VIEW_GROUP,
    paletteOpen,
    registerActions,
    type PaletteAction,
} from '@/lib/palette'
import { setDialogOpen } from '@/lib/dialogs'
import { fillPanel, openPanelTab, railCollapsed, togglePanel, toggleRail } from '@/lib/panels'
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
import { openLyrics } from '@/lib/lyrics'
import { nextRepeat, REPEAT_LABELS } from '@/lib/queue'
import { openSearch } from '@/lib/search'
import { sessionStore, signOut } from '@/lib/session'
import { applePlatform, modifierLabel, SEEK_STEP_S, VOLUME_STEP } from '@/lib/shortcuts'
import { toggleStar } from '@/lib/star'
import { choosePalette, PALETTES } from '@/lib/theme'
import { barRoom, cycleVisualizerStyle, openStage, toggleVisualizer, visualizerShown } from '@/lib/visualizer'

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
export const TOGGLE_PANEL_LABEL = 'Show or hide the side panel'
export const OPEN_PALETTE_LABEL = 'Open the command palette'

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
 * The chassis: a rail on the left, the screen in the middle, a panel on the right, the
 * transport across the foot and one line under all of it.
 *
 * `h-svh` rather than `min-h-svh`. The shell claims the viewport and the content column is the
 * one thing that scrolls, so there is exactly one scrollbar on every screen -- and a screen
 * that wants to fill the height it was given can be told how much that is.
 *
 * THE TRANSPORT SPANS THE WHOLE WIDTH, under the rail as well as under the screen. What is
 * playing is the app's rather than one screen's: it survives navigation, the keys that drive it
 * are bound on the document, and a bar that stopped at the rail's edge would read as the
 * screen's own furniture.
 *
 * WHAT THE QUEUE IS GOES IN THE SIDE PANEL, filled here for the same reason: a screen that
 * filled it would take it away again on the way to another one.
 */
export function AppShell({ children }: { children: ReactNode }) {
    const session = useStore(sessionStore)
    const collapsed = useStore(railCollapsed)
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
    const { setTheme } = useTheme()
    const [shortcutsOpen, setShortcutsOpen] = useState(false)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [settingsAsked, setSettingsAsked] = useState(false)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const menu = useRef<HTMLButtonElement | null>(null)
    const wasOpen = useRef(false)
    /** Whether this session has already been shown where what is playing lives. */
    const introduced = useRef(false)
    const caps = session.capabilities ?? null
    const music = session.music ?? null
    const queued = queuedCount > 0

    useEffect(() => {
        wasOpen.current = drawerOpen
    }, [drawerOpen])

    // The focus goes back where it came from: the button that raised the drawer. Only when the
    // drawer was actually standing -- a navigation closes it whether or not it was open, and
    // taking the focus off what somebody just clicked is not a close.
    const closeDrawer = useCallback(() => {
        if (!wasOpen.current) return
        setDrawerOpen(false)
        menu.current?.focus()
    }, [])

    const openSettings = useCallback(() => {
        setSettingsAsked(true)
        setSettingsOpen(true)
    }, [])

    useAppShortcuts(
        useCallback(() => {
            setShortcutsOpen(true)
        }, []),
    )

    // A bare key belongs to whatever is in front of somebody, and while one of these is up
    // that is the dialog rather than the app. `lib/dialogs` is what the key listener reads.
    useEffect(() => setDialogOpen('settings', settingsOpen), [settingsOpen])
    useEffect(() => setDialogOpen('shortcuts', shortcutsOpen), [shortcutsOpen])

    // The queue fills the panel for as long as there is one, and empties it when the queue
    // goes: a panel offering an empty tab is chrome that does nothing. A book fills it with its
    // chapters for the same reason and under the same heading -- what comes next -- and a book
    // carrying no chapter marks has nothing to list, so it does not.
    //
    // A STATION FILLS IT TOO, WITH ONE TAB. It has no queue and no chapters, so for a long
    // while it filled nothing at all: no Now playing, no Up next button on the bar, and the
    // spectrum's own pane unreachable for the one thing people put a spectrum on. What it has
    // is a now-playing, so that is the tab it gets, and the list of what comes next -- which
    // for a station is nothing, forever -- is not offered rather than offered empty.
    //
    // AND THE PANEL IS OPENED ONCE A SESSION, on what is playing. The panel defaults closed and
    // nothing on the screen says what is behind it, so the band nobody could find is put in
    // front of somebody the first time they play something -- once, guarded by a ref, because
    // the second time is a panel they have already had an opinion about. Not below the
    // breakpoint: the panel is a sheet over the whole screen there, the tab bar across the foot
    // is already the way to it, and a sheet raised by pressing play is one to dismiss first.
    // AND NOT THE SLEEVE WHILE THE BAR IS OPEN. A player bar pulled tall draws the spectrum
    // across the foot and its thumbnail names the track, so a Now playing tab beside it is the
    // same cover a third time; the panel then offers the queue alone.
    const room = useStore(barRoom)
    useEffect(() => {
        const listed = queued || chapterCount > 0
        if (!listed && station === null) return
        const sleeve = room === 0
        const tabs = [
            ...(sleeve ? [{ id: 'now', label: NOW_PLAYING_LABEL, render: () => <NowPlayingPanel /> }] : []),
            ...(listed ? [{ id: 'queue', label: QUEUE_LABEL, render: () => <QueuePanel /> }] : []),
        ]
        if (tabs.length === 0) return
        const empty = fillPanel(tabs, { screen: 'shell', open: sleeve ? 'now' : 'queue' })
        if (!introduced.current && !smallScreenNow()) {
            introduced.current = true
            openPanelTab(sleeve ? 'now' : 'queue')
        }
        return empty
    }, [queued, chapterCount, station, room])

    const actions = useMemo<PaletteAction[]>(() => {
        const pages: PaletteAction[] = entriesFor(caps).map((entry) => ({
            id: `go:${entry.path}`,
            title: entry.label,
            group: GO_GROUP,
            hint: entry.hint,
            icon: entry.icon,
            keywords: [entry.path],
            run: () => {
                void navigate(entry.path)
            },
        }))
        // WHAT THE PALETTE OFFERS IS WHAT IS PLAYING. A book steps by chapters and jumps by
        // fifteen seconds and is read at a speed; a record shuffles and repeats. Offering both
        // sets at once would be a list of rows half of which do nothing to the thing sounding.
        const bookRows: PaletteAction[] = [
            ...(chapterCount > 0
                ? [
                      {
                          id: 'play:next',
                          title: 'Next chapter',
                          group: PLAYBACK_GROUP,
                          icon: SkipForward,
                          keywords: ['skip', 'forward', 'chapter'],
                          run: next,
                      },
                      {
                          id: 'play:previous',
                          title: 'Previous chapter',
                          group: PLAYBACK_GROUP,
                          icon: SkipBack,
                          keywords: ['back', 'again', 'chapter'],
                          run: previous,
                      },
                  ]
                : []),
            {
                id: 'play:forward',
                title: `Forward ${String(SKIP_S)} seconds`,
                group: PLAYBACK_GROUP,
                icon: RotateCw,
                keywords: ['skip', 'jump', 'ahead'],
                run: () => {
                    skipBy(SKIP_S)
                },
            },
            {
                id: 'play:back',
                title: `Back ${String(SKIP_S)} seconds`,
                group: PLAYBACK_GROUP,
                icon: RotateCcw,
                keywords: ['skip', 'jump', 'again', 'missed'],
                run: () => {
                    skipBy(-SKIP_S)
                },
            },
            // Every speed rather than a row that cycles: a reader who wants it at one and a
            // half is asking for one and a half, not for four presses of "a bit faster".
            ...SPEEDS.map((speed) => ({
                id: `play:speed-${String(speed)}`,
                title: `Read at ${String(speed)}x`,
                group: PLAYBACK_GROUP,
                icon: Gauge,
                keywords: ['speed', 'rate', 'faster', 'slower', 'narration'],
                run: () => {
                    setSpeed(speed)
                },
            })),
        ]
        const transport: PaletteAction[] =
            queuedCount > 0 || station !== null || bookId !== null
                ? [
                      {
                          id: 'play:toggle',
                          title: playing ? 'Pause' : 'Play',
                          group: PLAYBACK_GROUP,
                          icon: playing ? Pause : Play,
                          keywords: ['stop', 'resume', 'transport'],
                          run: toggle,
                      },
                      ...(bookId !== null ? bookRows : []),
                      ...(bookId === null && station === null
                          ? [
                                {
                                    id: 'play:next',
                                    title: 'Next track',
                                    group: PLAYBACK_GROUP,
                                    icon: SkipForward,
                                    keywords: ['skip', 'forward'],
                                    run: next,
                                },
                                {
                                    id: 'play:previous',
                                    title: 'Previous track',
                                    group: PLAYBACK_GROUP,
                                    icon: SkipBack,
                                    keywords: ['back', 'again'],
                                    run: previous,
                                },
                                {
                                    id: 'play:shuffle',
                                    title: shuffle ? 'Play in the album order' : 'Shuffle the queue',
                                    group: PLAYBACK_GROUP,
                                    icon: Shuffle,
                                    keywords: ['random', 'mix'],
                                    run: toggleShuffle,
                                },
                                {
                                    id: 'play:repeat',
                                    title: REPEAT_LABELS[nextRepeat(repeat)],
                                    group: PLAYBACK_GROUP,
                                    icon: Repeat,
                                    keywords: ['loop', 'again', 'repeat'],
                                    run: cycleRepeat,
                                },
                                // WHAT ONLY A KEYBOARD COULD DO, OFFERED TO EVERYBODY. The star
                                // and the two arrows were a chord each and nothing on any
                                // screen, so a pointer could not reach them at all. A station
                                // has no row in the library to star and nothing to seek in.
                                {
                                    id: 'play:star',
                                    title: 'Star what is playing',
                                    group: PLAYBACK_GROUP,
                                    icon: Star,
                                    keywords: ['favourite', 'favorite', 'love', 'mark', 'unstar'],
                                    run: () => {
                                        toggleStar(music ?? undefined, currentSong())
                                    },
                                },
                                {
                                    id: 'play:seek-back',
                                    title: `Move ${String(SEEK_STEP_S)} seconds back`,
                                    group: PLAYBACK_GROUP,
                                    icon: Rewind,
                                    keywords: ['seek', 'rewind', 'scrub', 'position'],
                                    run: () => {
                                        seek(playerStore.get().positionS - SEEK_STEP_S)
                                    },
                                },
                                {
                                    id: 'play:seek-forward',
                                    title: `Move ${String(SEEK_STEP_S)} seconds forward`,
                                    group: PLAYBACK_GROUP,
                                    icon: FastForward,
                                    keywords: ['seek', 'skip', 'scrub', 'position'],
                                    run: () => {
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
                          title: 'Turn it up',
                          group: PLAYBACK_GROUP,
                          icon: Volume2,
                          keywords: ['volume', 'loud', 'level', 'up'],
                          run: () => {
                              setVolume(playerStore.get().volume + VOLUME_STEP)
                          },
                      },
                      {
                          id: 'play:quieter',
                          title: 'Turn it down',
                          group: PLAYBACK_GROUP,
                          icon: Volume1,
                          keywords: ['volume', 'quiet', 'level', 'down'],
                          run: () => {
                              setVolume(playerStore.get().volume - VOLUME_STEP)
                          },
                      },
                      {
                          // Named for what it does either way round, because the shell does not
                          // read whether it is muted and a row that said "Unmute" to somebody
                          // who is not muted would be worse than one that says neither.
                          id: 'play:mute',
                          title: 'Silence it, or bring it back',
                          group: PLAYBACK_GROUP,
                          icon: VolumeX,
                          keywords: ['mute', 'unmute', 'quiet', 'silence', 'volume'],
                          run: toggleMuted,
                      },
                  ]
                : []
        return [
            ...pages,
            ...transport,
            {
                id: 'view:rail',
                title: collapsed ? 'Expand the navigation' : 'Collapse the navigation',
                group: VIEW_GROUP,
                icon: PanelLeft,
                keywords: ['sidebar', 'rail'],
                run: toggleRail,
            },
            {
                id: 'view:panel',
                title: TOGGLE_PANEL_LABEL,
                group: VIEW_GROUP,
                icon: PanelRight,
                keywords: ['queue', 'up next', 'details'],
                run: togglePanel,
            },
            {
                id: 'view:search',
                title: SEARCH_TITLE,
                group: VIEW_GROUP,
                icon: Search,
                keywords: ['find', 'artist', 'album', 'track', 'song'],
                run: openSearch,
            },
            // The words are a track's, so the row is offered while there is one. A station has
            // no id to ask about and nothing to ask for it with.
            ...(queuedCount > 0
                ? [
                      {
                          id: 'view:lyrics',
                          title: 'Show the words of what is playing',
                          group: VIEW_GROUP,
                          icon: MicVocal,
                          keywords: ['lyrics', 'words', 'sing', 'along'],
                          run: openLyrics,
                      },
                  ]
                : []),
            {
                id: 'view:visualizer',
                title: spectrum ? 'Hide the spectrum' : 'Show the spectrum',
                group: VIEW_GROUP,
                icon: ListMusic,
                keywords: ['visualiser', 'visualizer', 'bars', 'analyser'],
                run: toggleVisualizer,
            },
            {
                id: 'view:stage',
                title: 'Put the spectrum over the whole screen',
                group: VIEW_GROUP,
                icon: Maximize2,
                keywords: ['fullscreen', 'full screen', 'stage', 'visualiser', 'visualizer'],
                run: openStage,
            },
            {
                id: 'view:settings',
                title: 'Open settings',
                group: VIEW_GROUP,
                icon: Settings,
                keywords: ['preferences', 'appearance', 'volume', 'account', 'server'],
                run: openSettings,
            },
            // Offered only where there is a library to walk: a row that asked a server with no
            // music to reindex its music would be a row that can only fail.
            ...(music
                ? [
                      {
                          id: 'view:rescan',
                          title: RESCAN_LABEL,
                          group: VIEW_GROUP,
                          icon: RefreshCw,
                          keywords: ['scan', 'refresh', 'reindex', 'library', 'reload', 'new albums'],
                          run: () => {
                              void rescan(music)
                          },
                      },
                  ]
                : []),
            {
                id: 'view:shortcuts',
                title: 'Keyboard shortcuts',
                group: VIEW_GROUP,
                icon: Keyboard,
                keywords: ['keys', 'chords', 'help'],
                run: () => {
                    setShortcutsOpen(true)
                },
            },
            ...MODES.map((mode) => ({
                id: `appearance:${mode}`,
                title: MODE_LABELS[mode],
                group: APPEARANCE_GROUP,
                icon: mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor,
                keywords: ['theme', 'appearance', mode],
                run: () => {
                    setTheme(mode)
                },
            })),
            {
                id: 'appearance:spectrum-style',
                title: 'Next spectrum style',
                group: APPEARANCE_GROUP,
                icon: AudioLines,
                // Every style, not the one that happens to be next: a row found by typing
                // "scope" is a row that answers whichever style is in front of somebody.
                keywords: ['spectrum', 'visualiser', 'visualizer', 'bars', 'mirror', 'ridge', 'scope'],
                run: () => {
                    cycleVisualizerStyle()
                },
            },
            // The palette carries the spectrum's ramp, so this is the one colour row there is:
            // what used to be a list of ramps here is a list of palettes.
            ...PALETTES.map((palette) => ({
                id: `appearance:palette-${palette.name}`,
                title: `Palette: ${palette.label}`,
                group: APPEARANCE_GROUP,
                icon: Palette,
                keywords: ['palette', 'theme', 'colour', 'color', 'spectrum', palette.name],
                run: () => {
                    choosePalette(palette.name)
                },
            })),
            {
                id: 'session:sign-out',
                title: SIGN_OUT_LABEL,
                group: SESSION_GROUP,
                icon: LogOut,
                keywords: ['logout', 'leave', 'server'],
                run: signOut,
            },
        ]
    }, [
        bookId,
        caps,
        chapterCount,
        collapsed,
        music,
        navigate,
        openSettings,
        playing,
        queuedCount,
        repeat,
        shuffle,
        station,
        setTheme,
        spectrum,
    ])

    useEffect(() => registerActions(actions), [actions])

    const modifier = modifierLabel(applePlatform(navigator.userAgent))

    return (
        <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
            {/* THE THREE COLUMNS, AND ONE RULE UNDER ALL OF THEM. The rail's head, the top strip
                and the panel's tab strip are each `h-shell-top`, and the line beneath them is
                drawn once across the whole width rather than three times -- three borders
                meeting at two column edges is a rule that can come apart. */}
            <div className="relative flex min-h-0 flex-1">
                <Rail />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <header
                        data-shell-strip="top"
                        className="flex h-shell-top shrink-0 items-center gap-2 bg-sidebar px-3"
                    >
                        {/* The rail is not drawn below the breakpoint, so this is the way to it. */}
                        <Button
                            ref={menu}
                            variant="ghost"
                            size="icon-sm"
                            aria-label={OPEN_NAV_LABEL}
                            className="md:hidden"
                            onClick={() => {
                                setDrawerOpen(true)
                            }}
                        >
                            <Menu className="size-4" aria-hidden />
                        </Button>
                        {/* Where the client this replaces kept it. It holds nothing and opens
                            the overlay with whatever was typed into it -- see `SearchBox`. */}
                        <SearchBox />
                        <div className="flex-1" />
                        {caps !== null && (
                            <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                                {caps.server} {caps.version}
                            </span>
                        )}
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="px-2 font-mono text-xs text-muted-foreground"
                                        onClick={() => {
                                            paletteOpen.set(true)
                                        }}
                                        aria-label={OPEN_PALETTE_LABEL}
                                    >
                                        {/* There is no keyboard below the breakpoint, so what the
                                            button carries there is the glyph rather than the chord. */}
                                        <Search className="size-4 md:hidden" aria-hidden />
                                        <span className="hidden md:inline">{modifier}K</span>
                                    </Button>
                                }
                            />
                            <TooltipContent side="bottom">{OPEN_PALETTE_LABEL}</TooltipContent>
                        </Tooltip>
                        {/* No panel toggle up here: the queue is what fills the panel, and the
                            player bar's own Up next button already opens it. Two controls for
                            one panel is one too many. */}
                        <ThemeToggle />
                    </header>

                    {/* A server that has stopped answering is the app's news, not one screen's,
                        so it is said once above the work rather than by each screen in turn. */}
                    <ConnectionBanner />

                    <main className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">{children}</main>

                    <PanelSheet />
                </div>
                <RightPanel />
                <div
                    data-shell-rule="top"
                    className="pointer-events-none absolute inset-x-0 top-shell-top z-20 h-px bg-border-strong"
                    aria-hidden
                />
            </div>

            <PlayerBar />
            <StatusBar onSettings={openSettings} />

            <NavDrawer open={drawerOpen} onClose={closeDrawer} onSettings={openSettings} />

            <FullscreenVisualizer />
            <LyricsOverlay />

            <SearchOverlay />
            <CommandPalette />
            <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
            {settingsAsked && (
                <Suspense fallback={null}>
                    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
                </Suspense>
            )}
        </div>
    )
}

/** Where a reader with no address of their own lands, which the router asks for. */
export { homePath }
