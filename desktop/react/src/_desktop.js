// Tiny desktop-wrapper bridge. Exposes `window.MK_DESKTOP` with a
// unified API the SPA uses for things the browser can't do well:
//
//   await MK_DESKTOP.setFullscreen(true|false)
//   await MK_DESKTOP.isFullscreen()
//   MK_DESKTOP.kind   "tauri" | "electron" | null
//
// In a plain browser (no wrapper) `MK_DESKTOP.kind === null` and
// every method is a no-op that resolves to false, so the SPA can
// always call MK_DESKTOP without a guard. Callers that NEED native
// behaviour should check `kind` first and fall back to whatever
// HTML5 thing they had before.

(function () {
  const tauri = window.__TAURI__;
  const electronBridge = window.__manekiDesktop;

  let kind = null;
  if (tauri && (tauri.window || tauri.webviewWindow)) {
    kind = "tauri";
  } else if (electronBridge && typeof electronBridge.setFullscreen === "function") {
    kind = "electron";
  }

  // Tauri 2 exposes the current window via either
  // `__TAURI__.window.getCurrentWindow()` or
  // `__TAURI__.webviewWindow.getCurrentWebviewWindow()` depending on
  // the API generation. We try both so we work across plugin
  // version bumps. Returns null in non-Tauri contexts.
  function getTauriWindow() {
    if (!tauri) return null;
    if (typeof tauri.window?.getCurrentWindow === "function") return tauri.window.getCurrentWindow();
    if (typeof tauri.webviewWindow?.getCurrentWebviewWindow === "function") {
      return tauri.webviewWindow.getCurrentWebviewWindow();
    }
    if (typeof tauri.window?.getCurrent === "function") return tauri.window.getCurrent();
    return null;
  }

  async function setFullscreen(on) {
    try {
      if (kind === "tauri") {
        const win = getTauriWindow();
        if (!win || typeof win.setFullscreen !== "function") return false;
        await win.setFullscreen(!!on);
        return await isFullscreen();
      }
      if (kind === "electron") {
        return await electronBridge.setFullscreen(!!on);
      }
    } catch (e) {
      console.warn("[MK_DESKTOP] setFullscreen failed:", e);
    }
    return false;
  }

  async function isFullscreen() {
    try {
      if (kind === "tauri") {
        const win = getTauriWindow();
        if (!win || typeof win.isFullscreen !== "function") return false;
        return await win.isFullscreen();
      }
      if (kind === "electron") return await electronBridge.isFullscreen();
    } catch (e) {
      console.warn("[MK_DESKTOP] isFullscreen failed:", e);
    }
    return false;
  }

  window.MK_DESKTOP = { kind, setFullscreen, isFullscreen };
})();
