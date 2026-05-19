# Video pipeline

When the library root contains video files, `mediakit serve` mounts the video pipeline under `/video/*`. The server auto-detects what's in the root and mounts the kinds it finds. The pipeline ships:

- A throwaway HTML demo page at `/video/` that lists every video (with title, duration, and size) and plays the one you pick via HLS.
- Raw byte streaming with HTTP Range at `/video/api/videos/{id}/stream` (for external players like VLC / mpv).
- On-the-fly ffmpeg-piped fragmented-MP4 streaming at `/video/api/videos/{id}/play` (one-shot fMP4 — no seek, no total duration, but cheap).
- On-the-fly HLS at `/video/api/videos/{id}/hls/{filename}` (MPEG-TS segments transcoded on demand from a synthesised VOD manifest; recommended for browser playback because it gives the player full duration, seek-anywhere, and re-encodes when needed).

The SPA at `/` (mount with `--ui`) is the primary client; the demo page is kept for quick debugging.

## Quick start

```bash
mediakit serve ~/Downloads/library --ui
# mediakit serve - /Users/morteoh/Downloads/library on http://127.0.0.1:8765 (SPA at /, workers=auto)
# INFO:     Uvicorn running on http://127.0.0.1:8765
```

Then in another terminal:

```bash
curl -s http://127.0.0.1:8765/capabilities | jq
# {
#   "server": "mediakit",
#   "version": "0.1.0",
#   "audio": true,
#   "video": true,
#   "endpoints": {
#     "audio_subsonic": "/audio/rest",
#     "video_api": "/video/api",
#     "auth_login": "/auth/login"
#   }
# }

curl -s http://127.0.0.1:8765/video/api/videos | jq
# [
#   {
#     "id": "movies-Some-Movie-2019-1080p",
#     "name": "Some.Movie.2019.1080p.BluRay.x264",
#     "path": "/Users/morteoh/Downloads/library/movies/Some.Movie.2019.1080p.BluRay.x264.mkv",
#     "size_bytes": 2442979091,
#     "rel_path": "movies/Some.Movie.2019.1080p.BluRay.x264.mkv"
#   },
#   ...
# ]
```

Note `rel_path` is relative to the library root, not a subdirectory — there's no `videos/` convention.

## Endpoints

The server ships five endpoints — one HTML page, three JSON, one media stream.

### `GET /video/`

Returns an HTML demo page (single-file, no build step, no frameworks). Lists every video found under the library root and plays the chosen one via the `/play` endpoint below. Visit `http://localhost:8765/video/` in any modern browser.

The page exists to demonstrate the pipeline end-to-end without the React SPA wiring. It will be retired now that the SPA has a Video tab.

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

### `GET /video/api/videos`

Flat list of every video file anywhere under the library root. One entry per file:

```json
{
  "id": "movies-Some-Movie-2019-1080p",
  "name": "Some.Movie.2019.1080p.BluRay.x264",
  "path": "/absolute/path/to/file.mkv",
  "size_bytes": 2442979091,
  "rel_path": "movies/Some.Movie.2019.1080p.BluRay.x264.mkv"
}
```

The `id` is derived from the relative path under the library root — stable across rescans until the file is renamed or moved.

### `GET /video/api/videos/{id}/stream`

Serves the raw bytes with HTTP Range support, so a browser's `<video>` tag (or VLC, mpv, curl) can seek mid-file. Returns:

- `200 OK` for the full file when no Range header is present
- `206 Partial Content` with `Content-Range: bytes <start>-<end>/<total>` when a Range header is present
- `404` for unknown ids
- `416` for malformed or out-of-bounds Range headers

No transcoding. The Content-Type is derived from the file extension (`video/x-matroska` for `.mkv`, `video/mp4` for `.mp4` / `.m4v`, etc).

### `GET /video/api/browse?path=<rel>`

Folder navigator. Lists the immediate children of `<root>/<rel>/`: subdirectories that contain at least one video somewhere below them (with a descendant `video_count`), then video files in the current directory. Path is POSIX-style and relative to the library root; an empty path browses the root itself. The server's own `.mediakit/` cache is always skipped.

Response shape:

```json
{
  "rel_path": "tv/Show A",
  "crumbs": ["tv", "Show A"],
  "folders": [{"name": "Season 1", "rel_path": "tv/Show A/Season 1", "video_count": 13}],
  "videos": []
}
```

