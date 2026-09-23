import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

import { LOCAL_SERVER, probeOrigins, shellKind, type ShellKind } from '@/lib/desktop'

const SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const ELECTRON =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) maneki/0.18.2 Chrome/130.0.0.0 Electron/33.0.2 Safari/537.36'

describe('which shell this is', () => {
    test('is Tauri wherever its global is, whatever the user agent says', () => {
        // Tauri 2 serves the bundle over http from its own host and writes nothing of its own
        // into the user agent, so the global is the only honest signal.
        expect(shellKind(SAFARI, true)).toBe('tauri')
        expect(shellKind(ELECTRON, true)).toBe('tauri')
    })

    test('is Electron where the user agent says so and there is no Tauri', () => {
        expect(shellKind(ELECTRON, false)).toBe('electron')
    })

    test('does not care how the version is cased', () => {
        expect(shellKind('something electron/33.0.2 something', false)).toBe('electron')
        expect(shellKind('SOMETHING ELECTRON/33.0.2', false)).toBe('electron')
    })

    test('is a browser otherwise, including one with nothing to go on', () => {
        expect(shellKind(SAFARI, false)).toBe('browser')
        expect(shellKind('', false)).toBe('browser')
    })

    // "Electronic" and the like: the version is what makes it the shell rather than a word.
    test('is not fooled by a user agent that merely contains the word', () => {
        expect(shellKind('Mozilla/5.0 ElectronicArts/2.1', false)).toBe('browser')
    })
})

describe('which addresses the door asks', () => {
    test("a browser asks the origin that served it first, then the shells' default", () => {
        expect(probeOrigins('browser', 'https://maneki.example')).toEqual([
            'https://maneki.example',
            LOCAL_SERVER,
        ])
    })

    test('a shell has no origin worth asking and goes straight to the default', () => {
        expect(probeOrigins('tauri', 'http://tauri.localhost')).toEqual([LOCAL_SERVER])
        expect(probeOrigins('electron', 'file://')).toEqual([LOCAL_SERVER])
    })

    test('an origin no HTTP server can be behind is not an address', () => {
        expect(probeOrigins('browser', '')).toEqual([LOCAL_SERVER])
        expect(probeOrigins('browser', 'null')).toEqual([LOCAL_SERVER])
        expect(probeOrigins('browser', 'file:///Users/someone/app/index.html')).toEqual([LOCAL_SERVER])
    })

    // Two chances for one server to answer differently, and one wasted round trip.
    test('never asks one server the same question twice', () => {
        expect(probeOrigins('browser', LOCAL_SERVER)).toEqual([LOCAL_SERVER])
    })
})

/**
 * The shell and the platform are tagged on <html> before the first paint by an inline script in
 * index.html, which cannot import this module -- the traffic-light clearance and the drag
 * regions in index.css hang off what it writes, and a tag that landed a frame later would draw
 * the rail's mark under the window's own buttons and then move it. These assert the two copies
 * of the same test say the same thing.
 */
describe('the pre-paint tagging', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

    test('asks the Tauri global first and the user agent after it', () => {
        expect(html).toContain('window.__TAURI__')
        expect(html).toContain("'electron/'")
    })

    test('writes the attribute the shell rules hang off, with the names this module answers', () => {
        expect(html).toContain("'data-shell'")
        for (const kind of ['tauri', 'electron', 'browser'] satisfies ShellKind[]) {
            expect(html).toContain(`'${kind}'`)
        }
    })

    test('names the platform whose windows draw their buttons over the page', () => {
        expect(html).toContain("'data-platform'")
        expect(html).toContain("'darwin'")
    })
})
