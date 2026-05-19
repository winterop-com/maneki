# Video

`mediakit video serve` starts a minimal HTTP server that exposes the videos in your library via a clean MediaKit-native JSON API. The base layer (this page) does no transcoding and no UI — it streams raw bytes with HTTP Range support so an `<video>` element can play and seek directly when codecs are compatible.

## Quick start

```bash
mediakit video serve ~/Downloads/library
# mediakit video serve - /Users/morteoh/Downloads/library on http://127.0.0.1:8765
# INFO:     Uvicorn running on http://127.0.0.1:8765
```

Then in another terminal:

```bash
curl -s http://127.0.0.1:8765/capabilities | jq
# {
#   "server": "mediakit",
#   "version": "0.1.0",
#   "audio": false,
#   "video": true,
#   "video_count": 2
# }

curl -s http://127.0.0.1:8765/api/videos | jq
# [
#   {
#     "id": "The.Chair.Company.S01E01.1080p",
#     "name": "The.Chair.Company.S01E01.1080p",
#     "path": "/Users/morteoh/Downloads/library/videos/...",
#     "size_bytes": 2442979091,
#     "rel_path": "The.Chair.Company.S01E01.1080p.mkv"
#   },
#   ...
# ]
```

## Endpoints

The base layer ships three endpoints. All return JSON or media bytes; no HTML.

### `GET /capabilities`

Server identity + which kinds are present at the root.

```json
{
  "server": "mediakit",
  "version": "0.1.0",
  "audio": false,
  "video": true,
  "video_count": 2
}
```

The base layer is video-only by design (the audio side is currently the Stage 1 Subsonic server). A unified `mediakit serve` that exposes both is on the Stage 2 roadmap.

### `GET /api/videos`

Flat list of every video file under `<root>/videos/` (or `<root>/video/`). One entry per file:

```json
{
  "id": "The.Chair.Company.S01E01.1080p",
  "name": "The.Chair.Company.S01E01.1080p",
  "path": "/absolute/path/to/file.mkv",
  "size_bytes": 2442979091,
  "rel_path": "The.Chair.Company.S01E01.1080p.mkv"
}
```

The `id` is derived from the relative path under the videos directory — stable across rescans until the file is renamed or moved.

### `GET /api/videos/{id}/stream`

Serves the raw bytes with HTTP Range support, so a browser's `<video>` tag (or VLC, mpv, curl) can seek mid-file. Returns:

- `200 OK` for the full file when no Range header is present
- `206 Partial Content` with `Content-Range: bytes <start>-<end>/<total>` when a Range header is present
- `404` for unknown ids
- `416` for malformed or out-of-bounds Range headers

No transcoding. The Content-Type is derived from the file extension (`video/x-matroska` for `.mkv`, `video/mp4` for `.mp4` / `.m4v`, etc).

## Browser compatibility

What plays in a browser depends on the file's codecs:

| Codec combo (typical)     | Safari | Chrome | Firefox |
| ------------------------- | ------ | ------ | ------- |
| H.264 + AAC in MP4        | yes    | yes    | yes     |
| H.265 + AAC in MP4        | yes    | partial| no      |
| H.264 + AAC in MKV        | varies | no     | partial |
| H.264 + E-AC3 (5.1) in MKV| varies | no     | no      |
| H.265 + DTS / TrueHD      | no     | no     | no      |

For incompatible combinations, the base layer is not enough — you need the transcode layer (HLS) that lands next. For now, point an external player (VLC, mpv, Infuse) at the stream URL and it will play anything ffmpeg understands.

## Why the base layer

Stage 2's video work is built in layers:

1. **Base** (this page) — scan, list, raw stream. Done.
2. **Transcode** — ffmpeg pipeline: remux MKV→MP4 and re-encode incompatible audio for direct-play in browsers.
3. **HLS** — on-the-fly HLS playlist + segments for codecs the browser can't direct-play even after remux.
4. **SPA video views** — the desktop web UI gets a Video tab listing movies / shows / episodes.
5. **Subtitle and audio-track pickers** — embedded + sidecar.

Each layer is independently demonstrable; the base on its own is already useful for command-line / external-player use.

## CLI options

```
mediakit video serve <root> [--host HOST] [--port PORT]

  <root>          Library root - expects a videos/ subdirectory
  --host HOST     Host to bind (default 127.0.0.1)
  --port PORT     Port to bind (default 8765)
```

There are two other commands under `mediakit video` reserved for later phases:

- `mediakit video convert` — no-op placeholder (reserved for organize / transcode semantics)
- `mediakit video library` — no-op placeholder (reserves the symmetric namespace with `mediakit audio library`)

## See also

- [`mediakit library`](library.md) — cross-cutting summary + scan that operates on both audio and video
- [Architecture](../architecture.md) — how the pieces fit together
