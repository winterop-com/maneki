# Maneki

A Python 3.13 CLI for a self-hosted media library: convert arbitrary audio rips (FLAC / MP3 / M4A / WAV / OGG / OPUS) into a clean tagged library and serve it over LAN / Tailscale via a Subsonic-compatible HTTP server, plus a video pipeline (HLS streaming with on-demand segments, sidecar + embedded subtitles, contact-sheet posters, folder browser) all behind one `maneki serve` and one web SPA.

!!! info "The name"
    **Maneki** (招き) is the Japanese word for *beckoning* — as in the *maneki-neko* (招き猫), the cat figurine with a raised paw that invites guests in. The name fits a self-hosted server: it sits quietly on your shelf and politely waves your media in when you come knocking. Pronounced *mah-neh-kee*.

## What it does

```
input/                            output/
└── messy rips/                   └── Artist/
    [FLAC] Some Album (CD1)/          └── 2012 - Album Name/
       01-track.flac      ─►              ├── 01 - First Track.m4a
       ...                                ├── 02 - Second Track.m4a
                                          └── cover.jpg
```

End-to-end pipeline:

1. **Walk** the input tree, group by leaf directory, merge multi-disc layouts.
2. **Read** source tags (mutagen for FLAC / MP3 / MP4) plus filename fallback for tagless rips.
3. **Re-encode** via `ffmpeg`, default to 256k AAC m4a (Apple Music quality, ~24% the size of lossless).
4. **Pick a cover** — embedded, sidecar, or online via MusicBrainz + Cover Art Archive.
5. **Write clean tags** + the normalised cover; lay out as `output/<Artist>/<YYYY> - <Album>/NN - <Title>.m4a`.

Then on top of that:

- **`maneki library`** — read, audit, fix, retag, cover, and manage the converted library. Subcommands:
  - `library tree DIR` / `library audit DIR` / `library fix DIR` — render, audit, auto-fix
  - `library cover IMAGE DIR` / `library cover-pick DIR` / `library retag DIR` — in-place tag and cover edits; semi-automated cover selection via [musichoarders.xyz](https://covers.musichoarders.xyz/)
  - `library lyrics fetch DIR` — populate `<track>.lrc` sidecars from [LRCLIB](https://lrclib.net) (free, no API key, returns synced lyrics for popular tracks)
  - `library index status|drop|rebuild DIR` — manage the persistent SQLite index at `<DIR>/.maneki/index.db`
- **`maneki serve`** — one server, one library root. Scans the directory recursively and auto-mounts whichever kinds have content: the Subsonic API at `/audio/rest/*` when audio is present, the Maneki-native video API at `/video/api/*` when video is present, the web SPA at `/` with `--ui`. Any Subsonic client (Symfonium, Amperfy, play:Sub, Feishin) reads `/audio/rest/*` directly. Real heart / star button (persistent favourites at `<root>/.maneki/stars.toml`); LRC bodies promoted to `synced: true` so client lyrics views highlight live. Video pipeline includes HLS streaming with on-demand MPEG-TS segments, sidecar `.srt` + embedded subtitle extraction to WebVTT, contact-sheet posters, click-in folder browser. See [Serve](guides/serve-unified.md) and [Video](guides/video.md).
- **`maneki library`** — cross-cutting tools for any library root. `info` counts files per kind, `list` walks the tree, `inspect` dumps tags / cover for an audio file or ffprobe streams / container info for a video file.
- **`maneki audio playlist`** — auto-generate `.m3u8` playlists anchored to a seed track using tag-based similarity (artist / genre / year). `gen` writes a mix; `list` / `show` browse what's saved. Output is plain extended M3U so VLC and Subsonic clients can play it.
- **`maneki audio inspect`** — quick tag dump for a single file (also reachable via the cross-cutting `maneki library inspect`).
- **Desktop apps** — Tauri (~15 MB, native WebKit on macOS) and Electron (~120 MB, bundled Chromium) wrappers around a generic Subsonic client UI. URL + Username + Password login; salted-token auth; refresh-restores via URL hash. `.dmg` / `.exe` / `.AppImage` / `.deb` attach to every release. See [Desktop apps](guides/desktop.md).
- **Mobile** — no Maneki app of its own; `serve` exposes the standard Subsonic API so play:Sub / Amperfy (iOS) and Symfonium / DSub / Tempo (Android) all work against it. See [Mobile](guides/mobile.md).

## Quickstart

```bash
uvx maneki audio convert ./input ./output
```

`uvx` downloads the latest `maneki` from PyPI, caches it, runs it. For persistent install: `uv tool install maneki`. New here?

- **[Quickstart](guides/quickstart.md)** — full end-to-end walkthrough including iPhone + Tailscale + Amperfy. ~30 minutes.
- **[Architecture](architecture.md)** — how the pieces fit together: process model, data flow, audio engine subprocess, SQLite index, FFT visualizer. Read this first if you want a mental model before diving in.

Per-command guides: [Serve (unified)](guides/serve-unified.md) · [Library](guides/library.md) · [Audio convert](guides/convert.md) · [Audio library](guides/audio-library.md) · [Video](guides/video.md) · [Playlist](guides/playlist.md) · [Inspect](guides/inspect.md).

Clients: [Desktop apps](guides/desktop.md) · [Mobile (Subsonic)](guides/mobile.md).

## Why this exists

Years of rip-collection wrangling produces an audio library full of:

- Scene-tag noise (`[FLAC]`, `[16Bit-44.1kHz]`, `[somesite.com]`)
- Multi-disc layouts in 6 different conventions (`CD1`/`CD2`, `Disc 1`/`Disc 2`, `Album (CD1)`/`Album (CD2)`, …)
- Tagless tracks that need filename parsing to recover artist / title
- Various-Artists rips with `album_artist = "VA"` and the real artist hiding in the filename
- Cover art that's either missing, low-resolution, or back-cover-by-mistake

`maneki audio convert` handles all of these; the rest of the CLI gives you tools to browse, play, audit, and stream the result.

## Status

Top-level commands: `maneki serve` (single-library audio + video + SPA, auto-detects what's there), `maneki library` (cross-cutting info / list / inspect), `maneki audio <...>` (convert, library, inspect, ui, playlist). mypy + pyright + ruff clean, full pytest suite green. Audio side real-world tested against Symfonium / Amperfy / play:Sub / Feishin clients with persistent favourites and synced lyrics; video side serves the SPA's folder browser + video.js player on the same origin.

Roadmap items still open are listed at [Roadmap](roadmap.md).
