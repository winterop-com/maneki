"""MediaKit-native video FastAPI app.

Endpoints:
- GET /                          minimal demo HTML page (lists + plays)
- GET /capabilities              server identity + audio/video presence
- GET /api/videos                flat list of files under <root>/videos/
- GET /api/videos/{id}/stream    raw bytes (HTTP Range supported)
- GET /api/videos/{id}/play      browser-compatible ffmpeg-piped fMP4
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from mediakit import __version__
from mediakit.video.serve.demo import DEMO_HTML
from mediakit.video.serve.scan import VideoEntry, scan_videos
from mediakit.video.serve.transcode import (
    FFmpegNotFoundError,
    assert_ffmpeg_available,
    transcode_to_mp4,
)

_MIME_BY_EXT: dict[str, str] = {
    ".mkv": "video/x-matroska",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".ts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".wmv": "video/x-ms-wmv",
}


def create_app(root: Path) -> FastAPI:
    """Build the FastAPI app rooted at the given library directory.

    Args:
        root: library root. The app scans <root>/videos/ on each request (no
            persistent cache in this base layer - simplicity over performance
            for v0; SQLite cache is the next layer up).
    """
    app = FastAPI(title="mediakit-video", version=__version__)

    @app.get("/", response_class=HTMLResponse)
    def demo_page() -> str:
        """Minimal demo page that lists videos and plays the chosen one."""
        return DEMO_HTML

    @app.get("/capabilities")
    def capabilities() -> dict[str, object]:
        """Return server identity + which kinds are present at the root."""
        videos = scan_videos(root)
        return {
            "server": "mediakit",
            "version": __version__,
            "audio": False,
            "video": len(videos) > 0,
            "video_count": len(videos),
        }

    @app.get("/api/videos")
    def list_videos() -> list[VideoEntry]:
        """Return a flat list of every video file under <root>/videos/."""
        return scan_videos(root)

    @app.get("/api/videos/{video_id}/stream")
    def stream_video(video_id: str, request: Request) -> Response:
        """Serve the bytes of the requested video with HTTP Range support."""
        entry = _find(video_id, root)
        return _range_response(Path(entry["path"]), request)

    @app.get("/api/videos/{video_id}/play")
    async def play_video(video_id: str) -> StreamingResponse:
        """Stream the video as fragmented MP4 via ffmpeg.

        Audio is re-encoded to stereo AAC; video stream is copied. Suitable
        for browser <video> playback when the source container or audio codec
        is not natively supported (most MKV files).
        """
        entry = _find(video_id, root)
        try:
            assert_ffmpeg_available()
        except FFmpegNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return StreamingResponse(
            transcode_to_mp4(Path(entry["path"])),
            media_type="video/mp4",
            headers={"Cache-Control": "no-cache"},
        )

    return app


def _find(video_id: str, root: Path) -> VideoEntry:
    for v in scan_videos(root):
        if v["id"] == video_id:
            return v
    raise HTTPException(status_code=404, detail=f"video {video_id!r} not found")


def _range_response(path: Path, request: Request) -> Response:
    """Serve a file, honouring HTTP Range so video elements can seek.

    Browsers require Range support to seek mid-file. Starlette's FileResponse
    handles only the simple case; this writes the partial-content response
    explicitly so seek works in Safari + Chrome + Firefox.
    """
    file_size = path.stat().st_size
    media_type = _MIME_BY_EXT.get(path.suffix.lower(), "application/octet-stream")
    range_header = request.headers.get("range")

    if range_header is None:
        return FileResponse(
            path,
            media_type=media_type,
            headers={"Accept-Ranges": "bytes"},
        )

    units, _, ranges = range_header.partition("=")
    if units.strip().lower() != "bytes":
        raise HTTPException(status_code=416, detail="only bytes ranges supported")
    start_str, _, end_str = ranges.partition("-")
    try:
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1
    except ValueError as exc:
        raise HTTPException(status_code=416, detail="malformed range") from exc

    if start < 0 or end < start or start >= file_size:
        raise HTTPException(status_code=416, detail="range out of bounds")
    end = min(end, file_size - 1)
    chunk_size = end - start + 1

    return StreamingResponse(
        _read_chunk(path, start, chunk_size),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
        },
    )


def _read_chunk(path: Path, start: int, length: int, buffer_size: int = 64 * 1024) -> Iterator[bytes]:
    with path.open("rb") as fh:
        fh.seek(start)
        remaining = length
        while remaining > 0:
            data = fh.read(min(buffer_size, remaining))
            if not data:
                return
            remaining -= len(data)
            yield data
