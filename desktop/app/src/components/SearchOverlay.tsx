import { Disc3, Music2, User } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import {
    Command,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useStore } from '@/hooks/use-store'
import { play } from '@/lib/player'
import {
    closeSearch,
    SEARCH_DEBOUNCE_MS,
    SEARCH_MIN,
    searchOpen,
    searchSeed,
    shelveResults,
    worthAsking,
    type SearchRow,
} from '@/lib/search'
import { sessionStore } from '@/lib/session'
import {
    getAlbum,
    search as searchLibrary,
    type Credentials,
    type SearchResult,
    type Song,
} from '@/lib/subsonic'

export const SEARCH_TITLE = 'Search the library'
export const SEARCH_DESCRIPTION = 'Everything this server holds, by artist, album or track'
export const SEARCH_PLACEHOLDER = 'Artist, album, or track'
export const SEARCH_EMPTY = 'Nothing in the library answers to that'
export const SEARCH_MINIMUM = `${SEARCH_MIN} letters is enough to search`
export const SEARCH_ASKING = 'Searching.'

/** The mark each kind of row wears, so the three shelves are told apart at a glance. */
const GLYPHS = { artist: User, album: Disc3, track: Music2 }

/**
 * The search over the whole library, over whatever screen somebody is on.
 *
 * THE SAME DIALOG THE PALETTE IS, and for the same reason: this is a box, a list of shelved
 * rows, and one key that acts on the row with the cursor on it. `shouldFilter` is off here too,
 * because the rows are the server's answer to the query -- filtering them again on the client
 * would drop what the server matched on an album name the row does not draw.
 *
 * THE QUESTION IS ASKED ONCE PER PAUSE, not once per keystroke. A quarter of a second after the
 * typing stops is one request for a word rather than five, and the effect is torn down on every
 * change, so an answer to a query somebody has moved on from never lands on the screen.
 *
 * ENTER ON A TRACK PLAYS ITS ALBUM FROM THERE, which is what picking a track does everywhere
 * else in this app -- the album screen, the queue, the star list. It costs one `getAlbum`, and
 * a track that has no album, or whose album cannot be read, plays alone rather than not at all.
 */
