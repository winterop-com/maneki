# Architecture

How the pieces fit together — process model, data flow, every dependency that
sits behind a public command.

## The user-facing surfaces

```
                   +----------+
                   | maneki |  CLI (typer)
                   +----+-----+
                        |
   +---------+----------+----------+----------+
   |         |          |          |          |
convert    library    inspect     serve     video
   |         |          |          |          |
ffmpeg    SQLite      mutagen   FastAPI    FastAPI
encode    + audit     dump      + Subsonic + HLS
                                + watcher    + posters
```

Top-level: `maneki serve` mounts both audio + video sub-apps and the SPA
at `/`. Audio commands live in `src/maneki/audio/cli/` (the `library`
subapp carries `tree`, `audit`, `fix`, `cover`, `cover-pick`, `retag`,
`index status|drop|rebuild`). Video commands live in
`src/maneki/video/serve/`.

## End-to-end data flow

```
+--------------------+
|    input dir       |   raw rips: scene tags, mixed disc layouts,
|  (FLAC/MP3/M4A/    |   tagless tracks, missing covers
|   WAV/OGG/OPUS)    |
+----+---------------+
     |
     |  maneki audio convert
     v
+--------------------+
|  output dir        |   <Artist>/<YYYY> - <Album>/NN - <Title>.m4a
|  (clean library)   |   one shape, all M4A/AAC unless --format said otherwise
+----+---------------+
     |
     |  maneki audio library tree | audit | fix | cover-pick | retag
     |
     |  (also: hydrates `<output>/.maneki/index.db`,
     |   the persistent SQLite index of every album/track/
     |   audit-warning + multi-genre)
     v
+--------------------+         +-----------------------------------+
|  in-memory         |  same   |  <output>/.maneki/index.db      |
|  LibraryIndex      |<------->|  derived cache; rebuilt on schema |
|  (Pydantic graph)  |         |  bump or root mismatch            |
+----+---------------+         +-----------------------------------+
     |
     +--> consumed by `maneki serve` + the web SPA
                              |
                              v
                +---------------------------+
                | maneki (audio) serve    |
                |                           |
                | FastAPI app               |
                |   + IndexCache            |
                |   + LibraryWatcher        |
                |   + mDNS advertisement    |
                |                           |
                | Subsonic-compatible API   |
                | over LAN / Tailscale      |
                +---------+-----------------+
                          |
                          v
                +--------------------+
                | Subsonic clients   |
                | Symfonium  / iOS   |
                | Amperfy    / iOS   |
                | play:Sub   / iOS   |
                | Feishin    / desk. |
                | + the bundled SPA  |
                +--------------------+
```

## The convert pipeline (`src/maneki/audio/pipeline/`)

Pure batch process — runs to completion and exits. No daemon, no IPC.

`pipeline.run.run_convert()` is the orchestrator. Per album:

1. **`discover.py`** — walks the input tree, groups files by leaf directory,
   merges multi-disc layouts (`Album/CD1/`, `Album/Disc 1/`, etc.) into one
   logical album.
2. **`metadata.read.read_source()`** — uses mutagen to pull tags + embedded
   picture from one representative track per album. Lowercase-stripped values
   get `smart_title_case` so `the beatles` becomes `The Beatles` while real
   casing (`AC/DC`, `iPhone`, `R.E.M.`) is preserved.
3. **`enrich/`** — optional MusicBrainz / Cover Art Archive / AcoustID
   lookups when tags are missing or the cover is low-res. AcoustID uses
   chromaprint fingerprints (via fpcalc) to identify tagless tracks by audio
   content alone.
4. **`pipeline.cover`** — pick the best cover from candidates: embedded ≥
   sidecar (`cover.jpg`/`folder.jpg`) ≥ MB CAA ≥ none. Normalise via Pillow
   (max-edge resize, JPEG quality 90).
