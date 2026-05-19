# Video

`mediakit video serve` starts a minimal HTTP server that exposes the videos in your library via a clean MediaKit-native JSON API. The server ships:

- A throwaway HTML demo page at `/` that lists every video (with title, duration, and size) and plays the one you pick via HLS.
- Raw byte streaming with HTTP Range at `/api/videos/{id}/stream` (for external players like VLC / mpv).
- On-the-fly ffmpeg-piped fragmented-MP4 streaming at `/api/videos/{id}/play` (one-shot fMP4 — no seek, no total duration, but cheap).
- On-the-fly HLS at `/api/videos/{id}/hls/{filename}` (MPEG-TS segments transcoded on demand from a synthesised VOD manifest; recommended for browser playback because it gives the player full duration, seek-anywhere, and re-encodes when needed).

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

### `GET /api/videos/{id}/poster`

Contact-sheet PNG: header strip with filename + codec/resolution/duration/size, then a 3×3 grid of timestamped frame thumbnails sampled across the middle 90% of the timeline. Used as the video.js player's `poster` so the paused player shows the video at a glance instead of a blank canvas.

Lazy: first request transcodes ~9 frames via ffmpeg (~1–2s on a modern CPU); cached to `<root>/.mediakit/posters/<id>.png` so re-requests are file-serve cheap. Returns 503 if ffmpeg or ffprobe is missing.

### `GET /api/videos/{id}/thumbnail`

Single-frame JPEG sampled at ~30% into the timeline, scaled to 320px wide. Used for the row icon in the SPA video list. Much smaller payload than the full poster (~10 KB vs ~800 KB) so the list paints fast even with hundreds of videos. Cached to `<root>/.mediakit/posters/<id>.thumb.jpg`.

### `GET /api/videos/{id}/play`

ffmpeg-piped, fragmented-MP4 stream designed for browser `<video>` elements:

- **Video stream**: copied through (no re-encode = cheap, no quality loss).
- **Audio**: always re-encoded to stereo AAC at 192 kbps so browsers can play it. Source codecs like E-AC3 (Dolby Digital Plus, common in MKV releases) are not natively supported by Chrome / Firefox; this endpoint sidesteps that.
- **Container**: fragmented MP4 with `moov` written upfront (`-movflags +frag_keyframe+empty_moov+default_base_moof`), so playback starts immediately rather than waiting for the file to finish.

Returns `503 Service Unavailable` if `ffmpeg` is not on `PATH`. Returns `404` for unknown ids.

Trade-offs: this endpoint streams one big fMP4 over one HTTP response. No `<video>` seek mid-file, no duration metadata (the player shows it as a live stream until ffmpeg finishes). For seek + duration + codec compatibility past audio, use the HLS endpoint below.

### `GET /api/videos/{id}/hls/{filename}`

On-demand HLS. The manifest is synthesised upfront from ffprobe's duration (every segment URL + EXTINF + `#EXT-X-ENDLIST`), so the player gets a true VOD timeline immediately. Each segment is transcoded lazily on first request:

- `index.m3u8`: built from the video's duration. Returned instantly. Marked `#EXT-X-PLAYLIST-TYPE:VOD` with `#EXT-X-ENDLIST` so video.js / Safari / hls.js show the scrub bar and allow seeking anywhere.
- `seg-NNNN.ts`: spawns a short ffmpeg that seeks to `N * 6s`, encodes that 6s slice, and writes the segment to disk. Cached for the server lifetime. Typical transcode time: 0.5–1.5s per 6s segment on a modern CPU.

Why MPEG-TS (.ts) and not fragmented MP4 (.m4s): per-segment ffmpeg runs each produce their own init segment, and the codec headers (`SPS/PPS`) differ subtly between invocations. fMP4 needs one shared init across every segment, so cross-segment playback breaks with MEDIA_ERR_DECODE. MPEG-TS segments carry their own headers and stitch cleanly.

Encoding choices:
- **Video**: always re-encoded with libx264 (`-preset veryfast -crf 23`) so each segment starts on a forced keyframe (`-force_key_frames expr:gte(t,0)`). Re-encoding costs a bit of CPU but lets segments be independently seekable - the price for any-position scrub on any source codec.
- **Audio**: stereo AAC at 192 kbps.
- **Timestamps**: `-copyts` + `-to` preserve absolute source-timeline PTS so each segment's playback position matches the manifest's EXTINF cumulative time. (Note: `-t duration` would mis-fire here - with `-copyts` the output PTS already starts at `start_s`, so `-t` is interpreted as "stop when output PTS hits duration" which is in the past for any segment past 0.)

Returns `503` if ffmpeg is missing, `400` if the requested filename looks like a path-traversal attempt or has an unparseable segment index, `404` for unknown video ids or out-of-range segments, `500` if the ffmpeg subprocess fails (stderr tail is included in the detail).

**v0 lifecycle limitation**: segments are cached per video for the lifetime of the server process - no automatic cleanup. Restart the server to free the per-video temp directories under `/tmp/mediakit-hls/<id>/`. A TTL + eviction layer is a follow-up.

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
3. **HLS** — on-demand MPEG-TS segments behind a synthesised VOD manifest. Seek anywhere, full duration, scrub bar works. Done.
4. **SPA video views** — the desktop web UI gets a real Video tab (vertical AUDIO/VIDEO rail) playing through video.js v8. Done.
5. **Subtitle and audio-track pickers** — sidecar `.srt` discovery + WebVTT conversion. Done. Embedded tracks and picker UI deferred.
6. **House auth** — bearer tokens at `/auth/login` protecting `/video/*` and future MediaKit-native endpoints. Done.

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
