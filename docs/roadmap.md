# Roadmap

What's landed, what's open, what's speculative. Keep this in sync with code changes - if a feature lands, move it from Open to a release-note entry; if a new gap surfaces, add it under Open.

## Stage 2 — video (in progress)

### Landed

- **Base scan + raw stream**: `<root>/videos/` discovered recursively; flat list endpoint; HTTP Range stream.
- **CLI**: `mediakit video serve`, plus unified `mediakit serve --ui` mounting both kinds + the SPA at `/`.
- **Subtitle sidecars**: `.srt` discovery + on-the-fly conversion to WebVTT.
- **HLS pipeline (on-demand segments)**: synthesised VOD manifest with `#EXT-X-ENDLIST` upfront from ffprobe duration; per-segment MPEG-TS transcode on first request, cached on disk. Seek-anywhere works without waiting for a linear transcode to catch up. See [video guide](guides/video.md#get-apivideosidhlsfilename).
- **Posters + thumbnails**: `/poster` returns a contact-sheet PNG (3x3 timestamped frame grid + header strip); `/thumbnail` returns a single mid-video JPEG. Both cached under `<root>/.mediakit/posters/`. Used as the video.js `poster` and the video-list row icon respectively. **Prewarm** on server startup walks the library and fills the cache in the background through a bounded worker pool, so opening any video for the first time is instant.
- **HLS seg-0 prewarm + neighbour prefetch**: at startup the same prewarm pass produces `seg-0.ts` for every video, so cold first-play drops from 1-3s to ~30ms. While playing, fetching segment N kicks off background transcodes for N+1 and N-1, so small forward / backward scrubs land on a warm cache.
- **Orphan cache cleanup**: on every startup we sweep the poster, HLS, and subtitle caches and remove entries whose source video id is no longer in the library. Catches rename / move / delete patterns ("files often get rotated out") without manual intervention.
- **SPA video tab**: vertical AUDIO / VIDEO rail on the left edge switches between modes; video mode collapses the audio sidebar, video.js v8 player with HLS source + WebVTT subtitle tracks, OS-level fullscreen via `f` key with `navigationUI: "hide"` so Chrome strips its own URL/tab bar.
- **Folder browser**: SPA now drives off `GET /api/browse?path=...` instead of the flat list - click-in directory navigator with sticky breadcrumbs at the top of the pane, folder rows above file rows, descendant video counts per folder. Empty subdirs are hidden. Path traversal guarded server-side.
- **Embedded subtitle streams**: `.mkv` / `.mp4` text subtitle tracks (subrip, ass, mov_text) are surfaced through `/subtitles` alongside any sidecar `.srt` files. Extraction to WebVTT runs on demand via `ffmpeg -c:s webvtt` and is cached under `<root>/.mediakit/subs/<id>/embed-<N>.vtt`. Multiple languages per file are picked through video.js's native subtitle menu. Image-based codecs (PGS, DVD VobSub, DVB) are filtered out since they'd need OCR.
- **House auth**: `POST /auth/login` returns bearer; SPA same-origin login form (URL field hidden when SPA is co-hosted with the server).
- **SPA served at `/`**: no `/ui/` prefix; API routes registered first so the StaticFiles mount at root doesn't shadow them.

### Open

- **Smaller-default caption size that doesn't break the menu**: video.js's auto-scaled 100% baseline is shouty in fullscreen, but every attempt to ship a smaller default (CSS override, `setValues({fontPercent})`, localStorage seed pre-init) either blocks the menu's user-picks or doesn't actually apply. Needs a MutationObserver on cue renders or a CSS-variable wired to the menu's change event. Today users have to pick a size once via the menu (persisted across reloads).
- **Long filename handling**: real release / encode filenames are very long (e.g. `Some.Movie.2019.1080p.BluRay.x264-GROUP.mkv`). Row layout currently overflows / truncates. Need a parsing pass to extract a clean display title (year, source, codec stripped off, available via hover for the full thing), tooltip with full filename, and wrap / ellipsis rules per density.
- **2160p (4K) / heavy-codec streaming**: libx264 software re-encode at veryfast/crf 23 is too slow for 4K HEVC sources - segments arrive slower than playback. Add a hardware-accelerated transcode path (VideoToolbox on macOS, NVENC on NVIDIA, QSV on Intel) and a quality-tier ladder so the client can opt down to 1080p when the network or CPU can't keep up.
- **HLS cache size cap + LRU eviction**: orphan cleanup (renamed / removed source files) runs at every startup, but there's no cap on the cache for currently-live videos. A normal viewing pattern is 20-50 GB; a full library cache is hundreds. Add `--hls-cache-gb N` with LRU eviction once the cap is hit (never touch prewarmed seg-0).
- **Kind-aware search**: the topbar search is wired only to the audio Subsonic library. In video mode the search box is currently hidden; replace with a video-list filter and (later) a unified search across both kinds.
- **Embedded subtitle tracks**: today only `.srt` sidecars are surfaced. ffprobe the source for embedded subtitle streams and expose a picker in the player.
- **Audio-track picker**: same shape as subtitles - ffprobe streams, surface a chooser in the player.
- **Resume position**: track playhead per `(user, video_id)` so closing and re-opening a video resumes where you left off. Wire to either localStorage (single device) or a server-side `.mediakit/resume.toml`.
- **Scrub-bar hover previews**: extend the contact-sheet logic into denser per-segment thumbnails for hover-on-scrub previews. Cheap re-use of existing ffmpeg infra.
- **SQLite index for videos**: today every request rescans `<root>/videos/`. The audio side has `<root>/.mediakit/index.db`; mirror it for video so a 1000-file library doesn't pay the walk cost on every list call.
- **Watchdog rescan**: file added / removed / renamed - update the index without a full walk. Audio side already does this; lift the pattern.

## Stage 3 — MediaKit-native protocol & compat facades

The Subsonic API is the only audio protocol today; the video API is MediaKit-native but unstable. Stage 3 is to design MediaKit's own clean protocol for both kinds, then offer Subsonic / Jellyfin compat layers on top for existing clients.

- **Protocol design**: pick the shape (REST vs gRPC vs JSON-RPC; flat vs typed). Library, playback, search, ratings, resume. One protocol for audio + video so the SPA only speaks one dialect.
- **Audio Subsonic compat facade**: keep `/audio/rest/*` working against MediaKit-native data so existing Subsonic clients (Symfonium, Amperfy, play:Sub, Feishin) keep working.
- **Jellyfin / Plex compat**: deferred until the native protocol is stable. Useful for Infuse / Streamio / VLC / mobile-app integration.

## Audio polish (continued)

- **AcoustID auto-enable**: today you have to pass `--acoustid-key` per run. Read from `~/.config/mediakit/mediakit.toml` (`[acoustid].api_key`) and apply automatically when an album has tagless tracks.
- **Album merge tool**: when the same album exists with different tags as two folders, an interactive merge.
- **`--dry-run` with rich diff**: show exactly what tags would change, what files would move.

## Speculative

Things that would be interesting if anyone ever asked, but not pursued speculatively:

- BPM / key analysis (needs `librosa`, big dep weight).
- AI-generated playlists with audio-feature similarity (current `mediakit audio playlist gen` is tag-based; an audio-feature pass would need fingerprinting / `librosa`).
- Multi-user serve (right now: single-user).
- Sonos / Chromecast / DLNA output (AirPlay covers the Apple-ecosystem case).
- Cross-fade between tracks.
- Listening rooms / sync-play across clients.
- Voice control.
- Live TV / DVR tuner support.
- Photo libraries as a third kind alongside audio + video.
