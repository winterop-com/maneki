import { Check, Volume2, VolumeX } from 'lucide-react'
import { useMemo, useRef, useState, type CSSProperties } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { CopyButton } from '@winterop-com/sokkel-ui/CopyButton'
import { useScheme } from '@winterop-com/sokkel-ui/hooks/use-scheme'
import { useStore } from '@winterop-com/sokkel-ui/hooks/use-store'
import { Segmented } from '@winterop-com/sokkel-ui/Segmented'
import { SettingsDialog as LibrarySettingsDialog, type Setting } from '@winterop-com/sokkel-ui/SettingsDialog'
import { APP_VERSION } from '@/lib/app-version'
import { playerStore, setVolume, spectrumContext, toggleMuted } from '@/lib/player'
import {
    chooseDensity,
    chooseFontScale,
    DENSITIES,
    DENSITY_LABELS,
    densityStore,
    FONT_SCALE_MAX,
    FONT_SCALE_MIN,
    FONT_SCALE_STEP,
    fontScaleStore,
    formatFontScale,
} from '@/lib/preferences'
import { sessionStore, signOut } from '@/lib/session'
import { FIRST_CATEGORY, settingsGroups, settingsRows, type SettingsRow } from '@/lib/settings'
import { applePlatform, shortcuts } from '@/lib/shortcuts'
import { rampForPalette, themeStops } from '@/lib/spectrum-themes'
import { outputDelayMs, setSpectrumDelay, SPECTRUM_DELAY_MAX_MS, spectrumDelayMs } from '@/lib/sync'
import {
    choosePalette,
    MODE_LABELS,
    MODES,
    paletteAfter,
    PALETTES,
    paletteStore,
    type PaletteName,
} from '@/lib/theme'
import type { Capabilities } from '@/lib/types'
import { cn } from '@/lib/utils'
import { autoplayNext, setAutoplayNext } from '@/lib/watching'
import {
    setSpectrumEffect,
    setVisualizer,
    setVisualizerStyle,
    SPECTRUM_EFFECT_LABELS,
    SPECTRUM_EFFECTS,
    spectrumEffect,
    VISUALIZER_STYLE_LABELS,
    VISUALIZER_STYLES,
    visualizerShown,
    visualizerStyle,
} from '@/lib/visualizer'

/**
 * Settings, drawn by sokkel-ui's `SettingsDialog`: its navigation, search, footer and Done.
 *
 * THE ROWS ARE `lib/settings`'S AND THE CONTROLS ARE THIS FILE'S. The registry says what each row
 * is called and what else it is found by; `control` below puts the control on it, keyed by the
 * row's id. Radio-only has no account and no server, so the registry offers neither.
 *
 * NOTHING HERE IS A COPY OF A SETTING. Appearance writes sokkel-ui's `useScheme`, which is the
 * same store the toggle in the top strip writes; the palette writes `lib/theme`; the volume and the
 * spectrum write the player and `lib/visualizer`, which the player bar reads.
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
    const [search, setSearch] = useState('')
    const [active, setActive] = useState(FIRST_CATEGORY)

    const session = useStore(sessionStore)
    const radioOnly = session.phase === 'radio'
    const rows = useMemo(() => settingsRows(apple, { server: !radioOnly }), [apple, radioOnly])
    const control = useControls(apple)
    const groups = settingsGroups(rows, (row) => ({
        id: row.id,
        title: row.label,
        description: row.description,
        keywords: row.keywords,
        ...control(row),
    }))

    return (
        <LibrarySettingsDialog
            open={open}
            onOpenChange={onOpenChange}
            groups={groups}
            active={active}
            onActiveChange={setActive}
            search={search}
            onSearchChange={setSearch}
        />
    )
}

/** What a row adds to the library's setting: its control, and a note or a layout where it has one. */
type Control = Pick<Setting, 'control' | 'note' | 'layout'>

