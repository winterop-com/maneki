# Roadmap

What's landed, what's open, what's speculative. Keep this in sync with code changes - if a feature lands, move it from Open to a release-note entry; if a new gap surfaces, add it under Open.

## Stage 2 — video (mostly landed)

### Landed

- **Single library root**: `maneki serve <root>` walks one directory recursively and auto-mounts whichever kinds it finds — no `<root>/audio/` or `<root>/videos/` subdir convention. Mixed roots mount both. Each mount also hosts a remote source that needs nothing on disk (internet radio on `/audio`, YouTube on `/video`), so an empty root still gets both mounts — only their local halves are empty.
- **`maneki info` / `list` / `inspect`**: cross-cutting top-level commands that take any library root - `info` for file counts per kind, `list` (alias `ls`) for a full inventory walk, `inspect` for a file's tags / cover (audio) or ffprobe streams + container info (video). Output is rich-formatted.
- **Base scan + raw stream**: every video file under the library root is discovered recursively; flat list endpoint; HTTP Range stream (with RFC 7233 suffix-range support).
- **Subtitle sidecars**: `.srt` discovery + on-the-fly conversion to WebVTT.
- **HLS pipeline (on-demand segments)**: synthesised VOD manifest with `#EXT-X-ENDLIST` upfront from ffprobe duration; per-segment MPEG-TS transcode on first request, cached on disk. Seek-anywhere works without waiting for a linear transcode to catch up. Foreground concurrency capped at 3 so rapid seeks don't wedge the player; partial .ts files are unlinked on ffmpeg cancel so a cancelled seek can't poison the next request. HLS cache survives server restarts and is wiped automatically when `HLS_CACHE_VERSION` changes (versioned marker file).
- **Posters + thumbnails**: `/poster` returns a 16:9-padded contact-sheet PNG (3×3 timestamped frame grid + header strip with codec / resolution / duration / size); `/thumbnail` returns a single mid-video JPEG. Both cached under `<root>/.maneki/posters/` using sha256-derived stems so deeply-nested paths can't blow `NAME_MAX`. Cache misses return `202 Accepted` with a tiny inline-SVG placeholder so the SPA paints instantly; the SPA polls `/api/thumbnails/ready` and swaps the placeholder once the real PNG / JPEG lands. Contact-sheet generation collapses 9 frame extracts into one ffmpeg invocation.
- **Embedded subtitle streams**: `.mkv` / `.mp4` text subtitle tracks (subrip, ass, mov_text) are surfaced through `/subtitles` alongside any sidecar `.srt`. Extraction runs in a **single ffmpeg invocation per video** (one `-map` output per stream) so a 45-track .mkv opens in ~2 s instead of stalling on 45 parallel ffmpegs that each re-read the source. Cached under `<root>/.maneki/subs/<sha256(id)[:32]>/embed-<N>.vtt`. The SPA registers only the default + English / English-SDH variants on player mount to keep the HLS critical path clean; the rest of the captions menu still lists them. Image-based codecs (PGS, DVD VobSub, DVB) are filtered out since they'd need OCR.
- **HLS cache cap**: `--hls-cache-gb N` (or `[media] hls_cache_gb`, default 20, 0 = no cap). A cache hit touches the segment's mtime; once the cache passes the cap, a background trim evicts the least recently watched segments down to 90% of it, never touching anything used in the last two minutes (what is playing, or what ffmpeg is still writing). Startup trims too, after the orphan sweep.
- **`--no-cover-images`** opt-out: skip the 9-frame contact-sheet phase entirely. `/poster` falls back to the row thumbnail. Useful on slow disks or huge libraries.
- **`--prewarm-cache`** (renamed from `--prewarm-images`): runs subtitle probe + thumbnail + contact-sheet generation at startup through a bounded worker pool; background work yields to foreground player requests via a shared `TranscodeBudget`.
- **SQLite-backed scan index**: video scan rows persist in `<root>/.maneki/index.db` (same file as audio, separate `videos` table, namespaced meta keys, `CREATE TABLE IF NOT EXISTS` so the two apps coexist). Warm rescans only ffprobe files whose `(mtime, size_bytes)` changed. Single-transaction batch upsert at end of scan keeps a 1300-file rescan under ~6 s.
- **Watcher hot-reload**: watchdog `Observer` rooted at the library directory drives a 5-second debounced rescan whenever a video file appears / disappears / moves. In-place edits (re-encode, retag) detect via fingerprint mismatch and invalidate the cached poster + thumbnail for that id so the next browse / open regenerates.
- **O(1) video lookup**: every per-video endpoint reads from the in-memory `video_cache` dict instead of re-walking the filesystem.
- **Stable, collision-free video ids**: `<readable-slug>-<8-hex-sha256>` so paths that flatten to the same slug (`tv/ch01.mkv` vs `tv-ch01.mkv` at the root) still get distinct ids.
- **Orphan cache cleanup**: on every startup we sweep the poster, HLS, and subtitle caches and remove entries whose source video id is no longer in the library. Catches rename / move / delete patterns without manual intervention.
- **SPA video tab**: vertical AUDIO / VIDEO rail on the left edge switches between modes; the rail self-hides when only one kind is mounted. Video mode collapses the audio sidebar, video.js v8 player with HLS source + WebVTT subtitle tracks. Browser fullscreen via the HTML5 Fullscreen API in plain Chrome / Safari (URL bar + tab strip stripped via `navigationUI: "hide"`); CSS-pin fallback in Tauri / Electron WKWebView; `f` is gated on `player.hasStarted()` so pre-playback presses don't fall through to the poster `<img>` and open it as a new tab.
- **Theater mode**: `t` shortcut (also in the command palette) hides the videos list + splitter so the player pane spans the full video area. Topbar + mode rail stay visible.
- **Player meta strip**: shows duration, source resolution (`1080p` / `4K` / `WxH` pulled from `videoWidth` × `videoHeight` on `loadedmetadata`), file size, subtitle count.
- **Folder browser**: SPA drives off `GET /video/api/browse?path=...` - click-in directory navigator with sticky breadcrumbs at the top of the pane, folder rows above file rows, descendant video counts per folder. Empty subdirs are hidden. Path traversal guarded server-side.
- **Resizable video / player splitter**: 6 px draggable divider between the video list pane and the player. Clamped so the player always keeps room. Per-session only.
- **Kind-aware search**: in video mode the topbar search swaps the folder browser for a flat results pane of filename-substring matches across the whole library; debounced 200 ms; capped at 200 results.
- **House auth**: `POST /auth/login` returns bearer; SPA same-origin login form (URL field hidden when SPA is co-hosted with the server).
- **SPA served at `/`**: no `/ui/` prefix; API routes registered first so the StaticFiles mount at root doesn't shadow them.
- **Radio without a library**: internet radio no longer depends on the local scan. The Subsonic app is mounted whenever local audio files exist **or** stations resolve (defaults in `radio.py` plus `~/.config/maneki/radio.toml`), mirroring what the video app already did for YouTube, so `maneki serve <empty-dir>` is a working radio player. `/capabilities` stays honest by splitting the two questions: `audio` still means "there is a local audio library to browse" (False on a radio-only server), a new `radio` flag reports station availability, and `endpoints.audio_subsonic` now describes the mount — non-null whenever either is on. The library scan stays gated on local audio, so a radio-only or video-only root pays no walk and gets no `.maneki/index.db` written into it. The SPA keeps its AUDIO tab (and therefore the Radio list) whenever `audio` or `radio` is on.

