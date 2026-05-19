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
  const tauriCore = window.__TAURI__?.core;
  const electronBridge = window.__mediakitDesktop;

  let kind = null;
  if (tauriCore && typeof tauriCore.invoke === "function") {
    kind = "tauri";
  } else if (electronBridge && typeof electronBridge.setFullscreen === "function") {
    kind = "electron";
  }

  async function setFullscreen(on) {
    try {
      if (kind === "tauri") {
        await tauriCore.invoke("set_fullscreen", { on: !!on });
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
      if (kind === "tauri") return await tauriCore.invoke("is_fullscreen");
      if (kind === "electron") return await electronBridge.isFullscreen();
    } catch (e) {
      console.warn("[MK_DESKTOP] isFullscreen failed:", e);
    }
    return false;
  }

  window.MK_DESKTOP = { kind, setFullscreen, isFullscreen };
})();
