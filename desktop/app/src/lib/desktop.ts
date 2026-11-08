/**
 * What this bundle is running inside, and the one thing a shell can do that a tab cannot.
 *
 * ONE BUNDLE, THREE HOMES. The same files are served by maneki itself in a browser tab, loaded
 * from disk by the Tauri shell and loaded from disk by the Electron one. Almost nothing in the
 * app needs to know which, and the two places that do are here: where to look for a server when
 * there is no origin to ask, and how to fill the screen.
 *
 * THE PROTOCOL IS NOT THE ANSWER. Tauri 2 serves the bundle from `http://tauri.localhost/`
 * rather than from `file://` or `tauri://`, so a check on `window.location.protocol` says
 * "browser" inside the shell. What is read instead is the runtime globals each shell injects,
 * and the user agent, which Electron writes itself into.
 *
 * FULLSCREEN IS THE SHELL'S WHERE THERE IS ONE. The HTML5 Fullscreen API fills the window a
 * page is in, which inside a desktop shell is the shell's own window with its chrome still
 * around it; asking the shell instead is what takes the whole display. The window's call and
 * its state are handed to sokkel-ui's `desktop`, whose `lib/fullscreen` is what every part
 * goes full screen through; a browser tab hands it nothing and gets the standard API.
 *
 * WHAT IS PURE IS SEPARATE. Deciding which shell a user agent describes and which addresses are
 * worth probing are the two decisions worth a test, and neither needs a window to make.
 */

import { useEffect, useMemo, useState } from 'react'

import type { DesktopWindow } from '@winterop-com/sokkel-ui/lib/desktop'

/** Where the bundle is running. */
export type ShellKind = 'tauri' | 'electron' | 'browser'

/**
 * The address `maneki serve` listens on when nobody said otherwise.
 *
 * It exists for the shells: a bundle loaded from disk has no origin holding a server, so the
 * default is the only address it can guess at, and guessing right is the difference between a
 * door with nothing to type in it and a door asking for a URL.
 */
export const LOCAL_SERVER = 'http://127.0.0.1:8765'

/**
 * Which shell a user agent and a Tauri global describe.
 *
 * Tauri first, because its global is a fact about the runtime while a user agent is a string
 * anything may write. Electron puts `Electron/<version>` into its own, which is the only signal
 * it offers a renderer that has not been handed a preload bridge.
 */
export function shellKind(userAgent: string, hasTauri: boolean): ShellKind {
    if (hasTauri) return 'tauri'
    return userAgent.toLowerCase().includes('electron/') ? 'electron' : 'browser'
}

/**
 * The addresses worth asking for a server, in the order worth asking them.
 *
 * THE PAGE'S OWN ORIGIN COMES FIRST WHERE THERE IS ONE, because a bundle served by a maneki
 * instance is already talking to the server it should use, and probing anywhere else first
 * would point a browser tab at whatever happens to be on the desk rather than at the server
 * that sent it the page. A shell has no such origin -- the bundle came off disk -- so it has
 * only the default to try.
 *
 * `file:`, the empty origin and the string `null` a browser answers with for an opaque one are
 * not addresses: a request against any of them reaches no HTTP server at all, so none is
 * offered. The default is dropped when it is already the origin, because asking one server the
 * same question twice is one wasted round trip and two chances to answer differently.
 */
export function probeOrigins(shell: ShellKind, origin: string): string[] {
    const servable = origin !== '' && origin !== 'null' && !origin.startsWith('file:')
    const own = shell === 'browser' && servable ? [origin] : []
    return own[0] === LOCAL_SERVER ? own : [...own, LOCAL_SERVER]
}

/** Tauri 2 hands the current window out under two names, depending on the API generation. */
interface TauriWindow {
    setFullscreen?: (on: boolean) => Promise<void>
    isFullscreen?: () => Promise<boolean>
    onResized?: (handler: () => void) => Promise<() => void>
    startDragging?: () => Promise<void>
}

interface TauriGlobal {
    window?: { getCurrentWindow?: () => TauriWindow; getCurrent?: () => TauriWindow }
    webviewWindow?: { getCurrentWebviewWindow?: () => TauriWindow }
}

/** What the Electron shell's preload exposes. */
interface ElectronBridge {
    setFullscreen: (on: boolean) => Promise<boolean>
    isFullscreen: () => Promise<boolean>
    /** The window's 'enter-full-screen' and 'leave-full-screen', however it got there. */
    onFullscreenChange?: (listener: (on: boolean) => void) => () => void
}

/**
 * The names the shells inject, which are theirs rather than ours.
 *
 * Written as keys rather than spelled at each access: nothing in this app is named with leading
 * underscores, and these two are read from the window four times between them.
 */
const TAURI_GLOBAL = '__TAURI__'
const ELECTRON_GLOBAL = '__manekiDesktop'

interface ShellGlobals {
    [TAURI_GLOBAL]?: TauriGlobal
    [ELECTRON_GLOBAL]?: ElectronBridge
}

