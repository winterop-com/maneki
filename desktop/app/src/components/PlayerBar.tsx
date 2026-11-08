import { useEffect, useState, type ComponentProps } from 'react'
import { NavLink, useLocation } from 'react-router'

import { LcdDisplay } from '@/components/LcdDisplay'
import { Spinner } from '@/components/Spinner'
import { Artwork } from '@winterop-com/sokkel-ui-media/Artwork'
import { Lyrics } from '@winterop-com/sokkel-ui-media/Lyrics'
import { MediaBar } from '@winterop-com/sokkel-ui-media/MediaBar'
import type { ParsedLyrics } from '@winterop-com/sokkel-ui-media/lrc'
import { useFramePosition } from '@winterop-com/sokkel-ui-media/use-frame-position'
import { StarButton } from '@winterop-com/sokkel-ui/StarButton'
import { SoundVisualizer } from '@winterop-com/sokkel-ui/media/SoundVisualizer'
import { useShortcutRegistry } from '@winterop-com/sokkel-ui/hooks/use-shortcuts'
import { useStore, useStoreValue } from '@winterop-com/sokkel-ui/hooks/use-store'
import { books as booksApi } from '@/lib/api'
import { nowPlayingFace } from '@/lib/lcd'
import { announced } from '@/lib/liner'
import { closeLyrics, lyricsOpen, NO_LYRICS, openLyrics, readLyrics } from '@/lib/lyrics'
import {
    bookStepCount,
    bookStops,
    currentChapter,
    currentSong,
    cycleRepeat,
    next,
    playerStore,
    positionNow,
    previous,
    retry,
    seek,
    setSpeed,
    setVolume,
    SKIP_S,
    skipBy,
    SPEEDS,
    spectrum,
    toggle,
    toggleMuted,
    toggleShuffle,
} from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { offlineStore } from '@/lib/offline'
import { soundRampFor } from '@/lib/spectrum-themes'
import { starMarks, starredNow, toggleStar } from '@/lib/star'
import { coverUrl } from '@/lib/subsonic'
import { spectrumDelayMs } from '@/lib/sync'
import { paletteStore } from '@/lib/theme'
import {
    BAR_SIZE_DEFAULT,
    barSize,
    closeStage,
    openStage,
    setBarSize,
    setVisualizerStyle,
    soundLook,
    spectrumEffect,
    spectrumReadable,
    stageOpen,
    styleForKind,
    visualizerShown,
    visualizerStyle,
} from '@/lib/visualizer'
import { barOnScreen } from '@/lib/watching'

export const RETRY_LABEL = 'Retry'
export const LYRICS_READING = 'Loading the lyrics'
export const LYRICS_NONE = 'No words for this track.'

/**
 * What is playing, along the foot of every screen: sokkel-ui-media's `MediaBar` over the player
 * store.
 *
 * Drawn only once something has been played: an empty transport under every screen is a row of
 * dead controls.
 *
 * THREE SOURCES, ONE BAR. A record steps by track and shuffles and repeats. A book steps by
 * chapter, jumps fifteen seconds either way and is read at a speed, and has no use for shuffle
 * or repeat. A station is live: nothing to scrub, skip or step to.
 *
 * The bar's own fullscreen view is the stage and the lyrics, held in `stageOpen` and
 * `lyricsOpen` so the keys and the palette open them too. It is a surface of the app's own, so
 * the shell's keys (`?`, `/`) stay quiet over it.
 */
