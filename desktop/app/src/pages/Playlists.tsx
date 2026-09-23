import { ListMusic, Pencil, Play, Plus, Trash2, Volume2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'

import { DeletePlaylistDialog, NameDialog } from '@/components/PlaylistDialogs'
import { Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { useStore, useStoreValue } from '@/hooks/use-store'
import { clock, duration, trackCount } from '@/lib/format'
import { PLAYLISTS_PATH } from '@/lib/nav'
import { registerActions, SCREEN_GROUP } from '@/lib/palette'
import { play, playerStore } from '@/lib/player'
import { clearScreenStatus, setScreenStatus } from '@/lib/screen-status'
import { sessionStore } from '@/lib/session'
import {
    createPlaylist,
    deletePlaylist,
    getPlaylist,
    getPlaylists,
    updatePlaylist,
    type Credentials,
    type Playlist,
    type Song,
} from '@/lib/subsonic'
import { cn } from '@/lib/utils'
import { Cover, Header, Notice, selectPlaying, selectPlayingId, StarButton, type Held } from '@/pages/Music'

/**
 * This account's playlists, and one of them.
 *
 * A PLAYLIST IS A THING SOMEBODY MADE, not a queue: there is no "up next" in this client, and a
 * playlist plays the way an album does, from the row that was chosen to its end. So the screen
 * is an album's screen with the record's order replaced by the one somebody put together, and
 * the verbs that go with having made it -- rename, take a track off, delete.
 */
export function PlaylistsPage() {
    const { playlistId } = useParams()
    const session = useStore(sessionStore)
    if (!session.music) return <Notice>This server has no music library.</Notice>
    if (playlistId) return <PlaylistScreen credentials={session.music} id={playlistId} />
    return <PlaylistList credentials={session.music} />
}

/** How a playlist's length reads in a listing and under its title. */
function summary(count: number, seconds: number): string {
    return count > 0 ? `${trackCount(count)} · ${duration(seconds)}` : trackCount(count)
}

/** Every playlist this account has, the most recently changed first, as the server orders them. */
function PlaylistList({ credentials }: { credentials: Credentials }) {
    const [playlists, setPlaylists] = useState<Playlist[] | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const [naming, setNaming] = useState(false)
    const navigate = useNavigate()

    useEffect(() => {
        let live = true
        getPlaylists(credentials).then(
            (answer) => {
                if (live) setPlaylists(answer)
            },
            (error: Error) => {
                if (live) setRefusal(error.message)
            },
        )
        return () => {
            live = false
        }
    }, [credentials])

    useEffect(
        () =>
            registerActions([
                {
                    id: 'playlists:new',
                    title: NEW_LABEL,
                    group: SCREEN_GROUP,
                    screen: true,
                    icon: Plus,
                    keywords: ['playlist', 'create', 'make'],
                    run: () => setNaming(true),
                },
            ]),
        [],
    )

    // An empty playlist is somewhere to put tracks later; the album screens fill it.
    const make = async (name: string) => {
        const made = await createPlaylist(credentials, name)
        void navigate(`${PLAYLISTS_PATH}/${made.playlist.id}`)
    }

    const dialog = (
        <NameDialog
            open={naming}
            title={NEW_LABEL}
            initial=""
            confirm="Create"
            onSubmit={make}
            onClose={() => setNaming(false)}
        />
    )

    if (refusal) return <Notice>{refusal}</Notice>
    if (!playlists) {
        return (
            <div className="p-4">
                <Skeleton rows={6} />
            </div>
        )
    }

    return (
        <div className="p-4">
            <div className="mb-4 flex items-center gap-2">
                <h1 className="min-w-0 flex-1 truncate text-base">Playlists</h1>
                <Button variant="ghost" size="sm" onClick={() => setNaming(true)}>
                    <Plus aria-hidden />
                    {NEW_LABEL}
                </Button>
            </div>
            {playlists.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                    No playlists yet. Make one here, or add an album or a track to one from its album.
                </p>
            ) : (
                <ul>
                    {playlists.map((playlist) => (
                        <li key={playlist.id}>
                            <button
                                type="button"
                                onClick={() => navigate(`${PLAYLISTS_PATH}/${playlist.id}`)}
                                className="row-hover flex min-h-finger w-full items-center gap-3 rounded-md px-3 text-left text-sm"
                            >
                                <ListMusic className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                                <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {summary(playlist.songCount, playlist.duration)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {dialog}
        </div>
    )
}

const NEW_LABEL = 'New playlist'
const RENAME_LABEL = 'Rename this playlist'
const DELETE_LABEL = 'Delete this playlist'

/**
 * One playlist's tracks, in the order they were put there. Picking one plays from there.
 *
 * TAKING A TRACK OFF IS BY POSITION, because that is how the server is told and because the
 * same track can be on a playlist twice: the row goes at once, and the list is read again only
 * if the server refused, so what is on screen is never a guess that stuck.
 */
function PlaylistScreen({ credentials, id }: { credentials: Credentials; id: string }) {
    const [held, setHeld] = useState<Held<{ playlist: Playlist; songs: Song[] }>>({
        key: id,
        value: null,
        refusal: null,
    })
    const [renaming, setRenaming] = useState(false)
    const [deleting, setDeleting] = useState(false)
    // Removals go to the server one after another: a position means the list as the previous
    // removal left it, and two requests racing each other would take off the wrong track.
    const removals = useRef<Promise<unknown>>(Promise.resolve())
    const playingId = useStoreValue(playerStore, selectPlayingId)
    const playing = useStoreValue(playerStore, selectPlaying)
    const navigate = useNavigate()

    // Tagged and guarded the way the album screen's read is: the tracks on screen belong to the
    // id in the address and to no other.
    useEffect(() => {
        let live = true
        getPlaylist(credentials, id).then(
            (answer) => {
                if (live) setHeld({ key: id, value: answer, refusal: null })
            },
            (error: Error) => {
                if (live) setHeld({ key: id, value: null, refusal: error.message })
            },
        )
        return () => {
            live = false
        }
    }, [credentials, id])

    const answered = held.key === id
    const data = answered ? held.value : null
    const refusal = answered ? held.refusal : null
    const name = data?.playlist.name ?? null

    // The bar's right-hand cell names the playlist, which is what somebody reading the foot of
    // the window can use; the id is a machine's string that means nothing to them.
    useEffect(() => {
        setScreenStatus({ note: null, tone: 'quiet', identifier: name })
    }, [name])
    useEffect(() => clearScreenStatus, [])

    const songs = useMemo(() => data?.songs ?? [], [data])
    useEffect(() => {
        if (name === null) return
        return registerActions([
            ...(songs.length > 0
                ? [
                      {
                          id: 'playlist:play',
                          title: 'Play this playlist',
                          group: SCREEN_GROUP,
                          screen: true,
                          icon: Play,
                          keywords: ['playlist', 'start'],
                          run: () => play(songs, 0),
                      },
                  ]
                : []),
            {
                id: 'playlist:rename',
                title: RENAME_LABEL,
                group: SCREEN_GROUP,
                screen: true,
                icon: Pencil,
                keywords: ['playlist', 'name', 'title'],
                run: () => setRenaming(true),
            },
            {
                id: 'playlist:delete',
                title: DELETE_LABEL,
                group: SCREEN_GROUP,
                screen: true,
                icon: Trash2,
                keywords: ['playlist', 'remove'],
                run: () => setDeleting(true),
            },
        ])
    }, [name, songs])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!data) {
        return (
            <div className="p-4">
                <Skeleton rows={10} />
            </div>
        )
    }
    const { playlist } = data
    const total = songs.reduce((sum, song) => sum + (song.duration ?? 0), 0)

    const rename = async (next: string) => {
        await updatePlaylist(credentials, playlist.id, { name: next })
        setHeld({ key: id, value: { playlist: { ...playlist, name: next }, songs }, refusal: null })
    }

    const remove = (index: number) => {
        const song = songs[index]
        if (!song) return
        const left = songs.filter((_, at) => at !== index)
        setHeld({
            key: id,
            value: { playlist: { ...playlist, songCount: left.length }, songs: left },
            refusal: null,
        })
        removals.current = removals.current
            .then(() => updatePlaylist(credentials, playlist.id, { remove: [index] }))
            .catch((error: Error) => {
                toast.error(`${song.title} is still on ${playlist.name}: ${error.message}`)
                // The list on screen is a guess the server did not agree to, so it is read again.
                getPlaylist(credentials, id).then(
                    (answer) => setHeld({ key: id, value: answer, refusal: null }),
                    (reread: Error) => setHeld({ key: id, value: null, refusal: reread.message }),
                )
            })
    }

    const destroy = async () => {
        await deletePlaylist(credentials, playlist.id)
        toast.success(`Deleted ${playlist.name}`)
        void navigate(PLAYLISTS_PATH)
    }

    return (
        <div className="p-4">
            <Header
                title={playlist.name}
                subtitle={summary(songs.length, total)}
                onBack={() => navigate(PLAYLISTS_PATH)}
                trail={[{ label: 'Playlists', to: PLAYLISTS_PATH }]}
                action={
                    <div className="flex shrink-0 items-center">
                        <Button
                            variant="ghost"
                            size="sm"
                            aria-label={RENAME_LABEL}
                            title={RENAME_LABEL}
                            onClick={() => setRenaming(true)}
                        >
                            <Pencil aria-hidden />
                            <span className="hidden sm:inline">Rename</span>
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            aria-label={DELETE_LABEL}
                            title={DELETE_LABEL}
                            onClick={() => setDeleting(true)}
                        >
                            <Trash2 aria-hidden />
                            <span className="hidden sm:inline">Delete</span>
                        </Button>
                    </div>
                }
            />
            {songs.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                    Nothing on this playlist yet. Add an album or a track to it from the album's page.
                </p>
            ) : (
                <ol className="rounded-lg border">
                    {songs.map((song, index) => {
                        const current = song.id === playingId
                        return (
                            // The same track can be on a playlist twice, so the position is
                            // part of what tells two rows apart.
                            <li
                                key={`${String(index)}:${song.id}`}
                                className={cn('flex items-center', current && 'bg-muted font-medium')}
                            >
                                <button
                                    type="button"
                                    onClick={() => play(songs, index)}
                                    aria-current={current ? 'true' : undefined}
                                    className="row-hover flex min-h-finger min-w-0 flex-1 items-center gap-3 px-3 text-left text-sm"
                                >
                                    <span className="flex w-6 shrink-0 items-center justify-end text-xs text-muted-foreground tabular-nums">
                                        {current ? (
                                            playing ? (
                                                <Volume2 className="size-3.5 text-primary" aria-hidden />
                                            ) : (
                                                <Play className="size-3.5 text-primary" aria-hidden />
                                            )
                                        ) : (
                                            index + 1
                                        )}
                                    </span>
                                    <Cover
                                        credentials={credentials}
                                        id={song.albumId ?? song.id}
                                        art={song.coverArt}
                                        className="size-8 shrink-0 rounded-sm"
                                    />
                                    {/* A PLAYLIST IS EVERY RECORD AT ONCE, so each row says whose it
                                        is under its title, which an album's rows only do on a
                                        compilation. */}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate" title={song.title}>
                                            {song.title}
                                        </span>
                                        <span
                                            className="block truncate text-xs text-muted-foreground"
                                            title={[song.artist, song.album].filter(Boolean).join(' · ')}
                                        >
                                            {[song.artist, song.album].filter(Boolean).join(' · ')}
                                        </span>
                                    </span>
                                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                                        {clock(song.duration ?? 0)}
                                    </span>
                                </button>
                                <StarButton credentials={credentials} song={song} />
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    aria-label={`Remove ${song.title} from ${playlist.name}`}
                                    title={`Remove from ${playlist.name}`}
                                    onClick={() => remove(index)}
                                >
                                    <X className="size-4" aria-hidden />
                                </Button>
                            </li>
                        )
                    })}
                </ol>
            )}
            <NameDialog
                open={renaming}
                title={RENAME_LABEL}
                initial={playlist.name}
                confirm="Rename"
                onSubmit={rename}
                onClose={() => setRenaming(false)}
            />
            <DeletePlaylistDialog
                open={deleting}
                name={playlist.name}
                onConfirm={destroy}
                onClose={() => setDeleting(false)}
            />
        </div>
    )
}
