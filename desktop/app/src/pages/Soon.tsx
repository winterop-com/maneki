/**
 * A section that has not moved onto this app yet.
 *
 * The screens are ported one at a time; until a section arrives here, the
 * one in the current app is what serves it, and this page says so rather
 * than drawing an empty library.
 */
export function Soon({ section }: { section: string }) {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">{section} has not moved to this app yet.</p>
        </div>
    )
}