export function PlayerBar() {
    const player = useStore(playerStore)
    const session = useStore(sessionStore)
    // A downloaded album's cover is this device's, there whether or not the server is.
    const keptAlbums = useStoreValue(offlineStore, (state) => state.albums)
    // A station on an engine that cannot hear one has no spectrum to draw: see `spectrumReadable`.
    const spectrumShown =
        useStore(visualizerShown) &&
        spectrumReadable(player.station !== null, undefined, session.phase !== 'radio')
    const style = useStore(visualizerStyle)
    const effect = useStore(spectrumEffect)
    // The ramp is the palette's, not a choice of its own: see `lib/spectrum-themes`.
    const ramp = soundRampFor(useStore(paletteStore))
    const delay = useStore(spectrumDelayMs)
    const size = useStore(barSize)
    const stage = useStore(stageOpen)
    const lyricsUp = useStore(lyricsOpen)
    const face = useStore(nowPlayingFace)
    const marks = useStore(starMarks)
    const registry = useShortcutRegistry()
    useEffect(() => {
        registry.surface('stage', stage)
        registry.surface('lyrics', lyricsUp)
        return () => {
            registry.surface('stage', false)
            registry.surface('lyrics', false)
        }
    }, [registry, stage, lyricsUp])
    // Under a picture the bar is the line or nothing: see `barOnScreen`.
    const fits = barOnScreen(useLocation().pathname, player.playing)
    // The analyser on the player's own audio graph, which `spectrum` builds once something has
    // played and answers with from then on; null before that.
    const tap = spectrumShown ? spectrum() : null

    const song = currentSong()
    const station = player.station
    const book = player.book
    const chapter = currentChapter()
    if (!song && !station && !book) return null
    // A track's cover and its stream are the music server's, so there is nothing to draw
    // without one. A book is maneki's own, and a station plays with no server too.
    if (!book && !station && !session.music) return null
    if (fits === 'none') return null

    // The sleeve is drawn at up to a few hundred pixels, so it is asked for at that size.
    const sleeve = book
        ? book.has_cover
            ? booksApi.coverUrl(book.id, 600)
            : null
        : song && session.music
          ? ((song.albumId ? keptAlbums[song.albumId]?.coverUrl : null) ??
            coverUrl(session.music, song.coverArt, 600))
          : station && session.music
            ? coverUrl(session.music, station.coverArt, 600)
            : null
    const seed = book?.id ?? song?.albumId ?? song?.id ?? station?.id ?? ''
    const duration = player.durationS || song?.duration || 0

    // The title is a way back to what it is from: the book, or the record.
    const title = book ? (
        <NavLink to={`/books/${book.id}`} className="control-link">
            {chapter?.title ?? book.title}
        </NavLink>
    ) : song?.albumId ? (
        <NavLink to={`/music/album/${song.albumId}`} className="control-link">
            {song.title}
        </NavLink>
    ) : (
        (song?.title ??
        (station && player.stationTitle ? announced(player.stationTitle, station.name) : station?.name))
    )
    // A SOURCE THAT DIED TAKES THE ARTIST'S LINE. Why it went quiet is the only thing anybody
    // wants off this bar at that moment, and it is where the eye already is.
    const refusal = player.refusal !== null && (
        <span className="inline-flex min-w-0 items-baseline gap-2">
            <span className="truncate text-critical-ink" title={player.refusal}>
                {player.refusal}
            </span>
            {/* Beside the sentence it answers: a refusal is most often the network, and the
                same source asked again usually plays. */}
            <button
                type="button"
                onClick={retry}
                className="control-link shrink-0 text-primary-ink underline-offset-2 hover:underline"
            >
                {RETRY_LABEL}
            </button>
        </span>
    )
    const artist = book
        ? book.author
        : station
          ? player.stationTitle
              ? station.name
              : undefined
          : (song?.artist ?? undefined)
    const album = book ? (chapter ? book.title : undefined) : (song?.album ?? undefined)
    // A book with nowhere to step to offers no step; see `bookStepCount`.
    const bookSteps = book !== null && bookStepCount(book) >= 2
    // THE DECK FACE IS A MUSIC FACE: a chapter of a novel is not a track, an artist and a number.
    const deck = face === 'lcd' && !book
    const fullscreen = stage || lyricsUp
    // The bar's backdrop is the plain bars; the chosen drawing and its effect are the stage's.
    const look = fullscreen ? soundLook(style) : soundLook('spectrum')
    const starred = song !== null && starredNow(marks, song)

    return (
        <MediaBar
            title={title}
            artist={refusal || artist}
            subtitle={refusal || undefined}
            album={refusal ? undefined : album}
            year={song?.year}
            trackNumber={song && player.queue.length > 1 ? player.index + 1 : undefined}
            trackCount={song && player.queue.length > 1 ? player.queue.length : undefined}
            artwork={sleeve ? <Artwork src={sleeve} seed={seed} /> : undefined}
            placeholderSeed={seed}
            playing={player.playing}
            onPlayingChange={(wanted) => {
                if (wanted !== player.playing) toggle()
            }}
            // `lib/player` claims the sound for its element through `lib/sound`, which the video
            // player shares; a second claim here would be a second arbiter.
            exclusive={false}
            position={player.positionS}
            // The element's clock read every frame, so the scrubber glides rather than steps.
            getPosition={positionNow}
            duration={duration}
            onSeek={seek}
            live={station !== null}
            chapters={book && bookSteps ? bookStops(book) : undefined}
            onPrevious={station || (book && !bookSteps) ? undefined : previous}
            onNext={station || (book && !bookSteps) ? undefined : next}
            skip={book ? SKIP_S : undefined}
            onSkip={book ? skipBy : undefined}
            rate={book?.speed ?? 1}
            rates={SPEEDS}
            onRateChange={book ? setSpeed : undefined}
            visualizer={
                spectrumShown && tap !== null ? (
                    <SoundVisualizer
                        source={tap}
                        playing={player.playing}
                        kind={look.kind}
                        align={look.align}
                        ramp={ramp}
                        color={ramp === undefined ? 'primary' : undefined}
                        effect={fullscreen ? effect : 'none'}
                        delay="auto"
                        delayOffset={delay}
                        label="Spectrum"
                    />
                ) : undefined
            }
            visualizerKind={soundLook(style).kind}
            onVisualizerKindChange={(kind) => {
                setVisualizerStyle(styleForKind(kind, style))
            }}
            volume={player.volume}
            onVolumeChange={setVolume}
            muted={player.muted}
            onMutedChange={toggleMuted}
            shuffle={player.shuffle}
            onShuffleChange={song ? toggleShuffle : undefined}
            repeat={player.repeat}
            onRepeatChange={
                song
                    ? () => {
                          cycleRepeat()
                      }
                    : undefined
            }
            face={
                deck ? (
                    <LcdFace
                        song={song}
                        station={station}
                        stationTitle={player.stationTitle}
                        positionS={player.positionS}
                        durationS={duration}
                        playing={player.playing}
                        muted={player.muted}
                        volume={player.volume}
                    />
                ) : undefined
            }
            fullscreenActions={
                song && session.music ? (
                    <StarButton
                        starred={starred}
                        onStarredChange={() => {
                            toggleStar(session.music ?? undefined, song)
                        }}
                        words={{ star: 'Star this track', unstar: 'Unstar this track' }}
                    />
                ) : undefined
            }
            // Under a picture the bar is its one line: the bar holds no less than that.
            size={fits === 'strip' ? 0 : size}
            onSizeChange={setBarSize}
            resizable={fits === 'full'}
            defaultSize={BAR_SIZE_DEFAULT}
            fullscreen={fullscreen}
            onFullscreenChange={(open) => {
                if (open) {
                    openStage()
                    return
                }
                closeStage()
                closeLyrics()
            }}
            lyrics={song ? <PlayerLyrics /> : undefined}
            lyricsShown={lyricsUp}
            onLyricsShownChange={(shown) => {
                if (shown) {
                    openLyrics()
                    return
                }
                // Hiding the words leaves the view up, on the spectrum.
                openStage()
                closeLyrics()
            }}
        />
    )
}

