# Video pipeline

When the library root contains video files, `maneki serve` mounts the video pipeline under `/video/*`. The server auto-detects what's in the root and mounts the kinds it finds. The pipeline ships:

- A throwaway HTML demo page at `/video/` that lists every video (with title, duration, and size) and plays the one you pick via HLS.
- Raw byte streaming with HTTP Range at `/video/api/videos/{id}/stream` (for external players like VLC / mpv).
- On-the-fly ffmpeg-piped fragmented-MP4 streaming at `/video/api/videos/{id}/play` (one-shot fMP4 — no seek, no total duration, but cheap).
- On-the-fly HLS at `/video/api/videos/{id}/hls/{filename}` (MPEG-TS segments transcoded on demand from a synthesised VOD manifest; recommended for browser playback because it gives the player full duration, seek-anywhere, and re-encodes when needed).

The SPA at `/` (mount with `--ui`) is the primary client; the demo page is kept for quick debugging.

## Quick start

```bash
maneki serve ~/Downloads/library --ui
# maneki serve starting   flags='SPA at /, workers=auto' host=127.0.0.1 port=8765 root=/Users/morteoh/Downloads/library
# Uvicorn running on http://127.0.0.1:8765
```

Then in another terminal:

```bash
curl -s http://127.0.0.1:8765/capabilities | jq
# {
#   "server": "maneki",
#   "version": "0.9.0",
#   "audio": true,
#   "video": true,
#   "video_count": 1313,
#   "endpoints": {
#     "audio_subsonic": "/audio/rest",
#     "video_api": "/video/api",
#     "auth_login": "/auth/login"
#   }
# }

curl -s http://127.0.0.1:8765/video/api/videos | jq '.[0]'
# {
#   "id": "movies-Some-Movie-2019-1080p-a3f1c2d4",
#   "name": "Some.Movie.2019.1080p.BluRay.x264",
#   "path": "/Users/morteoh/Downloads/library/movies/Some.Movie.2019.1080p.BluRay.x264.mkv",
#   "size_bytes": 2442979091,
#   "rel_path": "movies/Some.Movie.2019.1080p.BluRay.x264.mkv",
#   "duration_s": 7892.4,
#   "subtitles": [{"lang": "eng", "format": "srt"}]
# }
```

Note `rel_path` is relative to the library root, not a subdirectory — there's no `videos/` convention.

### Optional startup flags

```bash
# Wipe the on-disk poster / thumbnail cache and the SQLite videos table
# before scanning. Use after renames / edits if the cached frames are
# stale and you want a clean rebuild.
maneki serve ~/library --ui --rescan

# Generate every video's thumbnail, contact-sheet poster, and embedded-
# subtitle probe during startup. Otherwise these populate lazily on
# first browse / open. Heavy on cold libraries; idempotent on warm ones.
maneki serve ~/library --ui --prewarm-cache

# Skip contact-sheet poster generation entirely. /poster falls back to
# the single-frame row thumbnail. Useful on slow disks or huge
# libraries where the 9-frame contact sheet isn't worth the wait.
maneki serve ~/library --ui --no-cover-images

# Increase background-transcode worker cap. Default is min(8, cpu // 2).
maneki serve ~/library --ui --workers 8
```

## Endpoints

The server ships five endpoints — one HTML page, three JSON, one media stream.

### `GET /video/`

Returns an HTML demo page (single-file, no build step, no frameworks). Lists every video found under the library root and plays the chosen one via the `/play` endpoint below. Visit `http://localhost:8765/video/` in any modern browser.

The page exists to demonstrate the pipeline end-to-end without the React SPA wiring. It will be retired now that the SPA has a Video tab.

### `GET /capabilities`

Server identity + which kinds are present at the root.

```json
{
  "server": "maneki",
  "version": "0.9.0",
  "audio": false,
  "video": true,
  "video_count": 2
}
```

### `GET /video/api/videos`

Flat list of every video file anywhere under the library root. One entry per file:

```json
{
  "id": "movies-Some-Movie-2019-1080p-a3f1c2d4",
  "name": "Some.Movie.2019.1080p.BluRay.x264",
  "path": "/absolute/path/to/file.mkv",
  "size_bytes": 2442979091,
  "rel_path": "movies/Some.Movie.2019.1080p.BluRay.x264.mkv"
}
```

