import { ChevronLeft, Play } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { useStore } from '@/hooks/use-store'
import { clock } from '@/lib/format'
import { play } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import {
    coverUrl,
    getAlbum,
    getArtist,
    getArtists,
    type Album,
    type Artist,
    type Credentials,
    type Song,
} from '@/lib/subsonic'
import { cn } from '@/lib/utils'

export function MusicPage() {
    const { artistId, albumId } = useParams()
    const session = useStore(sessionStore)
    if (!session.music) return <Notice>This server has no music library.</Notice>
    if (albumId) return <AlbumScreen credentials={session.music} id={albumId} />
    if (artistId) return <ArtistScreen credentials={session.music} id={artistId} />
    return <Artists credentials={session.music} />
}

/** Everyone in the library, by name. */
function Artists({ credentials }: { credentials: Credentials }) {
    const [artists, setArtists] = useState<Artist[] | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()

    useEffect(() => {
        getArtists(credentials)
            .then(setArtists)
            .catch((error: Error) => setRefusal(error.message))
    }, [credentials])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!artists) return <Notice>Reading the library.</Notice>
    if (!artists.length) return <Notice>No artists.</Notice>

    return (
        <ul className="p-2">
            {artists.map((artist) => (
                <li key={artist.id}>
                    <button
                        type="button"
                        onClick={() => navigate(`/music/artist/${artist.id}`)}
                        className="row-hover flex min-h-finger w-full items-center gap-3 rounded-md px-3 text-left text-sm"
                    >
                        <span className="min-w-0 flex-1 truncate">{artist.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {artist.albumCount ?? 0} {artist.albumCount === 1 ? 'album' : 'albums'}
                        </span>
                    </button>
                </li>
            ))}
        </ul>
    )
}

/** One artist's albums, oldest first. */
function ArtistScreen({ credentials, id }: { credentials: Credentials; id: string }) {
    const [data, setData] = useState<{ artist: Artist; albums: Album[] } | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()

    useEffect(() => {
        getArtist(credentials, id)
            .then(setData)
            .catch((error: Error) => setRefusal(error.message))
    }, [credentials, id])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!data) return <Notice>Opening the artist.</Notice>

    return (
        <div className="p-4">
            <Header title={data.artist.name} onBack={() => navigate('/music')} />
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {data.albums.map((album) => (
                    <li key={album.id}>
                        <button
                            type="button"
                            onClick={() => navigate(`/music/album/${album.id}`)}
                            className="row-hover w-full rounded-lg p-2 text-left"
                        >
                            <Cover
                                credentials={credentials}
                                art={album.coverArt}
                                className="mb-2 w-full rounded-md"
                            />
                            <p className="truncate text-sm font-medium" title={album.name}>
                                {album.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {album.year ?? ''}
                                {album.year ? ' · ' : ''}
                                {album.songCount} tracks
                            </p>
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    )
}

/** One album's tracks. Picking one plays the album from there. */
function AlbumScreen({ credentials, id }: { credentials: Credentials; id: string }) {
    const [data, setData] = useState<{ album: Album; songs: Song[] } | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()

    useEffect(() => {
        getAlbum(credentials, id)
            .then(setData)
            .catch((error: Error) => setRefusal(error.message))
    }, [credentials, id])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!data) return <Notice>Opening the album.</Notice>
    const { album, songs } = data

    return (
        <div className="p-4">
            <Header
                title={album.name}
                subtitle={`${album.artist}${album.year ? ` · ${album.year}` : ''}`}
                onBack={() => navigate(album.artistId ? `/music/artist/${album.artistId}` : '/music')}
                action={
                    <Button size="sm" onClick={() => play(songs, 0)} disabled={!songs.length}>
                        <Play className="size-4" aria-hidden /> Play
                    </Button>
                }
            />
            <div className="flex items-start gap-4">
                <Cover
                    credentials={credentials}
                    art={album.coverArt}
                    className="hidden size-40 rounded-md sm:block"
                />
                <ol className="min-w-0 flex-1 rounded-lg border">
                    {songs.map((song, index) => (
                        <li key={song.id}>
                            <button
                                type="button"
                                onClick={() => play(songs, index)}
                                className={cn(
                                    'row-hover flex min-h-finger w-full items-center gap-3 px-3 text-left text-sm',
                                )}
                            >
                                <span className="w-6 shrink-0 text-right text-xs text-muted-foreground">
                                    {song.track ?? index + 1}
                                </span>
                                <span className="min-w-0 flex-1 truncate" title={song.title}>
                                    {song.title}
                                </span>
                                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                    {clock(song.duration ?? 0)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ol>
            </div>
        </div>
    )
}

function Header({
    title,
    subtitle,
    onBack,
    action,
}: {
    title: string
    subtitle?: string
    onBack: () => void
    action?: React.ReactNode
}) {
    return (
        <div className="mb-4 flex items-center gap-2">
            <Button variant="ghost" size="sm" aria-label="Back" onClick={onBack}>
                <ChevronLeft className="size-4" aria-hidden />
            </Button>
            <div className="min-w-0 flex-1">
                <h1 className="truncate text-base">{title}</h1>
                {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
            </div>
            {action}
        </div>
    )
}

function Cover({
    credentials,
    art,
    className,
}: {
    credentials: Credentials
    art: string | undefined
    className?: string
}) {
    const src = coverUrl(credentials, art, 500)
    if (!src) return <div className={cn('aspect-square bg-muted', className)} aria-hidden />
    return <img src={src} alt="" loading="lazy" className={cn('aspect-square object-cover', className)} />
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-full items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">{children}</p>
        </div>
    )
}
