import { useEffect, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useStore } from '@/hooks/use-store'
import { probe } from '@/lib/api'
import { currentShell, probeOrigins } from '@/lib/desktop'
import { connect, sessionStore, signInTo } from '@/lib/session'

export const CHANGE_SERVER_LABEL = 'Connect to a different server'

/**
 * The way in: which server, and credentials when it asks for them.
 *
 * THE SERVER IS FOUND RATHER THAN TYPED, WHEREVER IT CAN BE. A browser tab was served this
 * bundle by a maneki instance, so the answer is the origin it came from and asking for it is
 * asking somebody to read their own address bar. A desktop shell loaded the bundle off disk and
 * has no origin at all, so it asks the address `maneki serve` listens on -- which is where the
 * server is in the case the shells exist for, somebody running one on the machine in front of
 * them. `lib/desktop` decides which addresses that is; this asks them in order and takes the
 * first that answers.
 *
 * FOUND MEANS THE FIELD GOES, NOT THAT IT IS FILLED IN. A box holding an address nobody needs
 * to change is a question on a screen whose only real question is who is asking. It comes back
 * behind a link, for the server this client was not served by and did not guess.
 *
 * THE BUTTON IS SHUT WHILE THE PROBE IS OUT. Half a second of looking is shorter than anybody
 * can fill in a password, and a form submitted against an address about to be replaced would
 * sign in to the wrong server.
 */
export function SignIn() {
    const session = useStore(sessionStore)
    const [baseUrl, setBaseUrl] = useState(session.baseUrl)
    const [username, setUsername] = useState(session.username ?? '')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [looking, setLooking] = useState(true)
    const [found, setFound] = useState<string | null>(null)
    const [asking, setAsking] = useState(false)

    useEffect(() => {
        let live = true
        // ONE AT A TIME, IN ORDER. The first address that answers is the one this client should
        // use, and asking both together would race whatever is on the desk against the server
        // that actually sent the page. Written as a chain rather than a loop of awaits, which is
        // what a sequence of dependent questions is.
        const look = async (origins: readonly string[]): Promise<string | null> => {
            const [first, ...rest] = origins
            if (first === undefined) return null
            const caps = await probe(first)
            if (!live) return null
            return caps ? first : look(rest)
        }
        void look(probeOrigins(currentShell(), window.location.origin)).then((origin) => {
            if (!live) return
            if (origin !== null) {
                setFound(origin)
                setBaseUrl(origin)
            }
            setLooking(false)
        })
        return () => {
            live = false
        }
    }, [])

    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault()
        setBusy(true)
        const server = baseUrl.replace(/\/+$/, '')
        if (username) await signInTo(server, username, password)
        else await connect({ baseUrl: server })
        setBusy(false)
    }

    // The field stands where nothing was found, and where somebody asked for it back.
    const typing = asking || (!looking && found === null)

    return (
        <div className="flex h-svh items-center justify-center bg-background px-4">
            <form onSubmit={submit} className="w-full max-w-sm space-y-4">
                <h1 className="text-base">Maneki</h1>
                {typing ? (
                    <div className="space-y-2">
                        <Label htmlFor="server">Server</Label>
                        <Input
                            id="server"
                            value={baseUrl}
                            onChange={(event) => setBaseUrl(event.target.value)}
                            autoComplete="url"
                            required
                        />
                    </div>
                ) : (
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        {looking ? (
                            'Looking for a server.'
                        ) : (
                            <>
                                <span className="identifier">{found}</span>
                                <button
                                    type="button"
                                    className="control-link text-primary-ink underline-offset-2 hover:underline"
                                    onClick={() => {
                                        setAsking(true)
                                    }}
                                >
                                    {CHANGE_SERVER_LABEL}
                                </button>
                            </>
                        )}
                    </p>
                )}
                <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                        id="username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="username"
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                    />
                </div>
                {session.refusal && (
                    <p role="alert" className="text-sm text-critical-ink">
                        {session.refusal}
                    </p>
                )}
                <Button type="submit" disabled={busy || looking} className="w-full">
                    {busy ? 'Connecting' : 'Connect'}
                </Button>
            </form>
        </div>
    )
}
