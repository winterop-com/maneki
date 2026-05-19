# `mediakit library`

Cross-cutting tools that operate on a single library root containing both audio and video. The same root you'd hand to [`mediakit serve`](serve-unified.md).

For audio-specific deep operations (audit, retag, cover-pick, lyrics, ...) see [`mediakit audio library`](audio-library.md) — those stay under the audio subgroup.

## Subcommands

### `mediakit library info <root>`

Print file counts per kind for one library root. Rendered as a rich panel.

```bash
mediakit library info ~/Downloads/library
```

```
                              Library
  root   /Users/morteoh/Downloads/library
  audio  11 tracks
  video  105 files
```

### `mediakit library list <root>` (alias: `ls`)

Walk the library root and print every audio / video file found, grouped by kind. Cheap — filesystem stat only, no ffprobe / no Mutagen / no DB write.

```bash
mediakit library ls ~/Downloads/library
```

```
  /Users/morteoh/Downloads/library

Audio  11 tracks
  Artist/Pearl Jam/2009 - Ten (Deluxe Edition)/01-01 - Once.m4a       7.2 MB
  Artist/Pearl Jam/2009 - Ten (Deluxe Edition)/01-02 - Even Flow.m4a  9.1 MB
  ...

Video  105 files
  videos/movies/Some.Movie.2019.1080p.BluRay.x264.mkv                 2.3 GB
  videos/tv/The Americans (2013) - S01E01 - Pilot.mkv                 2.7 GB
  ...
```

### `mediakit library inspect <file>`

Dispatch by extension:

- **Audio file** — same panels the audio inspector shows: file info, tags, embedded cover, ReplayGain, lyrics.
- **Video file** — ffprobe-driven file / container info, video streams (codec, resolution, fps, bitrate, profile / pix_fmt), audio streams (codec, channels, sample rate, language, title), subtitle streams (codec, language, default / forced flags).

```bash
mediakit library inspect ~/Downloads/library/videos/tv/ch01.mkv
```

```
                              File
  path       /Users/morteoh/Downloads/library/videos/tv/ch01.mkv
  container  Matroska / WebM
  duration   32:31
  size       2.3 GiB
  bitrate    10.02 Mbps
  encoder    libebml v1.4.4 + libmatroska v1.7.1

                             Video
  #    codec    resolution    fps      bitrate    profile / pix_fmt
  0    h264     1920x960      23.98    ?          High / yuv420p

                             Audio
  #    codec    channels    rate        bitrate     lang    title
  0    eac3     6ch         48000 Hz    640 kbps    eng

                           Subtitles
  #     codec     lang    title                            flags
  0     subrip    eng     English                          default
  1     subrip    eng     English (SDH)
  ...
```

## Filesystem layout

There is no subdirectory convention. `mediakit library` walks the root recursively and picks files up by extension.

- **Audio** — `.mp3`, `.m4a`, `.m4b`, `.flac`, `.wav`, `.aiff`, `.aif`, `.ogg`, `.opus`, `.aac`, `.wma`, `.ape`. (`.mp4` is intentionally not in the audio set — it would collide with movie files. Use `.m4a` for audio-in-mp4-container.)
- **Video** — `.mkv`, `.mp4`, `.m4v`, `.webm`, `.mov`, `.avi`, `.ts`, `.m2ts`, `.mts`, `.wmv`, `.flv`, `.mpg`, `.mpeg`, `.vob`, `.ogv`, `.ogg`, `.3gp`, `.3g2`, `.asf`, `.divx`.

The server's own `.mediakit/` cache directory is always skipped — internal artefacts (poster art, HLS segments, extracted subtitles, SQLite index) never appear in the listing.

## What this is not

`mediakit library` is intentionally simple: it counts, lists, and inspects files. It does not:

- index into a SQLite cache (that's what `mediakit serve` does internally for the Subsonic side)
- audit or fix audio metadata (use [`mediakit audio library audit`](audio-library.md))
- transcode or extract artwork / subtitles (file inventory + probe only)

Use it as the quick "what's in my library" check.
