import { useEffect, useState } from 'react'

import { video as videoApi } from '@/lib/api'
import type { VideoStatsFrame } from '@/lib/types'

/**
 * The server's half of the stream stats: one frame a second with the shared transcode pool and
 * every session on it. The stream is open only while `enabled`, as while the overlay is shown,
 * and the last frame is dropped when it closes.
 */
export function useStreamStats(enabled: boolean): VideoStatsFrame | null {
    const [frame, setFrame] = useState<VideoStatsFrame | null>(null)

    useEffect(() => {
        if (!enabled) return
        let source: EventSource | null = null
        try {
            source = new EventSource(videoApi.statsStreamUrl())
            source.addEventListener('message', (event: MessageEvent<string>) => {
                try {
                    setFrame(JSON.parse(event.data) as VideoStatsFrame)
                } catch {
                    // A frame that is not JSON is one frame; the next is a second away.
                }
            })
        } catch {
            // No EventSource here: the overlay still has the player's half.
        }
        return () => {
            source?.close()
            setFrame(null)
        }
    }, [enabled])

    return frame
}
