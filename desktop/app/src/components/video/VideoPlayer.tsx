// STAND-IN. The real player is being built on video.js alongside this branch; this file holds
// the interface so the screens that use it type-check, and the integrator drops it for that one.

import { type JSX } from 'react'

import { claimSound } from '@/lib/sound'

export function VideoPlayer(props: {
    src: string
    kind?: 'hls' | 'file'
    poster?: string
    subtitles?: { label: string; src: string; lang?: string }[]
    autoplay?: boolean
    onEnded?: () => void
    onError?: (message: string) => void
}): JSX.Element {
    return (
        <video
            src={props.src}
            poster={props.poster}
            autoPlay={props.autoplay}
            controls
            playsInline
            className="h-full w-full bg-black"
            onPlay={() => {
                claimSound()
            }}
            onEnded={props.onEnded}
            onError={() => props.onError?.('this video would not play')}
        >
            {props.subtitles?.map((track) => (
                <track
                    key={track.src}
                    kind="subtitles"
                    label={track.label}
                    src={track.src}
                    srcLang={track.lang}
                />
            ))}
        </video>
    )
}
