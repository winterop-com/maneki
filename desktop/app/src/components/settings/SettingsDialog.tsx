import { Check, Volume2, VolumeX } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useMemo, useRef, useState, type ReactNode } from 'react'

import { Segmented } from '@/components/Segmented'
import { MODE_LABELS, MODES, type Mode } from '@/components/ThemeToggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useStore } from '@/hooks/use-store'
import { playerStore, setVolume, toggleMuted } from '@/lib/player'
import { sessionStore, signOut } from '@/lib/session'
import {
    categoriesWith,
    FIRST_CATEGORY,
    filterSettings,
    rowsOf,
    SETTINGS_GROUPS,
    settingsRows,
    type SettingsRow,
} from '@/lib/settings'
import { applePlatform, shortcuts } from '@/lib/shortcuts'
import { choosePalette, paletteAfter, PALETTES, paletteStore, type PaletteName } from '@/lib/theme'
import { chooseTimes, TIMES_LABELS, TIMES_MODES, timesMode } from '@/lib/times'
import { cn } from '@/lib/utils'
import { setVisualizer, visualizerShown } from '@/lib/visualizer'

export const SETTINGS_TITLE = 'Settings'

/**
 * Two panes: what there is on the left, one category of it on the right.
 *
 * THE ROWS ARE DATA AND THE SEARCH IS A PURE FUNCTION OVER THEM. `lib/settings` holds every row
 * as a record -- what it is called, what else it can be found by -- so filtering across every
 * category is one function with a test, and not a traversal of markup. What a row puts on its
 * right edge is this file's, keyed by the row's id.
 *
 * NOTHING HERE IS A COPY OF A SETTING. Appearance writes next-themes, which is the same store
 * the toggle in the top strip writes; the palette writes `lib/theme`; the volume and the
 * spectrum write the player and `lib/visualizer`, which the player bar reads. A dialog that
 * held its own copy of a setting would be a second answer to the same question.
 *
 * SIGN OUT IS STILL IN THE PALETTE. This adds a second way to reach it rather than moving it.
 */
