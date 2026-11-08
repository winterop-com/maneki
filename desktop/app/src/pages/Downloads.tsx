import { DownloadButton as SokkelDownloadButton } from '@winterop-com/sokkel-ui/DownloadButton'
import { useStore } from '@winterop-com/sokkel-ui/hooks/use-store'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'

import { CoverArt } from '@/components/CoverArt'
import { Button } from '@/components/ui/button'
import { byteSize } from '@/lib/format'
import {
    cancelDownload,
    downloadAlbum,
    offlineBytes,
    offlineStore,
    removeAlbum,
    removeAllAlbums,
} from '@/lib/offline'
import type { Credentials } from '@/lib/subsonic'
import { cn } from '@/lib/utils'

/** How long a second press has to confirm a removal before the button goes back. */
const CONFIRM_MS = 3000

/**
 * A press that removes something kept asks once more first: a download is minutes on a slow line,
 * and one stray click should not cost it. The second press within a few seconds is the yes.
 */
function useConfirm(): [boolean, () => boolean] {
    const [armed, setArmed] = useState(false)
    useEffect(() => {
        if (!armed) return
        const timer = setTimeout(() => setArmed(false), CONFIRM_MS)
        return () => clearTimeout(timer)
    }, [armed])
    const press = (): boolean => {
        if (armed) {
            setArmed(false)
            return true
        }
        setArmed(true)
        return false
    }
    return [armed, press]
}

/** What the album's download control says, where the library's words are not this app's. */
const DOWNLOAD_WORDS = {
    running: 'Starting',
    kept: 'Downloaded',
    removeLabel: 'Downloaded. Remove from this device',
}

/**
 * Keep an album on this device, watch it arrive, or let it go: one control in the album's header.
 * The control is sokkel-ui's; what it is wired to (the offline store, the album) is this app's.
 */
export function AlbumDownloadButton({ credentials, albumId }: { credentials: Credentials; albumId: string }) {
    const offline = useStore(offlineStore)
    const progress = offline.downloading[albumId]
    const kept = offline.albums[albumId]
    const state = progress ? 'running' : kept ? 'kept' : 'idle'

    return (
        <SokkelDownloadButton
            state={state}
            variant="ghost"
            size="sm"
            compact="narrow"
            count={progress && progress.total > 0 ? progress.done : undefined}
            total={progress && progress.total > 0 ? progress.total : undefined}
            keptDetail={kept ? `On this device (${byteSize(kept.bytes)}). Remove it` : undefined}
            error={offline.failed[albumId]}
            words={DOWNLOAD_WORDS}
            onDownload={() => {
                downloadAlbum(credentials, albumId).catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : 'The download failed.')
                })
            }}
            onCancel={() => cancelDownload(albumId)}
            onRemove={() => void removeAlbum(credentials, albumId)}
        />
    )
}

/**
 * The albums kept on this device.
 *
 * Reached from the rail, and drawn in place of the artists when the server is not answering, so
 * what can still be played is where somebody looks first.
 */
export function Downloads({
    credentials,
    serverGone = false,
}: {
    credentials: Credentials
    serverGone?: boolean
}) {
    const offline = useStore(offlineStore)
    const navigate = useNavigate()
    const [armed, press] = useConfirm()
    const kept = Object.values(offline.albums).toSorted(
        (left, right) =>
            left.album.artist.localeCompare(right.album.artist, undefined, { sensitivity: 'base' }) ||
            left.album.name.localeCompare(right.album.name, undefined, { sensitivity: 'base' }),
    )
    const total = offlineBytes(offline)

    return (
        <div className="px-4 pt-6 pb-10 sm:px-8">
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight">Downloads</h1>
                    <p className="text-sm text-muted-foreground">
                        {kept.length} {kept.length === 1 ? 'album' : 'albums'} · {byteSize(total)} on this
                        device
                    </p>
                    {serverGone && (
                        <p className="mt-1 text-sm text-muted-foreground">
                            The server is not answering. These albums play from this device.
                        </p>
                    )}
                </div>
                {kept.length > 0 && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            if (press()) void removeAllAlbums(credentials)
                        }}
                        className={cn(armed && 'text-critical-ink')}
                    >
                        {armed ? 'Press again to remove all' : 'Remove all'}
                    </Button>
                )}
            </div>
            {kept.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    Nothing downloaded yet. Open an album and press Download to keep it on this device.
                </p>
            ) : (
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-5 gap-y-6">
                    {kept.map((entry) => (
                        <li key={entry.album.id}>
                            <button
                                type="button"
                                onClick={() => navigate(`/music/album/${entry.album.id}`)}
                                className="group flex w-full min-w-0 flex-col gap-2.5 rounded-lg text-left focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                            >
                                {entry.coverUrl === null ? (
                                    <CoverArt
                                        id={entry.album.id}
                                        className="aspect-square w-full rounded-lg"
                                    />
                                ) : (
                                    <img
                                        src={entry.coverUrl}
                                        alt=""
                                        className="aspect-square w-full rounded-lg bg-secondary object-cover"
                                    />
                                )}
                                <span className="min-w-0">
                                    <span className="block truncate text-sm font-medium">
                                        {entry.album.name}
                                    </span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {entry.album.artist} · {byteSize(entry.bytes)}
                                    </span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
