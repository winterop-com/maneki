import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `mediakit serve --ui` serves the built bundle from <repo>/desktop/spa/dist/.
// Vite's dev server runs on http://localhost:5173 by default; configure a
// proxy so /capabilities, /auth/*, /audio/* and /video/* during local dev
// reach the Python server (default :8765) without CORS gymnastics.
export default defineConfig({
  plugins: [react()],
  // SPA is served under /ui/ by `mediakit serve --ui`, so all asset URLs in
  // the built index.html need to be prefixed accordingly. The Vite dev server
  // serves at "/" but the same `base` keeps things consistent there too -
  // hit http://localhost:5173/ui/ during dev.
  base: "/ui/",
  server: {
    port: 5173,
    proxy: {
      "/capabilities": "http://localhost:8765",
      "/auth": "http://localhost:8765",
      "/audio": "http://localhost:8765",
      "/video": "http://localhost:8765",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
