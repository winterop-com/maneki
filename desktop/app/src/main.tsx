import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Link } from 'react-router'
import { LinkProvider, type RoutedLinkProps } from '@winterop-com/sokkel-ui/Link'

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

/**
 * Every internal link the library draws (the rail's entries and mark among them), as the router's
 * link, so a hash route is followed rather than reloaded.
 *
 * WebKit (the macOS app, Safari) leaves links out of the Tab order unless the reader turned a
 * system setting on, so without `tabIndex` the rail could not be reached from the keyboard.
 */
function routerLink({ href, ...props }: RoutedLinkProps) {
    return <Link to={href} tabIndex={0} {...props} />
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <HashRouter>
            <LinkProvider render={routerLink}>
                <App />
            </LinkProvider>
        </HashRouter>
        <NowPlaying />
        <Toaster richColors />
    </StrictMode>,
)
