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
 * around it; asking the shell instead is what takes the whole display. A browser tab has no
 * shell to ask and gets the standard API, so a caller never has to know which it got.
 *
 * WHAT IS PURE IS SEPARATE. Deciding which shell a user agent describes and which addresses are
 * worth probing are the two decisions worth a test, and neither needs a window to make.
 */

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

/**
 * Fill the display.
 *
 * Answers whether it worked, so a caller can fall back to its own in-page stage rather than
 * leaving somebody looking at a window that did not change. A shell whose bridge is missing or
 * refuses is the browser case, and takes the standard API.
 */
export async function requestNativeFullscreen(): Promise<boolean> {
    const tauri = tauriWindow()
    if (tauri?.setFullscreen) {
        await tauri.setFullscreen(true)
        return isNativeFullscreen()
    }
    const bridge = electronBridge()
    if (bridge) return bridge.setFullscreen(true)
    if (typeof document === 'undefined' || document.fullscreenElement !== null) return true
    await document.documentElement.requestFullscreen()
    return true
}

/** Give the display back. */
export async function exitNativeFullscreen(): Promise<boolean> {
    const tauri = tauriWindow()
    if (tauri?.setFullscreen) {
        await tauri.setFullscreen(false)
        return !(await isNativeFullscreen())
    }
    const bridge = electronBridge()
    if (bridge) return !(await bridge.setFullscreen(false))
    if (typeof document === 'undefined' || document.fullscreenElement === null) return true
    await document.exitFullscreen()
    return true
}

/**
 * Move the window with the pointer that is already down, where there is a window to move.
 *
 * ONLY ONE SHELL NEEDS ASKING. Electron's Chromium moves its own window out of the
 * `-webkit-app-region: drag` the top strip wears in index.css, and a browser tab has no window
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

/** Whether the display is filled, asked of whoever is holding it. */
export async function isNativeFullscreen(): Promise<boolean> {
    const tauri = tauriWindow()
    if (tauri?.isFullscreen) return tauri.isFullscreen()
    const bridge = electronBridge()
    if (bridge) return bridge.isFullscreen()
    return typeof document !== 'undefined' && document.fullscreenElement !== null
}
