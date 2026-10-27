/**
 * Plays and stars made while the server was out of reach, kept until it answers again.
 *
 * A DOWNLOADED ALBUM PLAYS WITHOUT THE SERVER, and what happens while it plays still belongs to
 * the account: a finished track is a play in its history, a star is a favourite. Dropping them
 * because the wire was down made a train journey a hole in "Recently played" and a star that
 * came off again the moment it was pressed.
 *
 * ONLY THE NETWORK REFUSING KEEPS ANYTHING. A server that answered and said no has said what it
 * will say every time, so that write is let go as before; only `fetch` failing outright, the
 * case `connection.ts` raises its banner for, is worth sending again.
 *
 * ONE LIST PER ACCOUNT ON ONE SERVER, in `localStorage`: a handful of small records that must
 * outlive a quit, read once at start. A play carries the moment it ended, which the server
 * files it under, so history lands in the order it happened. A star keeps only the last thing
 * asked of it: starred and unstarred on the train is no change at all to send.
 *
 * WHAT IS KEPT IS SENT when the server comes back (`recoveries`) and when an account opens, in
 * the order it was made, and stops at the first refusal of the wire.
 */

import { isNetworkRefusal, recoveries } from '@/lib/connection'
import { libraryOf } from '@/lib/offline'
import { call, type Credentials } from '@/lib/subsonic'

/** One write the server has not had yet. */
export type Kept = { kind: 'play'; id: string; at: number } | { kind: 'star'; id: string; starred: boolean }

const KEY_PREFIX = 'maneki.outbox.'

/** The kept writes for one account, oldest first. Storage that cannot be read holds nothing. */
export function keptFor(credentials: Credentials): Kept[] {
    try {
        const held = localStorage.getItem(KEY_PREFIX + libraryOf(credentials))
        const parsed: unknown = held ? JSON.parse(held) : []
        return Array.isArray(parsed) ? (parsed as Kept[]) : []
    } catch {
        return []
    }
}

function write(credentials: Credentials, kept: Kept[]): void {
    try {
        const key = KEY_PREFIX + libraryOf(credentials)
        if (kept.length === 0) localStorage.removeItem(key)
        else localStorage.setItem(key, JSON.stringify(kept))
    } catch {
        // Storage refused: this write is lost, as it was before anything was kept.
    }
}

/** The list with one more write on it. A star replaces whatever was kept for the same id. */
export function withKept(kept: readonly Kept[], next: Kept): Kept[] {
    if (next.kind === 'play') return [...kept, next]
    return [...kept.filter((entry) => !(entry.kind === 'star' && entry.id === next.id)), next]
}

/** The list without one write: the first entry equal to it. */
export function withoutKept(kept: readonly Kept[], sent: Kept): Kept[] {
    const at = kept.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(sent))
    return at < 0 ? [...kept] : [...kept.slice(0, at), ...kept.slice(at + 1)]
}

function keep(credentials: Credentials, next: Kept): void {
    write(credentials, withKept(keptFor(credentials), next))
}

function send(credentials: Credentials, entry: Kept): Promise<unknown> {
    if (entry.kind === 'play')
        return call(credentials, 'scrobble', { id: entry.id, submission: true, time: entry.at })
    return call(credentials, entry.starred ? 'star' : 'unstar', { id: entry.id })
}

/**
 * Tell the server a track has played, or keep the play if the server is not there.
 *
 * Nothing reaches the listener either way: the music already played.
 */
export async function sendPlay(credentials: Credentials, id: string, at: number = Date.now()): Promise<void> {
    const entry: Kept = { kind: 'play', id, at }
    try {
        await send(credentials, entry)
    } catch (error) {
        if (isNetworkRefusal(error)) keep(credentials, entry)
    }
}

/**
 * Star or unstar, keeping the write if the server is not there. Rejects only when the server
 * answered and refused, which is the caller's to say.
 */
export async function sendStar(credentials: Credentials, id: string, starred: boolean): Promise<void> {
    const entry: Kept = { kind: 'star', id, starred }
    try {
        await send(credentials, entry)
    } catch (error) {
        if (!isNetworkRefusal(error)) throw error
        keep(credentials, entry)
        return
    }
    // What the server has now is this; an older kept star for the same id would undo it.
    const kept = keptFor(credentials)
    const left = kept.filter((held) => !(held.kind === 'star' && held.id === id))
    if (left.length !== kept.length) write(credentials, left)
}

/** The flush under way, so a recovery during one does not send the same play twice. */
let sending: Promise<void> | null = null
/** Asked again while a flush was under way: the server may have come back since it began. */
let again = false

async function flush(credentials: Credentials): Promise<void> {
    for (let entry = keptFor(credentials)[0]; entry; entry = keptFor(credentials)[0]) {
        try {
            await send(credentials, entry)
        } catch (error) {
            if (isNetworkRefusal(error)) return
        }
        // Re-read: something may have been kept while this one was on the wire.
        write(credentials, withoutKept(keptFor(credentials), entry))
    }
}

/**
 * Send what is kept, oldest first. Stops at the first refusal of the wire and keeps the rest;
 * a write the server refuses is let go.
 */
export function sendKept(credentials: Credentials): Promise<void> {
    if (sending) {
        again = true
        return sending
    }
    sending = (async () => {
        try {
            do {
                again = false
                await flush(credentials)
            } while (again)
        } finally {
            sending = null
        }
    })()
    return sending
}

/**
 * Send one account's kept writes now, and again each time the server comes back. Answers the
 * function that stops watching.
 */
export function startOutbox(credentials: Credentials): () => void {
    void sendKept(credentials)
    return recoveries.subscribe(() => {
        void sendKept(credentials)
    })
}
