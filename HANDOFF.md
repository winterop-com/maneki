# Maneki — handoff notes

This file captures live state and rationale that doesn't fit anywhere else in
the codebase. The next session (or you, three days from now) can read this to
pick up where the rename + desktop work left off.

## The name

Maneki (招き) is Japanese for *beckoning* — the *maneki-neko* (招き猫) is the
beckoning-cat figurine with a raised paw that invites guests in. The brand
fits a self-hosted server: sits quietly on your shelf, politely waves your
media in when you knock. Pronounced *mah-neh-kee*.

Inherited from the prior name `mediakit` (PyPI-taken, generic). Picked over
candidates: feline (too generic), playhouse (peewee ORM collision), mediabarn
(too cute), stagehand (taken).

## Open problems at handoff

Three things came up in the desktop testing that are NOT fully resolved:

### 1. Tauri rapid-click "non-stop reload"

User reproduces by mash-clicking video rows in the SPA video list. In Tauri's
WebKit the player goes into a reload loop ("Playback cannot continue. No
available working or supported playlists.").

What I tried:
- Added `recoverFromBlacklist` handler that catches video.js's exhausted-
  playlist error, calls `player.error(null)`, then `player.src({...})` to
  rebuild. First version re-entered itself → made the loop worse.
- Second version added an 8s cooldown guard. **Verified clean in browser via
  playwright** (mash-clicking through 5 videos with 120ms gaps produces
  exactly 1 manifest + 1 seg-0000 fetch for the final selection).
- User reports still reproduces in Tauri. They always run `make
  desktop-tauri-dev` (which now wipes the WebKit cache via
  `_wipe-tauri-userdata`), so it's not stale-JS.

What's likely the actual cause: each player mount calls
`player.addRemoteTextTrack()` for every embedded subtitle track (33 for the
ch01/ch2 test videos). Each addRemoteTextTrack triggers an immediate fetch
of the WebVTT. If any of those 404 (see #2 below), video.js can interpret
the accumulated `MEDIA_ERR_NETWORK` events as the playlist being unhealthy.

Next steps (untried):
- Add a `last_added` ref to debounce rapid `setSelectedVideo` calls so React
  doesn't mount-then-unmount-then-mount in fast succession. Goal: only the
  final click in a 200ms window actually mounts a player.
- Or skip `addRemoteTextTrack` for tracks whose URL is missing / known to
  404; only register on demand when the user actually opens the captions menu.

### 2. Subtitle 404 storm (root cause of #1?)

Browser console showed 67 errors during a mash-click test, all
`GET /video/api/videos/<id>/subtitles/<lang> → 404`. The endpoint exists
but expects track IDs (`embed-2`, `sidecar-<lang>`), not bare ISO language
codes (`eng`, `bul`, `dan`, …).

The SPA code in `desktop/react/src/video-views.jsx:374-376`:
```js
const src = sub.track_id
  ? window.MK_VIDEO.subtitleTrackUrl(session, video.id, sub.track_id)
  : window.MK_VIDEO.subtitleUrl(session, video.id, sub.lang);
```

The server's subtitle listing returns `track_id` on EVERY entry (verified
with curl), so the fallback branch should never fire. Yet the 404 URLs in
the console are exactly the fallback shape. Something is calling the
fallback path.

Hypotheses (untried):
- video.js's `addRemoteTextTrack` may have a "find this by srclang" search
  that produces URLs by language? Unlikely but worth checking.
- The `subtitleTrackUrl` path could be returning an undefined / empty
  string for some inputs, making video.js fall back to its own URL
  resolution off `srclang`.
- The 404 URLs are from a SEPARATE code path (not in my grep results).
  Possible: an old / cached version of the JS still running.

Next steps: open the Network panel in Tauri devtools (Cmd+Option+I), watch
the actual track src after `addRemoteTextTrack`, see what shape it actually
has. If it really is `/subtitles/<lang>`, then either my JS is wrong or
video.js is rewriting the URL.

### 3. Captions size at fullscreen still too large

User wants smaller-default subtitles. We tried:
- localStorage seed of `vjs-text-track-settings` with `fontPercent: "0.50"`
  before player init. Works for fresh installs (verified) but the user
  reports captions still look big.
- Explicit `player.textTrackSettings.setValues({fontPercent: "0.50"})`
  + `updateDisplay()` after init.

50% is the smallest value the captions menu's dropdown offers. To go below
that we'd need CSS-based scaling that doesn't conflict with the menu.
Roadmap entry covers this; not blocking.

## What just landed

- **`mediakit` → `maneki`** rename across 213 source files + the
  `src/mediakit/` → `src/maneki/` directory move. PyPI name `maneki` is
  free. Bundle IDs `com.winterop.maneki`. CLI is `maneki`. All tests
  (629) green under the new name. Repo URL `winterop-com/maneki`.
- **Desktop dev wipe**: `make desktop-tauri-dev` and `desktop-electron-dev`
  now `rm -rf` the WebKit / Electron user-data + cache + cookie + WebKit
  paths before launching. Means every dev run starts from a clean
  localStorage / cookies / IndexedDB.
- **Tauri native window fullscreen** via the built-in
  `core:window:allow-set-fullscreen` permission (no custom Rust commands;
  Tauri 2's auto-permission for custom commands is restrictive).
- **CSS player-only fullscreen**: `body[data-player-fullscreen="true"]`
  pins `.mk-tracks-pane` to viewport, hides all other chrome (drag strip,
  rail, topbar, video list, splitter, NowPlaying). Combined with the
  native window fullscreen above, the `f` key takes the video to a
  separate macOS Space with menu bar + dock hidden AND the video element
  filling the screen edge to edge.
- **Server `/capabilities` CORS**: the audio sub-app had CORS, but the
  top-level `/capabilities`, `/auth/*`, `/video/api/*` did not. Tauri
  serves the SPA from `http://tauri.localhost/` so all fetches against
  `127.0.0.1:8765` are cross-origin. Added `CORSMiddleware(allow_origins=["*"])`
  to the unified app.
- **MK_DESKTOP bridge** at `desktop/react/src/_desktop.js` exposes
  `{kind, setFullscreen, isFullscreen}` to the SPA, detecting Tauri vs
  Electron vs plain browser. Currently used only for native window
  fullscreen alongside the CSS pin.
- **Single-library auto-mount + fast startup**: `maneki serve <root>`
  scans the root recursively (no `audio/`+`videos/` subdir convention),
  mounts whichever kinds have content. The lifespan handler does only a
  fast stat-only walk (no ffprobe per file) and the orphan-cache sweep;
  posters + HLS seg-0 generate lazily on first request. Before this,
  starting the server against a 10000-file library queued thousands of
  background ffmpegs and pegged the CPU for hours.
- **`.mp4` removed from audio extensions** so movie files don't get
  scanned as phantom audio albums. `.ogg` removed from video extensions
  so Ogg Vorbis libraries don't mount both kinds.

## Things the python-reviewer flagged that are still open

From the review agent's report (kept here in case useful for the next
sweep):

- **TypedDict → Pydantic** for the four video-scan classes
  (`SubtitleSummary`, `VideoEntry`, `FolderEntry`, `BrowseResponse`).
  Project rule says Pydantic only; these slipped through.
- **`_find` does a full library scan per request**: every
  `/stream`, `/play`, `/poster`, `/thumbnail`, `/hls/*`, `/subtitles*`
  request calls `scan_videos(root)` from scratch. Fine at 100 files;
  won't scale to 1000s. Wants an in-memory index in `app.state`,
  rebuilt on a watcher event or fixed TTL.
- **`r.app` in serve_app.py:121**: pre-existing mypy error, the
  iteration over `app.routes` accesses `.app` via getattr. Should be
  `isinstance(r, Mount)`.
- **`/api/search` has no `limit` upper bound**: a caller can pass
  `limit=10000000` and combined with the per-request scan above is
  the worst-case path.
- **`serve_cmd` root arg has no `exists=True`** validation — silent
  "no kinds mounted" on a typo.
- **`transcode_budget._wait_for_foreground_arrival` polls every 250ms**
  instead of using an `asyncio.Event` directly. Adds 0-250ms latency
  on every background task that checks "did foreground arrive?".

## Pieces of state worth knowing

- **`HLS_CACHE_VERSION = "3"`** in `src/maneki/video/serve/hls.py`. Bump
  this any time segment generation rules change in a way old segments
  can't satisfy. `HLSManager.__init__` wipes the cache when the marker
  on disk doesn't match.
- **Video IDs are `<slug>-<8-hex-sha256>`** in `src/maneki/video/serve/scan.py`.
  Hash suffix is what makes the id collision-free; was a bug in earlier
  versions where two paths flattening to the same slug shared a cache.
- **Test library**: `~/Downloads/library/` has both audio (Pearl Jam,
  small MusicKit-style layout) and videos (movies/, tv/, plus a few flat
  files). Bigger reference library lives at `/Volumes/T9/Media/` but the
  user has asked NOT to dump its contents.
- **SPA cache-bust**: `desktop/react/index.html` has `?v=0.1.0-d56` on
  every JS/CSS asset. Bump that token (`sed -i.bak ...`) any time you
  change an SPA file and need to invalidate caches in browser + desktop
  webviews. The `make desktop-*-dev` wipe handles the desktop side too.
- **TranscodeBudget** has a 30s post-foreground quiet period
  (`DEFAULT_QUIET_AFTER_FG_S = 30.0` in
  `src/maneki/video/serve/transcode_budget.py`) — background ffmpeg
  jobs wait this long after the last player request before resuming so
  pausing playback doesn't immediately unleash queued prewarms.

## CLAUDE.md project rules (mirrored here for handoff)

1. **No emojis.** Anywhere.
2. **No Claude Code attribution.** No `Co-Authored-By: Claude`, no
   "Generated with Claude Code" tag lines.
3. **Conventional Commits.** `<type>(<scope>)?: <description>`. Branch
   names: `<type>/<short-description>`.
4. **Pydantic only, never `@dataclass`.** All data containers must use
   `pydantic.BaseModel`. Use `model_config = ConfigDict(frozen=True)`
   when you'd reach for `@dataclass(frozen=True)`. Convert legacy
   dataclasses the next time you touch the file.
