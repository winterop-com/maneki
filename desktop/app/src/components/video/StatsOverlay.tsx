import { X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { video as videoApi } from '@/lib/api'
import type { VideoStatsFrame } from '@/lib/types'
import {
    bitrateLabel,
    encoderOf,
    otherStreams,
    sessionFor,
    streamVerdict,
    type PlaybackSample,
    type StreamLevel,
} from '@/lib/video'
import { cn } from '@/lib/utils'

/**
 * Why playback is going the way it is, in one sentence and eight numbers.
 *
 * THE SENTENCE IS THE POINT AND THE GRID IS THE EVIDENCE. Somebody opens this because a film is
 * stuttering, and what they need is which wall was hit -- the machine cannot encode fast enough,
 * or the link cannot carry what it encoded -- because those have different answers. The numbers
 * underneath are for whoever wants to check the verdict, and `lib/video` is where it is decided,
 * so what the overlay says is a pure function with tests rather than a paragraph of markup.
 *
 * TWO SOURCES, NEITHER OF WHICH KNOWS THE OTHER. The server's half arrives as events -- one
 * frame a second carrying the shared transcode budget and every session on it, which is how
 * somebody else's 4K stream shows up as the reason this one is thin -- and the player's half is
 * read off the player once a second. The stream is opened only while this is on screen: a
 * connection held open for a panel nobody has asked for is a connection spent on nothing.
 */

/** How often the player is asked how it is doing. The server's own frames arrive at that rate. */
const SAMPLE_MS = 1000

export const STATS_LABEL = 'Show the stream stats'

/** How each verdict is inked. Buffering is information; only a stall is a fault. */
const TONE: Record<StreamLevel, string> = {
    healthy: 'text-good-ink',
    buffering: 'text-warning-ink',
    stalled: 'text-critical-ink',
    idle: 'text-muted-foreground',
}

export function StatsOverlay({
    videoId,
    sample,
    onClose,
    below = false,
}: {
    videoId: string
    /** How the player answers what it is doing, or null before there is a player. */
    sample: () => PlaybackSample | null
    onClose: () => void
    /** Hung under the screen's own strip, for the theater case where that strip floats. */
    below?: boolean
}) {
    const [frame, setFrame] = useState<VideoStatsFrame | null>(null)
    const [reading, setReading] = useState<PlaybackSample | null>(null)

    // The server's half. EventSource reconnects on its own schedule, which is the right
    // behaviour for a panel: a stats stream that dropped is not worth a sentence on screen.
    useEffect(() => {
        let source: EventSource | null = null
        try {
            source = new EventSource(videoApi.statsStreamUrl())
            source.addEventListener('message', (event: MessageEvent<string>) => {
                try {
                    setFrame(JSON.parse(event.data) as VideoStatsFrame)
                } catch {
                    // A frame that is not JSON is one frame; the next one is a second away.
                }
            })
        } catch {
            // No EventSource here: the grid still has the player's own half.
        }
        return () => {
            source?.close()
        }
    }, [])

    // The player's half.
    useEffect(() => {
        const tick = (): void => {
            setReading(sample())
        }
        tick()
        const timer = setInterval(tick, SAMPLE_MS)
        return () => {
            clearInterval(timer)
        }
    }, [sample])

    const session = sessionFor(frame, videoId)
    const verdict = streamVerdict(reading, session)
    const budget = frame?.budget ?? null
    const dropped =
        reading?.droppedFrames === null || reading?.droppedFrames === undefined
            ? '-'
            : `${String(reading.droppedFrames)} of ${String(reading.totalFrames ?? 0)}`

    return (
        <div
            className={cn(
                'absolute left-2 z-10 w-72 max-w-[calc(100%-1rem)] rounded-md border bg-card/95 p-2',
                below ? 'top-14' : 'top-2',
            )}
        >
            <div className="flex items-start gap-2">
                <p className={cn('min-w-0 flex-1 text-sm', TONE[verdict.level])}>{verdict.text}</p>
                <Button variant="ghost" size="icon-sm" aria-label="Close the stream stats" onClick={onClose}>
                    <X className="size-4" aria-hidden />
                </Button>
            </div>
            <dl className="mt-1 grid grid-cols-2 gap-x-2 font-mono text-xs">
                <Fact
                    name="buffer ahead"
                    value={reading === null ? '-' : `${reading.bufferAheadS.toFixed(1)}s`}
                />
                <Fact
                    name="transcode"
                    value={
                        session?.avg_realtime_ratio === null || session?.avg_realtime_ratio === undefined
                            ? '-'
                            : `${session.avg_realtime_ratio.toFixed(2)}x realtime`
                    }
                />
                <Fact name="encoder" value={encoderOf(session) ?? '-'} />
                <Fact name="bandwidth" value={bitrateLabel(reading?.bandwidthBps ?? null)} />
                <Fact
                    name="encoder load"
                    value={
                        budget === null
                            ? '-'
                            : `${String(budget.foreground_in_flight)}fg / ${String(budget.background_in_flight)}bg / ${String(budget.max_workers)}`
                    }
                />
                <Fact
                    name="segments"
                    value={
                        session === null
                            ? '-'
                            : `${String(session.transcodes_done)} of ${String(session.segments_total)}`
                    }
                />
                <Fact name="dropped frames" value={dropped} />
                <Fact name="other streams" value={String(otherStreams(frame, videoId))} />
            </dl>
        </div>
    )
}

function Fact({ name, value }: { name: string; value: string }) {
    return (
        <>
            <dt className="truncate text-muted-foreground">{name}</dt>
            <dd className="truncate text-right" title={value}>
                {value}
            </dd>
        </>
    )
}
