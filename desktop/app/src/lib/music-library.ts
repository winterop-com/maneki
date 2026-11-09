/**
 * The music folder's artists, and the albums of those opened so far, read once per server.
 *
 * TWO READERS, ONE READ. The library's tree stands in the rail's body and the artists wall on the
 * page, two parts of the app that share no parent below the shell; the phone's drawer draws the
 * rail a second time. All of them read this store, so the artists are asked for once and an
 * artist's albums once, however many trees show them.
 *
 * THE MUSIC FOLDER ONLY. maneki serves audiobooks as a second folder, and their authors are
 * artists to the Subsonic grammar: without saying which folder is meant, a library with 195 books
 * lists sixty authors among the musicians.
 */

import { createStore } from '@winterop-com/sokkel-ui/lib/stored'
import { articlesOf } from '@/lib/sorting'
import {
    getArtist,
    getArtists,
    getMusicFolders,
    musicFolderOf,
    type Album,
    type Artist,
    type Credentials,
} from '@/lib/subsonic'

/** The music folder's artists, and the articles the server files them by. */
export interface ArtistIndex {
    artists: Artist[]
    articles: string[]
}

export interface MusicLibraryState {
    /** Which server and account the rest was read from; see `serverOf`. */
    server: string | null
    index: ArtistIndex | null
    refusal: string | null
    /** Each opened artist's albums, by the artist's id. */
    albums: ReadonlyMap<string, readonly Album[]>
}

const EMPTY: MusicLibraryState = { server: null, index: null, refusal: null, albums: new Map() }

export const musicLibraryStore = createStore<MusicLibraryState>(EMPTY)

let reading: Promise<void> | null = null
const askingAlbums = new Map<string, Promise<readonly Album[]>>()

/** A server and an account, which is what a library belongs to; a fresh token is the same library. */
function serverOf(credentials: Credentials): string {
    return `${credentials.username}@${credentials.restUrl}`
}

/** Starts over for another server or account, forgetting the last one's library. */
function holdFor(credentials: Credentials): string {
    const server = serverOf(credentials)
    if (musicLibraryStore.get().server !== server) {
        reading = null
        askingAlbums.clear()
        musicLibraryStore.set({ ...EMPTY, server })
    }
    return server
}

/**
 * Asks for the artists unless they are held or on the way. A refusal is not held: the next
 * reader asks again, as a screen keyed on the server coming back does.
 */
export function readLibrary(credentials: Credentials): void {
    const server = holdFor(credentials)
    const now = musicLibraryStore.get()
    if (now.index !== null || reading !== null) return
    const read = (async () => {
        const folders = await getMusicFolders(credentials).catch(() => [])
        const answered = await getArtists(credentials, musicFolderOf(folders))
        return { artists: answered.artists, articles: articlesOf(answered.ignoredArticles) }
    })()
    const settled = read.then(
        (index) => {
            if (musicLibraryStore.get().server !== server) return
            musicLibraryStore.set({ ...musicLibraryStore.get(), index, refusal: null })
        },
        (error: Error) => {
            if (musicLibraryStore.get().server !== server) return
            musicLibraryStore.set({ ...musicLibraryStore.get(), refusal: error.message })
        },
    )
    reading = settled
    void settled.finally(() => {
        if (reading === settled) reading = null
    })
}

/** One artist's albums, asked for once however many times and by however many trees they are wanted. */
export function albumsOf(credentials: Credentials, artistId: string): Promise<readonly Album[]> {
    const server = holdFor(credentials)
    const held = askingAlbums.get(artistId)
    if (held !== undefined) return held
    const asked = getArtist(credentials, artistId).then(({ albums }) => {
        const now = musicLibraryStore.get()
        if (now.server === server) {
            musicLibraryStore.set({ ...now, albums: new Map(now.albums).set(artistId, albums) })
        }
        return albums
    })
    // A refusal is not kept: the tree's row to try again asks again.
    asked.catch(() => askingAlbums.delete(artistId))
    askingAlbums.set(artistId, asked)
    return asked
}

/** Forgets every library read, so a test starts from nothing. */
export function forgetLibrary(): void {
    reading = null
    askingAlbums.clear()
    musicLibraryStore.set(EMPTY)
}
