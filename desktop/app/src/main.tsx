import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'

import App from '@/App'
import { Toaster } from '@/components/ui/sonner'
import { installWindowDrag } from '@/lib/window-drag'
import '@/index.css'

// The shell's top strip is the window's title bar, and in one of the three homes dragging it
// has to be asked for rather than declared. Once, on the document, before anything is drawn.
installWindowDrag()

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
