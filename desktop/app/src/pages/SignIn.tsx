import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useStore } from '@/hooks/use-store'
import { connect, sessionStore, signInTo } from '@/lib/session'

/**
 * The way in: which server, and credentials when it asks for them.
 *
 * The server field is filled in already when the page came from a maneki
 * instance, which is every case but a desktop shell opening the bundle from
 * disk.
 */
export function SignIn() {
    const session = useStore(sessionStore)
    const [baseUrl, setBaseUrl] = useState(session.baseUrl)
    const [username, setUsername] = useState(session.username ?? '')
    const [password, setPassword] = useState('')
    const [busy, setBusy] = useState(false)

    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault()
        setBusy(true)
        const server = baseUrl.replace(/\/+$/, '')
        if (username) await signInTo(server, username, password)
        else await connect({ baseUrl: server })
        setBusy(false)
    }

    return (
        <div className="flex h-svh items-center justify-center bg-background px-4">
            <form onSubmit={submit} className="w-full max-w-sm space-y-4">
                <h1 className="text-base">Maneki</h1>
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
                <Button type="submit" disabled={busy} className="w-full">
                    {busy ? 'Connecting' : 'Connect'}
                </Button>
            </form>
        </div>
    )
}
