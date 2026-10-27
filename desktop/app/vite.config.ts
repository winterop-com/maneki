import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

import { appVersionDefine } from './build-version.ts'
import { serviceWorker } from './service-worker.ts'

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
    plugins: [react(), tailwindcss(), serviceWorker()],
    resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
    build: { outDir: 'dist', emptyOutDir: true },
})