5. **`convert.py`** — call `ffmpeg` to encode each track to the target format.
   Default is 256 kbps AAC m4a (Apple Music quality, ~24% the size of
   lossless). `--format alac` for archival lossless; `--format passthrough`
   for remux only.
6. **`pipeline.album.write_album()`** — write the encoded files into
   `<output>/<Artist>/<YYYY> - <Album>/NN - <Title>.m4a`, with mutagen
   writing tags + embedded cover.

`pipeline.dedupe` skips albums whose hash already exists in the output (cheap
restart safety). `pipeline.report` accumulates per-album outcomes for the
final summary table.

## The library index (`src/maneki/audio/library/`)

The same Pydantic `LibraryIndex` graph (Artist → Album → Track) is consumed
by **every** command that reads a converted library — `library tree/audit/fix`,
`serve`. It's defined once in `library/models.py` and built two ways:

### From the filesystem (`library/scan.py`)

`scan(root)` walks `root` with `Path.rglob`, groups audio files by parent
directory (= album), reads tags with mutagen, and returns a fresh
`LibraryIndex`. This is the cold path — used the very first time a library is
seen, and any time the user passes `--no-cache`.

`audit(index)` (`library/audit.py`) attaches `warnings` to each album by
running rules: no cover, low-res cover, missing/mixed years, mixed
album_artist, scene-residue dirnames, tag/path mismatch, track gaps. Pure
analysis — no I/O after the scan.

`fix_index(index, ...)` (`library/fix.py`) acts on the warnings: MusicBrainz
year backfill (one HTTP call per flagged album), tag/path mismatch resolution
(rename dir to match tag, or invert with `--prefer-dirname`), `--rename` after
`retag`. Each fix mutates the in-memory model AND the on-disk file/dir.

### From the SQLite cache (`library/db.py`, `library/load.py`)

`<root>/.maneki/index.db` persists the `LibraryIndex` so cold starts
(launching `serve`) don't re-read every audio tag. Tables:

| Table | Holds |
|---|---|
| `meta` | `schema_version`, `library_root_abs`, `last_full_scan_at` |
| `albums` | One row per album dir — tags, counts, `dir_mtime`, audit-relevant flags |
| `tracks` | One row per audio file — tags, ReplayGain, `file_mtime`, `file_size` |
| `track_genres` | `(track_id, genre)` pairs for multi-genre support |
| `album_warnings` | `(album_id, warning)` pairs from the audit pass |

`load_or_scan(root)` is the top-level entry point used by `serve`,
and the library subcommands:

```
load_or_scan(root):
  conn = open_db(root)            # creates schema if missing; unlinks +
                                  # rebuilds on schema_version mismatch
                                  # or library_root_abs mismatch
  if is_empty(conn):
      scan_full(root, conn)       # full FS walk, audit, write all rows
  else:
      load(root, conn)            # hydrate Pydantic from rows
      validate(root, conn)        # diff FS vs DB; per-album re-scan for
                                  # added / removed / tag-edited dirs
```

`validate()` uses `(file_mtime, file_size)` per track row to detect changes
without re-reading every tag. Affected album dirs go through `rescan_albums`,
which deletes the old album row (cascade-drops tracks + warnings) and inserts
a fresh one. Whole-album deletions are detected when the DB has a row for a
dir that no longer exists on disk.

The `serve` watcher (`serve/watcher.py`) drives the same `rescan_albums`
through `IndexCache.rescan_paths(paths)` whenever filesystem events fire
during the debounce window.

Schema bumps don't run migrations — `db.py` defines a `SCHEMA_VERSION`
constant; mismatched DBs are unlinked and rebuilt from scratch. The
filesystem is the source of truth so destructive rebuilds are always safe.

## The serve process (`src/maneki/audio/serve/`)

Single FastAPI process. Components:

