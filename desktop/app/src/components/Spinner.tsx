import { LoaderCircle } from 'lucide-react'

/**
 * Something is on its way: a turning ring in the middle of the space it will fill.
 *
 * A SHAPE, NOT A SENTENCE. Loading was said in words -- "Reading the shelf.", "Opening the
 * book." -- set in the same muted type as a real answer such as "No audiobooks.", so for a
 * moment it read as one. What is loading is still said, to a screen reader, as the label.
 *
 * NOT AT ONCE. Most loads finish inside a frame or two, and a ring that flashes for one of them
 * is a flicker; it fades in after a short wait, so only a load somebody actually waits for
 * shows one. A list waits on rows instead: see `Skeleton`.
 */
export function Spinner({ label }: { label: string }) {
    return (
        <div
            role="status"
            aria-label={label}
            className="flex h-full min-h-24 items-center justify-center p-8"
        >
            <LoaderCircle
                aria-hidden
                className="size-6 [animation:spin_1s_linear_infinite,spinner-in_150ms_ease-out_250ms_forwards] text-muted-foreground opacity-0 motion-reduce:[animation:spinner-in_150ms_ease-out_250ms_forwards]"
            />
        </div>
    )
}
