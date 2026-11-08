import { LevelBars } from '@winterop-com/sokkel-ui/SignInArt'
import { Cat } from 'lucide-react'

/** What the version row says for a typed address that nothing answered at. */
export const NO_ANSWER = 'no answer'

/**
 * The half of the door that says what is behind it.
 *
 * THE LOCKUP AND THE FACTS ARE ANCHORED TO THE FOOT, and the spectrum takes the room above:
 * neither the mark nor the facts move between a short pane and a tall one. Below lg the pane
 * is a strip an inch tall with the lockup on the left and the facts on the right, read before
 * the fields the way the answer to "what am I signing into" is read before a password.
 *
 * THE FACTS ARE THE ONES A DOOR CAN KNOW. The server, where one has been found or typed, and
 * the version it answered `/capabilities` with -- or that it did not answer, which a typed
 * address is asked as it is typed. A pane that has found nothing yet says so with a blank
 * rather than with a placeholder address, and a fact it does not have is not a row.
 *
 * A SHELL ALSO SAYS WHICH APP IT IS (`app`). Its copy of the client is its own and drifts from
 * the server's; a browser tab was served the server's, so it has nothing to add there.
 */
export function BrandPane({
    server,
    version,
    silent = false,
    app = null,
}: {
    server: string | null
    version: string | null
    silent?: boolean
    app?: string | null
}) {
    return (
        // Below `lg` the pane is a strip with the lockup at its left, which inside a desktop
        // shell on macOS is where the window's traffic lights are drawn -- `data-shell-lights`
        // is what the clearance rule in index.css hangs off. Above `lg` the pane's own content
        // is inset far enough to clear them on its own.
        <aside
            data-shell-lights="pane"
            data-window-drag
            className="relative flex items-center justify-between gap-4 overflow-hidden bg-terminal px-5 py-5 text-terminal-foreground lg:block lg:p-0"
        >
            {/* What a record looks like while it plays, breathing: sokkel-ui's level bars, lit in
                the pane's accent. They hold still when motion is turned down. */}
            <div className="hidden lg:absolute lg:inset-x-12 lg:top-12 lg:bottom-72 lg:flex lg:items-end xl:inset-x-18">
                <LevelBars color="var(--terminal-accent)" className="h-full w-full" />
            </div>
            <div className="relative flex items-center gap-3 lg:absolute lg:right-12 lg:bottom-36 lg:left-12 lg:gap-5 xl:right-18 xl:left-18">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-terminal-accent text-terminal lg:size-16 lg:rounded-2xl">
                    <Cat className="size-5 lg:size-9" aria-hidden />
                </span>
                <h1 className="text-base font-semibold tracking-tight lg:text-brand-name">maneki</h1>
            </div>
            <dl className="relative flex items-baseline gap-x-3 text-xs lg:absolute lg:right-12 lg:bottom-12 lg:left-12 lg:grid lg:grid-cols-[4.5rem_1fr] lg:gap-y-1.5 xl:right-18 xl:left-18">
                <dt className="sr-only text-terminal-faint lg:not-sr-only">server</dt>
                <dd className="truncate font-mono text-terminal-muted">{server ?? ''}</dd>
                {(version !== null || silent) && (
                    <>
                        <dt className="sr-only text-terminal-faint lg:not-sr-only">version</dt>
                        <dd className="font-mono text-terminal-muted">{version ?? NO_ANSWER}</dd>
                    </>
                )}
                {app !== null && (
                    <>
                        <dt className="hidden text-terminal-faint lg:block">app</dt>
                        <dd className="hidden font-mono text-terminal-muted lg:block">{app}</dd>
                    </>
                )}
            </dl>
        </aside>
    )
}