The SPA folder browser drives off this. Returns 404 when the path escapes the videos directory (path-traversal guard) or doesn't exist.

### `GET /video/api/videos/{id}/poster`

Contact-sheet PNG: header strip with filename + codec/resolution/duration/size, then a 3×3 grid of timestamped frame thumbnails sampled across the middle 90% of the timeline. Used as the video.js player's `poster` so the paused player shows the video at a glance instead of a blank canvas.

Lazy: first request transcodes ~9 frames via ffmpeg (~1–2s on a modern CPU); cached to `<root>/.mediakit/posters/<id>.png` so re-requests are file-serve cheap. Returns 503 if ffmpeg or ffprobe is missing.

### `GET /video/api/videos/{id}/thumbnail`

Single-frame JPEG sampled at ~30% into the timeline, scaled to 320px wide. Used for the row icon in the SPA video list. Much smaller payload than the full poster (~10 KB vs ~800 KB) so the list paints fast even with hundreds of videos. Cached to `<root>/.mediakit/posters/<id>.thumb.jpg`.

### Prewarm

On startup the combined `mediakit serve` walks the library once and, in the background, generates:

1. Every missing thumbnail then poster (concurrency 2).
2. Every missing HLS `seg-0.ts` (concurrency 1) so first-play of any video drops from 1-3s of cold ffmpeg to ~30ms of cache hit.

Both tasks race to fill the cache while the server stays responsive. With a ~100-video library the thumbnail pass finishes in seconds, posters in a couple of minutes, and HLS seg-0 in a few minutes more (variable - depends on source resolution and codec). Re-runs are cheap because cached files are skipped.

### `GET /video/api/videos/{id}/play`

ffmpeg-piped, fragmented-MP4 stream designed for browser `<video>` elements:

- **Video stream**: copied through (no re-encode = cheap, no quality loss).
- **Audio**: always re-encoded to stereo AAC at 192 kbps so browsers can play it. Source codecs like E-AC3 (Dolby Digital Plus, common in MKV releases) are not natively supported by Chrome / Firefox; this endpoint sidesteps that.
- **Container**: fragmented MP4 with `moov` written upfront (`-movflags +frag_keyframe+empty_moov+default_base_moof`), so playback starts immediately rather than waiting for the file to finish.

Returns `503 Service Unavailable` if `ffmpeg` is not on `PATH`. Returns `404` for unknown ids.

Trade-offs: this endpoint streams one big fMP4 over one HTTP response. No `<video>` seek mid-file, no duration metadata (the player shows it as a live stream until ffmpeg finishes). For seek + duration + codec compatibility past audio, use the HLS endpoint below.

### `GET /video/api/videos/{id}/hls/{filename}`

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

### `GET /video/api/videos/{id}/subtitles`

Returns the unified list of subtitle tracks for the video - both `.srt`/`.vtt` sidecars discovered next to the file AND text-based subtitle streams embedded in the container (subrip, ass, mov_text). Image-based codecs (PGS, DVD VobSub, DVB) are filtered out because they'd need OCR to become WebVTT.

Each entry has a `track_id` like `sidecar:en` or `embed:2`, a human `label` for the picker ("English", "Japanese (SDH)"), a `lang` tag, and a `default` flag derived from the stream's disposition. The SPA renders one `<track>` element per entry; video.js exposes the language picker on the player chrome.

### `GET /video/api/videos/{id}/subtitles/{key}`

Serves one subtitle track as WebVTT. `key` is either a sidecar language tag (`en`, `und`, ...) or `embed-<stream_index>` for embedded streams. Sidecars are converted on the fly (.srt → .vtt timestamps + header). Embedded streams are extracted via `ffmpeg -map 0:<index> -c:s webvtt` and the result is cached at `<root>/.mediakit/subs/<id>/embed-<N>.vtt` so re-requests are file-serve cheap.

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

## CLI

The video pipeline rides on `mediakit serve`; see [the serve guide](serve-unified.md) for flags. The `mediakit video` subgroup carries placeholders for tooling that doesn't belong on the serve command:

- `mediakit video convert` — no-op placeholder (reserved for organize / transcode semantics)
- `mediakit video library` — no-op placeholder (reserves the symmetric namespace with `mediakit audio library`)

## See also

- [`mediakit library`](library.md) — cross-cutting summary + scan that operates on both audio and video
- [Architecture](../architecture.md) — how the pieces fit together
