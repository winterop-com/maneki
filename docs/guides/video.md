# Video

`mediakit video serve` starts a minimal HTTP server that exposes the videos in your library via a clean MediaKit-native JSON API. The server ships:

- A throwaway HTML demo page at `/` that lists every video (with title, duration, and size) and plays the one you pick via HLS.
- Raw byte streaming with HTTP Range at `/api/videos/{id}/stream` (for external players like VLC / mpv).
- On-the-fly ffmpeg-piped fragmented-MP4 streaming at `/api/videos/{id}/play` (one-shot fMP4 — no seek, no total duration, but cheap).
- On-the-fly HLS at `/api/videos/{id}/hls/{filename}` (fMP4 segments + incrementally-written playlist; recommended for browser playback because it gives the player a real timeline, seek, and codec re-encode when needed).

No SPA integration yet — that lands as a follow-up layer.

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

Trade-offs: this endpoint streams one big fMP4 over one HTTP response. No `<video>` seek mid-file, no duration metadata (the player shows it as a live stream until ffmpeg finishes). For seek + duration + codec compatibility past audio, use the HLS endpoint below.

### `GET /api/videos/{id}/hls/{filename}`

On-the-fly HLS transcode. The first request to `/hls/index.m3u8` lazily spawns ffmpeg into a per-video temp directory; subsequent requests for `index.m3u8`, `init.mp4`, and `seg-NNNN.m4s` segments are served as files as ffmpeg produces them.

- **Video stream**: copied through when the source codec is H.264 (cheap, no quality loss). Otherwise transcoded to H.264 via libx264 at `-preset veryfast -crf 23`.
- **Audio**: always re-encoded to stereo AAC at 192 kbps.
- **Segments**: fragmented MP4 (`.m4s`) for browser native compatibility + a shared `init.mp4` segment with the codec metadata.
- **Playlist**: written incrementally; clients can start playback as soon as the first segment is ready. When ffmpeg finishes the input, `#EXT-X-ENDLIST` is appended and the player gets a final, seekable timeline.

Use this when the source codec is H.265 / VP9 / MPEG-2 (anything not H.264) — the `/play` endpoint only remuxes, this endpoint re-encodes video as needed.

Returns `503` if ffmpeg is missing, `400` if the requested filename looks like a path-traversal attempt, `404` for unknown video ids, `504` if the requested file doesn't materialise within 60s (first request only; subsequent requests are fast once ffmpeg is producing).

**v0 lifecycle limitation**: HLS sessions live for the entire server-process lifetime — no automatic cleanup. Restart the server to free the per-video temp directories under `/tmp/mediakit-hls/<id>/`. A TTL + eviction layer is a follow-up.

## Browser compatibility

What plays in a browser depends on the file's codecs:

| Codec combo (typical)     | Safari | Chrome | Firefox |
| ------------------------- | ------ | ------ | ------- |
| H.264 + AAC in MP4        | yes    | yes    | yes     |
| H.265 + AAC in MP4        | yes    | partial| no      |
| H.264 + AAC in MKV        | varies | no     | partial |
| H.264 + E-AC3 (5.1) in MKV| varies | no     | no      |
| H.265 + DTS / TrueHD      | no     | no     | no      |

The `/play` endpoint covers the audio-codec problem (E-AC3, AC-3, DTS, TrueHD → AAC) and the MKV container problem (remuxes to MP4). Video stream is copied through, so files whose **video** codec is incompatible (H.265 in non-Safari browsers, MPEG-2) still won't play via `/play` — for those, use the HLS endpoint which transcodes the video stream to H.264 when needed. The demo page at `/` uses HLS for this reason.

For files that won't play even via HLS (rare — anything ffmpeg can decode, libx264 can re-encode), point an external player (VLC, mpv, Infuse) at the `/stream` URL.

## Why the base layer

Stage 2's video work is built in layers:

1. **Base** — scan, list, raw stream. Done.
2. **Transcode + demo page** — ffmpeg-piped fMP4 at `/play`, browser-friendly. Done.
3. **HLS** (current) — on-the-fly HLS playlist + fMP4 segments with full video re-encode when needed. Demo page upgraded to use HLS for seek + duration. Done.
4. **SPA video views** — the desktop web UI gets a real Video tab listing movies / shows / episodes; the throwaway `/` demo page is retired.
5. **Subtitle and audio-track pickers** — embedded + sidecar.
6. **House auth** — bearer tokens at `/auth/login` protecting `/video/*` and future MediaKit-native endpoints.

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