The `id` is `<readable-slug>-<8-hex-sha256>` derived from the relative path under the library root. The hash suffix is what makes the id collision-free: two paths that flatten to the same slug (`tv/ch01.mkv` and `tv-ch01.mkv` at the root, say) still get distinct ids. Ids stay stable across rescans until the file is renamed or moved.

### `GET /video/api/videos/{id}/stream`

Serves the raw bytes with HTTP Range support, so a browser's `<video>` tag (or VLC, mpv, curl) can seek mid-file. Returns:

- `200 OK` for the full file when no Range header is present
- `206 Partial Content` with `Content-Range: bytes <start>-<end>/<total>` when a Range header is present
- `404` for unknown ids
- `416` for malformed or out-of-bounds Range headers

No transcoding. The Content-Type is derived from the file extension (`video/x-matroska` for `.mkv`, `video/mp4` for `.mp4` / `.m4v`, etc).

### `GET /video/api/browse?path=<rel>`

Folder navigator. Lists the immediate children of `<root>/<rel>/`: subdirectories that contain at least one video somewhere below them (with a descendant `video_count`), then video files in the current directory. Path is POSIX-style and relative to the library root; an empty path browses the root itself. The server's own `.maneki/` cache is always skipped.

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

Contact-sheet PNG: header strip with filename + codec / resolution / duration / size, then a 3×3 grid of timestamped frame thumbnails sampled across the middle 90% of the timeline. Padded to a 16:9 canvas so the player frame and the poster have identical aspect — no grow-on-play jump when the user clicks play. Used as the video.js `poster`.

Lazy: first request returns `202 Accepted` with a tiny inline-SVG placeholder and schedules a background ffmpeg job that grabs all 9 frames in a single subprocess (one source file open instead of nine). The SPA polls `/api/thumbnails/ready` and bumps the player's poster src once the real PNG lands on disk. Cached at `<root>/.maneki/posters/<sha256(id)[:32]>.png` (hash-derived filename so deeply-nested rel paths don't blow the OS's 255-byte `NAME_MAX`). Subsequent requests are a file-serve. Returns 503 if ffmpeg / ffprobe is missing.

With `--no-cover-images`, `/poster` falls back to the single-frame thumbnail described below — same code path, no contact sheet.

### `GET /video/api/videos/{id}/thumbnail`

Single-frame JPEG sampled at ~30% into the timeline, scaled to 320px wide. Used for the row icon in the SPA video list — small payload (~10 KB vs ~800 KB for the contact sheet) so a 1000-video folder paints fast. Same 202+SVG placeholder pattern as `/poster`; bumps in the SPA via the same `/api/thumbnails/ready` poll. Cached at `<root>/.maneki/posters/<sha256(id)[:32]>.thumb.jpg`.

### `GET /api/thumbnails/ready`

Returns `{"ready": [video_id, ...], "posters_ready": [video_id, ...]}`. The SPA polls every few seconds while a folder is open (for `ready`) or while the player is mounted (for `posters_ready`). When an id newly appears, the SPA bumps the matching `<img>` src with a version query string so the placeholder swaps for the real frame without a page reload.

### Prewarm cache

Pass `--prewarm-cache` to `maneki serve` and the startup walk fills three caches in the background through a bounded worker pool:

1. **Subtitle probes** — runs `ffprobe` for embedded subtitle streams. The browse listing reads this synchronously, so warming it up front keeps cold-browse-after-restart instant.
2. **Row thumbnails** — one ffmpeg per video, ~200 ms each.
3. **Contact-sheet posters** — one ffmpeg per video, ~500 ms-2 s (extracts all 9 frames in a single invocation; skip the phase entirely with `--no-cover-images`).

Background work yields to foreground player requests through the shared `TranscodeBudget` so prewarm pauses when someone hits play. Re-runs are idempotent: any file already on disk is skipped. Pair with `--rescan` if you want everything rebuilt from scratch (e.g. after a major upgrade).

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
- `seg-NNNN.ts`: spawns a short ffmpeg that seeks to `N * 6s`, encodes that 6s slice, and writes the segment to disk. Cached on disk under `<tempdir>/maneki-hls/<sha256(id)[:32]>/` so re-watches are file-serve cheap. Typical transcode time: 0.2-1.5 s per 6 s segment on a modern CPU.