### Open

- **Smaller-default caption size that doesn't break the menu**: video.js's auto-scaled 100% baseline is shouty in fullscreen, but every attempt to ship a smaller default (CSS override, `setValues({fontPercent})`, localStorage seed pre-init) either blocks the menu's user-picks or doesn't actually apply. Today users have to pick a size once via the menu (persisted across reloads).
- **Long filename handling**: real release / encode filenames are very long (e.g. `Some.Movie.2019.1080p.BluRay.x264-GROUP.mkv`). Row layout currently overflows / truncates. Need a parsing pass to extract a clean display title (year, source, codec stripped off, available via hover), tooltip with full filename, and wrap / ellipsis rules per density.
- **2160p (4K) / heavy-codec hardware transcode**: libx264 software re-encode at veryfast / crf 23 is too slow for 4K HEVC sources — segments arrive slower than playback. Add a hardware-accelerated transcode path (VideoToolbox on macOS, NVENC on NVIDIA, QSV on Intel) and a quality-tier ladder so the client can opt down to 1080p when the network or CPU can't keep up.
- **Audio-track picker**: same shape as subtitles — ffprobe streams, surface a chooser in the player chrome.
- **Scrub-bar hover previews**: extend the contact-sheet logic into denser per-segment thumbnails for hover-on-scrub previews. Cheap re-use of existing ffmpeg infra.
- **Theater-mode overlap with topbar** (cosmetic): some viewport sizes show the player title strip rendering tighter than expected next to the topbar. Investigation pending.

