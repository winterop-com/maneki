import { CircleCheck, Download, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'

import { CoverArt } from '@/components/CoverArt'
import { Button } from '@/components/ui/button'
import { useStore } from '@/hooks/use-store'
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

/**
 * Keep an album on this device, watch it arrive, or let it go: one control in the album's header.
 */
export function DownloadButton({ credentials, albumId }: { credentials: Credentials; albumId: string }) {
    const offline = useStore(offlineStore)
    const [armed, press] = useConfirm()
    const progress = offline.downloading[albumId]
    const kept = offline.albums[albumId]

    if (progress) {
        const label =
            progress.total > 0 ? `${String(progress.done)} of ${String(progress.total)}` : 'Starting'
        return (
            <Button
                variant="ghost"
                size="sm"
                aria-label={`Downloading, ${label}. Cancel`}
                title="Cancel the download"
                onClick={() => cancelDownload(albumId)}
            >
                <X aria-hidden />
                <span className="font-mono text-xs tabular-nums">{label}</span>
            </Button>
        )
    }
    if (kept) {
        return (
            <Button
                variant="ghost"
                size="sm"
                aria-label={
                    armed ? 'Press again to remove this download' : 'Downloaded. Remove from this device'
                }
                title={
                    armed ? 'Press again to remove' : `On this device (${byteSize(kept.bytes)}). Remove it`
                }
                onClick={() => {
                    if (press()) void removeAlbum(credentials, albumId)
                }}
                className={cn(armed ? 'text-critical-ink' : 'text-primary')}
            >
                <CircleCheck aria-hidden />
                <span className="hidden sm:inline">{armed ? 'Remove?' : 'Downloaded'}</span>
            </Button>
        )
    }
    return (
        <Button
            variant="ghost"
            size="sm"
            aria-label="Download this album to this device"
            title={offline.failed[albumId] ?? 'Keep this album on this device, to play without the server'}
            onClick={() => {
                downloadAlbum(credentials, albumId).catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : 'The download failed.')
                })
            }}
        >
            <Download aria-hidden />
            <span className="hidden sm:inline">Download</span>
        </Button>
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
