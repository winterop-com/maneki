# Maneki Desktop

Two shells, one client. `tauri/` and `electron/` each open a window on the
bundle Vite builds from `desktop/app/`, which is the same bundle `maneki serve`
hands a browser tab. The shells add what a tab cannot have: a real fullscreen
that takes the whole display, a remembered window, and a home for a server that
is not the page's own origin.

## Layout

```
desktop/
├── app/                      the client: TypeScript, React, Tailwind, shadcn
│   ├── src/lib/desktop.ts       which shell this is, and the shell's fullscreen
│   └── dist/                    what `bun run build` produces and the shells load
├── react/                    the client before this one; served at /classic
├── tauri/src-tauri/          Rust shell: window bounds, plugins
└── electron/src/             Node main + sandboxed preload bridge
```

## How the client finds its server

A browser tab was served the bundle by a maneki instance, so the server is the
tab's own origin. A shell loaded the bundle off disk and has no origin, so the
sign-in screen probes `http://127.0.0.1:8765` and, when nothing answers there,
asks for an address. Enter `http://<host>:8765` (no `/audio`; that suffix is for
Subsonic apps) plus the username and password from `maneki.toml`.

The shells are told apart from a tab by what they inject: Tauri's global, and
the `Electron/` token in Electron's user agent. See `app/src/lib/desktop.ts`.

## Building

```bash
make desktop-tauri-dev          # Tauri window on the Vite dev server (port 1421)
make desktop-tauri-build        # release .app and .dmg under tauri/src-tauri/target/
make desktop-electron-dev       # Electron window on desktop/app/dist
make desktop-electron-build     # release .dmg under electron/dist/
make build                      # both, plus the Python wheel, collected into ./dist
```

Both release targets run `bun run build` in `desktop/app` first, so the shell
always ships the client at the repo's current version.