/** The control each row carries, keyed by its id, over the stores the rows set. */
function useControls(apple: boolean): (row: SettingsRow) => Control {
    const player = useStore(playerStore)
    const spectrum = useStore(visualizerShown)
    const style = useStore(visualizerStyle)
    const effect = useStore(spectrumEffect)
    const delay = useStore(spectrumDelayMs)
    // Read as the dialog renders rather than held in state: what the browser reports changes the
    // moment somebody puts headphones on, and this dialog stands open for minutes.
    const graph = spectrumContext()
    const auto = Math.round(outputDelayMs(graph))
    const density = useStore(densityStore)
    const fontScale = useStore(fontScaleStore)
    const upNext = useStore(autoplayNext)
    const { scheme: mode, setScheme } = useScheme()
    const palette = useStore(paletteStore)
    const session = useStore(sessionStore)
    const caps = session.capabilities
    const subsonic = subsonicAddress(session.baseUrl, caps)
    const libraries = caps
        ? (['audio', 'video', 'books', 'radio'] as const).filter((library) => caps[library])
        : []
    const keys = new Map(shortcuts(apple).map((shortcut) => [`shortcuts:${shortcut.id}`, shortcut.keys]))

    return (row) => {
        switch (row.id) {
            case 'general:visualizer':
                return {
                    control: (
                        <Toggle
                            on={spectrum}
                            words={['Shown', 'Hidden']}
                            onChange={() => {
                                setVisualizer(!spectrum)
                            }}
                        />
                    ),
                }
            case 'general:visualizer-style':
                return {
                    control: (
                        <Segmented
                            size="sm"
                            label={row.label}
                            value={style}
                            options={VISUALIZER_STYLES.map((one) => ({
                                value: one,
                                label: VISUALIZER_STYLE_LABELS[one],
                            }))}
                            onValueChange={setVisualizerStyle}
                        />
                    ),
                }
            case 'general:spectrum-effect':
                return {
                    control: (
                        <Segmented
                            size="sm"
                            label={row.label}
                            value={effect}
                            options={SPECTRUM_EFFECTS.map((one) => ({
                                value: one,
                                label: SPECTRUM_EFFECT_LABELS[one],
                            }))}
                            onValueChange={setSpectrumEffect}
                        />
                    ),
                }
            case 'general:spectrum-delay':
                return {
                    note: delayNote(graph !== null, auto),
                    control: (
                        <span className="flex items-center gap-1">
                            <span className="w-14 text-right font-mono text-xs text-muted-foreground tabular-nums">
                                {delay} ms
                            </span>
                            <input
                                type="range"
                                aria-label={row.label}
                                min={0}
                                max={SPECTRUM_DELAY_MAX_MS}
                                step={10}
                                value={delay}
                                onChange={(event) => {
                                    setSpectrumDelay(Number(event.target.value))
                                }}
                                className="w-40 accent-primary"
                            />
                        </span>
                    ),
                }
            case 'general:volume':
                return {
                    control: (
                        <span className="flex items-center gap-1">
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
                        </span>
                    ),
                }
            case 'general:density':
                return {
                    control: (
                        <Segmented
                            size="sm"
                            label="Density"
                            value={density}
                            options={DENSITIES.map((one) => ({ value: one, label: DENSITY_LABELS[one] }))}
                            onValueChange={chooseDensity}
                        />
                    ),
                }
            case 'general:font-scale':
                return {
                    control: (
                        <span className="flex items-center gap-1">
                            {/* The readout is what the slider cannot say: a notch along a track
                                is not a size until it carries the number it stands for. */}
                            <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums">
                                {formatFontScale(fontScale)}
                            </span>
                            <input
                                type="range"
                                aria-label="Text size"
                                min={FONT_SCALE_MIN}
                                max={FONT_SCALE_MAX}
                                step={FONT_SCALE_STEP}
                                value={fontScale}
                                onChange={(event) => {
                                    chooseFontScale(Number(event.target.value))
                                }}
                                className="w-40 accent-primary"
                            />
                        </span>
                    ),
                }
            case 'general:autoplay-next':
                return {
                    control: (
                        <Toggle
                            on={upNext}
                            words={['On', 'Off']}
                            onChange={() => {
                                setAutoplayNext(!upNext)
                            }}
                        />
                    ),
                }
            case 'general:app-version':
                return { control: <span className="font-mono text-sm">{APP_VERSION}</span> }
            case 'theme:appearance':
                return {
                    control: (
                        <Segmented
                            size="sm"
                            label="Appearance"
                            value={mode}
                            options={MODES.map((one) => ({ value: one, label: MODE_LABELS[one] }))}
                            onValueChange={setScheme}
                        />
                    ),
                }
            case 'theme:palette':
                return {
                    layout: 'below',
                    control: (
                        <PaletteSwatches
                            value={palette}
                            onChoose={(name) => {
                                choosePalette(name)
                            }}
                        />
                    ),
                }
            case 'account:identity':
                return { control: <span className="font-mono text-sm">{session.username ?? 'nobody'}</span> }
            case 'account:sign-out':
                return {
                    control: (
                        <Button variant="outline" size="sm" onClick={signOut}>
                            Sign out
                        </Button>
                    ),
                }
            case 'server:address':
                return {
                    control: (
                        <span className="identifier break-all">
                            {session.baseUrl === '' ? 'this origin' : session.baseUrl}
                        </span>
                    ),
                }
            case 'server:subsonic':
                return subsonic === null
                    ? {
                          control: (
                              <span className="text-sm text-muted-foreground">
                                  this server serves no music
                              </span>
                          ),
                      }
                    : {
                          note: (
                              <>
                                  Amperfy, play:Sub, Symfonium and DSub all take this address, your username
                                  and your password, and append their own{' '}
                                  <code className="identifier">/rest</code>. Downloading an album in one of
                                  them keeps it on the phone with no server in reach.
                              </>
                          ),
                          control: (
                              <span className="flex items-center gap-1">
                                  <span className="identifier break-all">{subsonic}</span>
                                  <CopyButton value={subsonic} words={{ copy: 'Copy the address' }} />
                              </span>
                          ),
                      }
            case 'server:version':
                return { control: <span className="font-mono text-sm">{caps?.version ?? 'unknown'}</span> }
            case 'server:libraries':
                return {
                    control:
                        libraries.length === 0 ? (
                            <span className="text-sm text-muted-foreground">none</span>
                        ) : (
                            <span className="flex flex-wrap gap-1">
                                {libraries.map((library) => (
                                    <Badge key={library} variant="secondary">
                                        {library === 'audio' ? 'music' : library}
                                    </Badge>
                                ))}
                            </span>
                        ),
                }
            default:
                // Every other row is a shortcut, its keys drawn from `lib/shortcuts`.
                return {
                    control: (
                        <KbdGroup>
                            {(keys.get(row.id) ?? []).map((key) => (
                                <Kbd key={key}>{key}</Kbd>
                            ))}
                        </KbdGroup>
                    ),
                }
        }
    }
}

