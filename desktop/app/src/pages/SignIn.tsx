import { ArrowRight, CircleAlert, Eye, EyeOff, Globe, Lock, User } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import { BrandPane } from '@/components/login/BrandPane'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useStore } from '@/hooks/use-store'
import { probe } from '@/lib/api'
import { candidates } from '@/lib/server-address'
import { currentShell, probeOrigins } from '@/lib/desktop'
import { connect, sessionStore, signInTo } from '@/lib/session'
import type { Capabilities } from '@/lib/types'

export const CHANGE_SERVER_LABEL = 'Connect to a different server'
export const SHOW_PASSWORD_LABEL = 'Show password'
export const HIDE_PASSWORD_LABEL = 'Hide password'

/**
 * The first of `origins` that answers `/capabilities`, asked one at a time, or null.
 *
 * One at a time on purpose: the list is in order of likelihood, and asking all of them at
 * once would let a slower, likelier answer lose to a faster, less likely one.
 */
async function firstAnswering(origins: readonly string[]): Promise<string | null> {
    const [first, ...rest] = origins
    if (first === undefined) return null
    return (await probe(first)) ? first : firstAnswering(rest)
}

/** The field treatment this screen alone wears: taller than a control, and edged in every palette. */
const FIELD = 'border-border-strong h-12 rounded-lg pl-11'

/**
 * The way in: which server, and credentials when it asks for them.
 *
 * OUTSIDE THE SHELL, deliberately: there is no rail to draw for somebody who cannot reach any
 * of it. TWO PANES, BECAUSE THE DOOR HAS TWO JOBS. The brand pane says what is behind it -- the
 * mark the rail wears, the wordmark, the server and the version it answered with -- and the
 * form pane asks the one question. Below lg they stack, brand first and compact.
 *
 * THE SERVER IS FOUND RATHER THAN TYPED, WHEREVER IT CAN BE. A browser tab was served this
 * bundle by a maneki instance, so the answer is the origin it came from. A desktop shell loaded
 * the bundle off disk and has no origin, so it asks the address `maneki serve` listens on.
 * `lib/desktop` decides which addresses that is; this asks them in order and takes the first
 * that answers. FOUND MEANS THE FIELD GOES: what was found is stated on the brand pane, and the
 * field comes back behind a link for the server this client was not served by and did not
 * guess.
 *
 * THE DOOR GREETS, AND NOTHING BEHIND IT DOES. This is the one screen a person meets before the
 * product's own facts are on it, so it carries an eyebrow, a heading at display size, a
 * one-line subtitle and placeholders -- and no other screen may copy any of it.
 *
 * THE REFUSAL IS THE SERVER'S OWN SENTENCE, AND IT TAKES NO ROOM. The form is centred in its
 * column, so a notice that took space would move every field the moment somebody got a
 * password wrong. It hangs below the button, out of the flow.
 */
