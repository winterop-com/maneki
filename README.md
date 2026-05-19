# MediaKit

[![CI](https://github.com/winterop-com/mediakit/actions/workflows/ci.yml/badge.svg)](https://github.com/winterop-com/mediakit/actions/workflows/ci.yml)
[![PyPI version](https://img.shields.io/pypi/v/mediakit)](https://pypi.org/project/mediakit/)
[![Python 3.13+](https://img.shields.io/badge/python-3.13+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Documentation](https://img.shields.io/badge/docs-mkdocs-blue.svg)](https://winterop-com.github.io/mediakit/)

Python 3.13 CLI for a self-hosted media library — audio (convert rips + serve via Subsonic) and video (HLS streaming with on-demand segments, sidecar + embedded subtitles, contact-sheet posters, click-in folder browser). A single `mediakit serve` runs both kinds plus the web SPA on one port.

## Install

The lowest-friction way is [`uvx`](https://docs.astral.sh/uv/) — it downloads, caches, and runs the latest published `mediakit` in one step. No install step required:

```bash
uvx mediakit --help
```

For daily / persistent use (PATH-installed, no per-run network check):

```bash
uv tool install mediakit
mediakit --help
```

You'll also need `ffmpeg` and `ffprobe` on `$PATH` for the convert pipeline:

```bash
brew install ffmpeg            # macOS
sudo apt install ffmpeg        # Debian / Ubuntu
```

## Quickstart

```bash
# Unified — one process, one URL, both protocols (recommended):
uvx mediakit serve ~/Downloads/library                     # audio on /audio/rest/*, video on /video/*

# Shared across audio + video:
uvx mediakit library summary ~/Downloads/library           # kind counts (audio + video)
uvx mediakit library scan ~/Downloads/library              # full file inventory

# Audio subgroup:
uvx mediakit audio convert ./input ./output                          # convert rips
uvx mediakit audio library audit ./output                            # audit
uvx mediakit audio serve ./output                                    # standalone Subsonic server
uvx mediakit audio playlist gen ./output --seed <track> --minutes 60 # auto-generate a mix

# Video (standalone):
uvx mediakit video serve ~/Downloads/library                         # standalone video server on :8765
```

## Screenshots

The browser SPA — bordered panels with floating titles, same palette across audio + video:

![Browser UI — drilled into an album](docs/screenshots/web-album-tracks.png)

Internet radio mode (Stations panel + ICY metadata in the title):

![Browser UI — radio mode](docs/screenshots/web-radio.png)

More in the [serve guide](https://winterop-com.github.io/mediakit/guides/serve/#browser-ui) and the [video guide](https://winterop-com.github.io/mediakit/guides/video/).

## Documentation

Full docs are at **[docs/](docs/index.md)** — built with MkDocs Material. Run them locally:

```bash
make docs-serve     # http://127.0.0.1:8000
```

Or jump straight to:

- [Architecture](docs/architecture.md) — how all the pieces fit together (process model, data flow, audio subprocess, SQLite index, FFT visualizer)
- [Quickstart](docs/guides/quickstart.md) — end-to-end walkthrough including iPhone + Tailscale + Amperfy
- [mediakit convert](docs/guides/convert.md) — codec / bitrate / enrichment matrix
- [mediakit library](docs/guides/library.md) — audit rules + auto-fix + SQLite index
- [mediakit serve](docs/guides/serve.md) — Subsonic API + Tailscale + clients
- [mediakit video](docs/guides/video.md) — HLS, subtitles, posters, folder browser
- [mediakit playlist](docs/guides/playlist.md) — auto-generated `.m3u8` mixes anchored to a seed track
- [Desktop apps](docs/guides/desktop.md) — Tauri + Electron generic Subsonic clients
- [Mobile (Subsonic)](docs/guides/mobile.md) — play:Sub / Amperfy / Symfonium / DSub / Tempo
- [Edge cases](docs/edge-cases.md) — every weirdness encountered on real rips
- [Roadmap](docs/roadmap.md) — what's next
- [Development](docs/guides/development.md) — directory layout + test patterns + commit style

## Status

v0.1.0 · audio (Subsonic-compat) + video (HLS, sidecar + embedded subtitles, contact-sheet posters, folder browser) share one `mediakit serve` and the web SPA at `/`. ruff + mypy + pyright clean, full pytest suite green. The audio server is OpenSubsonic-compatible (`multipleGenres`, `transcodeOffset`, `songLyrics` extensions), backs heart / star buttons with a persistent `<root>/.mediakit/stars.toml`, returns sub-ms FTS5-ranked `/search3` results, promotes LRC lyrics to `synced: true`, and is tested against Symfonium / Amperfy / play:Sub / Feishin clients on iOS / Android / desktop. A persistent SQLite library index at `<root>/.mediakit/index.db` makes cold starts skip the filesystem walk + tag read; the filesystem watcher does per-album incremental rescans.

## License

See LICENSE in the repo root.
