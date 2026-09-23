import {
    Keyboard,
    ListMusic,
    LogOut,
    Menu,
    Monitor,
    Moon,
    Pause,
    PanelLeft,
    PanelRight,
    Play,
    Maximize2,
    Search,
    Settings,
    Repeat,
    Shuffle,
    SkipBack,
    SkipForward,
    Sun,
} from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { useTheme } from 'next-themes'

import { CommandPalette } from '@/components/CommandPalette'
import { FullscreenVisualizer } from '@/components/FullscreenVisualizer'
import { NavDrawer, OPEN_NAV_LABEL } from '@/components/NavDrawer'
import { PanelSheet } from '@/components/PanelSheet'
import { PlayerBar, QUEUE_LABEL } from '@/components/PlayerBar'
import { QueuePanel } from '@/components/QueuePanel'
import { Rail } from '@/components/Rail'
import { RightPanel } from '@/components/RightPanel'
import { SearchOverlay, SEARCH_TITLE } from '@/components/SearchOverlay'
import { ShortcutsDialog } from '@/components/ShortcutsDialog'
import { StatusBar } from '@/components/StatusBar'
import { MODES, MODE_LABELS, ThemeToggle } from '@/components/ThemeToggle'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppShortcuts } from '@/hooks/use-app-shortcuts'
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
import { fillPanel, railCollapsed, togglePanel, toggleRail } from '@/lib/panels'
import { cycleRepeat, next, playerStore, previous, toggle, toggleShuffle } from '@/lib/player'
import { nextRepeat, REPEAT_LABELS } from '@/lib/queue'
import { openSearch } from '@/lib/search'
import { sessionStore, signOut } from '@/lib/session'
import { applePlatform, modifierLabel } from '@/lib/shortcuts'
import { openStage, toggleVisualizer, visualizerShown } from '@/lib/visualizer'

/** The three facts the shell reads off the player. Module scope, so each is one stable function. */
const selectPlaying = (state: { playing: boolean }) => state.playing
const selectQueueLength = (state: { queue: unknown[] }) => state.queue.length
const selectStation = (state: { station: unknown }) => state.station
const selectShuffle = (state: { shuffle: boolean }) => state.shuffle
const selectRepeat = (state: { repeat: 'off' | 'all' | 'one' }) => state.repeat

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
    const spectrum = useStore(visualizerShown)
    const navigate = useNavigate()
    const { setTheme } = useTheme()
    const [shortcutsOpen, setShortcutsOpen] = useState(false)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [settingsAsked, setSettingsAsked] = useState(false)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const menu = useRef<HTMLButtonElement | null>(null)
    const wasOpen = useRef(false)
    const caps = session.capabilities ?? null
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

    // The queue fills the panel for as long as there is one, and empties it when the queue
    // goes: a panel offering an empty tab is chrome that does nothing.
    useEffect(() => {
        if (!queued) return
        return fillPanel([{ id: 'queue', label: QUEUE_LABEL, render: () => <QueuePanel /> }], {
            screen: 'shell',
            open: 'queue',
        })
    }, [queued])

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
        const transport: PaletteAction[] =
            queuedCount > 0 || station !== null
                ? [
                      {
                          id: 'play:toggle',
                          title: playing ? 'Pause' : 'Play',
                          group: PLAYBACK_GROUP,
                          icon: playing ? Pause : Play,
                          keywords: ['stop', 'resume', 'transport'],
                          run: toggle,
                      },
                      ...(station === null
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
                            ]
                          : []),
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
                id: 'session:sign-out',
                title: SIGN_OUT_LABEL,
                group: SESSION_GROUP,
                icon: LogOut,
                keywords: ['logout', 'leave', 'server'],
                run: signOut,
            },
        ]
    }, [
        caps,
        collapsed,
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