## Radio without a server

Landed in the client: the sign-in screen offers **Sign in** (to a server, with an account) and **Just listen to radio** (no server, no address, no account). Signing in keeps the server's radio exactly as it was (relayed stream, ICY titles, shared station list, the spectrum); the radio-only mode adds a way in and removes nothing.

What radio-only does in place of the server:

- **Streams** play from the station's own address, with no `crossOrigin` and so no spectrum (WebKit cannot draw one for a live stream anyway).
- **Now-playing titles** are not shown: a browser cannot read ICY metadata cross-origin. Per-station now-playing APIs (NRK has one) are an optional later step.
- **The station list** is the built-in ten plus the stations added from search, kept in `localStorage` (`maneki.radioStations`) on that device, with no sync.
- **Search** asks radio-browser.info directly (it allows any origin), with the server's rules: no HLS, no playlists, logos only when they are addresses.
- **The account menu** reads "Radio only" and offers **Sign in to a server**, which returns to the sign-in screen with the last server and username kept.

Still open:

- **Per-user stations when signed in.** Added stations go into `~/.config/maneki/radio.db` today, shared by every account. They should move into the user's own directory under `<root>/.maneki/users/<name>/`, beside `books.db`, `videos.db`, `history.db` and `youtube.db`. The defaults and the hand-written `radio.toml` stay shared and cannot be removed from a client.
- **A pasted stream URL** in **+ Add** beside search, and the same **+ Add** for a YouTube channel when signed in (YouTube stays out of radio-only, since it needs the server's yt-dlp).
- **A native relay in the desktop shells**: Tauri (Rust) and Electron (Node) can do what `radio_proxy.py` does without CORS, so the desktop apps get ICY titles and (in Electron) the spectrum with no server at all.
- Plain-`http` stations from a client served over `https` (mixed content; fine in the desktop shells), and whether a station list kept on a device should be offered to a server on a later sign-in.

## iOS and Android apps

The same approach as `delivery-app`: one React UI for every platform, with Tauri 2's mobile targets wrapping `desktop/app` for iOS and Android, so a phone gets the app the desktop has rather than a second client. Phones today use the web client in a browser or a Subsonic app (play:Sub on iOS).

- **Shell**: `tauri ios init` / `tauri android init` in `desktop/tauri` (the generated projects under `gen/apple` and `gen/android`), `TAURI_ENV_PLATFORM` through Vite's `envPrefix` so the UI knows it is on a phone. No admin screens on phones beyond what the account allows.
- **Make targets** in the same shape: `setup-phones`, `ios` and `android` (simulator and emulator), `sims` (web, iOS and Android side by side), `ios-build` / `android-build`, `phone-install` for an Android phone on USB.
- **Radio-only first**: a phone app needs no server to be useful, so the first build can ship the radio-only mode, then sign-in to a server on the LAN or over the internet.
- **Playback that phones expect**: background audio (iOS audio session, an Android foreground media service), lock-screen and notification controls through Media Session, and keeping a book's position when the app is suspended.
- **Networking**: Android allows cleartext HTTP only in debug builds and Android 17 needs `ACCESS_LOCAL_NETWORK` for LAN servers; iOS ATS needs a local-network exception. Plain-`http` radio stations hit the same rules.
- **Tests**: Playwright on the Android WebView (`_android`) and Maestro on the iOS simulator, as `make e2e-android` / `make e2e-ios`, beside the existing phone-sized browser checks.
- **Traps already found there**: `tauri-plugin-log` broke the iOS simulator build (`num_threads` via `time`); the Android 17 emulator image was unstable in October 2026 (an API 36 AVD works); Xcode 27 has no Simulator.app (DeviceHub.app).

## Stage 3 — Maneki-native protocol & compat facades

The Subsonic API is the only audio protocol today; the video API is Maneki-native but unstable. Stage 3 is to design Maneki's own clean protocol for both kinds, then offer Subsonic / Jellyfin compat layers on top for existing clients.

- **Protocol design**: pick the shape (REST vs gRPC vs JSON-RPC; flat vs typed). Library, playback, search, ratings, resume. One protocol for audio + video so the SPA only speaks one dialect.
- **Gaps already patched over in Subsonic** (each a non-standard field or endpoint today, which phone clients ignore): station logos (`coverArt` on a station), whether a station may be removed (`custom`), stable station ids, station search (`searchRadioStations`), the ICY now-playing title (`radioMeta`), audiobook chapters, and errors as HTTP 200 envelopes instead of statuses. The native protocol should carry these as first-class fields.
- **Audio Subsonic compat facade**: keep `/audio/rest/*` working against Maneki-native data so existing Subsonic clients (Symfonium, Amperfy, play:Sub, Feishin) keep working.
- **Jellyfin / Plex compat**: deferred until the native protocol is stable. Useful for Infuse / Streamio / VLC / mobile-app integration.

## Audio polish (continued)

- **AcoustID auto-enable**: today you have to pass `--acoustid-key` per run. Read from `~/.config/maneki/maneki.toml` (`[acoustid].api_key`) and apply automatically when an album has tagless tracks.
- **Album merge tool**: when the same album exists with different tags as two folders, an interactive merge.
- **`--dry-run` with rich diff**: show exactly what tags would change, what files would move.

## Packaging & distribution

- **Deno as a single-binary shell**: `deno compile --target` cross-compiles to x86_64/aarch64 Linux, x86_64/aarch64 macOS, and x86_64 Windows from one toolchain, producing a self-contained executable with no runtime to install. That is attractive against what the desktop story costs today: two parallel shells (`desktop/tauri`, `desktop/electron`) sharing one React frontend, where Tauri needs a Rust toolchain plus per-platform system webviews and Electron ships an entire Chromium per build. Worth scoping as a third shell that serves the existing SPA and talks to the same HTTP API.

  The honest limit: this only replaces the *shell and distribution* layer, not the media pipeline. The backend is Python for real reasons - mutagen for tag round-tripping, yt-dlp, and the ffmpeg orchestration in the HLS and convert paths - and none of that ports cheaply. So the realistic shape is a Deno shell wrapping a Python server, which does not remove the Python runtime dependency, or a much larger rewrite that does. Evaluate before committing: whether the packaged binary can bundle or locate a Python runtime and ffmpeg, and whether that beats today's Tauri bundle size and build matrix.

## Speculative

Things that would be interesting if anyone ever asked, but not pursued speculatively:

- BPM / key analysis (needs `librosa`, big dep weight).
- AI-generated playlists with audio-feature similarity (current `maneki audio playlist gen` is tag-based; an audio-feature pass would need fingerprinting / `librosa`).
- Multi-user serve (right now: single-user).
- Sonos / Chromecast / DLNA output (AirPlay covers the Apple-ecosystem case).
- Cross-fade between tracks.
- Listening rooms / sync-play across clients.
- Voice control.
- Live TV / DVR tuner support.
- Photo libraries as a third kind alongside audio + video.
