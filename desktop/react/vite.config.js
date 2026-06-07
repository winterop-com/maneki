import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

// Single source of truth for the version label: read pyproject.toml directly
// at build time. Avoids a separate sync step (and the make-ordering race that
// generating a define from sync_desktop_versions.py would create).
function projectVersion() {
  try {
    const toml = readFileSync(resolve(here, "../../pyproject.toml"), "utf8");
    return toml.match(/^version = "([^"]+)"/m)?.[1] ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export default defineConfig({
  root: here,
  // Relative asset paths so the same dist/ works under the FastAPI "/" mount,
  // Electron file://, and Tauri's custom protocol.
  base: "./",
  plugins: [react()],
  define: {
    __MK_VERSION__: JSON.stringify(projectVersion()),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The main bundle is ~270 KB; video.js is split into its own ~700 KB
    // chunk that loads lazily only when a video player mounts (see
    // video-views.jsx). That one library chunk can't be shrunk, so lift the
    // warning above it - the initial load is already small.
    chunkSizeWarningLimit: 800,
  },
  server: {
    // Fixed port so the Tauri/Electron dev shells can point at a known URL.
    port: 1421,
    strictPort: true,
  },
});
