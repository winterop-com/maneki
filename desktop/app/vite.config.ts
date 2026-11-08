import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { appearanceScript, SCHEME_KEY } from '@winterop-com/sokkel-ui/lib/appearance'

import { appVersionDefine } from './build-version.ts'
import { serviceWorker } from './service-worker.ts'

/**
 * The light or dark a reader chose, kept under the key next-themes used before sokkel-ui held the
 * scheme, copied once to sokkel-ui's key and dropped, so nobody's choice is lost in the move.
 */
const SCHEME_MOVE = `(function(){try{var l=localStorage,t=l.getItem('theme');if(t!==null){if((t==='light'||t==='dark')&&l.getItem(${JSON.stringify(SCHEME_KEY)})===null)l.setItem(${JSON.stringify(SCHEME_KEY)},t);l.removeItem('theme')}}catch(e){}})()`

/**
 * The scheme on `<html>` before the first paint, so a dark reader never sees a light frame first.
 * The palette, the density and the text scale are maneki's own and follow in `index.html`.
 */
const appearance: Plugin = {
    name: 'appearance',
    transformIndexHtml: () => [
        { tag: 'script', children: SCHEME_MOVE + ';' + appearanceScript(), injectTo: 'head-prepend' },
    ],
}

/**
 * Relative asset URLs, because this bundle is also opened from a file.
 *
 * The browser serves it from `/`, but the Electron shell loads `index.html`
 * off disk, where an absolute `/assets/...` resolves to the filesystem root
 * and every asset 404s. Hash routing (see `main.tsx`) is the same story for
 * routes.
 */
export default defineConfig({
    base: './',
    define: appVersionDefine(),
    plugins: [react(), tailwindcss(), appearance, serviceWorker()],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    build: { outDir: 'dist', emptyOutDir: true },
})
