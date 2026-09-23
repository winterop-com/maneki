import { WifiOff, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useStore } from '@/hooks/use-store'
import { connectionStore, dismissRefusal } from '@/lib/connection'
import { connect, sessionStore } from '@/lib/session'

export const DISMISS_LABEL = 'Dismiss'

/**
 * One line across the top of the work when the server has stopped answering.
 *
 * IT IS THE SHELL'S, BECAUSE THE FACT IS THE APP'S. A screen's own refusal goes where that
 * screen's content would be -- an album that will not load says so in the album's place. A
 * server that is not there is about to break every screen the same way, so it is said once,
 * above all of them, instead of each screen reporting its own mystery.
 *
 * IT DOES NOT COVER ANYTHING. It is a row in the content column's own flow, under the top strip
 * and above the work, so the screen moves down by its height rather than losing its first line
 * under a floating bar. Nothing is dismissed and nothing is unmounted: what was already read
 * stays on screen, because a server going quiet does not make what it already said untrue.
 *
 * TWO VERBS, AND THEY ARE DIFFERENT THINGS. Retry asks the server again, which is the whole of
 * what `connect` does; Dismiss takes the line away without claiming anything, for somebody who
 * knows their server is off and does not need a bar about it all evening. The next request that
 * fails the same way raises it again.
 */
export function ConnectionBanner() {
    const connection = useStore(connectionStore)
    const session = useStore(sessionStore)
    if (!connection.down) return null

    return (
        <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-critical/35 bg-critical/12 px-3 py-1.5 text-critical-ink"
        >
            <WifiOff className="size-4 shrink-0" aria-hidden />
            {/* The address is what tells somebody which server went quiet, and on a phone it is
                the first thing off the row: the sentence is the news, the host is the detail. */}
            <p className="min-w-0 flex-1 truncate text-sm">
                No answer from{' '}
                <span className="font-mono">{session.baseUrl === '' ? 'this server' : session.baseUrl}</span>.
            </p>
            <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => {
                    void connect()
                }}
            >
                Retry
            </Button>
            <Button
                variant="ghost"
                size="icon-sm"
                aria-label={DISMISS_LABEL}
                className="shrink-0"
                onClick={dismissRefusal}
            >
                <X className="size-4" aria-hidden />
            </Button>
        </div>
    )
}