export function SettingsDialog({
    open,
    onOpenChange,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const apple = applePlatform(navigator.userAgent)
    const [query, setQuery] = useState('')
    const [chosen, setChosen] = useState(FIRST_CATEGORY)

    const rows = useMemo(() => settingsRows(apple), [apple])
    const shown = useMemo(() => filterSettings(rows, query), [query, rows])
    const categories = useMemo(() => categoriesWith(shown), [shown])
    const active = categories.some((category) => category.id === chosen)
        ? chosen
        : (categories[0]?.id ?? null)
    const heading = categories.find((category) => category.id === active) ?? null

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[32rem] flex-col gap-0 p-0 sm:max-w-3xl">
                <DialogHeader className="shrink-0 gap-1 border-b border-border px-4 py-3">
                    <DialogTitle>{SETTINGS_TITLE}</DialogTitle>
                </DialogHeader>

                <div className="flex min-h-0 flex-1">
                    <nav className="flex w-36 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-sidebar p-2 md:w-52">
                        <Input
                            value={query}
                            aria-label="Search the settings"
                            placeholder="Search"
                            className="mb-1"
                            onChange={(event) => {
                                setQuery(event.target.value)
                            }}
                        />
                        {SETTINGS_GROUPS.map((group) => {
                            const inGroup = categories.filter((category) => category.group === group.id)
                            if (inGroup.length === 0) return null
                            return (
                                <div key={group.id} className="mb-1">
                                    <p className="px-2 py-1 text-xs text-faint">{group.label}</p>
                                    {inGroup.map((category) => (
                                        <button
                                            key={category.id}
                                            type="button"
                                            aria-current={category.id === active}
                                            className={cn(
                                                // A category is a destination inside the sheet,
                                                // and takes the row a drawer entry takes.
                                                'flex min-h-finger w-full items-center rounded-md px-2 py-1 text-left text-sm md:min-h-0',
                                                category.id === active
                                                    ? 'bg-primary/15 font-medium text-foreground'
                                                    : 'text-muted-foreground hover:bg-accent',
                                            )}
                                            onClick={() => {
                                                setChosen(category.id)
                                            }}
                                        >
                                            {category.label}
                                        </button>
                                    ))}
                                </div>
                            )
                        })}
                    </nav>

                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
                        {heading === null ? (
                            <p className="text-sm text-muted-foreground">Nothing matches that.</p>
                        ) : (
                            <>
                                <h2 className="mb-3 text-sm font-semibold">{heading.label}</h2>
                                <Pane category={heading.id} rows={rowsOf(shown, heading.id)} apple={apple} />
                            </>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}

/** Which pane one category is. */
function Pane({ category, rows, apple }: { category: string; rows: SettingsRow[]; apple: boolean }) {
    if (rows.length === 0) return <p className="text-sm text-muted-foreground">Nothing matches that.</p>
    switch (category) {
        case 'general':
            return <GeneralPane rows={rows} />
        case 'theme':
            return <ThemePane rows={rows} />
        case 'account':
            return <AccountPane rows={rows} />
        case 'shortcuts':
            return <ShortcutsPane rows={rows} apple={apple} />
        default:
            return <ServerPane rows={rows} />
    }
}

/**
 * One row: what it is called, the control on its right edge, and whatever it expands into.
 *
 * The description is the row's own and is usually absent: a line restating the label is a line
 * that says nothing, so only a row with a fact the control cannot show carries one.
 */
function Row({ row, children, under }: { row: SettingsRow; children?: ReactNode; under?: ReactNode }) {
    return (
        <div className="row-hover -mx-2 border-b border-border px-2 py-3 last:border-b-0">
            {/* Below the breakpoint the control sits under what it is called: a label column
                and a control column on a 390px screen is two words a line. */}
            <div className="flex flex-col items-start gap-2 md:flex-row md:items-start md:justify-between md:gap-4">
                <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">{row.label}</p>
                    {row.description !== undefined && (
                        <p className="text-xs text-muted-foreground">{row.description}</p>
                    )}
                </div>
                {children !== undefined && <div className="flex shrink-0 items-center gap-1">{children}</div>}
            </div>
            {under !== undefined && <div className="mt-3">{under}</div>}
        </div>
    )
}

/** Listening: the spectrum, how loud, and which clock a date is read against. */
function GeneralPane({ rows }: { rows: SettingsRow[] }) {
    const times = useStore(timesMode)
    const player = useStore(playerStore)
    const spectrum = useStore(visualizerShown)

    return (
        <div>
            {rows.map((row) => {
                if (row.id === 'general:times') {
                    return (
                        <Row key={row.id} row={row}>
                            <Segmented
                                label="Times"
                                value={times}
                                options={TIMES_MODES.map((one) => ({ value: one, label: TIMES_LABELS[one] }))}
                                onChoose={chooseTimes}
                            />
                        </Row>
                    )
                }
                if (row.id === 'general:volume') {
                    return (
                        <Row key={row.id} row={row}>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={player.muted ? 'Unmute' : 'Mute'}
                                aria-pressed={player.muted}
                                onClick={toggleMuted}
                            >
                                {player.muted ? (
                                    <VolumeX className="size-4" aria-hidden />
                                ) : (
                                    <Volume2 className="size-4" aria-hidden />
                                )}
                            </Button>
                            <input
                                type="range"
                                aria-label="Volume"
                                min={0}
                                max={100}
                                value={Math.round(player.volume * 100)}
                                onChange={(event) => {
                                    setVolume(Number(event.target.value) / 100)
                                }}
                                className="w-40 accent-primary"
                            />
                        </Row>
                    )
                }
                return (
                    <Row key={row.id} row={row}>
                        <Button
                            variant={spectrum ? 'secondary' : 'outline'}
                            size="sm"
                            aria-pressed={spectrum}
                            onClick={() => {
                                setVisualizer(!spectrum)
                            }}
                        >
                            {spectrum ? 'Shown' : 'Hidden'}
                        </Button>
                    </Row>
                )
            })}
        </div>
    )
}

/** The look: the two axes, one row each. */
function ThemePane({ rows }: { rows: SettingsRow[] }) {
    const { theme, setTheme } = useTheme()
    const mode = (theme ?? 'system') as Mode
    const palette = useStore(paletteStore)

    return (
        <div>
            {rows.map((row) => {
                if (row.id === 'theme:appearance') {
                    return (
                        <Row key={row.id} row={row}>
                            <Segmented
                                label="Appearance"
                                value={mode}
                                options={MODES.map((one) => ({ value: one, label: MODE_LABELS[one] }))}
                                onChoose={setTheme}
                            />
                        </Row>
                    )
                }
                return (
                    <Row
                        key={row.id}
                        row={row}
                        under={
                            <PaletteSwatches
                                value={palette}
                                onChoose={(name) => {
                                    choosePalette(name)
                                }}
                            />
                        }
                    />
                )
            })}
        </div>
    )
}

/** The tokens a swatch shows, ground first and accent last: the ladder plus the two inks. */
const SWATCH_STRIPS = ['bg-background', 'bg-card', 'bg-border', 'bg-foreground', 'bg-primary']

/**
 * One card per palette, and the card is the radio.
 *
 * WHAT A PALETTE LOOKS LIKE IS THE SWATCH, NOT A SENTENCE. Each card scopes itself with
 * `data-palette`, which index.css hangs that palette's own token block off, so the five strips
 * are the real ground, surface, line, ink and accent -- in the appearance in force, and right
 * without anybody copying a colour when a token moves.
 *
 * A RADIOGROUP, WITH THE ARROWS CHOOSING. One tab stop for the group, the arrows move and
 * choose, Space and Enter choose what has focus. That is the stock behaviour of a radio group,
 * and a palette applies the moment it is chosen, so moving through them is trying them on.
 */
function PaletteSwatches({ value, onChoose }: { value: PaletteName; onChoose: (name: PaletteName) => void }) {
    const cards = useRef<(HTMLButtonElement | null)[]>([])
    const at = Math.max(
        0,
        PALETTES.findIndex((one) => one.name === value),
    )

    const move = (key: string) => {
        const next = paletteAfter(value, key)
        if (next === null) return false
        onChoose(next)
        cards.current[PALETTES.findIndex((one) => one.name === next)]?.focus()
        return true
    }

    return (
        <div role="radiogroup" aria-label="Palette" className="flex gap-2">
            {PALETTES.map((palette, index) => {
                const chosen = palette.name === value
                return (
                    <button
                        key={palette.name}
                        ref={(element) => {
                            cards.current[index] = element
                        }}
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        tabIndex={index === at ? 0 : -1}
                        className={cn(
                            'flex max-w-32 min-w-0 flex-1 flex-col gap-1.5 rounded-md border p-1.5 text-left',
                            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                            chosen ? 'border-primary ring-2 ring-primary' : 'border-border hover:bg-accent',
                        )}
                        onClick={() => {
                            onChoose(palette.name)
                        }}
                        onKeyDown={(event) => {
                            if (move(event.key)) {
                                event.preventDefault()
                            } else if (event.key === ' ' || event.key === 'Enter') {
                                event.preventDefault()
                                onChoose(palette.name)
                            }
                        }}
                    >
                        <span
                            data-palette={palette.name}
                            className="flex h-8 overflow-hidden rounded-sm border border-border"
                        >
                            {SWATCH_STRIPS.map((strip) => (
                                <span key={strip} className={cn('flex-1', strip)} />
                            ))}
                        </span>
                        <span className="flex items-center gap-1 text-xs">
                            {palette.label}
                            {chosen && <Check className="size-3 text-primary" aria-hidden />}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

/** Every key this app answers, drawn from `lib/shortcuts` rather than listed again here. */
function ShortcutsPane({ rows, apple }: { rows: SettingsRow[]; apple: boolean }) {
    const keys = new Map(shortcuts(apple).map((shortcut) => [`shortcuts:${shortcut.id}`, shortcut.keys]))
    return (
        <div>
            {rows.map((row) => (
                <Row key={row.id} row={row}>
                    <KbdGroup>
                        {(keys.get(row.id) ?? []).map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                        ))}
                    </KbdGroup>
                </Row>
            ))}
        </div>
    )
}

/** Who this is, and the way out. */
function AccountPane({ rows }: { rows: SettingsRow[] }) {
    const session = useStore(sessionStore)
    return (
        <div>
            {rows.map((row) => {
                if (row.id === 'account:identity') {
                    return (
                        <Row key={row.id} row={row}>
                            <span className="font-mono text-sm">{session.username ?? 'nobody'}</span>
                        </Row>
                    )
                }
                return (
                    <Row key={row.id} row={row}>
                        <Button variant="outline" size="sm" onClick={signOut}>
                            Sign out
                        </Button>
                    </Row>
                )
            })}
        </div>
    )
}

/** What this server is, read off the capabilities the session already holds. */
function ServerPane({ rows }: { rows: SettingsRow[] }) {
    const session = useStore(sessionStore)
    const caps = session.capabilities
    const libraries = caps
        ? (['audio', 'video', 'books', 'radio'] as const).filter((library) => caps[library])
        : []

    return (
        <div>
            {rows.map((row) => {
                if (row.id === 'server:address') {
                    return (
                        <Row key={row.id} row={row}>
                            <span className="identifier break-all">
                                {session.baseUrl === '' ? 'this origin' : session.baseUrl}
                            </span>
                        </Row>
                    )
                }
                if (row.id === 'server:version') {
                    return (
                        <Row key={row.id} row={row}>
                            <span className="font-mono text-sm">{caps?.version ?? 'unknown'}</span>
                        </Row>
                    )
                }
                return (
                    <Row key={row.id} row={row}>
                        {libraries.length === 0 ? (
                            <span className="text-sm text-muted-foreground">none</span>
                        ) : (
                            libraries.map((library) => (
                                <Badge key={library} variant="secondary">
                                    {library === 'audio' ? 'music' : library}
                                </Badge>
                            ))
                        )}
                    </Row>
                )
            })}
        </div>
    )
}
