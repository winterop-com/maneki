import { Cat, Radio as RadioIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useStore } from '@winterop-com/sokkel-ui/hooks/use-store'
import { SignIn as LibrarySignIn, type SignInProbe, type SignInValues } from '@winterop-com/sokkel-ui/SignIn'
import { LevelBars } from '@winterop-com/sokkel-ui/SignInArt'
import { NETWORK_REFUSAL } from '@/lib/connection'
import { probe } from '@/lib/api'
import { APP_VERSION } from '@/lib/app-version'
import { answering, candidates } from '@/lib/server-address'
import { currentShell, inDesktopShell, probeOrigins, useDesktopWindow } from '@/lib/desktop'
import { connect, hasKeptSignIn, listenWithoutServer, sessionStore, signInTo } from '@/lib/session'
import type { Capabilities } from '@/lib/types'

/** How often a kept sign-in asks a quiet server again. */
const KEPT_SIGN_IN_RETRY_MS = 10_000

/** How long the typing has to pause before the typed address is asked. */
const TYPED_ASK_DELAY_MS = 500

/** The sign-in screen's way to radio with no server. */
export const LISTEN_WITHOUT_SERVER_LABEL = 'Just listen to radio'

/** A server that answered, and where. */
interface Answer {
    origin: string
    caps: Capabilities
}

/**
 * The way in: which server, and credentials when it asks for them, drawn by sokkel-ui's `SignIn`.
 *
 * OUTSIDE THE SHELL, deliberately: there is no rail to draw for somebody who cannot reach any
 * of it. The library draws both panes; what is maneki's is finding the server, asking a typed
 * address as it is typed, and what signing in does.
 *
 * THE SERVER IS FOUND RATHER THAN TYPED, WHEREVER IT CAN BE. A browser tab was served this
 * bundle by a maneki instance, so the answer is the origin it came from. A desktop shell loaded
 * the bundle off disk and has no origin, so it asks the address `maneki serve` listens on.
 * `lib/desktop` decides which addresses that is; this asks them in order and takes the first
 * that answers. FOUND MEANS THE FIELD GOES: what was found is stated on the brand pane, and the
 * field comes back behind a link for the server this client was not served by and did not
 * guess.
 *
 * NOTHING IS REQUIRED BUT THE SERVER. A server without `--auth` takes a username alone, and one
 * with no accounts takes nothing, so the credentials are `optional` as a whole.
 *
 * NO REMEMBER ME. The sign-in is already kept on this device until somebody signs out, and the
 * server's token lifetime is fixed, so the box would promise nothing.
 */
