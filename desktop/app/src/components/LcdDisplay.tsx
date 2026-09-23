import { useEffect, useState } from 'react'

import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { useSmallScreen } from '@/hooks/use-small-screen'
import { useStore } from '@/hooks/use-store'
import {
    LCD_WIDTH,
    lcdClock,
    lcdLine,
    lcdTint,
    marqueeAt,
    marqueeSteps,
    MARQUEE_MS,
    trackCell,
} from '@/lib/lcd'
import type { Song, Station } from '@/lib/subsonic'

/** A blank cell still has to hold its width, so a space is drawn as one that will not collapse. */
const NO_BREAK = '\u00a0'

/**
 * How many cells the window has on a phone.
 *
 * A HOOK RATHER THAN A CLASS, because these are two different displays and not one hidden
 * twice: the number of cells decides what the travel does, so a window sized by CSS would be
 * twenty-two cells of glyphs overflowing a 390px bar while the arithmetic thought they fitted.
 */
const NARROW_WIDTH = 11

/**
 * The front panel of a hi-fi, in the middle of the player bar.
 *
 * `lib/lcd` decides what the window holds; this holds the timer and the spans. The split is the
 * usual one, and here it is what makes a marquee testable at all: which characters are on the
 * glass at step 14 of a given title is arithmetic, and only the fact that the step advances
 * every 320ms needs a browser.
 *
 * WHAT IT SAYS IS WHAT THE STANDARD FACE SAYS, READ LIKE A DECK. The title and the artist
 * travel across the window; the pills say which mode the transport is in; the clocks are elapsed
 * and remaining rather than elapsed and total, because remaining is the question somebody looks
 * at a deck to answer. The readouts along the end are the facts a panel has room for and a
 * one-line strip does not: which track, what year, what the file is, how loud.
 *
 * THE GLYPHS ARE HIDDEN FROM A SCREEN READER AND THE SENTENCE IS NOT. A window of characters
 * mid-travel is read aloud as the fragment it is, so what is announced is the plain title and
 * artist, once, in the order a person would say them.
 *
 * IT STANDS STILL FOR SOMEBODY WHO ASKED FOR THAT. Motion here carries no information that the
 * `title` on the element does not also carry, so under reduced motion the line does not travel:
 * it sits at its beginning, and the whole string is on hover.
 */
export function LcdDisplay({
    song,
    station,
    stationTitle,
    positionS,
    durationS,
    playing,
    muted,
    volume,
}: {
    song: Song | null
    station: Station | null
    stationTitle: string
    positionS: number
    durationS: number
    playing: boolean
    muted: boolean
    volume: number
}) {
    const tint = useStore(lcdTint)
    const still = usePrefersReducedMotion()
    const small = useSmallScreen()
    const width = small ? NARROW_WIDTH : LCD_WIDTH

    // A station announces what it is playing where the artist would be, and says it is live
    // until it announces anything -- the same two facts the standard face draws.
    const spoken = station
        ? lcdLine([station.name, stationTitle || 'Live'])
        : lcdLine([song?.title, song?.artist, song?.album])
    const line = spoken === '' ? 'NO DISC' : spoken
    const total = station ? null : durationS || song?.duration || 0
    const left = total === null ? null : Math.max(0, total - positionS)
    const format = (song?.suffix ?? '').toUpperCase() || (station ? 'STRM' : '---')

    return (
        <div className="mk-lcd min-w-0 flex-1" data-tint={tint} role="group" aria-label="Now playing">
            {/* The glass clips: a window is a window, and cells that ran past its edge would be
                a display spilling glyphs over the transport beside it. */}
            <div className="mk-lcd-glass flex min-w-0 items-center gap-3 overflow-hidden px-2 py-1">
                <div className="min-w-0">
                    <span className="sr-only">{spoken === '' ? 'Nothing playing' : spoken}</span>
                    <div className="mk-lcd-line" title={line}>
                        {/* Keyed by the line, which is how a new title opens at its beginning:
                            React throws the travel away with the component rather than an
                            effect painting the last title's position for one frame first. */}
                        <Marquee key={line} line={line} width={width} running={playing && !still} />
                    </div>
                    <div className="mt-1 hidden items-center gap-2 sm:flex">
                        <Pill on={playing}>PLAY</Pill>
                        <Pill on={station !== null}>RADIO</Pill>
                        <Pill on={!muted}>STEREO</Pill>
                        <Pill on={muted}>MUTE</Pill>
                    </div>
                </div>

                <div className="ml-auto hidden shrink-0 items-end gap-3 sm:flex">
                    <Readout label="ELAPSED" value={lcdClock(positionS)} />
                    <Readout label="REMAIN" value={lcdClock(left)} />
                    <div className="hidden items-end gap-3 lg:flex">
                        <Readout label="TR" value={trackCell(song?.track, station !== null)} />
                        <Readout label="YR" value={song?.year === undefined ? '----' : String(song.year)} />
                        <Readout label="FMT" value={format} />
                        <Readout
                            label="VOL"
                            value={String(Math.round((muted ? 0 : volume) * 100)).padStart(3, '0')}
                        />
                    </div>
                </div>
            </div>
        </div>
    )
}

/**
 * The title, walking across its window.
 *
 * It is a component of its own so that its one piece of state can be thrown away with it: the
 * parent keys it by the line, which is what makes a new title start at its beginning without an
 * effect reaching in to reset a step count.
 */
function Marquee({ line, width, running }: { line: string; width: number; running: boolean }) {
    const [at, setAt] = useState(0)
    const steps = marqueeSteps(line, width)

    useEffect(() => {
        // A line that fits has nowhere to go, and a stopped deck holds what it was showing.
        if (!running || steps === 0) return
        const timer = setInterval(() => {
            setAt((step) => (step + 1) % steps)
        }, MARQUEE_MS)
        return () => {
            clearInterval(timer)
        }
    }, [running, steps])

    return <Cells text={marqueeAt(line, at, width)} />
}

/**
 * One string as cells.
 *
 * A cell is keyed by where it stands, because that is what a cell is: the third cell of the
 * window stays the third cell whatever character travels through it, and keying by the character
 * would rebuild the row every step for a display whose cells never move.
 */
function Cells({ text }: { text: string }) {
    const cells = [...text].map((character, index) => ({ at: index, character }))
    return (
        <span className="inline-flex gap-px" aria-hidden>
            {cells.map((cell) => (
                <span key={cell.at} className="mk-lcd-cell">
                    <span className="mk-lcd-ghost">8</span>
                    <span className="relative">{cell.character === ' ' ? NO_BREAK : cell.character}</span>
                </span>
            ))}
        </span>
    )
}

/** A mode indicator, lit or unlit. There is no third state and no colour of its own. */
function Pill({ on, children }: { on: boolean; children: string }) {
    return (
        <span className="mk-lcd-pill" data-on={on} aria-hidden>
            {children}
        </span>
    )
}

/** One labelled readout: the caps label a panel silk-screens, and the cells under it. */
function Readout({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="mk-lcd-label" aria-hidden>
                {label}
            </span>
            <span className="mk-lcd-value">
                <Cells text={value} />
            </span>
        </div>
    )
}
