"""On-the-fly transcode via ffmpeg pipe - browser-compatible fragmented MP4.

The base layer's /stream endpoint serves raw bytes (great for VLC / mpv /
external players, but most browsers won't play MKV containers or E-AC3
audio). This module remuxes the container to fragmented MP4 and re-encodes
the audio to stereo AAC so a <video> element can direct-play in Safari +
Chrome + Firefox.

Video stream is copied through (no re-encode = cheap, no quality loss).
Audio is always re-encoded; the decision tree of "is this audio codec
browser-compatible" is deferred to a later layer (HLS) where the cost of
guessing wrong is higher.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any


class FFmpegNotFoundError(RuntimeError):
    """Raised when ffmpeg is not on PATH but a transcode was requested."""


def _ffmpeg_path() -> str:
    """Return the absolute path to ffmpeg, or raise FFmpegNotFoundError."""
    path = shutil.which("ffmpeg")
    if path is None:
        raise FFmpegNotFoundError("ffmpeg is required for /play but was not found on PATH")
    return path


def assert_ffmpeg_available() -> None:
    """Raise FFmpegNotFoundError synchronously if ffmpeg is not on PATH.

    Use this in the request handler BEFORE returning a StreamingResponse, so
    the error reaches the HTTP layer as a 503 rather than being lost inside
    the async generator (which only runs once iteration begins).
    """
    _ffmpeg_path()


def _idle_preexec() -> None:
    """preexec_fn that demotes the child to OS-idle scheduling priority.

    Sits at module scope (not nested in a factory) so the function is
    picklable across the asyncio subprocess pipe and so we don't allocate
    a fresh closure on every spawn.
    """
    try:  # pragma: no cover - exercised by spawned subprocesses
        os.nice(19)
    except (AttributeError, OSError):
        pass


def low_priority_kwargs() -> dict[str, Any]:
    """Return Popen / create_subprocess_exec kwargs that demote priority.

    Spawned ffmpegs (background thumbnail / poster / HLS prefetch) compete
    with the foreground HLS segment transcoder at the OS scheduler level
    — ffmpeg grabs all the threads it can get by default, so the
    foreground player request stutters even when our asyncio-level
    `TranscodeBudget` is keeping background work below the concurrency
    cap. Lowering the OS priority of the background subprocess means the
    kernel preempts it the moment the foreground transcoder has work,
    even if both are runnable.

    Unix: `os.nice(19)` in a preexec_fn (lowest priority allowed without
    root).  Windows: `IDLE_PRIORITY_CLASS` via `creationflags`. Other
    platforms: empty dict (no-op).
    """
    if sys.platform == "win32":  # pragma: no cover - non-Mac/Linux runtime
        idle_class = getattr(subprocess, "IDLE_PRIORITY_CLASS", 0)
        return {"creationflags": idle_class} if idle_class else {}
    return {"preexec_fn": _idle_preexec}


def _build_args(input_path: Path) -> list[str]:
    """Build the ffmpeg argv: copy video stream, re-encode audio, fragmented MP4 to stdout.

    `-movflags +frag_keyframe+empty_moov+default_base_moof` produces fMP4 that
    can be played from the first byte (the standard MP4 layout puts moov at the
    end and requires the whole file before playback can start).

    Audio is downmixed to stereo AAC at 192 kbps - covers the 99% case of
    "browser can play this" without inflating the bitrate.
    """
    return [
        _ffmpeg_path(),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(input_path),
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ac",
        "2",
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ]


async def transcode_to_mp4(input_path: Path, chunk_size: int = 64 * 1024) -> AsyncIterator[bytes]:
    """Yield fragmented-MP4 bytes from ffmpeg's stdout as they arrive.

    Cleans up the subprocess on normal completion, on client disconnect
    (CancelledError propagates), and on ffmpeg failure (stdout closes).
    """
    args = _build_args(input_path)
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    assert proc.stdout is not None, "stdout PIPE was requested above"
    try:
        while True:
            chunk = await proc.stdout.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except TimeoutError:
                proc.kill()
                await proc.wait()
