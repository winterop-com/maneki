"""HLS on-the-fly transcode session management.

The /play endpoint (transcode.py) streams a single fragmented MP4 over one
HTTP response - great for "click and watch", limited for "seek anywhere".
This module produces a true HLS playlist + fMP4 segments that any HLS-aware
player can seek freely within.

Lifecycle (v0 - intentionally minimal):

- One HLSSession per (video_id) lives in a module-level HLSManager dict.
- First GET /api/videos/{id}/hls/index.m3u8 lazily spawns ffmpeg into
  <tmp>/mediakit-hls/<id>/ producing index.m3u8 + init.mp4 + seg-NNNN.m4s.
- Segment endpoint waits up to a few seconds for the requested segment
  to appear (ffmpeg writes them sequentially as it transcodes).
- Sessions are NOT cleaned up automatically in v0; restart the server
  to free disk. Cleanup task and per-session TTL is a follow-up layer.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
from pathlib import Path

from mediakit.video.serve.transcode import FFmpegNotFoundError


def _ffmpeg_path() -> str:
    path = shutil.which("ffmpeg")
    if path is None:
        raise FFmpegNotFoundError("ffmpeg is required for HLS but was not found on PATH")
    return path


async def _probe_video_codec(input_path: Path) -> str | None:
    """Return the input's first video stream codec name, or None if ffprobe is missing."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return None
    proc = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "csv=p=0",
        str(input_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    codec = out.decode("utf-8", errors="replace").strip()
    return codec or None


def _build_args(*, ffmpeg_bin: str, input_path: Path, session_dir: Path, video_codec_copy: bool) -> list[str]:
    """Compose the ffmpeg HLS argv.

    `video_codec_copy=True` skips re-encoding the video stream (cheap, when
    the source is already H.264). Otherwise transcodes to H.264 via libx264
    at preset veryfast / crf 23 - the well-trodden "compatible everywhere,
    reasonably small, fast enough on a modern CPU" trio.
    """
    if video_codec_copy:
        video_args = ["-c:v", "copy"]
    else:
        video_args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]
    return [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(input_path),
        *video_args,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ac",
        "2",
        "-hls_time",
        "6",
        "-hls_list_size",
        "0",
        # NOTE: do NOT set "-hls_playlist_type vod" - it makes ffmpeg buffer
        # the entire playlist until input EOF, so /hls/index.m3u8 doesn't
        # exist until transcode finishes (minutes-long delay on a feature
        # film). With hls_list_size=0 and no playlist_type, ffmpeg writes
        # the playlist incrementally and appends EXT-X-ENDLIST when done.
        "-hls_segment_type",
        "fmp4",
        "-hls_segment_filename",
        str(session_dir / "seg-%04d.m4s"),
        "-hls_fmp4_init_filename",
        "init.mp4",
        str(session_dir / "index.m3u8"),
    ]


class HLSSession:
    """One ffmpeg HLS transcode for one video.

    Owns the temp directory and the ffmpeg subprocess. Idempotent start(): if
    already running, the second call is a no-op. Files appear in
    `self.session_dir` as ffmpeg produces them.
    """

    def __init__(self, input_path: Path, session_dir: Path) -> None:
        self.input_path = input_path
        self.session_dir = session_dir
        self.process: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        if self.process is not None and self.process.returncode is None:
            return
        self.session_dir.mkdir(parents=True, exist_ok=True)
        codec = await _probe_video_codec(self.input_path)
        args = _build_args(
            ffmpeg_bin=_ffmpeg_path(),
            input_path=self.input_path,
            session_dir=self.session_dir,
            video_codec_copy=(codec == "h264"),
        )
        self.process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )

    async def wait_for(self, filename: str, *, timeout: float) -> Path:
        """Block until `filename` materialises in the session dir or timeout elapses."""
        target = self.session_dir / filename
        deadline = asyncio.get_event_loop().time() + timeout
        while not target.exists():
            if asyncio.get_event_loop().time() > deadline:
                raise TimeoutError(f"timed out waiting for {filename!r}")
            await asyncio.sleep(0.1)
        return target

    async def stop(self) -> None:
        if self.process is None or self.process.returncode is not None:
            return
        self.process.terminate()
        try:
            await asyncio.wait_for(self.process.wait(), timeout=2.0)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()

    def cleanup_dir(self) -> None:
        shutil.rmtree(self.session_dir, ignore_errors=True)


class HLSManager:
    """Holds active HLS sessions, keyed by video id.

    v0: sessions persist for the lifetime of the server process. No TTL,
    no eviction. Disk usage grows as more videos are HLS-played; restart
    the server to reclaim.
    """

    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = base_dir or Path(tempfile.gettempdir()) / "mediakit-hls"
        self.sessions: dict[str, HLSSession] = {}

    async def get_or_start(self, video_id: str, input_path: Path) -> HLSSession:
        session = self.sessions.get(video_id)
        if session is not None and session.process is not None and session.process.returncode is None:
            return session
        # Recreate from scratch on first use or after a previous run died.
        session_dir = self.base_dir / video_id
        shutil.rmtree(session_dir, ignore_errors=True)
        session = HLSSession(input_path, session_dir)
        await session.start()
        self.sessions[video_id] = session
        return session

    def get(self, video_id: str) -> HLSSession | None:
        return self.sessions.get(video_id)

    async def stop_all(self) -> None:
        for session in self.sessions.values():
            await session.stop()
            session.cleanup_dir()
        self.sessions.clear()
