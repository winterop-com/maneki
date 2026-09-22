import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router'

import { AppShell } from '@/components/AppShell'
import { useStore } from '@/hooks/use-store'
import { connect, sessionStore } from '@/lib/session'
import { BooksPage } from '@/pages/Books'
import { SignIn } from '@/pages/SignIn'
import { Soon } from '@/pages/Soon'

export default function App() {
    const session = useStore(sessionStore)

    useEffect(() => {
        void connect()
    }, [])

    if (session.phase === 'unknown') return <div className="h-svh bg-background" />
    if (session.phase === 'signed-out') return <SignIn />

    return (
        <AppShell>
            <Routes>
                <Route path="/books" element={<BooksPage />} />
                <Route path="/books/:bookId" element={<BooksPage />} />
                <Route path="/music/*" element={<Soon section="Music" />} />
                <Route path="/video/*" element={<Soon section="Video" />} />
                <Route
                    path="*"
                    element={<Navigate to={session.capabilities?.books ? '/books' : '/music'} replace />}
                />
            </Routes>
        </AppShell>
    )
}
