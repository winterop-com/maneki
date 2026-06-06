// Electron main process — opens a single BrowserWindow pointed at the
// shared `desktop/react/index.html`. The renderer page (the SPA) is
// identical to what Tauri loads; the only Electron-specific bits live
// in this file + `preload.js`.
//
// Window bounds persistence
// -------------------------
// `electron-window-state` v5 saved sub-min sizes during macOS minimize /
// fullscreen-exit, leaving every subsequent launch at a tiny window.
// We persist bounds ourselves to a small JSON file in userData with
// explicit guards: never save while minimized or fullscreen, never save
// a size below the configured min (720x480), and on restore re-validate
// the size before applying. Fallback is the 1440x900 default below.
//
// We read/write the file directly (no electron-store) — the only thing
// persisted is the window rectangle, so a 15-line `fs` helper needs no
// dependency and lets the preload stay sandboxed. The { "bounds": {...} }
// shape matches the previous electron-store file, so saved bounds carry
// over for existing installs.
//
// What we deliberately do NOT do:
//   - Auto-open DevTools. Press Cmd+Option+I when needed; auto-opening
//     on every launch obscures the small login window and makes the
//     "is the app working?" question harder to answer at a glance.

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const SAVE_DEBOUNCE_MS = 250;

// Separate file from the servers / session state so a corrupt window
// rectangle can never wedge the login flow. `app.getPath("userData")` is
// only valid after the app is ready, so resolve it lazily on each call.
const boundsFile = () => path.join(app.getPath("userData"), "maneki-window.json");

function readBoundsFile() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeBoundsFile(data) {
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(data));
  } catch {
    // Non-fatal: a failed save just means the next launch falls back to
    // the default size/position.
  }
}

let mainWindow;

function loadBounds() {
  const b = readBoundsFile().bounds;
  if (!b || typeof b !== "object") return null;
  if (typeof b.width !== "number" || typeof b.height !== "number") return null;
  if (b.width < MIN_WIDTH || b.height < MIN_HEIGHT) return null;
  return b;
}

// Verify the saved (x, y) still lands on a connected display. If the
// user unplugged the monitor the window was on, fall back to centering.
function isVisibleOnAnyDisplay(b) {
  if (typeof b.x !== "number" || typeof b.y !== "number") return false;
  const rect = { x: b.x, y: b.y, width: b.width, height: b.height };
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return (
      rect.x < wa.x + wa.width &&
      rect.x + rect.width > wa.x &&
      rect.y < wa.y + wa.height &&
      rect.y + rect.height > wa.y
    );
  });
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  const b = mainWindow.getBounds();
  if (b.width < MIN_WIDTH || b.height < MIN_HEIGHT) return;
  writeBoundsFile({ bounds: b });
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveBounds, SAVE_DEBOUNCE_MS);
}

function createWindow() {
  const saved = loadBounds();
  const usePosition = saved && isVisibleOnAnyDisplay(saved);

  mainWindow = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WIDTH,
    height: saved?.height ?? DEFAULT_HEIGHT,
    x: usePosition ? saved.x : undefined,
    y: usePosition ? saved.y : undefined,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    center: !usePosition,
    title: "Maneki",
    icon: path.join(__dirname, "..", "..", "tauri", "src-tauri", "icons", "icon.png"),
    // Hide the native title-bar text so our in-app topbar IS the title
    // bar — Spotify / Linear / Notion / VSCode all do this. On macOS,
    // `hiddenInset` keeps the traffic-light buttons in their usual top-
    // left position but drops the duplicated "Maneki" label. CSS in
    // `_app.css` adds ~78px of left padding to `.topbar` on darwin so
    // the search input doesn't sit under the traffic lights, and
    // marks the bar as `-webkit-app-region: drag` so it functions as
    // a drag handle like a native title bar.
    titleBarStyle: "hiddenInset",
    // Windows / Linux equivalent — overlay buttons over the topbar
    // colour so the visual cue is consistent across platforms.
    titleBarOverlay: {
      color: "#1a1b26",
      symbolColor: "#a9b1d6",
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload only touches `electron` built-ins now
    },
  });

  mainWindow.on("resize", scheduleSave);
  mainWindow.on("move", scheduleSave);
  mainWindow.on("close", saveBounds);

  mainWindow.loadFile(path.join(__dirname, "..", "..", "react", "index.html"));
}

// IPC: native fullscreen toggle for the renderer's MK_DESKTOP bridge.
// HTML5 Fullscreen API works for the video element only and on macOS
// leaves the menu bar peeking; mainWindow.setFullScreen(true) is the
// real macOS fullscreen (separate Space, everything hidden).
ipcMain.handle("desktop:setFullscreen", (_evt, on) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.setFullScreen(!!on);
  return mainWindow.isFullScreen();
});
ipcMain.handle("desktop:isFullscreen", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isFullScreen();
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS convention: keep the app alive when the last window closes
  // so users reopen via the dock; quit on other platforms.
  if (process.platform !== "darwin") app.quit();
});
