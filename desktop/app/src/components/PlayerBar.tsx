import {
    ListMusic,
    Pause,
    Play,
    Repeat,
    Repeat1,
    Shuffle,
    SkipBack,
    SkipForward,
    Volume1,
    Volume2,
    VolumeX,
} from 'lucide-react'
import { NavLink } from 'react-router'

import { CoverArt } from '@/components/CoverArt'
import { Visualizer } from '@/components/Visualizer'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStore } from '@/hooks/use-store'
import { clock } from '@/lib/format'
import {
    currentSong,
    cycleRepeat,
    next,
    playerStore,
    previous,
    seek,
    setVolume,
    toggle,
    toggleMuted,
    toggleShuffle,
} from '@/lib/player'
import { REPEAT_LABELS } from '@/lib/queue'
import { panelOpen, panelTabs, togglePanel } from '@/lib/panels'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'
import { openStage } from '@/lib/visualizer'
import { cn } from '@/lib/utils'

export const QUEUE_LABEL = 'Up next'
export const STAGE_LABEL = 'Put the spectrum over the whole screen'

/**
 * What is playing, along the foot of every screen.
 *
 * Drawn only once something has been played: an empty transport under every screen is a row of
 * dead controls.
 *
 * THE PROGRESS LINE IS ALWAYS THERE, THE SCRUBBER IS NOT. A 390px screen has no room for a
 * slider between the title and the transport, but "how far through this is" is the one fact a
 * transport must always show, so it is drawn as a hairline across the top edge of the bar at
 * every width, and the slider with its two clocks appears where there is room to drag it.
 *
 * A STATION HAS NO POSITION. It has no length, nothing to skip to and nothing to scrub, so the
 * skip buttons are disabled and the line and the clocks are not drawn at all rather than drawn
 * as zeroes.
 */
export function PlayerBar() {
    const player = useStore(playerStore)
    const session = useStore(sessionStore)
    const tabs = useStore(panelTabs)
    const open = useStore(panelOpen)
    const song = currentSong()
    const station = player.station
    if ((!song && !station) || !session.music) return null

    const cover = song ? coverUrl(session.music, song.coverArt, 96) : null
    const duration = player.durationS || song?.duration || 0
    const through = duration > 0 ? Math.min(1, player.positionS / duration) : 0
    const queued = tabs.length > 0

    return (
        <div
            data-shell-strip="player"
            className="relative flex h-shell-foot shrink-0 items-center gap-3 border-t border-border-strong bg-sidebar px-3"
        >
            {/* The hairline stands in for the scrubber where the scrubber does not fit, and
                nowhere else: both at once is the same fact drawn twice. */}
            {!station && (
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary transition-[width] duration-200 md:hidden"
                    style={{ width: `${String(through * 100)}%` }}
                />
            )}

            {cover ? (
                <img src={cover} alt="" className="size-9 shrink-0 rounded-sm object-cover" />
            ) : (
                // The album's id rather than the track's, so every track off one record wears
                // the same mark here that the record wears on the shelf.
                <CoverArt
                    id={song?.albumId ?? song?.id ?? station?.id ?? ''}
                    className="size-9 shrink-0 rounded-sm"
                />
            )}

            <div className="min-w-0 flex-1 md:max-w-64">
                <p className="truncate text-sm" title={song?.title ?? station?.name}>
                    {song ? (
                        song.albumId ? (
                            <NavLink to={`/music/album/${song.albumId}`} className="control-link">
                                {song.title}
                            </NavLink>
                        ) : (
                            song.title
                        )
                    ) : (
                        station?.name
                    )}
                </p>
                {/* A station that has announced what it is playing says that; one that has
                    not says it is live, which is the only other true thing about it. */}
                <p
                    className="truncate text-xs text-muted-foreground"
                    title={station ? player.stationTitle || 'Live' : song?.artist}
                >
                    {station ? player.stationTitle || 'Live' : song?.artist}
                </p>
            </div>

            <div className="flex items-center gap-1">
                {/* Shuffle and repeat sit beside the transport they change, and are drawn as
                    pressed rather than as a different glyph: what they do is a state the
                    queue is in, not an action. A station has no queue to be in one. */}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Shuffle the queue"
                    aria-pressed={player.shuffle}
                    onClick={toggleShuffle}
                    disabled={station !== null}
                    className={cn('hidden sm:inline-flex', player.shuffle && 'text-primary')}
                >
                    <Shuffle className="size-4" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={REPEAT_LABELS[player.repeat]}
                    aria-pressed={player.repeat !== 'off'}
                    onClick={cycleRepeat}
                    disabled={station !== null}
                    className={cn('hidden sm:inline-flex', player.repeat !== 'off' && 'text-primary')}
                >
                    {player.repeat === 'one' ? (
                        <Repeat1 className="size-4" aria-hidden />
                    ) : (
                        <Repeat className="size-4" aria-hidden />
                    )}
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Previous"
                    onClick={previous}
                    disabled={station !== null}
                >
                    <SkipBack className="size-4" aria-hidden />
                </Button>
                <Button size="icon-sm" aria-label={player.playing ? 'Pause' : 'Play'} onClick={toggle}>
                    {player.playing ? (
                        <Pause className="size-4" aria-hidden />
                    ) : (
                        <Play className="size-4" aria-hidden />
                    )}
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Next"
                    onClick={next}
                    disabled={station !== null}
                >
                    <SkipForward className="size-4" aria-hidden />
                </Button>
            </div>

            <div className={cn('hidden min-w-0 flex-1 items-center gap-2 md:flex', station && 'invisible')}>
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {clock(player.positionS)}
                </span>
                <input
                    type="range"
                    aria-label="Position"
                    min={0}
                    max={Math.max(1, Math.floor(duration))}
                    value={Math.floor(player.positionS)}
                    onChange={(event) => {
                        seek(Number(event.target.value))
                    }}
                    className="w-full accent-primary"
                />
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {clock(duration)}
                </span>
            </div>

            {/* The strip is the way to the stage with a pointer, as the F key is without one. */}
            <button
                type="button"
                aria-label={STAGE_LABEL}
                onClick={openStage}
                className="hidden shrink-0 rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none lg:block"
            >
                <Visualizer className="h-7 w-28 text-primary/70" />
            </button>

            <div className="hidden shrink-0 items-center gap-1 md:flex">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={player.muted ? 'Unmute' : 'Mute'}
                    aria-pressed={player.muted}
                    onClick={toggleMuted}
                >
                    <VolumeGlyph muted={player.muted} volume={player.volume} />
                </Button>
                <input
                    type="range"
                    aria-label="Volume"
                    min={0}
                    max={100}
                    value={Math.round((player.muted ? 0 : player.volume) * 100)}
                    onChange={(event) => {
                        setVolume(Number(event.target.value) / 100)
                    }}
                    className="w-20 accent-primary"
                />
            </div>

            {queued && (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={QUEUE_LABEL}
                                aria-pressed={open}
                                className="hidden shrink-0 md:inline-flex"
                                onClick={togglePanel}
                            >
                                <ListMusic className="size-4" aria-hidden />
                            </Button>
                        }
                    />
                    <TooltipContent side="top">{QUEUE_LABEL}</TooltipContent>
                </Tooltip>
            )}
        </div>
    )
}

/** Loud, quiet or silent: the glyph says which without anybody reading a number. */
function VolumeGlyph({ muted, volume }: { muted: boolean; volume: number }) {
    if (muted || volume === 0) return <VolumeX className="size-4" aria-hidden />
    if (volume < 0.5) return <Volume1 className="size-4" aria-hidden />
    return <Volume2 className="size-4" aria-hidden />
}