/** A setting that is on or off, as the pressed button the rows have always had. */
function Toggle({ on, words, onChange }: { on: boolean; words: [string, string]; onChange: () => void }) {
    return (
        <Button variant={on ? 'secondary' : 'outline'} size="sm" aria-pressed={on} onClick={onChange}>
            {on ? words[0] : words[1]}
        </Button>
    )
}

/**
 * What this browser reports about its own output, as a sentence.
 *
 * The figure is a fact the slider cannot show: what somebody is dialling in is what the browser
 * failed to admit to, so knowing it already reports 190ms is the difference between dragging
 * with a reason and dragging until it looks right.
 */
function delayNote(playing: boolean, auto: number): string {
    if (!playing) return 'Nothing has played yet, so this browser has not said what its output is behind by.'
    if (auto > 0) return `This output reports ${String(auto)} ms of its own, which is held back as well.`
    return 'This output reports no delay of its own, which is the case this slider is for.'
}

/**
 * A ramp's stops as a strip, quiet end first.
 *
 * One stop is the palette that carries no ramp of its own and burns in its accent alone: it is
 * laid at both ends, because a gradient with a single stop is not a gradient.
 */
function ramp(stops: readonly string[]): CSSProperties {
    const across = stops.length === 1 ? [stops[0], stops[0]] : stops
    return { backgroundImage: `linear-gradient(to right, ${across.join(', ')})` }
}

/** The tokens a swatch shows, ground first and accent last: the ladder plus the two inks. */
const SWATCH_STRIPS = ['bg-background', 'bg-card', 'bg-border', 'bg-foreground', 'bg-primary']

/**
 * One card per palette, and the card is the radio.
 *
 * WHAT A PALETTE LOOKS LIKE IS THE SWATCH, NOT A SENTENCE. Each card scopes itself with
 * `data-theme-scope`, which sokkel-ui's theme files hang that palette's own token block off, so
 * the five strips are the real ground, surface, line, ink and accent -- in the appearance in
 * force, and right without anybody copying a colour when a token moves. Under them is the ramp
 * the palette carries, because the spectrum's colour comes with the palette and is not chosen
 * anywhere else.
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
        // Eight cards in one row were too narrow for their names on a phone; under the
        // breakpoint they wrap four to a row.
        <div role="radiogroup" aria-label="Palette" className="grid grid-cols-4 gap-2 md:flex">
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
                            data-theme-scope={palette.name}
                            className="flex h-8 overflow-hidden rounded-sm border border-border forced-color-adjust-none"
                        >
                            {SWATCH_STRIPS.map((strip) => (
                                <span key={strip} className={cn('flex-1', strip)} />
                            ))}
                        </span>
                        {/* The ramp this palette burns its spectrum in. It is scoped the same
                            way, so the palette that paints in its own accent rather than a ramp
                            shows that accent here, and the card is the whole choice. */}
                        <span
                            data-theme-scope={palette.name}
                            className="h-2 rounded-sm forced-color-adjust-none"
                            style={ramp(themeStops(rampForPalette(palette.name), 'var(--primary)'))}
                        />
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

/**
 * The address a Subsonic app on a phone wants, which is not the one in the browser's bar.
 *
 * maneki mounts Subsonic under `/audio`, beside the video and books APIs, and every client
 * appends its own `/rest/...`. Leaving `/audio` off is the mistake that costs an evening: the
 * calls 404 and the app reports a server it cannot reach rather than a wrong address. So the
 * app states the whole thing, ready to copy, rather than leaving it to a guide.
 */
function subsonicAddress(baseUrl: string, caps: Capabilities | undefined): string | null {
    const mount = caps?.endpoints.audio_subsonic
    if (!mount) return null
    const origin = baseUrl === '' ? window.location.origin : baseUrl
    // The client appends `/rest`, so what a person types stops before it.
    return `${origin}${mount.replace(/\/rest$/, '')}`
}
