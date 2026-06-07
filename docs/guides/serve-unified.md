# maneki serve

`maneki serve <root>` is the only serve command. It scans `<root>` recursively and auto-mounts whichever kinds have content: the Subsonic API at `/audio/rest/*` when audio is present, the Maneki-native video API at `/video/api/*` when video is present, the web SPA at `/` with `--ui`.

There is no `<root>/audio/` or `<root>/videos/` subdirectory convention. You can have everything flat under one root, or nested in any layout — the audio scanner picks up dirs containing audio files (treating the dir-above as the artist) and the video scanner picks up matching files at any depth. The SPA's AUDIO/VIDEO rail self-hides when only one kind is mounted.

## Quick start

```bash
maneki serve ~/Downloads/library
# maneki serve starting   flags='workers=auto' host=127.0.0.1 port=8765 root=/Users/morteoh/Downloads/library
# Uvicorn running on http://127.0.0.1:8765

# With the web SPA at /:
maneki serve ~/Downloads/library --ui

# Video-side: opt into / out of cache prewarm + contact-sheet posters
maneki serve ~/library --ui --prewarm-cache         # populate thumbs / posters / subs at startup
maneki serve ~/library --ui --no-cover-images       # skip contact sheets; fall back to row thumbnail
maneki serve ~/library --ui --rescan                # wipe the on-disk video cache + DB rows first
```

Then:

```bash
curl -s http://127.0.0.1:8765/capabilities | jq
# {
#   "server": "maneki",
#   "version": "0.9.0",
#   "audio": true,
#   "video": true,
#   "endpoints": {
#     "audio_subsonic": "/audio/rest",
#     "video_api": "/video/api"
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
| Audio + video files | Both protocols mounted; SPA shows the AUDIO/VIDEO rail |
| Only audio files | Only the Subsonic mount; `/video/*` returns 404; SPA hides the rail |
| Only video files | Only the video mount; `/audio/*` returns 404; SPA hides the rail and auto-switches to video |
| Neither | Empty server — `/capabilities` reports `audio: false, video: false` |

There is no kind-toggle flag: to serve only audio, point at an audio-only root; to serve only video, point at a video-only root. The single-library design is the whole point.

## Options

```
maneki serve <root> [--host HOST] [--port PORT] [--ui] [--auth] [--workers N]

  <root>          Library root - scanned recursively for both audio and video
  --host HOST     Interface to bind (default 127.0.0.1)
  --port PORT     Port to bind (default 8765)
  --ui            Mount the web SPA at /
  --auth          Require bearer-token auth on /video/* endpoints
  --workers N     Background transcode workers (default 0 = cpu_count // 2, capped 4)
```

The defaults bind to localhost on port 8765. To expose on the LAN or Tailscale, pass `--host 0.0.0.0`.

## Auth

**The audio (Subsonic) mount** keeps its own auth grammar (salt + token query params per the Subsonic spec). Credentials resolve from `~/.config/maneki/maneki.toml` `[server]` section, falling back to `admin`/`admin` with a yellow warning at startup. This is unchanged by `--auth`.

**The Maneki-native endpoints** (`/video/*` today, more later) optionally require a bearer token. Auth is off by default so the demo page keeps working. Enable with `--auth`:

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

The demo page at `/video/` does NOT yet drive the login flow, so when `--auth` is on the demo can't play videos. Use the API directly until the SPA video tab lands.

Same credentials as the audio Subsonic mount — one password sourced from the same TOML.

## Multiple libraries

`maneki serve` runs against one root at a time. To serve several libraries, run several processes on different ports — eg one for music and one for movies if they live on separate disks.

## See also

- [`maneki info` / `list` / `inspect`](library.md) — cross-cutting library info / list / inspect for any root
- [`maneki video`](video.md) — what the video pipeline does (HLS, subtitles, posters, folder browser)
