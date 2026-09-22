import { Play, Volume2 } from 'lucide-react'

import { useStore } from '@/hooks/use-store'
import { clock } from '@/lib/format'
import { play, playerStore } from '@/lib/player'
import { cn } from '@/lib/utils'

/**
 * What is queued, and what is playing out of it.
 *
 * The panel is the shell's rather than a screen's, because the queue outlives every screen: it
 * was filled on an album and it is still there while somebody reads a book's chapters.
 *
 * A row plays from itself, which is what picking a track in a queue means: the queue is kept
 * and the position moves, exactly as picking a track in an album does.
 */
export function QueuePanel() {
    const player = useStore(playerStore)
    if (player.queue.length === 0) {
        return <p className="p-4 text-sm text-muted-foreground">Nothing queued.</p>
    }

    return (
        <ol className="p-2">
            {player.queue.map((song, index) => {
                const current = index === player.index
                return (
                    <li key={`${song.id}-${String(index)}`}>
                        <button
                            type="button"
                            onClick={() => {
                                play(player.queue, index)
                            }}
                            aria-current={current ? 'true' : undefined}
                            className={cn(
                                'row-hover flex min-h-finger w-full items-center gap-2 rounded-md px-2 text-left text-sm',
                                current && 'bg-muted font-medium',
                            )}
                        >
                            <span className="flex size-5 shrink-0 items-center justify-center text-xs text-muted-foreground tabular-nums">
                                {current ? (
                                    player.playing ? (
                                        <Volume2 className="size-3.5 text-primary" aria-hidden />
                                    ) : (
                                        <Play className="size-3.5 text-primary" aria-hidden />
                                    )
                                ) : (
                                    index + 1
                                )}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate">{song.title}</span>
                                {song.artist !== undefined && (
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {song.artist}
                                    </span>
                                )}
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                {clock(song.duration ?? 0)}
                            </span>
                        </button>
                    </li>
                )
            })}
        </ol>
    )
}
