import { ListMusic, Plus } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import { Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { setDialogOpen } from '@/lib/dialogs'
import { trackCount } from '@/lib/format'
import {
    createPlaylist,
    getPlaylists,
    updatePlaylist,
    type Credentials,
    type Playlist,
    type Song,
} from '@/lib/subsonic'

/**
 * Hold the playlist flag in `lib/dialogs` while one of these is standing.
 *
 * Only a dialog that is open writes it, and only that one takes it down again: a screen with a
 * rename and a delete mounted side by side must not have the closed one answer for the open one.
 */
function useStanding(open: boolean): void {
    useEffect(() => {
        if (!open) return
        setDialogOpen('playlist', true)
        return () => {
            setDialogOpen('playlist', false)
        }
    }, [open])
}

/** What is being put on a playlist, and the line that says so under the dialog's title. */
export interface Adding {
    songs: readonly Song[]
    /** "Kid A, 10 tracks", or the one track's title. */
    what: string
}

/**
 * Put some tracks on a playlist: one of the ones there are, or a new one named here.
 *
 * ONE LIST AND ONE FIELD. The playlists this account has are rows, and choosing one is the
 * whole gesture; under them is a name and a Create, which makes the playlist with these tracks
 * already on it. There is no second step, and the dialog closes on the answer.
 *
 * THE BODY IS MOUNTED PER OPENING, so what it read and what was typed belong to this opening:
 * the list is asked for again each time, because a playlist made on the phone since is one
 * somebody expects to find here.
 */
export function AddToPlaylistDialog({
    credentials,
    adding,
    onClose,
}: {
    credentials: Credentials
    adding: Adding | null
    onClose: () => void
}) {
    const open = adding !== null
    useStanding(open)
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose()
            }}
        >
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Add to a playlist</DialogTitle>
                    <DialogDescription>{adding?.what ?? ''}</DialogDescription>
                </DialogHeader>
                {adding && <Chooser credentials={credentials} adding={adding} onDone={onClose} />}
            </DialogContent>
        </Dialog>
    )
}

function Chooser({
    credentials,
    adding,
    onDone,
}: {
    credentials: Credentials
    adding: Adding
    onDone: () => void
}) {
    const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
    const [name, setName] = useState('')
    const [busy, setBusy] = useState(false)
    const [refusal, setRefusal] = useState<string | null>(null)
    const ids = adding.songs.map((song) => song.id)

    useEffect(() => {
        let live = true
        getPlaylists(credentials).then(
            (answer) => {
                if (live) setPlaylists(answer)
            },
            (error: Error) => {
                if (live) {
                    setPlaylists([])
                    setRefusal(error.message)
                }
            },
        )
        return () => {
            live = false
        }
    }, [credentials])

    const addTo = (playlist: Playlist) => {
        setBusy(true)
        setRefusal(null)
        updatePlaylist(credentials, playlist.id, { add: ids }).then(
            () => {
                toast.success(`Added ${trackCount(ids.length)} to ${playlist.name}`)
                onDone()
            },
            (error: Error) => {
                setBusy(false)
                setRefusal(error.message)
            },
        )
    }

    const create = (event: FormEvent) => {
        event.preventDefault()
        const chosen = name.trim()
        if (!chosen) return
        setBusy(true)
        setRefusal(null)
        createPlaylist(credentials, chosen, ids).then(
            () => {
                toast.success(`Made ${chosen} with ${trackCount(ids.length)}`)
                onDone()
            },
            (error: Error) => {
                setBusy(false)
                setRefusal(error.message)
            },
        )
    }

    return (
        <div className="grid gap-4">
            {playlists === null ? (
                <Skeleton rows={3} />
            ) : playlists.length === 0 ? (
                <p className="text-sm text-muted-foreground">No playlists yet. Name the first one below.</p>
            ) : (
                <ul className="-mx-1 max-h-64 overflow-y-auto">
                    {playlists.map((playlist) => (
                        <li key={playlist.id}>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => addTo(playlist)}
                                className="row-hover flex min-h-finger w-full items-center gap-3 rounded-md px-3 text-left text-sm disabled:opacity-50"
                            >
                                <ListMusic className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {trackCount(playlist.songCount)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <form onSubmit={create} className="flex items-center gap-2">
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-label="New playlist"
                    placeholder="New playlist"
                    className="min-w-0 flex-1"
                />
                <Button type="submit" disabled={busy || !name.trim()}>
                    <Plus aria-hidden />
                    Create
                </Button>
            </form>
            {refusal && <p className="text-sm text-destructive">{refusal}</p>}
        </div>
    )
}

/**
 * Ask for a playlist's name: a new one, or a new name for one there is.
 *
 * The field starts with what the playlist is called now, so a rename is an edit rather than a
 * retype, and the button that commits waits until there is a name that differs from it.
 */
export function NameDialog({
    open,
    title,
    initial,
    confirm,
    onSubmit,
    onClose,
}: {
    open: boolean
    title: string
    initial: string
    /** What the button that commits says: "Create", "Rename". */
    confirm: string
    onSubmit: (name: string) => Promise<void>
    onClose: () => void
}) {
    useStanding(open)
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose()
            }}
        >
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                {open && (
                    <NameForm initial={initial} confirm={confirm} onSubmit={onSubmit} onDone={onClose} />
                )}
            </DialogContent>
        </Dialog>
    )
}

function NameForm({
    initial,
    confirm,
    onSubmit,
    onDone,
}: {
    initial: string
    confirm: string
    onSubmit: (name: string) => Promise<void>
    onDone: () => void
}) {
    const [name, setName] = useState(initial)
    const [busy, setBusy] = useState(false)
    const [refusal, setRefusal] = useState<string | null>(null)
    const chosen = name.trim()

    const submit = (event: FormEvent) => {
        event.preventDefault()
        if (!chosen || chosen === initial) return
        setBusy(true)
        setRefusal(null)
        onSubmit(chosen).then(onDone, (error: Error) => {
            setBusy(false)
            setRefusal(error.message)
        })
    }

    return (
        <form onSubmit={submit} className="grid gap-4">
            <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label="Name"
                placeholder="Name"
                autoFocus
            />
            {refusal && <p className="text-sm text-destructive">{refusal}</p>}
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={busy || !chosen || chosen === initial}>
                    {confirm}
                </Button>
            </DialogFooter>
        </form>
    )
}

/**
 * Say yes to deleting a playlist.
 *
 * A PLAYLIST IS A THING SOMEBODY MADE, and there is no bin to take it back out of, so the one
 * gesture that ends it is asked twice. What the dialog says is what goes and what stays.
 */
export function DeletePlaylistDialog({
    open,
    name,
    onConfirm,
    onClose,
}: {
    open: boolean
    name: string
    onConfirm: () => Promise<void>
    onClose: () => void
}) {
    const [busy, setBusy] = useState(false)
    const [refusal, setRefusal] = useState<string | null>(null)
    useStanding(open)

    const confirm = () => {
        setBusy(true)
        setRefusal(null)
        onConfirm().then(
            () => {
                setBusy(false)
                onClose()
            },
            (error: Error) => {
                setBusy(false)
                setRefusal(error.message)
            },
        )
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose()
            }}
        >
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>Delete this playlist?</DialogTitle>
                    <DialogDescription>
                        {name} goes, on every client. The tracks on it stay in the library.
                    </DialogDescription>
                </DialogHeader>
                {refusal && <p className="text-sm text-destructive">{refusal}</p>}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="button" variant="destructive" disabled={busy} onClick={confirm}>
                        Delete
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
