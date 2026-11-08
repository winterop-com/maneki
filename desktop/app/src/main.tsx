import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'

import App from '@/App'
import { Toaster } from '@/components/ui/sonner'
import { useNowPlaying } from '@/lib/media-session'
import '@/index.css'

// A browser keeps its own copy of the app (`service-worker.js`), so with the server out of
// reach a reload still opens on what was downloaded. The desktop shells carry the app on disk.
if (
    import.meta.env.PROD &&
    'serviceWorker' in navigator &&
    document.documentElement.dataset.shell === 'browser'
) {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined)
}

/**
 * Hash routing, because the bundle is also opened from disk.
 *
 * The Electron shell loads `index.html` over `file://`, where a path route
 * has no server to answer it and a reload lands on a blank window. A hash
 * route is the same string in all three shells.
 */
/** The OS's media keys and Now Playing, and the window's title, for the whole app. */
function NowPlaying() {
    useNowPlaying()
    return null
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <HashRouter>
            <App />
        </HashRouter>
        <NowPlaying />
        <Toaster richColors />
    </StrictMode>,
)
