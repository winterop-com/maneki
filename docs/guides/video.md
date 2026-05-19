# Video

`mediakit video serve` starts a minimal HTTP server that exposes the videos in your library via a clean MediaKit-native JSON API. The server ships:

- A throwaway HTML demo page at `/` that lists every video and plays the one you pick — useful for verifying the pipeline end-to-end without touching the SPA.
- Raw byte streaming with HTTP Range at `/api/videos/{id}/stream` (for external players like VLC / mpv).
- On-the-fly ffmpeg-piped fragmented-MP4 streaming at `/api/videos/{id}/play` (for browser `<video>` elements when the source container or audio codec isn't natively supported).

No HLS, no UI integration into the React SPA yet. Those land as follow-up layers.

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

The server ships five endpoints — one HTML page, three JSON, one media stream.

### `GET /`

Returns an HTML demo page (single-file, no build step, no frameworks). Lists every video found under `<root>/videos/` and plays the chosen one via the `/play` endpoint below. Visit `http://localhost:8765/` in any modern browser.

The page exists to demonstrate the pipeline end-to-end without the React SPA wiring. It will be retired when the SPA grows a Video tab.

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

### `GET /api/videos/{id}/play`

ffmpeg-piped, fragmented-MP4 stream designed for browser `<video>` elements:

- **Video stream**: copied through (no re-encode = cheap, no quality loss).
- **Audio**: always re-encoded to stereo AAC at 192 kbps so browsers can play it. Source codecs like E-AC3 (Dolby Digital Plus, common in MKV releases) are not natively supported by Chrome / Firefox; this endpoint sidesteps that.
- **Container**: fragmented MP4 with `moov` written upfront (`-movflags +frag_keyframe+empty_moov+default_base_moof`), so playback starts immediately rather than waiting for the file to finish.

Returns `503 Service Unavailable` if `ffmpeg` is not on `PATH`. Returns `404` for unknown ids.

Trade-offs: seek over a non-Range fragmented MP4 stream is limited; for full seek + adaptive bitrate, the HLS layer (next phase) is the answer. For "click play and watch" inside a browser, this endpoint covers the 99% case.

## Browser compatibility

What plays in a browser depends on the file's codecs:

| Codec combo (typical)     | Safari | Chrome | Firefox |
| ------------------------- | ------ | ------ | ------- |
| H.264 + AAC in MP4        | yes    | yes    | yes     |
| H.265 + AAC in MP4        | yes    | partial| no      |
| H.264 + AAC in MKV        | varies | no     | partial |
| H.264 + E-AC3 (5.1) in MKV| varies | no     | no      |
| H.265 + DTS / TrueHD      | no     | no     | no      |

The `/play` endpoint covers the audio-codec problem (E-AC3, AC-3, DTS, TrueHD → AAC) and the MKV container problem (remuxes to MP4). Video stream is copied through, so files whose **video** codec is incompatible (H.265 in non-Safari browsers, MPEG-2) still won't play via `/play` — those need full video transcode, which is the HLS layer's job. For now, point an external player (VLC, mpv, Infuse) at the `/stream` URL for those.

## Why the base layer

Stage 2's video work is built in layers:

1. **Base** — scan, list, raw stream. Done.
2. **Transcode + demo page** (current) — ffmpeg-piped fMP4 at `/play`, browser-friendly. Done.
3. **HLS** — on-the-fly HLS playlist + segments for video codecs the browser can't direct-play even after remux (H.265 in non-Safari, MPEG-2).
4. **SPA video views** — the desktop web UI gets a real Video tab listing movies / shows / episodes; the throwaway `/` demo page is retired.
5. **Subtitle and audio-track pickers** — embedded + sidecar.

Each layer is independently demonstrable.

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