```
+-------------------------------------------------+
|  uvicorn                                        |
|    +------------------------------------------+ |
|    | FastAPI app (serve/app.py)               | |
|    |  - Subsonic auth dependency              | |
|    |  - PostFormToQueryMiddleware             | |
|    |    (play:Sub iOS sends creds in form)    | |
|    |  - SubsonicFormatMiddleware              | |
|    |    (XML default; ?f=json opts in)        | |
|    |  - 7 endpoint routers under /rest/       | |
|    +------------------------------------------+ |
|                                                 |
|    app.state.cache = IndexCache(root)           |
|      - LibraryIndex                             |
|      - albums_by_id / tracks_by_id /            |
|        artists_by_id (Subsonic-ID lookups)      |
|      - rebuild() / rescan_paths()               |
|                                                 |
|    app.state.watcher = LibraryWatcher(cache)    |
|      - watchdog Observer                        |
|      - debounce timer (5s)                      |
|      - dispatches changed paths to              |
|        cache.rescan_paths(...)                  |
|                                                 |
|    mDNS service (Zeroconf) advertises           |
|    `_subsonic._tcp.local` so clients on the     |
|    LAN find the server without typing its IP    |
+-------------------------------------------------+
```

The `IndexCache` wraps the shared `LibraryIndex` / `load_or_scan`
machinery so endpoints can resolve Subsonic IDs without re-walking the
filesystem. Endpoints in `serve/endpoints/` resolve
incoming Subsonic IDs against `albums_by_id` / `tracks_by_id` /
`artists_by_id` (built from the index by `_reindex`); none of them hit
the disk on a hot request — even `getCoverArt` has the path resolved
from the cache and only opens the on-disk image bytes for the response.

The `/rest/stream` endpoint either streams raw bytes (when no transcode
is requested) or pipes through ffmpeg-on-the-fly when the client asks for
`format=mp3` or `maxBitRate=N`. Symfonium / Amperfy / play:Sub clients
auto-negotiate this via `getMusicFolders` / `getOpenSubsonicExtensions`
on first connect.

### Subsonic-ID stability

`serve/ids.py` builds opaque Subsonic IDs from each entity's identity:

```python
def artist_id(artist_dir: str) -> str:
    return "ar_" + hashlib.sha1(artist_dir.encode("utf-8")).hexdigest()[:16]


def album_id(album: LibraryAlbum) -> str:
    return "al_" + hashlib.sha1(str(album.path).encode("utf-8")).hexdigest()[:16]


def track_id(track: LibraryTrack) -> str:
    return "tr_" + hashlib.sha1(str(track.path).encode("utf-8")).hexdigest()[:16]
```

The 2-char prefixes (`ar_` / `al_` / `tr_`) prevent cross-type collisions
and make IDs visually classifiable in logs / debugging. Hashing path
strings means IDs are stable across rescans for unchanged entities
(rebuild recomputes from the same input) and across server restarts.
Symfonium / Amperfy / play:Sub cache IDs per-server, so any churn would
force re-downloads on every client. Reverse lookup is O(1) via the
`albums_by_id` / `tracks_by_id` / `artists_by_id` dicts on
`IndexCache`, populated by `_reindex`.

If the user renames an album dir or moves a file, the hash changes and
clients see it as a new entity. That's the right behavior — moved
content really is logically different — but it's worth knowing if you
plan a directory reorganisation, since clients will lose any
"recently played" / "starred" state tied to the old IDs.

### IndexCache rebuild atomicity

`IndexCache._reindex` does NOT take a lock around its writes — it
mutates `self.index`, `self.albums_by_id`, `self.tracks_by_id`,
`self.artists_by_id`, `self.artist_name_by_id` in sequence. The
guarantee callers rely on is **per-attribute atomicity** from CPython's
GIL: an endpoint reading `self.albums_by_id[album_id]` either sees the
old dict reference or the new one, never a half-mutated dict. It can,
however, see a mix between old and new across attributes (a brand-new
album in `albums_by_id` paired with the old `index.albums` list)
during the ~microsecond window of `_reindex`.

