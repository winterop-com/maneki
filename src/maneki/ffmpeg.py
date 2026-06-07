"""Locate the ffmpeg / ffprobe binaries.

`MANEKI_FFMPEG` / `MANEKI_FFPROBE` override the normal `PATH` lookup, so you can
point maneki at a specific build without touching the global `PATH` - e.g. a
keg-only Homebrew `ffmpeg-full` (which bundles libzimg/`zscale` for HDR
tonemapping) at `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`. Handy under a
service manager where exporting `PATH` is awkward.

Every ffmpeg/ffprobe invocation in maneki goes through these, so a single
override covers transcoding, probing, posters, subtitles, and the scan.
"""

from __future__ import annotations

import os
import shutil


def ffmpeg_path() -> str | None:
    """Ffmpeg binary: `MANEKI_FFMPEG` if set, else the `PATH` lookup (None if absent)."""
    return os.environ.get("MANEKI_FFMPEG") or shutil.which("ffmpeg")


def ffprobe_path() -> str | None:
    """Ffprobe binary: `MANEKI_FFPROBE` if set, else the `PATH` lookup (None if absent)."""
    return os.environ.get("MANEKI_FFPROBE") or shutil.which("ffprobe")