/** The deck's readout, its elapsed time read off the element every frame as the scrubber's is. */
function LcdFace({ positionS, playing, ...rest }: ComponentProps<typeof LcdDisplay>) {
    const position = useFramePosition(positionS, positionNow, playing)
    return <LcdDisplay {...rest} positionS={position} playing={playing} />
}

const selectSongId = (state: { queue: { id: string }[]; index: number; book: unknown }) =>
    state.book === null ? (state.queue[state.index]?.id ?? null) : null
const selectPositionS = (state: { positionS: number }) => state.positionS

/**
 * The words of the track playing, for the fullscreen view. Mounted only while they are shown,
 * and asked for again on every change of track: what is on screen while that is in flight is
 * the sentence saying so, rather than the previous song's chorus.
 */
function PlayerLyrics() {
    const credentials = useStore(sessionStore).music
    const songId = useStoreValue(playerStore, selectSongId)
    const positionS = useStoreValue(playerStore, selectPositionS)
    const [answer, setAnswer] = useState<{ songId: string; words: ParsedLyrics } | null>(null)

    useEffect(() => {
        if (!credentials || songId === null) return
        const asked = currentSong()
        if (asked === null) return
        readLyrics(credentials, asked)
            .then((found) => setAnswer({ songId: asked.id, words: found }))
            .catch(() => setAnswer({ songId: asked.id, words: NO_LYRICS }))
    }, [credentials, songId])

    const words = answer !== null && answer.songId === songId ? answer.words : null
    if (words === null) return <Spinner label={LYRICS_READING} />
    return <Lyrics lyrics={words} position={positionS} onSeek={seek} words={{ none: LYRICS_NONE }} />
}