function globals(): ShellGlobals {
    return typeof window === 'undefined' ? {} : (window as unknown as ShellGlobals)
}

/** Which shell this document is actually in. */
export function currentShell(): ShellKind {
    const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
    return shellKind(agent, globals()[TAURI_GLOBAL] !== undefined)
}

/** Whether this is running inside one of the desktop shells rather than a browser tab. */
export function inDesktopShell(): boolean {
    return currentShell() !== 'browser'
}

/**
 * The Tauri window, under whichever name this plugin generation publishes it.
 *
 * Both are tried rather than one, so a plugin version bump is not a shell whose fullscreen
 * silently stops working.
 */
function tauriWindow(): TauriWindow | null {
    const tauri = globals()[TAURI_GLOBAL]
    if (!tauri) return null
    return (
        tauri.window?.getCurrentWindow?.() ??
        tauri.webviewWindow?.getCurrentWebviewWindow?.() ??
        tauri.window?.getCurrent?.() ??
        null
    )
}

function electronBridge(): ElectronBridge | null {
    const bridge = globals()[ELECTRON_GLOBAL]
    return bridge && typeof bridge.setFullscreen === 'function' ? bridge : null
}

/** Put the window in its own full screen, or take it out. */
function setWindowFullscreen(on: boolean): Promise<unknown> {
    const tauri = tauriWindow()
    if (tauri?.setFullscreen) return tauri.setFullscreen(on)
    return electronBridge()?.setFullscreen(on) ?? Promise.resolve()
}

/**
 * Move the window with the pointer that is already down, where there is a window to move.
 *
 * ONLY ONE SHELL NEEDS ASKING. Electron's Chromium moves its own window out of the
 * `-webkit-app-region: drag` sokkel-ui puts on the top strip, and a browser tab has no window
 * of its own. Tauri's WKWebView honours neither that property nor Tauri's own drag attribute
 * on a tree React renders after mount, so there the press is handed to the window here.
 *
 * Answers whether a window took it, which is the caller's cue that there was nothing to do.
 */
export async function startNativeWindowDrag(): Promise<boolean> {
    const tauri = tauriWindow()
    if (!tauri?.startDragging) return false
    await tauri.startDragging()
    return true
}

/**
 * Follow the window in and out of its own full screen, however it got there: the library's call,
 * the green button, the menu. Answers with the way to stop.
 *
 * Electron says so with the window's own events. Tauri has none for it, so a resize, which every
 * change of full screen is, is the cue to ask; the last resize of the animation answers true.
 */
function followWindowFullscreen(listener: (on: boolean) => void): () => void {
    const bridge = electronBridge()
    if (bridge?.onFullscreenChange) return bridge.onFullscreenChange(listener)
    const tauri = tauriWindow()
    if (!tauri?.onResized || !tauri.isFullscreen) return () => undefined
    const read = (): void => {
        tauri.isFullscreen?.().then(listener, () => {
            // A window that will not say is left where the library last put it.
        })
    }
    const stop: { unlisten: (() => void) | null; done: boolean } = { unlisten: null, done: false }
    tauri.onResized(read).then(
        (unlisten) => {
            if (stop.done) unlisten()
            else stop.unlisten = unlisten
        },
        () => undefined,
    )
    read()
    return () => {
        stop.done = true
        stop.unlisten?.()
    }
}

/**
 * The desktop window the frame stands in, as sokkel-ui's `desktop` takes it; undefined in a tab.
 *
 * Both shells hide the native title bar, so the frame's top strip is the title bar. On macOS the
 * window's traffic lights are drawn over its start, which `index.html` says with `data-platform`
 * before the first paint. Tauri's WKWebView ignores `app-region`, so there a press on the strip
 * is handed to the window here. Full screen is the window's own, through `setFullscreen`, and
 * `fullscreen` is what the caller last heard from it.
 */
export function desktopWindow(fullscreen = false): DesktopWindow | undefined {
    const shell = currentShell()
    if (shell === 'browser') return undefined
    return {
        trafficLights: document.documentElement.dataset.platform === 'darwin',
        fullscreen,
        setFullscreen: fullscreenWindow,
        onWindowDrag: shell === 'tauri' ? dragWindow : undefined,
    }
}

/** `desktopWindow`, with `fullscreen` following the window as it changes. */
export function useDesktopWindow(): DesktopWindow | undefined {
    const [fullscreen, setFullscreen] = useState(false)
    useEffect(() => followWindowFullscreen(setFullscreen), [])
    return useMemo(() => desktopWindow(fullscreen), [fullscreen])
}

function fullscreenWindow(on: boolean): void {
    setWindowFullscreen(on).catch((error: unknown) => {
        // The library already covers the window with the part, and leaving takes it off again.
        console.warn('the window did not change its full screen', error)
    })
}

function dragWindow(): void {
    startNativeWindowDrag().catch((error: unknown) => {
        // A window that will not move is the shell's business and not the app's: the press is
        // already spent, and there is nothing a screen could do about it.
        console.warn('the window did not take the drag', error)
    })
}
