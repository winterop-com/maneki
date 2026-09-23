import { Cat } from 'lucide-react'
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
import { VideoPage } from '@/pages/Video'
import { WatchPage } from '@/pages/Watch'
import { YouTubePage } from '@/pages/YouTube'

export default function App() {
    const session = useStore(sessionStore)

    useEffect(() => {
        void connect()
    }, [])

    // The player lives outside React and needs whatever the session holds.
    useEffect(() => {
        setPlayerCredentials(session.music)
    }, [session.music])

    // THE FIRST SECOND IS A SCREEN LIKE ANY OTHER. What `unknown` means is that the server has
    // not yet said what it has, which on a cold machine or a slow network is long enough to
    // read as an app that did not start. So it says whose it is and what it is doing -- the
    // mark, the name, and the one word that is true of it -- rather than painting a ground and
    // hoping the answer lands before anybody looks.
    if (session.phase === 'unknown') {
        return (
            <div className="flex h-svh flex-col items-center justify-center gap-3 bg-background text-foreground">
                <div className="flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        <Cat className="size-4" aria-hidden />
                    </span>
                    <span className="text-base font-semibold tracking-tight">Maneki</span>
                </div>
                <p className="text-sm text-muted-foreground">Connecting</p>
            </div>
        )
    }
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
                <Route path="/video" element={<VideoPage />} />
                {/* The splat carries the whole of a folder's path, so a season is a link. */}
                <Route path="/video/browse/*" element={<VideoPage />} />
                <Route path="/video/v/:videoId" element={<WatchPage />} />
                <Route path="/youtube" element={<YouTubePage />} />
                <Route path="/youtube/c/:channelId" element={<YouTubePage />} />
                <Route path="/youtube/v/:videoId" element={<YouTubePage />} />
                <Route
                    path="*"
                    element={<Navigate to={session.capabilities?.audio ? '/music' : '/books'} replace />}
                />
            </Routes>
        </AppShell>
    )
}
