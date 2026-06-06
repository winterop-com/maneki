// Preload script - runs before the renderer page loads. Exposes a small
// native bridge to the React frontend at `desktop/react/`. The SPA persists
// its own state (server list, session) in localStorage exactly like the
// plain-browser build, so no storage bridge is needed here. This preload
// only touches `electron` built-ins, which keeps the renderer sandboxed.

const { contextBridge, ipcRenderer } = require("electron");

// Native desktop bridge - things that don't have a useful HTML5
// equivalent. The flagship use is window-level fullscreen, which on
// macOS opens a separate Space and hides the menu bar + dock - the
// HTML5 Fullscreen API does neither.
contextBridge.exposeInMainWorld("__manekiDesktop", {
  setFullscreen: (on) => ipcRenderer.invoke("desktop:setFullscreen", !!on),
  isFullscreen: () => ipcRenderer.invoke("desktop:isFullscreen"),
});
