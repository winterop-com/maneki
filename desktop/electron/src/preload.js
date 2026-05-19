// Preload script - runs before the renderer page loads, with access to
// Node + Electron APIs. Exposes `window.__manekiStore` for the React
// frontend at `desktop/react/` (which currently uses localStorage and
// doesn't need it, but kept for future native features: Now Playing
// widget, OS notifications, etc).

const { contextBridge, ipcRenderer } = require("electron");
const ElectronStore = require("electron-store");

// Single store instance, scoped to a JSON file in app.getPath('userData').
// The picker uses generic .get('servers') / .set('servers', ...) so the
// schema mirrors the Tauri build.
const store = new ElectronStore({
  name: "maneki-servers",
  // No schema - picker will write whatever shape it wants. Validation
  // happens picker-side (filter to {url, last_used_at} entries).
});

contextBridge.exposeInMainWorld("__manekiStore", {
  get: async (key) => store.get(key),
  set: async (key, value) => {
    store.set(key, value);
  },
  delete: async (key) => {
    store.delete(key);
  },
  // electron-store writes synchronously on every set; .save() is a
  // no-op so the picker's await chain stays uniform with the Tauri
  // path (which DOES require an explicit save()).
  save: async () => {},
});

// Native desktop bridge - things that don't have a useful HTML5
// equivalent. The flagship use is window-level fullscreen, which on
// macOS opens a separate Space and hides the menu bar + dock - the
// HTML5 Fullscreen API does neither.
contextBridge.exposeInMainWorld("__manekiDesktop", {
  setFullscreen: (on) => ipcRenderer.invoke("desktop:setFullscreen", !!on),
  isFullscreen: () => ipcRenderer.invoke("desktop:isFullscreen"),
});