In practice this is fine because endpoints touch one or two attributes
each and inconsistencies resolve on the next request. If we ever needed
strict cross-attribute snapshot reads, we'd build a single replacement
state object outside the lock and assign it via one rebind — but the
current pattern is simpler and the inconsistency window is too short to
ever observe in real Subsonic-client traffic.

## The watcher (`src/maneki/audio/serve/watcher.py`)

`watchdog` `Observer` watches the library root recursively. The handler
filters by extension (audio files only — skip `.DS_Store`, `cover.jpg`)
and pushes paths into a set during a debounce window (default 5 s). When
no new event has arrived for the debounce period, the whole batch goes
to `cache.rescan_paths(paths)`, which:

1. Resolves each path to its album dir (file → parent; existing dir →
   self; vanished → both, since we can't tell file-vs-dir from a missing
   path).
2. Calls `library.rescan_albums` to delete + re-insert only those albums
   in one transaction.
3. Refreshes the in-memory `LibraryIndex` and the reverse-lookup dicts
   from the new rows.

Dropping a brand-new album into the library directory therefore takes ~6 s
to appear (5 s debounce + scan + rebuild dicts). A bulk copy of 100 files
collapses to one rescan.

### Client-triggered rescan via the Subsonic API

Subsonic clients (Symfonium / Amperfy / Feishin) usually have a "refresh
library" button that hits two standard endpoints:

- `GET /rest/startScan` — kicks off a non-blocking rescan and returns
  immediately with `{scanning: true, count: <current-track-count>}`.
  maneki backs this with `cache.start_background_rescan(force=True)`,
  which spawns a daemon thread running the same full rebuild as
  `maneki audio library index rebuild`.
- `GET /rest/getScanStatus` — poll endpoint, returns `{scanning: bool,
  count: <track-count>}`. The client polls every second or two while
  `scanning=true`, then refreshes its in-app library view.

Streaming endpoints (`/rest/stream`, `/rest/getCoverArt`) are
completely independent of the rescan path: stream reads bytes
straight off disk via PyAV/ffmpeg without touching the index. The
rescan thread does mutate the in-memory dicts (`albums_by_id` etc.)
but `IndexCache._reindex` uses an atomic per-attribute swap, so a
concurrent `/rest/getAlbum?id=X` sees either the old dict or the
new dict, never a partial state. **A track playing on Amperfy
doesn't skip during a server-side rescan.**

The watcher's auto-rescan covers most workflows, so an explicit
`startScan` from the client is usually unnecessary — drop a file in,
wait 5 seconds, pull-to-refresh the client.

## The video pipeline (`src/maneki/video/serve/`)

Same `maneki serve` process; the video sub-app is mounted at `/video/*`
when `has_video(root)` finds any file with a video extension under the
library root.

Components:

```
+--------------------------------------------------------+
|  /video/* sub-app                                      |
|    GET /api/videos          flat listing               |
|    GET /api/browse?path=    folder navigator           |
|    GET /api/videos/{id}/    poster|thumbnail|stream    |
|    GET /api/videos/{id}/hls/index.m3u8                 |
|    GET /api/videos/{id}/hls/seg-NNNN.ts                |
|    GET /api/videos/{id}/subtitles[/{key}]              |
|    GET /api/scan_status                                |
|    POST /api/scan          manual rescan trigger       |
|    GET /api/thumbnails/ready                           |
|    DELETE /api/videos/{id}/session    cancel prefetch  |
|                                                        |
|    app.state.video_cache    list[VideoEntry]           |
|    app.state.poster_manager PosterManager              |
|    app.state.hls_manager    HLSManager                 |
|    app.state.subtitle_cache SubtitleCache              |
|    app.state.scan_tracker   VideoScanTracker           |
|    app.state.trigger_rescan _rescan_callback           |
+--------------------------------------------------------+
            ^                            |
            | watchdog Observer          | TranscodeBudget
            | (5s debounce)              | (max_workers, max_foreground=3)
            v                            v
+--------------------------+    +--------------------------+
|  VideoIndex (SQLite)     |    |  ffmpeg / ffprobe        |
|  shared index.db         |    |  - HLS segment transcode |
|  videos table            |    |  - Contact-sheet 9 frames|
|  fingerprint=(mtime,size)|    |  - Subtitle extract (one |
|  batched upsert at scan- |    |    invocation, N -map    |
|  end (one transaction)   |    |    outputs)              |
+--------------------------+    +--------------------------+
```

