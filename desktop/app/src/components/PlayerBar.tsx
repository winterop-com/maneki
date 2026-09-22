import { Pause, Play, SkipBack, SkipForward } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useStore } from '@/hooks/use-store'
import { clock } from '@/lib/format'
import { currentSong, next, playerStore, previous, seek, toggle } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { coverUrl } from '@/lib/subsonic'

/**
 * What is playing, along the foot of every screen.
 *
 * Drawn only once something has been played: an empty transport under every
 * screen is a row of dead controls.
 */
export function PlayerBar() {
    const player = useStore(playerStore)
    const session = useStore(sessionStore)
    const song = currentSong()
    if (!song || !session.music) return null

    const cover = coverUrl(session.music, song.coverArt, 96)
    const duration = player.durationS || song.duration || 0

    return (
        <div className="flex h-shell-foot shrink-0 items-center gap-3 border-t bg-sidebar px-3">
            {cover && <img src={cover} alt="" className="size-9 shrink-0 rounded-sm object-cover" />}
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={song.title}>
                    {song.title}
                </p>
                <p className="truncate text-xs text-muted-foreground" title={song.artist}>
                    {song.artist}
                </p>
            </div>
            <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" aria-label="Previous" onClick={previous}>
                    <SkipBack className="size-4" aria-hidden />
                </Button>
                <Button size="sm" aria-label={player.playing ? 'Pause' : 'Play'} onClick={toggle}>
                    {player.playing ? (
                        <Pause className="size-4" aria-hidden />
                    ) : (
                        <Play className="size-4" aria-hidden />
                    )}
                </Button>
                <Button variant="ghost" size="sm" aria-label="Next" onClick={next}>
                    <SkipForward className="size-4" aria-hidden />
                </Button>
            </div>
            <div className="hidden min-w-0 flex-1 items-center gap-2 md:flex">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {clock(player.positionS)}
                </span>
                <input
                    type="range"
                    aria-label="Position"
                    min={0}
                    max={Math.max(1, Math.floor(duration))}
                    value={Math.floor(player.positionS)}
                    onChange={(event) => seek(Number(event.target.value))}
                    className="w-full accent-primary"
                />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{clock(duration)}</span>
            </div>
        </div>
    )
}
