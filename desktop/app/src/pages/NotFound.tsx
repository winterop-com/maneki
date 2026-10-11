import { Link, useLocation } from 'react-router'

/**
 * An address the app has no screen for.
 *
 * IT SAYS SO RATHER THAN LANDING ON MUSIC. A mistyped or stale link opened the music screen as
 * though it had been asked for, so a broken bookmark looked like a working one; the address is
 * named and the way home is offered.
 */
export function NotFound({ home }: { home: string }) {
    const { pathname } = useLocation()
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <h1 className="text-base font-medium">Nothing here</h1>
            <p className="text-sm text-muted-foreground">
                There is no screen at <span className="font-mono">{pathname}</span>.
            </p>
            <Link
                to={home}
                className="control-link text-sm text-primary-ink underline-offset-2 hover:underline"
            >
                Go to the library
            </Link>
        </div>
    )
}