Why MPEG-TS (.ts) and not fragmented MP4 (.m4s): per-segment ffmpeg runs each produce their own init segment, and the codec headers (`SPS/PPS`) differ subtly between invocations. fMP4 needs one shared init across every segment, so cross-segment playback breaks with `MEDIA_ERR_DECODE`. MPEG-TS segments carry their own headers and stitch cleanly.

Encoding choices:

- **Video**: always re-encoded with libx264 (`-preset veryfast -crf 23`) so each segment starts on a forced keyframe (`-force_key_frames expr:gte(t,0)`). Re-encoding costs CPU but lets segments be independently seekable — the price for any-position scrub on any source codec.
- **Audio**: stereo AAC at 192 kbps.
- **Timestamps**: `-output_ts_offset N*SEG_LEN` + `-avoid_negative_ts disabled` shifts each segment's output PTS to its nominal manifest position. Adjacent segments don't overlap and the player's `currentTime` matches the manifest timeline. (A pre-v0.9 bug here would emit a partial .ts on ffmpeg cancel during a rapid scrub, the cache check would short-circuit on the partial file, and the player would jump 4-5 min on the next seek; fixed by unlinking partial files on cancel and bumping `HLS_CACHE_VERSION` to wipe any leftover stubs from older runs.)

Foreground transcodes are capped at 3 concurrent (rapid seeks fire one fetch per scrub and the browser's HLS engine doesn't cancel old XHRs; without the cap, 18 simultaneous ffmpegs sharing disk I/O each took 15s instead of 200ms and the player wedged). Queued requests release as slots free up; normal playback fits inside the cap. Background prefetch (neighbour ±1) is cancelled on pause / player-close via a `DELETE /api/videos/{id}/session` call from the SPA.

Returns `503` if ffmpeg is missing, `400` if the requested filename looks like a path-traversal attempt or has an unparseable segment index, `404` for unknown video ids or out-of-range segments, `499` if the client disconnected mid-transcode (and the running ffmpeg is killed), `500` if the ffmpeg subprocess fails (stderr tail in detail).

Cache lifecycle: on every startup the cache is swept for orphaned video-id directories (renamed / deleted source files) and the cache-version marker is verified — if it doesn't match the running build's `HLS_CACHE_VERSION`, the whole cache is wiped so segments produced under different rules don't poison the player.

### `GET /video/api/videos/{id}/subtitles`

Returns the unified list of subtitle tracks for the video - both `.srt`/`.vtt` sidecars discovered next to the file AND text-based subtitle streams embedded in the container (subrip, ass, mov_text). Image-based codecs (PGS, DVD VobSub, DVB) are filtered out because they'd need OCR to become WebVTT.

Each entry has a `track_id` like `sidecar:en` or `embed:2`, a human `label` for the picker ("English", "Japanese (SDH)"), a `lang` tag, and a `default` flag derived from the stream's disposition. The SPA renders one `<track>` element per entry; video.js exposes the language picker on the player chrome.

### `GET /video/api/videos/{id}/subtitles/{key}`

Serves one subtitle track as WebVTT. `key` is either a sidecar language tag (`en`, `und`, ...) or `embed-<stream_index>` for embedded streams. Sidecars are converted on the fly (.srt → .vtt timestamps + header). Embedded streams are extracted via a **single ffmpeg invocation with one `-map 0:<idx>` output per stream** — the source file is opened once and every missing .vtt is written in one pass, then cached at `<root>/.maneki/subs/<sha256(id)[:32]>/embed-<N>.vtt` so re-requests are file-serve cheap.

This pattern matters on .mkv files with many embedded tracks (Stranger Things S5 ships 45 of them): the older one-ffmpeg-per-stream approach spawned 45 simultaneous ffmpegs that each re-read the 800 MB source and saturated disk I/O. The single-pass version completes the same work in roughly the time of one stream extract. Per-video lock so concurrent requests for different tracks of the same file share the extraction.

