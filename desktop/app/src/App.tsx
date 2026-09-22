import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router'

import { AppShell } from '@/components/AppShell'
import { useStore } from '@/hooks/use-store'
import { connect, sessionStore } from '@/lib/session'
import { setPlayerCredentials } from '@/lib/player'
import { BooksPage } from '@/pages/Books'
import { MusicPage } from '@/pages/Music'
import { RadioPage } from '@/pages/Radio'
import { SignIn } from '@/pages/SignIn'
import { Soon } from '@/pages/Soon'

export default function App() {
    const session = useStore(sessionStore)

    useEffect(() => {
        void connect()
    }, [])

    // The player lives outside React and needs whatever the session holds.
    useEffect(() => {
        setPlayerCredentials(session.music)
    }, [session.music])

    if (session.phase === 'unknown') return <div className="h-svh bg-background" />
    if (session.phase === 'signed-out') return <SignIn />

    return (
        <AppShell>
            <Routes>
                <Route path="/books" element={<BooksPage />} />
                <Route path="/books/:bookId" element={<BooksPage />} />
                <Route path="/music" element={<MusicPage />} />
                <Route path="/music/artist/:artistId" element={<MusicPage />} />
                <Route path="/music/album/:albumId" element={<MusicPage />} />
                <Route path="/music/starred" element={<MusicPage view="starred" />} />
                <Route path="/radio" element={<RadioPage />} />
                <Route path="/video/*" element={<Soon section="Video" />} />
                <Route
                    path="*"
                    element={<Navigate to={session.capabilities?.audio ? '/music' : '/books'} replace />}
                />
            </Routes>
        </AppShell>
    )
}
