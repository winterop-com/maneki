"""Input-source abstraction for the HLS transcode pipeline.

The on-demand HLS pipeline (`hls.py`) was originally hard-wired to a local
file `Path`: every segment's ffmpeg command ended in a single ``-i <path>``.
Streaming a remote source — a yt-dlp-resolved YouTube video, which YouTube
serves as *separate* video and audio googlevideo URLs — needs two ``-i``
inputs plus an explicit ``-map``. This module hides that difference behind a
small `MediaSource` so the segment builder stays source-agnostic: it asks the
source for its seek+input args and its stream-map args and otherwise treats
local files and remote URLs identically.

Why this shape:

- ``seek_input_args(start_s)`` returns the ``-ss <start> -i <input>`` block.
  The ``-ss`` is placed *before* each ``-i`` so ffmpeg seeks via the input
  demuxer — an HTTP range request for remote URLs, which googlevideo honours —
  rather than decoding from zero. A remote source emits the block twice (video
  then audio), each with its own ``-ss``.
- ``map_args()`` returns the output-section ``-map`` args. A local single-input
  file needs none (ffmpeg auto-selects the best streams); a remote split-stream
  source maps ``0:v:0`` + ``1:a:0`` explicitly.
- ``is_hdr()`` gates the SDR tonemap. Local files are probed with ffprobe;
  remote sources skip the probe (a network ffprobe is slow and YouTube is
  overwhelmingly SDR) and report False.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict

from maneki.video.serve.encoders import is_hdr


class LocalSource(BaseModel):
    """A local file on disk — the original, single-input case."""

    model_config = ConfigDict(frozen=True)

    path: Path

    def seek_input_args(self, start_s: float) -> list[str]:
        return ["-ss", f"{start_s:.6f}", "-i", str(self.path)]

    def map_args(self) -> list[str]:
        return []

    def display_name(self) -> str:
        return self.path.name

    def is_hdr(self) -> bool:
        return is_hdr(self.path)

    def target_height(self) -> int | None:
        # Unknown without a probe; the encoder falls back to its 1080p bitrate
        # tier. (Local files are usually <=1080p; a probe can be added later.)
        return None


class RemoteSource(BaseModel):
    """A remote source served as separate video + audio URLs (yt-dlp / DASH).

    `name` is a human label for logs and the stats panel — there's no filename
    behind a googlevideo URL. `headers` are the per-request HTTP headers yt-dlp
    resolved for these URLs (notably `User-Agent`): googlevideo returns
    403 Forbidden if ffmpeg fetches with the wrong/missing headers, so we
    replay them on every input. HDR is assumed off (see module docstring).
    """

    model_config = ConfigDict(frozen=True)

    video_url: str
    audio_url: str
    name: str
    headers: dict[str, str] = {}
    height: int | None = None

    def _input_opts(self, start_s: float) -> list[str]:
        """Per-input ffmpeg options: replayed headers + the demuxer seek.

        ffmpeg's `-user_agent` / `-headers` are *input* options, so they must
        precede each `-i`. The UA goes through `-user_agent` (its own flag);
        any remaining headers are CRLF-joined into `-headers`.
        """
        opts: list[str] = []
        ua = self.headers.get("User-Agent")
        if ua:
            opts += ["-user_agent", ua]
        extra = "".join(f"{k}: {v}\r\n" for k, v in self.headers.items() if k.lower() != "user-agent")
        if extra:
            opts += ["-headers", extra]
        opts += ["-ss", f"{start_s:.6f}"]
        return opts

    def seek_input_args(self, start_s: float) -> list[str]:
        opts = self._input_opts(start_s)
        return [*opts, "-i", self.video_url, *opts, "-i", self.audio_url]

    def map_args(self) -> list[str]:
        return ["-map", "0:v:0", "-map", "1:a:0"]

    def display_name(self) -> str:
        return self.name

    def is_hdr(self) -> bool:
        return False

    def target_height(self) -> int | None:
        # Known from the resolved format, so the encoder sizes its bitrate to
        # the actual output resolution.
        return self.height


# Union of the concrete sources. Both expose the same method surface
# (`seek_input_args` / `map_args` / `display_name` / `is_hdr`), so the HLS
# segment builder can hold one of these and call through without caring which.
MediaSource = LocalSource | RemoteSource
"""Anything the HLS pipeline can transcode: a local file or a remote stream."""