export function SearchOverlay() {
    const open = useStore(searchOpen)
    const session = useStore(sessionStore)
    const seed = useStore(searchSeed)
    const [typed, setTyped] = useState<string | null>(null)
    const [answer, setAnswer] = useState<Answer | null>(null)
    const navigate = useNavigate()
    const credentials = session.music
    // WHAT THE BOX HOLDS IS WHAT IT WAS OPENED WITH UNTIL SOMEBODY TYPES INTO IT. The strip's
    // field is a door and hands over the letters already typed, and from the first keystroke in
    // here the box is this box's. Derived rather than copied in by an effect, which would be a
    // render spent putting a value where one already is.
    const query = typed ?? seed
    const asked = query.trim()

    // WHICH QUESTION THE ANSWER IS TO IS CARRIED ON IT, and read during render rather than
    // cleared from an effect: an answer to a query somebody has typed past is simply not the
    // current one, so nothing has to race to take it off the screen.
    const current = answer !== null && answer.query === asked ? answer : null
    const found = current?.result ?? null

    useEffect(() => {
        if (!open || !credentials || !worthAsking(asked)) return
        const timer = setTimeout(() => {
            searchLibrary(credentials, asked)
                .then((result) => {
                    setAnswer({ query: asked, result, refusal: null })
                })
                .catch((error: Error) => {
                    setAnswer({ query: asked, result: null, refusal: error.message })
                })
        }, SEARCH_DEBOUNCE_MS)
        return () => {
            clearTimeout(timer)
        }
    }, [asked, credentials, open])

    const shelves = useMemo(() => shelveResults(found, asked), [found, asked])

    function dismiss(): void {
        closeSearch()
        setTyped(null)
        setAnswer(null)
    }

    function choose(row: SearchRow): void {
        dismiss()
        if (row.kind === 'artist') {
            void navigate(`/music/artist/${row.id}`)
            return
        }
        if (row.kind === 'album') {
            void navigate(`/music/album/${row.id}`)
            return
        }
        const song = found?.songs.find((one) => one.id === row.id)
        if (credentials && song) void playFrom(credentials, song)
    }

    return (
        <CommandDialog
            open={open}
            onOpenChange={(next) => {
                if (next) searchOpen.set(true)
                else dismiss()
            }}
            title={SEARCH_TITLE}
            description={SEARCH_DESCRIPTION}
            className="top-[15vh] w-full p-0 shadow-2xl sm:max-w-[768px]"
        >
            <Command shouldFilter={false} label={SEARCH_TITLE} className="p-0">
                <CommandInput
                    placeholder={SEARCH_PLACEHOLDER}
                    value={query}
                    onValueChange={setTyped}
                    autoFocus
                    className="text-base"
                />
                <CommandList className="max-h-[26rem] p-2">
                    <CommandEmpty>{emptyWord(asked, current)}</CommandEmpty>
                    {shelves.map((shelf) => (
                        <CommandGroup key={shelf.label} heading={shelf.label} className="p-0 pb-1">
                            {shelf.rows.map((row) => (
                                <Row
                                    key={`${row.kind}:${row.id}`}
                                    row={row}
                                    onChoose={() => {
                                        choose(row)
                                    }}
                                />
                            ))}
                        </CommandGroup>
                    ))}
                </CommandList>
                <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-t border-border px-3 text-faint">
                    <KbdGroup>
                        <Kbd>↑↓</Kbd>
                        <span className="text-xs">choose</span>
                        <Kbd className="ml-2">↵</Kbd>
                        <span className="text-xs">open it</span>
                    </KbdGroup>
                </div>
            </Command>
        </CommandDialog>
    )
}

/**
 * One row: its mark, what it is, and what it is on.
 *
 * TWO LINES, UNLIKE THE PALETTE'S ONE. A palette row is a verb and its title says the whole of
 * it; a track called Love Sux is one of four in this library, and which artist and which record
 * is the difference between the row somebody wanted and the row above it.
 */
function Row({ row, onChoose }: { row: SearchRow; onChoose: () => void }) {
    const Icon = GLYPHS[row.kind]
    return (
        <CommandItem
            value={`${row.kind}:${row.id}`}
            onSelect={onChoose}
            className="gap-3 rounded-md px-2 py-2"
        >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{row.title}</span>
                {row.subtitle !== '' && (
                    <span className="block truncate text-xs text-muted-foreground">{row.subtitle}</span>
                )}
            </span>
        </CommandItem>
    )
}

/** One answer, and the query it answers. */
interface Answer {
    query: string
    result: SearchResult | null
    /** What the server said when it refused, in its own words. */
    refusal: string | null
}

/**
 * What an empty list says.
 *
 * FOUR STATES THAT STAY APART. Too little typed, in flight, refused, and found nothing are
 * four different facts, and collapsing them is how a server that cannot be reached tells
 * somebody their library is empty.
 */
function emptyWord(query: string, answer: Answer | null): string {
    if (!worthAsking(query)) return SEARCH_MINIMUM
    if (answer === null) return SEARCH_ASKING
    return answer.refusal ?? SEARCH_EMPTY
}

/** Play a track the way picking one anywhere else in this app does: its album, from there. */
async function playFrom(credentials: Credentials, song: Song): Promise<void> {
    if (song.albumId !== undefined) {
        try {
            const { songs } = await getAlbum(credentials, song.albumId)
            const at = songs.findIndex((one) => one.id === song.id)
            if (at >= 0) {
                play(songs, at)
                return
            }
        } catch {
            // The album could not be read. The track itself is still a track.
        }
    }
    play([song], 0)
}
