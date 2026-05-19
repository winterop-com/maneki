# Library

`mediakit library` is the cross-cutting command that operates on a media library root containing both audio and video. It works across **multiple** library locations configured in `~/.config/mediakit/mediakit.toml`.

For audio-specific deep operations (audit, retag, cover-pick, lyrics, ...) see [`mediakit audio library`](audio-library.md) — those stay under the audio subgroup.

## Quick start

Pass a path directly:

```bash
mediakit library summary ~/Downloads/library
mediakit library scan ~/Downloads/library
```

Or configure one or more libraries once and skip the path:

```toml
# ~/.config/mediakit/mediakit.toml
[libraries]
locations = [
  "~/Downloads/library",
  "/Volumes/NAS/media",
]
```

Then:

```bash
mediakit library              # summary across all configured locations
mediakit library scan         # full inventory across all configured locations
```

## Subcommands

### `mediakit library`

No subcommand. Summarises every library in `[libraries].locations`. Errors out with a helpful message if no config exists.

### `mediakit library summary [<path>]`

Print kind counts for one library root, or for all configured locations if no path is given.

Output:

```
Library: /Users/morteoh/Downloads/library
  audio:     11 tracks   (audio/)
  video:      2 files    (videos/)
```

### `mediakit library scan [<path>]`

Walk one library root (or all configured) and print every file found, grouped by kind. Cheap — filesystem stat only, no ffprobe / no Mutagen / no DB write. Use this as the inventory dump.

Output:

```
Library: /Users/morteoh/Downloads/library

  audio (audio/) - 11 tracks
    Artist/Pearl Jam/2009 - Ten (Deluxe Edition)/01-01 - Once.m4a  (7.2 MB)
    Artist/Pearl Jam/2009 - Ten (Deluxe Edition)/01-02 - Even Flow.m4a  (9.1 MB)
    ...

  video (videos/) - 2 files
    The.Chair.Company.S01E01.1080p.mkv  (2.3 GB)
    The.Chair.Company.S01E02.1080p.mkv  (2.3 GB)
```

## Filesystem layout

`mediakit library` looks for two subdirectories under each library root:

- **`audio/`** (or `music/`, case-insensitive) — music files. Recognised extensions: `.mp3`, `.m4a`, `.flac`, `.wav`, `.aiff`, `.aif`, `.ogg`, `.opus`, `.aac`, `.wma`, `.ape`.
- **`videos/`** (or `video/`, case-insensitive) — video files. Recognised extensions: `.mkv`, `.mp4`, `.m4v`, `.webm`, `.mov`, `.avi`, `.ts`, `.m2ts`, `.wmv`.

Both subdirectories are scanned recursively, so any internal organisation (artist / album folders for audio, `Movies/`+`Shows/` for video, or flat) works.

If either subdir is missing, the summary or scan simply reports it (no audio, no video) and continues.

## Config file (`~/.config/mediakit/mediakit.toml`)

Schema (only the keys mediakit reads here are documented; audio-specific sections like `[server]` and `[acoustid]` live in the same file and are owned by the audio config):

```toml
[libraries]
locations = [
  "~/Downloads/library",
  "/Volumes/NAS/media",
]
```

`locations` is a list of paths. Tilde-expansion is applied so `~/Downloads/library` works as expected. Paths can be absolute or relative to the user's home; relative-to-cwd is not supported (be explicit).

## What this is not

`mediakit library` is intentionally simple: it counts and lists files. It does not:

- index into a SQLite cache (that's the next layer — `mediakit serve` does its own indexing today; a persistent scan-into-cache verb may land later)
- ffprobe video files (probe is on demand via the video server)
- audit or fix audio metadata (use [`mediakit audio library audit`](audio-library.md))
- extract artwork or subtitles (file inventory only)

Use it as the quick "what's in my library" overview.