export function SignIn() {
    const session = useStore(sessionStore)
    const [baseUrl, setBaseUrl] = useState(session.baseUrl)
    const [username, setUsername] = useState(session.username ?? '')
    const [password, setPassword] = useState('')
    const [shown, setShown] = useState(false)
    const [busy, setBusy] = useState(false)
    const [looking, setLooking] = useState(true)
    const [found, setFound] = useState<{ origin: string; caps: Capabilities } | null>(null)
    const [asking, setAsking] = useState(false)
    // THE REFUSAL IS SHOWN FOR WHAT THIS SCREEN ASKED, NOT FOR WHAT THE APP TRIED ON ITS WAY
    // HERE. The session carries the boot probe's failure -- a shell finding nothing on the desk
    // is one -- and a door that opened already saying "the server did not answer" would be
    // scolding somebody who has not typed anything yet.
    const [submitted, setSubmitted] = useState(false)

    useEffect(() => {
        let live = true
        // ONE AT A TIME, IN ORDER. The first address that answers is the one this client should
        // use, and asking both together would race whatever is on the desk against the server
        // that actually sent the page.
        const look = async (
            origins: readonly string[],
        ): Promise<{ origin: string; caps: Capabilities } | null> => {
            const [first, ...rest] = origins
            if (first === undefined) return null
            const caps = await probe(first)
            if (!live) return null
            return caps ? { origin: first, caps } : look(rest)
        }
        void look(probeOrigins(currentShell(), window.location.origin)).then((answer) => {
            if (!live) return
            if (answer !== null) {
                setFound(answer)
                setBaseUrl(answer.origin)
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
        setSubmitted(true)
        // A NAME IS ENOUGH. `macmini` is tried the ways a server is reached -- see
        // `lib/server-address` -- and the first address that answers is the one signed in to.
        // When none answers, the likeliest is tried anyway so the refusal names it.
        const tried = candidates(baseUrl)
        const server = (await firstAnswering(tried)) ?? tried[0] ?? baseUrl
        setBaseUrl(server)
        if (username) await signInTo(server, username, password)
        else await connect({ baseUrl: server }, true)
        setBusy(false)
    }

    // The field stands where nothing was found, and where somebody asked for it back.
    const typing = asking || (!looking && found === null)
    const server = typing ? (baseUrl === '' ? null : baseUrl) : (found?.origin ?? null)

    return (
        // The brand pane is bounded: never narrower than 560px, never wider than 1056px, so a
        // wide display spends what it gains on the form rather than on the mark.
        <div className="flex min-h-svh flex-col bg-background lg:grid lg:grid-cols-[minmax(35rem,45%)_1fr] xl:grid-cols-[clamp(35rem,52vw,66rem)_1fr]">
            {/* The version is whichever server has answered: the one found, or the one typed
                once a connect has reached it -- a wrong password still says which maneki it is. */}
            <BrandPane
                server={server}
                version={found?.caps.version ?? session.capabilities?.version ?? null}
            />
            {/* The form pane is the lit surface in the dark mode: against a brand pane that is
                dark in both, a form on the page ground would be one rung from it. */}
            <main className="relative flex flex-1 items-start justify-center p-6 lg:items-center lg:p-12 dark:bg-card">
                <form
                    className="relative grid w-full max-w-xs gap-5 xl:w-[26.875rem] xl:max-w-none"
                    onSubmit={(event) => {
                        void submit(event)
                    }}
                >
                    <div className="grid gap-2">
                        <p className="text-sm tracking-[0.18em] text-primary-ink uppercase">
                            Welcome to maneki
                        </p>
                        <h2 className="text-display font-semibold tracking-tight">Sign in</h2>
                        <p className="text-sm text-muted-foreground">
                            {typing
                                ? 'Say where the server is, and who you are.'
                                : looking
                                  ? 'Looking for a server.'
                                  : 'Enter your credentials to continue.'}
                        </p>
                    </div>

                    {typing ? (
                        <div className="grid gap-1.5">
                            <Label htmlFor="server">Server</Label>
                            <div className="relative">
                                <Globe
                                    className="pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2 text-muted-foreground"
                                    aria-hidden
                                />
                                <Input
                                    id="server"
                                    name="server"
                                    autoComplete="url"
                                    required
                                    placeholder="macmini, or http://host:8765"
                                    className={`${FIELD} font-mono`}
                                    value={baseUrl}
                                    onChange={(event) => {
                                        setBaseUrl(event.target.value)
                                    }}
                                />
                            </div>
                        </div>
                    ) : (
                        !looking && (
                            <p className="text-xs text-muted-foreground">
                                <button
                                    type="button"
                                    className="control-link text-primary-ink underline-offset-2 hover:underline"
                                    onClick={() => {
                                        setAsking(true)
                                    }}
                                >
                                    {CHANGE_SERVER_LABEL}
                                </button>
                            </p>
                        )
                    )}

                    <div className="grid gap-1.5">
                        <Label htmlFor="username">Username</Label>
                        <div className="relative">
                            <User
                                className="pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                id="username"
                                name="username"
                                autoComplete="username"
                                autoFocus={!typing}
                                required
                                placeholder="Your username"
                                className={FIELD}
                                value={username}
                                onChange={(event) => {
                                    setUsername(event.target.value)
                                }}
                            />
                        </div>
                    </div>

                    <div className="grid gap-1.5">
                        <Label htmlFor="password">Password</Label>
                        <div className="relative">
                            <Lock
                                className="pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                id="password"
                                name="password"
                                type={shown ? 'text' : 'password'}
                                autoComplete="current-password"
                                required
                                placeholder="Your password"
                                className={`${FIELD} pr-12`}
                                value={password}
                                onChange={(event) => {
                                    setPassword(event.target.value)
                                }}
                            />
                            <button
                                type="button"
                                aria-label={shown ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL}
                                aria-pressed={shown}
                                onClick={() => {
                                    setShown(!shown)
                                }}
                                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                            >
                                {shown ? (
                                    <EyeOff className="size-4.5" aria-hidden />
                                ) : (
                                    <Eye className="size-4.5" aria-hidden />
                                )}
                            </button>
                        </div>
                    </div>

                    <Button
                        type="submit"
                        className="h-13 w-full rounded-lg"
                        disabled={busy || looking}
                        title={busy ? 'Connecting' : undefined}
                    >
                        Connect
                        <ArrowRight className="size-4.5" aria-hidden />
                    </Button>

                    {submitted && session.refusal && (
                        <p
                            role="alert"
                            className="absolute inset-x-0 top-[calc(100%+1.5rem)] flex h-12 items-center gap-3 rounded-lg border border-critical/40 bg-critical/10 px-4 text-sm text-critical-ink"
                        >
                            <CircleAlert className="size-4 shrink-0" aria-hidden />
                            <span className="truncate">{session.refusal}</span>
                        </p>
                    )}
                </form>
            </main>
        </div>
    )
}
