import { cn } from '@/lib/utils'

/**
 * The shape of a list, drawn while the list is being read.
 *
 * A SENTENCE IN THE MIDDLE OF AN EMPTY SCREEN SAYS NOTHING THE WAIT DOES NOT. What somebody
 * wants to know is whether what they asked for is coming and roughly what it will be, and a
 * grey line reading "Reading the library" answers the first and not the second -- then the
 * whole screen jumps when the rows land where the sentence was. Placeholders at the shape of
 * the list answer both and the rows arrive into the space already held for them.
 *
 * TWO SHAPES, BECAUSE THIS APP DRAWS TWO KINDS OF LIST. A run of rows is a track list, an
 * artist list, a shelf of stations; a grid of cards is a wall of sleeves. Nothing else is
 * offered, so a screen cannot invent a third.
 *
 * NO COLOUR OF ITS OWN. One rung of the surface ladder and nothing else -- a placeholder is
 * ground waiting to be written on, not a thing to look at. It breathes, and it stands still
 * for somebody who asked their machine for less motion.
 */
/** How long a placeholder line is, walked down the list so it does not read as a bar chart. */
const LENGTHS = ['w-full', 'w-4/5', 'w-2/3', 'w-3/4']

export function Skeleton({ rows, kind = 'row' }: { rows: number; kind?: 'row' | 'card' }) {
    const places = Array.from({ length: rows }, (_, index) => index)
    const bar = 'animate-pulse rounded-sm bg-muted motion-reduce:animate-none'

    if (kind === 'card') {
        return (
            <div
                role="status"
                aria-label="Loading"
                className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
            >
                {places.map((place) => (
                    <div key={place} className="p-2">
                        <div className={cn(bar, 'mb-2 aspect-square w-full rounded-md')} />
                        <div className={cn(bar, 'mb-1 h-3 w-3/4')} />
                        <div className={cn(bar, 'h-3 w-1/2')} />
                    </div>
                ))}
            </div>
        )
    }

    return (
        <div role="status" aria-label="Loading">
            {places.map((place) => (
                <div key={place} className="flex min-h-finger items-center gap-3 px-3">
                    {/* The lines are not all one length, because a column of names is not. */}
                    <div className="min-w-0 flex-1">
                        <div className={cn(bar, 'h-3', LENGTHS[place % LENGTHS.length])} />
                    </div>
                    <div className={cn(bar, 'h-3 w-10 shrink-0')} />
                </div>
            ))}
        </div>
    )
}
