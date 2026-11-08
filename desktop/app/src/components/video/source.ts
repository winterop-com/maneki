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

/**
 * The player's element asks for its subtitles with CORS, as the server is another origin in a
 * desktop shell and a cross-origin `<track>` without it is never loaded. Set through the player's
 * `videoRef`, which runs before a track is shown and so before it is fetched.
 */
export function crossOriginVideo(element: HTMLVideoElement | null): void {
    if (element !== null) element.crossOrigin = 'anonymous'
}
