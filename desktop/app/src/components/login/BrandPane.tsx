import { Cat } from 'lucide-react'

/**
 * The bars the pane draws above the lockup: a spectrum stood still.
 *
 * THE ONE DECORATIVE ELEMENT IN THE APP, and it is the thing the app is for: what a record
 * looks like while it plays, as the pane behind the sign-in draws it the moment it is
 * playing. The heights are a fixed ridge rather than a random one so the door looks the same
 * every time it is opened, and one run through the ridge is lit in the accent, the way the
 * pane's own spectrum lights the band the sound is in.
 */
const BAR_COUNT = 56

/** Heights in the unit the drawing is laid out in: a ridge, tallest left of centre. */
export function brandBars(count: number): number[] {
    return Array.from({ length: count }, (_, index) => {
        const at = index / (count - 1)
        // Two humps, the first higher: a shape a mix has, not a bell.
        const first = Math.exp(-(((at - 0.32) / 0.2) ** 2))
        const second = 0.55 * Math.exp(-(((at - 0.74) / 0.14) ** 2))
        // A slow ripple so neighbouring bars are not a smooth curve.
        const ripple = 0.08 * Math.sin(index * 1.7)
        return Math.max(0.06, Math.min(1, first + second + ripple + 0.04))
    })
}

/** Which bars are lit: the run at the top of the first hump. */
function lit(index: number, count: number): boolean {
    const at = index / (count - 1)
    return at >= 0.24 && at <= 0.4
}

/**
 * The half of the door that says what is behind it.
 *
 * THE LOCKUP AND THE FACTS ARE ANCHORED TO THE FOOT, and the spectrum takes the room above:
 * neither the mark nor the facts move between a short pane and a tall one. Below lg the pane
 * is a strip an inch tall with the lockup on the left and the facts on the right, read before
 * the fields the way the answer to "what am I signing into" is read before a password.
 *
 * THE FACTS ARE THE ONES A DOOR CAN KNOW. The server, where one has been found or typed, and
 * the version it answered `/capabilities` with. A pane that has found nothing yet says so with
 * a blank rather than with a placeholder address.
 */
export function BrandPane({ server, version }: { server: string | null; version: string | null }) {
    // Laid out once: each bar is keyed by where it stands, which is what tells them apart.
    const bars = brandBars(BAR_COUNT).map((height, index) => ({
        x: index * 10 + 2,
        height,
        lit: lit(index, BAR_COUNT),
    }))
    return (
        // Below `lg` the pane is a strip with the lockup at its left, which inside a desktop
        // shell on macOS is where the window's traffic lights are drawn -- `data-shell-lights`
        // is what the clearance rule in index.css hangs off. Above `lg` the pane's own content
        // is inset far enough to clear them on its own.
        <aside
            data-shell-lights="pane"
            className="relative flex items-center justify-between gap-4 overflow-hidden bg-terminal px-5 py-5 text-terminal-foreground lg:block lg:p-0"
        >
            <div className="hidden lg:absolute lg:inset-x-12 lg:top-12 lg:bottom-72 lg:flex lg:items-end xl:inset-x-18">
                <svg
                    className="h-full w-full"
                    viewBox={`0 0 ${String(BAR_COUNT * 10)} 100`}
                    preserveAspectRatio="none"
                    aria-hidden
                >
                    {bars.map((bar) => (
                        <rect
                            key={bar.x}
                            x={bar.x}
                            y={100 - bar.height * 100}
                            width={6}
                            height={bar.height * 100}
                            className={bar.lit ? 'fill-terminal-accent' : 'fill-terminal-bar'}
                        />
                    ))}
                </svg>
            </div>
            <div className="relative flex items-center gap-3 lg:absolute lg:right-12 lg:bottom-30 lg:left-12 lg:gap-5 xl:right-18 xl:left-18">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-terminal-accent text-terminal lg:size-16 lg:rounded-2xl">
                    <Cat className="size-5 lg:size-9" aria-hidden />
                </span>
                <h1 className="text-base font-semibold tracking-tight lg:text-wordmark">maneki</h1>
            </div>
            <dl className="relative flex items-baseline gap-x-3 text-xs lg:absolute lg:right-12 lg:bottom-12 lg:left-12 lg:grid lg:grid-cols-[4.5rem_1fr] lg:gap-y-1.5 xl:right-18 xl:left-18">
                <dt className="sr-only text-terminal-faint lg:not-sr-only">server</dt>
                <dd className="truncate font-mono text-terminal-muted">{server ?? ''}</dd>
                <dt className="sr-only text-terminal-faint lg:not-sr-only">version</dt>
                <dd className="font-mono text-terminal-muted">{version ?? ''}</dd>
            </dl>
        </aside>
    )
}
