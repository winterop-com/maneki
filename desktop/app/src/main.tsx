import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'

import App from '@/App'
import { Toaster } from '@/components/ui/sonner'
import { installMediaSession } from '@/lib/media-session'
import { installWindowDrag } from '@/lib/window-drag'
import '@/index.css'

// The shell's top strip is the window's title bar, and in one of the three homes dragging it
// has to be asked for rather than declared. Once, on the document, before anything is drawn.
installWindowDrag()
installMediaSession()

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
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <HashRouter>
                <App />
            </HashRouter>
            <Toaster richColors />
        </ThemeProvider>
    </StrictMode>,
)
