# `mediakit ui`

Static-serve the desktop SPA as a local web client against any Subsonic-compatible server. Unlike [`mediakit serve`](serve.md) (which IS a Subsonic server), `mediakit ui` is purely a client — point it at your own server, a friend's, a Navidrome install, anything that speaks the spec.

```bash
mediakit ui                                       # opens http://localhost:1888
mediakit ui --port 8080                           # different port
mediakit ui --url http://macair:4533 \            # pre-fill the picker
            --user admin --password admin
mediakit ui --no-open                             # skip auto-opening the browser
```

The SPA is the same code Tauri / Electron bundle, served over a tiny local HTTP server. The picker accepts a URL + credentials, stores them, and the rest of the session talks Subsonic directly to whatever server you typed.

## When to reach for `mediakit ui` instead of the desktop wrappers

| Want a | Use |
|---|---|
| Quick browser-based player against any Subsonic server | `mediakit ui` |
| Standalone macOS app with native window chrome, dock icon, media keys | `mediakit-tauri.dmg` / `mediakit-electron.dmg` |
| Browser tab against a server you don't admin | `mediakit ui --url http://...` |
| Dedicated client for daily driving | desktop wrapper (sticks around in the dock) |

Both surfaces share the same SPA — the visual + interaction is identical. The difference is just packaging.

## Pre-filling the picker

Optional `--url / --user / --password` get serialised into the page URL as query parameters that the picker reads on load. Useful for shell aliases or shortcuts:

```bash
alias mkmac='mediakit ui --url http://macair:4533 --user admin --password admin'
```

Password ends up in shell history this way — fine for a local LAN setup, less great for shared machines.

## Running as a background service

Mostly you launch `mediakit ui` on demand (it's a CLI command, not a daemon). If you want it always running on a dedicated kiosk / always-on machine, use the same systemd / launchd patterns documented under [`mediakit serve`](serve.md#running-as-a-background-service) — substitute the `ExecStart` / `ProgramArguments` for `mediakit ui --no-open --host 0.0.0.0 --port 1888`.
