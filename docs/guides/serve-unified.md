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
host:port/capabilities         server identity + which kinds are mounted
host:port/audio/rest/*         Subsonic API (audio = Subsonic, mounted here)
host:port/video/api/*          MediaKit-native video JSON API
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
mediakit serve <root> [--host HOST] [--port PORT] [--audio-only | --video-only]

  <root>          Library root containing audio/ and/or videos/ subdirectories
  --host HOST     Interface to bind (default 127.0.0.1)
  --port PORT     Port to bind (default 8765)
  --audio-only    Mount only the audio (Subsonic) endpoints
  --video-only    Mount only the video endpoints
```

The defaults bind to localhost on port 8765. To expose on the LAN or Tailscale, pass `--host 0.0.0.0`.

## Auth (current state)

The audio (Subsonic) mount uses the same credential resolution as standalone [`mediakit audio serve`](serve.md): TOML config at `~/.config/mediakit/mediakit.toml` `[server]` section, falling back to `admin`/`admin` with a yellow warning at startup.

The video and `/capabilities` endpoints have **no auth** in the current base layer. A unified bearer-token auth at `/auth/login` is in the Stage 2 plan but not yet built — until it lands, restrict exposure to localhost or trusted networks (Tailscale / VPN).

## Configuring multiple libraries

The unified server runs against one root at a time. To serve multiple libraries, run multiple processes on different ports — or use [`mediakit library`](library.md) (which reads `~/.config/mediakit/mediakit.toml` `[libraries].locations`) for cross-library summary / scan operations on the CLI side.

## See also

- [`mediakit audio serve`](serve.md) — standalone Subsonic server (more granular options, the original Stage 1 surface)
- [`mediakit video serve`](video.md) — standalone video server (used by the unified serve internally)
- [`mediakit library`](library.md) — cross-cutting library summary / scan
