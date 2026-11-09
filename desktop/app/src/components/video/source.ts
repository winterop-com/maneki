import type { VideoSource } from '@winterop-com/sokkel-ui/media/VideoPlayer'
import { hlsSource } from '@winterop-com/sokkel-ui-media/hls-source'

import { playsHlsItself } from '@/lib/video'

/**
 * What the server's playlists play through, on every screen that plays one: sokkel-ui's
 * `hlsSource`, native on Apple WebKit and hls.js everywhere else (see `playsHlsItself`).
 */

/** Read once: the engine does not change. */
const NATIVE = typeof navigator !== 'undefined' && playsHlsItself(navigator.userAgent)

export function videoSource(url: string): VideoSource {
    return hlsSource(url, { native: NATIVE })
}
