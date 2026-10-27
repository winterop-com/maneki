/*
 * The browser's copy of the app, so a page opened with the server out of reach still starts.
 *
 * Downloaded albums live in IndexedDB and play without the server, but in a browser the page
 * itself came from the server: with it gone, a reload was the browser's own "cannot connect"
 * and the albums behind it unreachable. This keeps the shell -- `index.html` and everything the
 * build emitted -- and answers with it when the network cannot.
 *
 * THE BUILD FILLS THIS IN. `service-worker.ts` writes it out as `sw.js` with the build's file
 * list and a cache name drawn from it, so every release is a changed worker: the browser
 * installs it, it fetches the new shell, and the old cache goes when it takes over.
 *
 * ONLY THE SHELL IS TOUCHED. The API, streams, covers and downloads go to the network exactly
 * as they would without a worker; nothing the server answers is kept here.
 *
 * THE NETWORK FIRST FOR THE PAGE, the cache first for the hashed files. A page load asks the
 * server, so a release shows up on the next reload; only a load that fails, or that a proxy
 * answers with a 5xx because maneki behind it is down, is answered from the cache.
 */

const CACHE = 'maneki-shell-__BUILD__'
const SHELL = __SHELL__

// The server's CORS layer marks every answer `Vary: Origin`, and a page's own `crossorigin`
// scripts carry an Origin the install's fetch did not: honouring it missed every script.
const MATCH = { ignoreSearch: true, ignoreVary: true }

const scope = new URL(self.registration.scope)
const page = new URL('./', scope).href
const kept = new Set(SHELL.map((path) => new URL(path, scope).pathname))
kept.add(scope.pathname)

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => cache.addAll(['./', ...SHELL]))
            .then(() => self.skipWaiting()),
    )
})

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((names) =>
                Promise.all(
                    names
                        .filter((name) => name.startsWith('maneki-shell-') && name !== CACHE)
                        .map((name) => caches.delete(name)),
                ),
            )
            .then(() => self.clients.claim()),
    )
})

/** The page from the server, or the kept one when the server cannot give it. */
async function pageFor(request) {
    try {
        const answer = await fetch(request)
        if (answer.status < 500) return answer
        return (await caches.match(page, MATCH)) ?? answer
    } catch (error) {
        const held = await caches.match(page, MATCH)
        if (held) return held
        throw error
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event
    if (request.method !== 'GET') return
    const url = new URL(request.url)
    if (url.origin !== scope.origin || !kept.has(url.pathname)) return
    if (request.mode === 'navigate') {
        event.respondWith(pageFor(request))
        return
    }
    event.respondWith(caches.match(request, MATCH).then((held) => held ?? fetch(request)))
})