The shared `TranscodeBudget` caps foreground (player) transcodes at 3
concurrent and background (prewarm + prefetch) at `default_workers()`
(min 8, cpu // 2). Foreground holds an idle event clear; background
slots wait until idle returns. Without the foreground cap, rapid seeks
fire one segment fetch per scrub (vhs doesn't abort on seek) and N
simultaneous ffmpegs share disk I/O so each takes ~15s instead of
~200ms; the player wedges with `readyState=1, buffered=[0,0]` and no
error to recover from.

On-disk cache layout uses `cache_stem(video_id) = sha256(id)[:32]` as
the filename / directory stem to keep paths within the OS's 255-byte
NAME_MAX limit. Posters live at `<root>/.maneki/posters/<stem>.png`;
thumbnails at `<root>/.maneki/posters/<stem>.thumb.jpg`; subtitle .vtt
files under `<root>/.maneki/subs/<stem>/embed-N.vtt`; HLS segments
under `<tempdir>/maneki-hls/<stem>/seg-NNNN.ts` (segments are large +
ephemeral so `/tmp` placement is fine).

The watcher mirrors the audio side: 5-second debounced rescan whenever
a video-extension file appears / disappears / moves; in-place edits
detect via `(mtime, size_bytes)` fingerprint mismatch and invalidate
the cached poster + thumbnail for that id so the next `/poster` /
`/thumbnail` request regenerates from the new content.

## Where every dependency sits

| Package | Used by | Purpose |
|---|---|---|
| `typer` | `cli/` | CLI plumbing (subcommands, options, autocompletion). |
| `mutagen` | `metadata/`, `pipeline/` | Read/write tags for FLAC, MP3, MP4, WAV, OGG, OPUS. |
| `Pillow` | `cover.py`, `pipeline/`, `video/serve/poster.py` | Decode + resize cover images, compose contact-sheet posters. |
| `httpx` | `enrich/` | MusicBrainz / Cover Art Archive / AcoustID HTTP. |
| `pydantic` | `library/`, `metadata/`, `video/serve/` | Data models with type-checking and round-trippable JSON. |
| `rich` | `cli/`, `library/` | Terminal tables, trees, progress bars. |
| `zeroconf` | `serve/discovery.py` | mDNS/Bonjour: server advertises so LAN clients can find it. |
| `watchdog` | `audio/serve/watcher.py`, `video/serve/watcher.py` | Filesystem-event observer for auto-rescan on both kinds. |
| `FastAPI` | `serve/`, `video/serve/`, `serve_app.py` | HTTP framework; endpoint routing, JSON serialization. |
| `uvicorn` | `cli/__init__.py` | ASGI server that runs the FastAPI app. |
| `structlog` | `audio/serve/logging.py` (shared across audio + video) | Unified colored logging + access-log middleware factory. |

External binaries: `ffmpeg` and `ffprobe` for the convert pipeline,
on-the-fly Subsonic transcoding, HLS segment generation, and subtitle
extraction. Optional: `chromaprint` (`fpcalc`) for AcoustID.

## Where to read next

- [Convert](guides/convert.md) — pipeline stages in detail.
- [Library](guides/library.md) — audit rules + the SQLite index.
- [Serve](guides/serve-unified.md) — Subsonic API + Tailscale + client setup.
- [Video](guides/video.md) — HLS, subtitles, posters, folder browser.
- [Quickstart](guides/quickstart.md) — end-to-end walkthrough including iPhone streaming.
- [Development](guides/development.md) — directory layout + test patterns.