export function SignIn() {
    const desktop = useDesktopWindow()
    const session = useStore(sessionStore)
    const [baseUrl, setBaseUrl] = useState(session.baseUrl)
    const [username, setUsername] = useState(session.username ?? '')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)
    const [looking, setLooking] = useState(true)
    const [found, setFound] = useState<Answer | null>(null)
    const [asking, setAsking] = useState(false)
    // THE REFUSAL IS SHOWN FOR WHAT THIS SCREEN ASKED, NOT FOR WHAT THE APP TRIED ON ITS WAY
    // HERE. The session carries the boot probe's failure -- a shell finding nothing on the desk
    // is one -- and a door that opened already saying "The server did not answer." would be
    // scolding somebody who has not typed anything yet.
    const [submitted, setSubmitted] = useState(false)
    // What the typed address answered, and for which spelling of it; see the effect below.
    const [heard, setHeard] = useState<{ typed: string; answer: Answer | null } | null>(null)
    // The server went quiet under a sign-in that is still good; see the footer below.
    const waiting = session.refusal === NETWORK_REFUSAL && hasKeptSignIn()
    useEffect(() => {
        if (!waiting) return
        const retrying = setInterval(() => {
            void connect()
        }, KEPT_SIGN_IN_RETRY_MS)
        return () => {
            clearInterval(retrying)
        }
    }, [waiting])

    useEffect(() => {
        let live = true
        // ONE AT A TIME, IN ORDER. The first address that answers is the one this client should
        // use, and asking both together would race whatever is on the desk against the server
        // that actually sent the page.
        const look = async (origins: readonly string[]): Promise<Answer | null> => {
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

    // The field stands where nothing was found, and where somebody asked for it back.
    const typing = asking || (!looking && found === null)

    // A TYPED ADDRESS IS ASKED AS IT IS TYPED, once the typing pauses, so the brand pane can say
    // which maneki is there, or that nothing answered, before a password is spent on it. Only
    // the latest spelling counts: an answer for one that has since been edited is dropped.
    useEffect(() => {
        if (!typing || baseUrl.trim() === '') return
        let live = true
        const timer = setTimeout(() => {
            void answering(baseUrl, probe).then((answer) => {
                if (live) setHeard({ typed: baseUrl, answer })
            })
        }, TYPED_ASK_DELAY_MS)
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [typing, baseUrl])
    const heardNow = typing && heard?.typed === baseUrl ? heard : null

    async function submit(): Promise<void> {
        setBusy(true)
        setSubmitted(true)
        // A NAME IS ENOUGH. `macmini` is tried the ways a server is reached -- see
        // `lib/server-address` -- and the first address that answers is the one signed in to.
        // When none answers, the likeliest is tried anyway so the refusal names it.
        const tried = candidates(baseUrl)
        const server = (await answering(baseUrl, probe))?.origin ?? tried[0] ?? baseUrl
        setBaseUrl(server)
        if (username) await signInTo(server, username, password)
        else await connect({ baseUrl: server }, true)
        setBusy(false)
    }

    const values: SignInValues = { server: baseUrl, user: username, password, token: '', remember: false }

    // WHAT THE BRAND PANE SAYS: whichever server has answered -- the one found, or the one typed
    // once it has been asked, so a wrong password still says which maneki it is -- or that
    // nothing answered there. A pane that has found nothing yet names nothing.
    let said: SignInProbe | undefined
    if (!typing) {
        said =
            found === null
                ? undefined
                : { server: found.origin, state: 'answered', version: found.caps.version }
    } else if (baseUrl.trim() !== '') {
        said =
            heardNow === null
                ? { server: baseUrl, state: 'asking' }
                : heardNow.answer === null
                  ? { server: baseUrl, state: 'silent' }
                  : {
                        server: heardNow.answer.origin,
                        state: 'answered',
                        version: heardNow.answer.caps.version,
                    }
    }

    return (
        <LibrarySignIn
            desktop={desktop}
            mark={<Cat aria-hidden />}
            name="maneki"
            eyebrow="Welcome to maneki"
            description={
                typing
                    ? 'Say where the server is, and who you are.'
                    : looking
                      ? 'Looking for a server.'
                      : 'Enter your credentials to continue.'
            }
            // What a record looks like while it plays, breathing, lit in the pane's accent.
            art={<LevelBars color="var(--terminal-accent)" className="h-full w-full" />}
            probe={said}
            // A shell's copy of the client is its own and drifts from the server's; a browser tab
            // was served the server's, so it has nothing to add there.
            facts={inDesktopShell() ? [{ label: 'app', value: APP_VERSION }] : []}
            server={looking ? 'looking' : found === null ? true : 'found'}
            onChangeServer={() => {
                setAsking(true)
            }}
            optional="credentials"
            icons
            values={values}
            onValuesChange={(next) => {
                setBaseUrl(next.server)
                setUsername(next.user)
                setPassword(next.password)
            }}
            error={submitted ? session.refusal : undefined}
            busy={busy}
            onSubmit={() => {
                void submit()
            }}
            words={{
                serverHint: 'macmini, or http://host:8765',
                userHint: 'Your username',
                passwordHint: 'Your password',
            }}
            // RADIO NEEDS NO SERVER. Somebody without one, or away from theirs, can still listen:
            // the built-in stations and the open directory, kept on this device.
            alternatives={
                <Button type="button" variant="outline" onClick={listenWithoutServer}>
                    <RadioIcon aria-hidden />
                    {LISTEN_WITHOUT_SERVER_LABEL}
                </Button>
            }
            // A SIGN-IN KEPT FROM BEFORE AND A SERVER THAT DID NOT ANSWER is not a door to knock at
            // again: the sign-in is still good and the server is away, so this says so, keeps
            // asking, and offers Retry.
            footer={
                !submitted && waiting ? (
                    <span
                        role="status"
                        className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-muted px-4 text-sm text-foreground"
                    >
                        <span className="min-w-0 flex-1">
                            No answer from <span className="font-mono">{session.baseUrl}</span>. Your sign-in
                            is kept; trying again.
                        </span>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                void connect()
                            }}
                        >
                            Retry
                        </Button>
                    </span>
                ) : undefined
            }
        />
    )
}
