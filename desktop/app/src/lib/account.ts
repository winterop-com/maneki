/**
 * What the account corner says about who is signed in, and where.
 *
 * Pure, so the corner's two facts are exercised without a DOM: the letter on the badge and the
 * name of the server the session is against.
 */

/** The letter on the badge: the name's first letter, or a mark that is not a blank circle. */
export function accountInitial(username: string | undefined): string {
    const first = username?.trim().charAt(0) ?? ''
    return first === '' ? '?' : first.toLocaleUpperCase()
}

/**
 * The server, as somebody would name it: its host, and the port when it is not the default.
 * A base URL that is not a URL (empty in a test, say) is shown as it is.
 */
export function serverHost(baseUrl: string): string {
    try {
        return new URL(baseUrl).host
    } catch {
        return baseUrl
    }
}
