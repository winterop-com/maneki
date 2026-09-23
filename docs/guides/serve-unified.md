# maneki serve

`maneki serve <root>` is the only serve command. It scans `<root>` recursively and auto-mounts whichever kinds have content: the Subsonic API at `/audio/rest/*` when audio is present, the Maneki-native video API at `/video/api/*` when video is present, the audiobook API at `/books/api/*` when `<root>` has an `Audiobooks/` folder, and the web client at `/` (on by default; `--no-ui` for an API-only server).

There is no `<root>/audio/` or `<root>/videos/` subdirectory convention. You can have everything flat under one root, or nested in any layout — the audio scanner picks up dirs containing audio files (treating the dir-above as the artist) and the video scanner picks up matching files at any depth. The SPA's AUDIO/VIDEO rail self-hides when only one kind is mounted.

## Quick start

```bash
maneki serve ~/Downloads/library
# maneki serve starting   flags='workers=auto' host=127.0.0.1 port=8765 root=/Users/morteoh/Downloads/library
# Uvicorn running on http://127.0.0.1:8765

# With the web SPA at /:
maneki serve ~/Downloads/library

# Video-side: opt into / out of cache prewarm + contact-sheet posters
maneki serve ~/library --prewarm-cache              # populate thumbs / posters / subs at startup
maneki serve ~/library --no-cover-images            # skip contact sheets; fall back to row thumbnail
maneki serve ~/library --rescan                     # rebuild every library from the files first
```

Then:

```bash
curl -s http://127.0.0.1:8765/capabilities | jq
# {
#   "server": "maneki",
#   "version": "0.9.0",
#   "audio": true,
#   "video": true,
#   "youtube": true,
#   "radio": true,
#   "books": true,
#   "endpoints": {
#     "audio_subsonic": "/audio/rest",
#     "video_api": "/video/api",
#     "books_api": "/books/api"
#   }
# }
```

## URL layout

```
host:port/capabilities          server identity + which kinds are mounted (public)
host:port/auth/login            POST username + password -> bearer token
host:port/auth/me               GET /me with Bearer header -> who you are
host:port/audio/rest/*          Subsonic API (its own auth grammar; unaffected by --auth)
host:port/video/api/*           Maneki-native video JSON API
host:port/books/api/*           Maneki-native audiobook JSON API (when <root>/Audiobooks/ exists)
host:port/video/                throwaway demo HTML page (retired when SPA lands)
```

External clients:

- **Subsonic clients** (Symfonium, Amperfy, play:Sub, Feishin, ...) — set the server URL to `https://host:port/audio` and the client will append `/rest/` itself.
- **Maneki clients** (the forthcoming SPA video tab) — hit `/capabilities`, then `/video/api/*` for video.
- **Browser quick check** — open `http://host:port/video/` for the demo page.

## Auto-detection

`maneki serve <root>` walks the library root once at startup and decides what to mount based on what files it finds:

| If `<root>` contains | Behaviour |
|---|---|
| Audio + video files | Both libraries browsable; SPA shows the AUDIO/VIDEO rail |
| Only audio files | `/capabilities` reports `audio: true, video: false`; the video list is empty |
| Only video files | `/capabilities` reports `audio: false, video: true`; the audio library browses empty |
| Neither | `audio: false, video: false` — a pure internet-radio + YouTube player |

Two top-level folders are never part of either library, whatever they hold: `inbox/`, where raw rips wait for `maneki audio convert` and `maneki books import`, and `Audiobooks/`, the audiobook section. The names match in any case, and only directly under `<root>`, so an album folder called `Music/Inbox/` is still music. The music and video watchers ignore both folders too, so copying a batch into `inbox/` triggers no rescan.

