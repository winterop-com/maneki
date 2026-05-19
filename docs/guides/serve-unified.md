# Unified serve

`mediakit serve <root>` starts a single FastAPI process that exposes both audio and video over one port. It's the recommended way to run a mediakit server: one URL covers your whole library, external Subsonic clients and the (forthcoming) MediaKit-native web UI share a base.

For audio-only or video-only deployments, the kind-specific commands ([`mediakit audio serve`](serve.md), [`mediakit video serve`](video.md)) still work standalone with their own defaults.

## Quick start

```bash
mediakit serve ~/Downloads/library
# mediakit serve - /Users/morteoh/Downloads/library on http://127.0.0.1:8765
# INFO:     Uvicorn running on http://127.0.0.1:8765
```

Then:

```bash
curl -s http://127.0.0.1:8765/capabilities | jq
# {
#   "server": "mediakit",
#   "version": "0.1.0",
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
host:port/video/api/*           MediaKit-native video JSON API
host:port/video/                throwaway demo HTML page (retired when SPA lands)
```

External clients:

- **Subsonic clients** (Symfonium, Amperfy, play:Sub, Feishin, ...) — set the server URL to `https://host:port/audio` and the client will append `/rest/` itself.
- **MediaKit clients** (the forthcoming SPA video tab) — hit `/capabilities`, then `/video/api/*` for video.
- **Browser quick check** — open `http://host:port/video/` for the demo page.

## Autodetect + flags

`mediakit serve <root>` inspects the library root and mounts what's there:

| If `<root>` contains | Behaviour |
|---|---|
| `audio/` and `videos/` | Both protocols mounted |
| Only `audio/` (or `music/`) | Only the Subsonic mount; `/video/*` returns 404 |
| Only `videos/` (or `video/`) | Only the video mount; `/audio/*` returns 404 |
| Neither | Empty server — `/capabilities` reports `audio: false, video: false` |

Override the autodetect:

```bash
mediakit serve <root> --audio-only      # mount only audio, even if videos/ exists
mediakit serve <root> --video-only      # mount only video, even if audio/ exists
```

`--audio-only` and `--video-only` are mutually exclusive (specifying both is a usage error).

## Options

```
mediakit serve <root> [--host HOST] [--port PORT] [--audio-only | --video-only] [--auth]

  <root>          Library root containing audio/ and/or videos/ subdirectories
  --host HOST     Interface to bind (default 127.0.0.1)
  --port PORT     Port to bind (default 8765)
  --audio-only    Mount only the audio (Subsonic) endpoints
  --video-only    Mount only the video endpoints
  --auth          Require bearer-token auth on /video/* endpoints
```

The defaults bind to localhost on port 8765. To expose on the LAN or Tailscale, pass `--host 0.0.0.0`.

## Auth

**The audio (Subsonic) mount** keeps its own auth grammar (salt + token query params per the Subsonic spec). Credentials resolve from `~/.config/mediakit/mediakit.toml` `[server]` section, falling back to `admin`/`admin` with a yellow warning at startup. This is unchanged by `--auth`.

**The MediaKit-native endpoints** (`/video/*` today, more later) optionally require a bearer token. Auth is off by default so the demo page keeps working. Enable with `--auth`:

```bash
mediakit serve ~/Downloads/library --auth
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

## Configuring multiple libraries

The unified server runs against one root at a time. To serve multiple libraries, run multiple processes on different ports — or use [`mediakit library`](library.md) (which reads `~/.config/mediakit/mediakit.toml` `[libraries].locations`) for cross-library summary / scan operations on the CLI side.

## See also

- [`mediakit audio serve`](serve.md) — standalone Subsonic server (more granular options, the original Stage 1 surface)
- [`mediakit video serve`](video.md) — standalone video server (used by the unified serve internally)
- [`mediakit library`](library.md) — cross-cutting library summary / scan
