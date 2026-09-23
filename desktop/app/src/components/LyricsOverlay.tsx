import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useOverlay } from '@/hooks/use-overlay'
import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { useStore, useStoreValue } from '@/hooks/use-store'
import { closeLyrics, lineAt, lyricsOpen, NO_LYRICS, readLyrics, type Lyrics } from '@/lib/lyrics'
import { currentSong, playerStore } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { cn } from '@/lib/utils'

export const LEAVE_LYRICS_LABEL = 'Close the words'
export const LYRICS_READING = 'Reading the words.'
export const LYRICS_NONE = 'No words for this track.'
export const LYRICS_NOTHING_PLAYING = 'Nothing is playing.'

/** The two facts this overlay reads off the player. Module scope, so each is one stable function. */
const selectSongId = (state: { queue: { id: string }[]; index: number }) =>
    state.queue[state.index]?.id ?? null
const selectPositionS = (state: { positionS: number }) => state.positionS

/**
 * The words of what is playing, over everything.
 *
 * FULL SCREEN, LIKE THE SPECTRUM, and for the same reason: this is put up and looked at rather
 * than glanced at beside something else. Escape leaves and so does the control in the corner,
 * because a screen with no obvious way out is a screen somebody reloads the tab to escape.
 *
 * TIMED WORDS FOLLOW THE TRACK AND UNTIMED ONES ARE A PAGE. Where the file carried markers the
 * line being sung is lit and kept in the middle of the screen, so reading along needs no hands;
 * where it did not, the same words are a column to read, and nothing pretends to know where in
 * them the track is.
 *
 * THE READ FOLLOWS THE TRACK, not the opening. A queue moves on while this is up, so the words
 * are asked for again on every change of track -- and what is on screen while that is in flight
 * is the sentence saying so, rather than the previous song's chorus.
 *
 * ONE FACT EACH OFF THE PLAYER. The position publishes four times a second, which is what the
 * highlight needs and what nothing else here does, so it is read on its own rather than by
 * subscribing this component to the whole store.
 */
export function LyricsOverlay() {
    const open = useStore(lyricsOpen)
    // NOTHING READS THE PLAYER UNTIL THE WORDS ARE UP. The position publishes four times a
    // second, and a component subscribed to it to render nothing is the cost this app moved to
    // `useStoreValue` to stop paying. The subscriptions are the inner component's, so they
    // exist for exactly as long as it is on screen.
    if (!open) return null
    return <Words />
}

function Words() {
    const session = useStore(sessionStore)
    const songId = useStoreValue(playerStore, selectSongId)
    const positionS = useStoreValue(playerStore, selectPositionS)
    const still = usePrefersReducedMotion()
    const [answer, setAnswer] = useState<{ songId: string; words: Lyrics } | null>(null)
    const active = useRef<HTMLParagraphElement | null>(null)
    const page = useRef<HTMLDivElement | null>(null)
    const song = currentSong()
    const credentials = session.music

    // Escape leaves, the shell behind it is inert while this stands, and the control that
    // opened it gets the focus back. See `hooks/use-overlay`: the stage is the same dialog.
    useOverlay(page, closeLyrics)

    // WHICH TRACK THE WORDS ARE FOR IS CARRIED ON THEM, and read during render: a queue moves
    // on while this is up, and the previous song's chorus under the new song's title is worse
    // than the sentence saying the words are being read.
    const words = answer !== null && answer.songId === songId ? answer.words : null

    // Asked for when this goes up, and again on every change of track. The track is read inside
    // the effect rather than depended on: the player rebuilds its state four times a second and
    // the id is the only part of it that decides whether these are the same words.
    useEffect(() => {
        if (!credentials || songId === null) return
        const asked = currentSong()
        if (asked === null) return
        readLyrics(credentials, asked)
            .then((found) => {
                setAnswer({ songId: asked.id, words: found })
            })
            .catch(() => {
                setAnswer({ songId: asked.id, words: NO_LYRICS })
            })
    }, [credentials, songId])

    const at = words?.synced === true ? lineAt(words.lines, positionS) : -1

    // The line being sung is kept in the middle of the screen: following along is what this is
    // for, and a highlight below the fold is one nobody can read.
    useEffect(() => {
        if (at < 0) return
        active.current?.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
    }, [at, still])

    return (
        <div
            ref={page}
            data-lyrics
            tabIndex={-1}
            className="fixed inset-0 z-50 flex flex-col bg-background outline-none"
            role="dialog"
            aria-label="Lyrics"
            aria-modal="true"
        >
            <div className="flex h-shell-top shrink-0 items-center gap-3 px-4">
                <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium">{song?.title ?? ''}</p>
                    <p className="truncate text-sm text-muted-foreground">{song?.artist ?? ''}</p>
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={LEAVE_LYRICS_LABEL}
                    onClick={closeLyrics}
                    className="text-muted-foreground"
                >
                    <X className="size-5" aria-hidden />
                </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-[30vh]">
                <Body words={words} song={song} active={active} at={at} />
            </div>
        </div>
    )
}

/** The words themselves, or the one sentence saying why there are none on screen. */
function Body({
    words,
    song,
    active,
    at,
}: {
    words: Lyrics | null
    song: { title: string } | null
    active: React.RefObject<HTMLParagraphElement | null>
    at: number
}) {
    if (song === null) return <Notice>{LYRICS_NOTHING_PLAYING}</Notice>
    if (words === null) return <Notice>{LYRICS_READING}</Notice>
    if (words.lines.length === 0) return <Notice>{LYRICS_NONE}</Notice>

    return (
        <div className="mx-auto max-w-2xl">
            {words.lines.map((line, index) => (
                <p
                    // The words are the row: two lines of a chorus are the same string, and an
                    // index is what tells the first from the second.
                    key={`${String(index)}:${line.text}`}
                    ref={index === at ? active : null}
                    className={cn(
                        'py-1 text-lg leading-relaxed transition-colors md:text-xl',
                        words.synced && index !== at && 'text-muted-foreground',
                        words.synced && index === at && 'font-semibold text-foreground',
                        !words.synced && 'text-foreground',
                    )}
                >
                    {line.text === '' ? ' ' : line.text}
                </p>
            ))}
        </div>
    )
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">{children}</p>
        </div>
    )
}
