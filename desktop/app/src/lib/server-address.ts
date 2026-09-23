/**
 * What somebody typed as a server, turned into the addresses worth asking.
 *
 * A PERSON TYPES A NAME, NOT A URL. `macmini` is how they know the machine; the scheme, the
 * port and the mount are the server's business, and asking for them on the door was asking
 * somebody to know how the server is started. So a bare name is tried the ways a maneki server
 * is actually reached, in order of likelihood: on its own port over plain http, then behind a
 * `tailscale serve` front over https with no port, then plain http on 80 for whatever else is
 * in front of it. The door asks each for `/capabilities` and takes the first that answers.
 *
 * WHAT WAS SPELLED OUT IS TRIED FIRST AND AS SPELLED. A full URL is a decision, and the list
 * only adds the default port behind it when none was given. The phone guide hands out the
 * address with `/audio` on the end, and that is the Subsonic mount rather than the server, so
 * a pasted one is taken back to the root rather than refused.
 *
 * Pure, so the order can be tested without a network.
 */

/** The port `maneki serve` listens on when nobody said otherwise. */
export const DEFAULT_PORT = 8765

/** The mounts a pasted address may end in, which are not where the client signs in. */
const MOUNTS = ['/audio', '/video', '/books', '/classic']

/** The addresses to try for what was typed, first the most likely, with nothing repeated. */
export function candidates(typed: string): string[] {
    const cleaned = stripMount(typed.trim().replace(/\/+$/, ''))
    if (cleaned === '') return []

    const spelled = /^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)
    const list: string[] = []
    if (spelled) {
        list.push(cleaned)
        // `http://macmini` without a port most likely means the server's own port; port 80
        // stays in the list because it was what was spelled.
        if (cleaned.startsWith('http://') && !hasPort(cleaned)) list.push(withPort(cleaned, DEFAULT_PORT))
    } else if (hasPort(`http://${cleaned}`)) {
        list.push(`http://${cleaned}`, `https://${cleaned}`)
    } else {
        list.push(`http://${cleaned}:${String(DEFAULT_PORT)}`, `https://${cleaned}`, `http://${cleaned}`)
    }
    return [...new Set(list)]
}

/** Whether a URL names a port explicitly. */
function hasPort(url: string): boolean {
    try {
        return new URL(url).port !== ''
    } catch {
        return false
    }
}

function withPort(url: string, port: number): string {
    try {
        const parsed = new URL(url)
        parsed.port = String(port)
        return parsed.toString().replace(/\/+$/, '')
    } catch {
        return url
    }
}

/** `http://host:8765/audio` is the phone's address; the client's is the root behind it. */
function stripMount(url: string): string {
    for (const mount of MOUNTS) {
        if (url.endsWith(mount)) return url.slice(0, -mount.length)
    }
    return url
}
