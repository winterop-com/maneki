import { ChevronLeft, Play, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { Button } from '@/components/ui/button'
import { useStore } from '@/hooks/use-store'
import { clock } from '@/lib/format'
import { play } from '@/lib/player'
import { sessionStore } from '@/lib/session'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/Segmented'
import { articlesOf, SORT_LABELS, SORT_MODES, sortArtists, type SortMode } from '@/lib/sorting'
import {
    coverUrl,
    getAlbum,
    getArtist,
    getArtists,
    getMusicFolders,
    getStarred,
    musicFolderOf,
    search as searchLibrary,
    setStarred,
    type Album,
    type Artist,
    type Credentials,
    type Song,
} from '@/lib/subsonic'
import { cn } from '@/lib/utils'

/** How much has to be typed before the server is asked, and how long to wait after typing. */
const SEARCH_MIN = 2
const SEARCH_DEBOUNCE_MS = 250

/** Where the chosen order is kept, because it is a way of reading rather than a search. */
const SORT_KEY = 'maneki.artistSort'

function storedSort(): SortMode {
    try {
        const held = localStorage.getItem(SORT_KEY)
        return (SORT_MODES as readonly string[]).includes(held ?? '') ? (held as SortMode) : 'name'
    } catch {
        return 'name'
    }
}

export function MusicPage({ view }: { view?: 'starred' } = {}) {
    const { artistId, albumId } = useParams()
    const session = useStore(sessionStore)
    if (!session.music) return <Notice>This server has no music library.</Notice>
    if (view === 'starred') return <Favourites credentials={session.music} />
    if (albumId) return <AlbumScreen credentials={session.music} id={albumId} />
    if (artistId) return <ArtistScreen credentials={session.music} id={artistId} />
    return <Artists credentials={session.music} />
}

/** Everything this account starred, across artists, albums and tracks. */
function Favourites({ credentials }: { credentials: Credentials }) {
    const [starred, setStarredList] = useState<Awaited<ReturnType<typeof getStarred>> | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()

    useEffect(() => {
        getStarred(credentials)
            .then(setStarredList)
            .catch((error: Error) => setRefusal(error.message))
    }, [credentials])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!starred) return <Notice>Reading your favourites.</Notice>
    const empty = !starred.albums.length && !starred.songs.length && !starred.artists.length
    if (empty) return <Notice>Nothing starred yet.</Notice>

    return (
        <div className="p-4">
            <h1 className="mb-4 text-base">Favourites</h1>
            {starred.albums.length > 0 && (
                <ul className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                    {starred.albums.map((album) => (
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
                                <p className="truncate text-sm font-medium">{album.name}</p>
                                <p className="truncate text-xs text-muted-foreground">{album.artist}</p>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {starred.songs.length > 0 && (
                <ol className="rounded-lg border">
                    {starred.songs.map((song, index) => (
                        <li key={song.id}>
                            <button
                                type="button"
                                onClick={() => play(starred.songs, index)}
                                className="row-hover flex min-h-finger w-full items-center gap-3 px-3 text-left text-sm"
                            >
                                <span className="min-w-0 flex-1 truncate">{song.title}</span>
                                <span className="shrink-0 truncate text-xs text-muted-foreground">
                                    {song.artist}
                                </span>
                                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                    {clock(song.duration ?? 0)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    )
}

/**
 * Everyone in the library.
 *
 * THE MUSIC FOLDER ONLY. maneki serves audiobooks as a second folder, and their authors are
 * artists to the Subsonic grammar: without saying which folder this screen means, a library
 * with 195 books lists sixty authors among the musicians.
 *
 * ORDERED BY THE NAME MINUS ITS ARTICLE, which is what the server's `ignoredArticles` is for.
 * The order itself is a choice somebody makes once and keeps.
 */
function Artists({ credentials }: { credentials: Credentials }) {
    const [artists, setArtists] = useState<Artist[] | null>(null)
    const [articles, setArticles] = useState<string[]>(() => articlesOf(undefined))
    const [sort, setSort] = useState<SortMode>(storedSort)
    const [query, setQuery] = useState('')
    const [found, setFound] = useState<Awaited<ReturnType<typeof searchLibrary>> | null>(null)
    const [refusal, setRefusal] = useState<string | null>(null)
    const navigate = useNavigate()

    /**
     * The typed name filters the artists straight away, and the server is
     * asked as well: it searches albums and tracks, which the names on this
     * screen cannot answer for. A pause before asking keeps a burst of
     * keystrokes down to one search.
     */
    useEffect(() => {
        const text = query.trim()
        if (text.length < SEARCH_MIN) return
        const timer = setTimeout(() => {
            searchLibrary(credentials, text)
                .then(setFound)
                .catch(() => setFound(null))
        }, SEARCH_DEBOUNCE_MS)
        return () => clearTimeout(timer)
    }, [credentials, query])

    useEffect(() => {
        let live = true
        const read = async () => {
            const folders = await getMusicFolders(credentials).catch(() => [])
            const answered = await getArtists(credentials, musicFolderOf(folders))
            if (!live) return
            setArtists(answered.artists)
            setArticles(articlesOf(answered.ignoredArticles))
        }
        read().catch((error: Error) => {
            if (live) setRefusal(error.message)
        })
        return () => {
            live = false
        }
    }, [credentials])

    const typed = query.trim()
    const ordered = useMemo(() => sortArtists(artists ?? [], sort, articles), [articles, artists, sort])

    if (refusal) return <Notice>{refusal}</Notice>
    if (!artists) return <Notice>Reading the library.</Notice>
    if (!artists.length) return <Notice>No artists.</Notice>

    const shown = typed
        ? ordered.filter((artist) => artist.name.toLowerCase().includes(typed.toLowerCase()))
        : ordered
    // What the server last found belongs to the last search worth making; a
    // query shorter than that is not one, so the results are simply not shown.
    const results = typed.length >= SEARCH_MIN ? found : null

    return (
        <div className="p-2">
            <div className="mb-2 flex items-center gap-2">
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    aria-label="Search the library"
                    placeholder="Search"
                    className="min-w-0 flex-1"
                />
                <Segmented
                    label="Order"
                    value={sort}
                    options={SORT_MODES.map((mode) => ({ value: mode, label: SORT_LABELS[mode] }))}
                    onChoose={(chosen) => {
                        setSort(chosen as SortMode)
                        try {
                            localStorage.setItem(SORT_KEY, chosen)
                        } catch {
                            // Storage denied: the order holds while this document is open.
                        }
                    }}
                />
            </div>
            {results && (
                <div className="mb-4 rounded-lg border p-2">
                    <p className="mb-1 px-1 text-xs text-muted-foreground">
                        {results.albums.length} albums, {results.songs.length} tracks
                    </p>
                    {results.albums.slice(0, 8).map((album) => (
                        <button
                            key={album.id}
                            type="button"
                            onClick={() => navigate(`/music/album/${album.id}`)}
                            className="row-hover flex min-h-finger w-full items-center gap-3 rounded-md px-3 text-left text-sm"
                        >
                            <span className="min-w-0 flex-1 truncate">{album.name}</span>
                            <span className="shrink-0 truncate text-xs text-muted-foreground">
                                {album.artist}
                            </span>
                        </button>
                    ))}
                    {results.songs.slice(0, 8).map((song, index) => (
                        <button
                            key={song.id}
                            type="button"
                            onClick={() => play(results.songs, index)}
                            className="row-hover flex min-h-finger w-full items-center gap-3 rounded-md px-3 text-left text-sm"
                        >
                            <span className="min-w-0 flex-1 truncate">{song.title}</span>
                            <span className="shrink-0 truncate text-xs text-muted-foreground">
                                {song.artist}
                            </span>
                        </button>
                    ))}
                </div>
            )}
            <ul>
                {shown.map((artist) => (
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
        </div>
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
                        <li key={song.id} className="flex items-center">
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
                                {/* On a compilation every row is a different artist, and a
                                    list of titles alone says nothing about what they are. */}
                                {song.artist && song.artist !== album.artist && (
                                    <span
                                        className="hidden max-w-48 min-w-0 shrink truncate text-xs text-muted-foreground sm:block"
                                        title={song.artist}
                                    >
                                        {song.artist}
                                    </span>
                                )}
                                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                    {clock(song.duration ?? 0)}
                                </span>
                            </button>
                            <StarButton credentials={credentials} song={song} />
                        </li>
                    ))}
                </ol>
            </div>
        </div>
    )
}

/** The star on a track. Its own state, because the server answers with nothing to redraw from. */
function StarButton({ credentials, song }: { credentials: Credentials; song: Song }) {
    const [starred, setStarredState] = useState(Boolean(song.starred))
    return (
        <Button
            variant="ghost"
            size="sm"
            aria-label={starred ? `Unstar ${song.title}` : `Star ${song.title}`}
            aria-pressed={starred}
            onClick={() => {
                const next = !starred
                setStarredState(next)
                void setStarred(credentials, song.id, next).catch(() => setStarredState(!next))
            }}
        >
            <Star className={cn('size-4', starred && 'fill-primary text-primary')} aria-hidden />
        </Button>
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