The SPA only registers the **default + English / English-SDH** tracks with video.js on player mount; the rest stay listed in the captions menu but aren't fetched. Trade-off: less captions-menu completeness, but no head-of-line block on the HLS critical path from 45 parallel `.vtt` fetches at video-open time.

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

## Library scan + watcher

`maneki serve` keeps the video index in `<root>/.maneki/index.db` (same SQLite file as the audio side, separate `videos` table, namespaced meta keys). Cold start hits a stat-only filesystem walk plus an ffprobe for any new / modified file; fingerprints are `(mtime, size_bytes)`, so a warm rescan touches ffmpeg only for what actually changed. The persisted batch upsert at end-of-scan keeps the SQLite write footprint to one transaction even on 1300+ file libraries.

After the initial scan, a watchdog Observer rooted at the library directory drives a 5-second debounced rescan whenever a video extension appears / disappears / moves. Adds, deletes, and renames flow through the same `prewarm_scan` path the cold start uses. In-place edits (re-encode, retag, remux) detect via the `(mtime, size_bytes)` fingerprint mismatch and invalidate the cached poster + thumbnail for that id so the next browse / open regenerates from the new content. Subtitle + HLS caches stay (extracted .vtts are still valid for a re-mux; HLS regenerates on play anyway).

## Cache layout

Everything under `<root>/.maneki/`:

| Path | What's in it | Lifecycle |
|---|---|---|
| `index.db`, `index.db-wal`, `index.db-shm` | SQLite, shared with audio. Audio owns `albums` / `tracks` / `track_genres` / `album_warnings`; video owns `videos` (plus namespaced `meta` keys). | Survives restarts. Wiped only on schema-version mismatch (audio rebuilds its tables, video rebuilds its `videos` table). |
| `posters/<sha256(id)[:32]>.png` | 16:9 contact-sheet posters. | Survives restarts. Swept on startup for orphaned ids. Invalidated on in-place file edit. Wiped wholesale by `--rescan`. |
| `posters/<sha256(id)[:32]>.thumb.jpg` | Row thumbnails (single frame, 320 px wide). | Same lifecycle as posters. |
| `subs/<sha256(id)[:32]>/embed-<N>.vtt` | Extracted embedded subtitle tracks. | Survives restarts. Swept on startup for orphaned ids. |
| (HLS lives at `<tempdir>/maneki-hls/<sha256(id)[:32]>/seg-NNNN.ts`, not under the library root — segments are large and explicit RAM-disk / `/tmp` placement is the right tradeoff.) | | Wiped on `HLS_CACHE_VERSION` mismatch. Per-id directories swept on startup for orphaned ids. |

Filenames use a **sha256-derived stem** because the readable `<rel-path-with-slashes-as-dashes>-<8hex>` id can blow past APFS / ext4's 255-byte `NAME_MAX` on deeply-nested releases. URLs and log lines still carry the readable id; only the on-disk path is hashed.

## CLI

The video pipeline rides on `maneki serve`. Relevant flags:

| Flag | Effect |
|---|---|
| `--ui` | Mount the React SPA at `/`. |
| `--rescan` | Wipe `<root>/.maneki/posters/` and `DELETE FROM videos` before scanning. The next browse / open regenerates from scratch. Audio's tables are untouched. |
| `--prewarm-cache` | Run the subtitle probe + thumbnail + contact-sheet poster generation passes at startup (background workers, yields to foreground player requests). Idempotent on a warm cache. Aliased as `--prewarm-images` was renamed in 0.9. |
| `--no-cover-images` | Skip the contact-sheet poster phase entirely. `/poster` falls back to the row thumbnail. |
| `--workers N` | Background-transcode worker cap. Default `min(8, cpu // 2)`. Affects prewarm + neighbour prefetch; foreground transcodes are capped at 3 concurrent regardless. |

The `maneki video` subgroup carries placeholders for tooling that doesn't belong on the serve command:

- `maneki video convert` — no-op placeholder (reserved for organize / transcode semantics)
- `maneki video library` — no-op placeholder (reserves the symmetric namespace with `maneki audio library`)

## See also

- [`maneki library`](library.md) — cross-cutting summary + scan that operates on both audio and video
- [Architecture](../architecture.md) — how the pieces fit together