When `Audiobooks/` exists, `/capabilities` reports `books: true`, the books API is mounted at `/books/api/*`, and the Subsonic mount reports a second music folder (`Audiobooks`) that clients can browse on its own. The books index fills from a background scan after startup (warm starts reuse the rows in `.maneki/index.db`), and a watcher on `Audiobooks/` picks up newly imported books a few seconds after they land. See [`maneki books import`](books.md#serving).

Both mounts are always present, because each also hosts a remote source that needs nothing on disk: internet radio (`getInternetRadioStations`, the ICY proxy) on `/audio/rest/*`, YouTube on `/video/api/*`. What the scan decides is the *content* of the local half, reported by the `audio` / `video` flags — so a client can tell "nothing to browse here" from "this mount does not exist". The local library scan itself is still gated on finding files of that kind, so a radio-only root pays no walk and gets no `.maneki/index.db` written into it.

There is no kind-toggle flag: to serve only audio, point at an audio-only root; to serve only video, point at a video-only root; to run Maneki as a pure radio player, point it at an empty directory. The single-library design is the whole point.

## Options

```
maneki serve <root> [--host HOST] [--port PORT] [--no-ui] [--auth] [--workers N]

  <root>          Library root - scanned recursively for both audio and video
  --host HOST     Interface to bind (default 0.0.0.0, every interface; 127.0.0.1 keeps it local)
  --port PORT     Port to bind (default 8765)
  --no-ui         Leave the web client out and serve the APIs alone
  --auth          Require bearer-token auth on /video/* endpoints
  --workers N     Background transcode workers (default 0 = cpu_count // 2, capped 4)
```

The defaults bind to localhost on port 8765. To expose on the LAN or Tailscale, pass `--host 0.0.0.0`.

## Auth

**The audio (Subsonic) mount** keeps its own auth grammar (salt + token query params per the Subsonic spec). Credentials resolve from `~/.config/maneki/maneki.toml` `[server]` section, falling back to `admin`/`admin` with a yellow warning at startup. This is unchanged by `--auth`.

**The Maneki-native endpoints** (`/video/*` and `/books/*`) optionally require a bearer token. Auth is off by default so the demo page keeps working. Enable with `--auth`:

```bash
maneki serve ~/Downloads/library --auth
```

When auth is on:

1. `POST /auth/login` with `{username, password}` returns a token + expiry.
2. Send `Authorization: Bearer <token>` on every request to `/video/*`.
3. `/capabilities`, `/auth/login`, the audio mount, and the demo page at `/video/` stay public.

```bash
# Get a token
TOKEN=$(curl -sS -X POST http://localhost:8765/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' \
  | jq -r .token)

# Use it
curl -H "Authorization: Bearer $TOKEN" http://localhost:8765/video/api/videos
curl -H "Authorization: Bearer $TOKEN" http://localhost:8765/auth/me
```

Tokens live in memory and expire after 24 hours (or when the server restarts).

**Media URLs carry the token as `?token=<token>` instead of a header.** A `<video>` source, an `<img>` poster or cover, a `<track>` subtitle, an `<audio>` book file and an `EventSource` are all fetched by the browser out of an address, and an address has nowhere to put an `Authorization` header — so without a second way to present the token, `--auth` would leave the client signed in and every picture and stream under it answering 401. The same token in the query is validated exactly as the header is, but only on the routes one of those elements actually fetches (video `stream`, `play`, `poster`, `thumbnail`, `hls/*`, `subtitles/<track>` and `stats/stream`; books `cover` and `files/<n>`), and only on a GET. A token in a URL ends up in browser history and in anything that copies a link, so every JSON API keeps the header and answers 401 to `?token=` alone. An HLS manifest names its segments relatively and a relative URL does not inherit the manifest's query, so the server stamps the token back onto each segment URI itself. The access log records the path and never the query, which is what keeps this token — and Subsonic's `p=` and `t=` — out of the log line.

The demo page at `/video/` does NOT yet drive the login flow, so when `--auth` is on the demo can't play videos. Use the API directly until the SPA video tab lands.

Same credentials as the audio Subsonic mount — one password sourced from the same TOML.

## Keeping it running

A server started from a shell dies with the shell, and does not come back
after a reboot -- which is how a library that worked all week is missing
on the one morning somebody reaches for it from a train.

### macOS (launchd)

Write `~/Library/LaunchAgents/com.maneki.serve.plist`, substituting the
path to the binary (`which maneki`), the library root, and the hostname
the machine is reached by:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.maneki.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.local/bin/maneki</string>
    <string>serve</string>
    <string>/Volumes/Media</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/maneki.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/maneki.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.maneki.serve.plist
launchctl kickstart -k gui/$(id -u)/com.maneki.serve   # restart after an upgrade
launchctl print gui/$(id -u)/com.maneki.serve | head   # is it running
```

`KeepAlive` restarts the process if it exits; `RunAtLoad` starts it at
login. An external library disk that is not mounted yet is the one case
worth knowing about: the server starts, finds nothing, and the first scan
is empty -- `launchctl kickstart -k` once the disk is mounted fixes it.

### Linux (systemd)

```ini
# ~/.config/systemd/user/maneki.service
[Unit]
Description=maneki
After=network-online.target

[Service]
ExecStart=%h/.local/bin/maneki serve /srv/media
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now maneki
loginctl enable-linger "$USER"   # so it runs with nobody logged in
```

## Multiple libraries

`maneki serve` runs against one root at a time. To serve several libraries, run several processes on different ports — eg one for music and one for movies if they live on separate disks.

## See also

- [`maneki info` / `list` / `inspect`](library.md) — cross-cutting library info / list / inspect for any root
- [`maneki video`](video.md) — what the video pipeline does (HLS, subtitles, posters, folder browser)
