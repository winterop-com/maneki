"""MediaKit-native video FastAPI app.

Endpoints:
- GET /                          minimal demo HTML page (lists + plays)
- GET /capabilities              server identity + audio/video presence
- GET /api/videos                flat list of files under <root>/videos/
- GET /api/videos/{id}/stream    raw bytes (HTTP Range supported)
- GET /api/videos/{id}/play      browser-compatible ffmpeg-piped fMP4
- GET /api/videos/{id}/hls/{filename}   HLS playlist + fMP4 segments
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse

from mediakit import __version__
from mediakit.video.serve.demo import DEMO_HTML
from mediakit.video.serve.hls import HLSManager
from mediakit.video.serve.poster import PosterManager
from mediakit.video.serve.scan import BrowseResponse, VideoEntry, browse_dir, scan_videos
from mediakit.video.serve.subtitles import (
    SubtitleCache,
    SubtitleSidecar,
    discover_sidecars,
    probe_embedded_subtitles,
    to_webvtt,
)
from mediakit.video.serve.transcode import (
    FFmpegNotFoundError,
    assert_ffmpeg_available,
    transcode_to_mp4,
)
from mediakit.video.serve.transcode_budget import TranscodeBudget

# Module-level HLS manager so sessions survive across requests within one
# server process. Each create_app call gets its own (passed in via closure),
# scoped to that app's lifetime.

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


def create_app(root: Path, *, budget: TranscodeBudget | None = None) -> FastAPI:
    """Build the FastAPI app rooted at the given library directory.

    Args:
        root: library root. The app scans <root>/videos/ on each request (no
            persistent cache in this base layer - simplicity over performance
            for v0; SQLite cache is the next layer up).
        budget: shared foreground-priority transcode scheduler. When None
            a fresh one is created with the default worker count.
    """
    app = FastAPI(title="mediakit-video", version=__version__)
    shared_budget = budget if budget is not None else TranscodeBudget()
    hls_manager = HLSManager(budget=shared_budget)
    # Posters live under <root>/.mediakit/posters/ - library-local cache
    # so they survive server restarts and follow the library if moved.
    poster_manager = PosterManager(
        cache_dir=root / ".mediakit" / "posters",
        budget=shared_budget,
    )
    subtitle_cache = SubtitleCache(cache_dir=root / ".mediakit" / "subs")
    # Exposed on app.state so callers running this app as a mounted
    # sub-app (mediakit serve --ui) can trigger prewarm from their own
    # lifespan - FastAPI does NOT run sub-app lifespans automatically.
    app.state.poster_manager = poster_manager
    app.state.hls_manager = hls_manager
    app.state.subtitle_cache = subtitle_cache
    app.state.library_root = root
    app.state.budget = shared_budget

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

    @app.get("/api/browse")
    def browse(path: str = "") -> BrowseResponse:
        """List immediate children of <root>/videos/<path>/ (folders + videos).

        Powers the SPA's click-in folder navigator. The empty path browses
        the videos root. Returns 404 when the path escapes the videos
        directory or doesn't exist as a directory.
        """
        result = browse_dir(root, path)
        if result is None:
            raise HTTPException(status_code=404, detail=f"no such folder under videos/: {path!r}")
        return result

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

    @app.get("/api/videos/{video_id}/poster")
    async def video_poster(video_id: str) -> Response:
        """Serve the contact-sheet poster (9-frame mosaic with header)."""
        entry = _find(video_id, root)
        try:
            assert_ffmpeg_available()
        except FFmpegNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        try:
            path = await poster_manager.ensure_poster(
                video_id,
                Path(entry["path"]),
                size_bytes=entry["size_bytes"],
                title=entry["name"],
                duration_s=entry["duration_s"],
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return FileResponse(path, media_type="image/png")

    @app.get("/api/videos/{video_id}/thumbnail")
    async def video_thumbnail(video_id: str) -> Response:
        """Serve a single-frame JPEG thumbnail for the video-list row icon."""
        entry = _find(video_id, root)
        try:
            assert_ffmpeg_available()
        except FFmpegNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        try:
            path = await poster_manager.ensure_thumbnail(
                video_id,
                Path(entry["path"]),
                duration_s=entry["duration_s"],
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return FileResponse(path, media_type="image/jpeg")

    @app.get("/api/videos/{video_id}/subtitles")
    def list_subtitles(video_id: str) -> list[dict[str, object]]:
        """List sidecar + embedded subtitle tracks usable by the player.

        Each entry carries a stable `track_id`, a human label (suitable
        for the player's language picker), and a `url` the SPA can wire
        straight to a <track src=...> element. Image-based embedded
        codecs (PGS, VobSub) are filtered out upstream.

        The `default` flag is rewritten so at most one track is marked
        default, with priority English (SDH / HoH / closed captions) >
        plain English > none. ffprobe's stream-disposition default is
        ignored on purpose - real-world files often have "Spanish"
        marked default by upload tools, which isn't what an English-
        speaking viewer expects.
        """
        entry = _find(video_id, root)
        video_path = Path(entry["path"])
        tracks: list[dict[str, object]] = []
        for s in discover_sidecars(video_path):
            tracks.append(
                {
                    "track_id": f"sidecar:{s.language}",
                    "kind": "sidecar",
                    "lang": s.language,
                    "label": _track_label(s.language, None),
                    "format": s.fmt,
                    "default": False,
                    "url": f"/api/videos/{video_id}/subtitles/{s.language}",
                }
            )
        for e in probe_embedded_subtitles(video_path):
            tracks.append(
                {
                    "track_id": f"embed:{e.stream_index}",
                    "kind": "embedded",
                    "lang": e.language,
                    "label": _track_label(e.language, e.title) + (" (forced)" if e.forced else ""),
                    "format": e.codec_name,
                    "default": False,
                    "url": f"/api/videos/{video_id}/subtitles/embed-{e.stream_index}",
                }
            )
        _apply_default_priority(tracks)
        return tracks

    @app.get("/api/videos/{video_id}/subtitles/{key}")
    async def stream_subtitle(video_id: str, key: str) -> Response:
        """Serve one subtitle track as WebVTT.

        `key` is either a language tag for a sidecar (`en`, `und`, ...)
        or `embed-<stream_index>` for an embedded stream. Embedded
        streams are extracted via ffmpeg on first request and cached
        under `<root>/.mediakit/subs/<id>/embed-<N>.vtt`.
        """
        entry = _find(video_id, root)
        video_path = Path(entry["path"])
        if key.startswith("embed-"):
            try:
                idx = int(key[len("embed-"):])
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="invalid embed key") from exc
            # Make sure the index actually corresponds to a probed track
            # so we don't trigger ffmpeg on bogus input.
            probed = probe_embedded_subtitles(video_path)
            if not any(p.stream_index == idx for p in probed):
                raise HTTPException(status_code=404, detail=f"no embedded subtitle at index {idx}")
            try:
                path = await subtitle_cache.ensure(video_id, video_path, idx)
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            return FileResponse(path, media_type="text/vtt; charset=utf-8")
        # Sidecar path
        sidecars = discover_sidecars(video_path)
        match = _pick_sidecar(sidecars, key)
        if match is None:
            raise HTTPException(status_code=404, detail=f"no subtitle for lang {key!r}")
        body = to_webvtt(match.path)
        return Response(content=body, media_type="text/vtt; charset=utf-8")

    @app.get("/api/videos/{video_id}/hls/{filename}")
    async def hls_file(video_id: str, filename: str, request: Request) -> Response:
        """Serve an HLS playlist, init segment, or fMP4 segment.

        - `index.m3u8`: synthesised from ffprobe duration. Returned
          instantly with full segment list + #EXT-X-ENDLIST so the
          player treats it as VOD (scrub anywhere).
        - `init.mp4`: emitted alongside segment 0 by ffmpeg's HLS muxer.
        - `seg-NNNN.m4s`: transcoded on first request, cached on disk.
        """
        if "/" in filename or filename.startswith("."):
            raise HTTPException(status_code=400, detail="invalid filename")
        entry = _find(video_id, root)
        try:
            assert_ffmpeg_available()
        except FFmpegNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        duration = entry["duration_s"]
        if duration is None or duration <= 0:
            raise HTTPException(status_code=503, detail="cannot determine video duration for HLS")

        session = hls_manager.get_or_create(video_id, Path(entry["path"]), duration)

        if filename == "index.m3u8":
            return Response(
                content=session.manifest(),
                media_type="application/vnd.apple.mpegurl",
            )
        if filename.startswith("seg-") and filename.endswith(".ts"):
            try:
                idx = int(filename[len("seg-") : -len(".ts")])
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="invalid segment filename") from exc
            # Mark this as a foreground transcode for the duration -
            # the shared budget pauses any in-flight background work
            # (prewarm + prefetch) so the player request gets full CPU.
            # Race the transcode against a disconnect watcher; when the
            # browser aborts the request (rapid scrubs do this), the
            # work task is cancelled which propagates into
            # _transcode_segment and kills the ffmpeg subprocess in its
            # try/finally. Without this, ffmpeg pile-up == hang.
            async with shared_budget.foreground():
                work = asyncio.create_task(session.ensure_segment(idx))
                watcher = asyncio.create_task(_watch_disconnect(request))
                try:
                    done, _ = await asyncio.wait(
                        {work, watcher},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                finally:
                    if not watcher.done():
                        watcher.cancel()
                    if work not in done and not work.done():
                        work.cancel()
                # Drain cancelled tasks so warnings don't leak. Note:
                # CancelledError is a BaseException subclass in 3.8+,
                # so plain `suppress(Exception)` doesn't cover it.
                for task in (watcher, work):
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
                if watcher in done and work not in done:
                    raise HTTPException(status_code=499, detail="client disconnected")
                try:
                    path = work.result()
                except IndexError as exc:
                    raise HTTPException(status_code=404, detail=str(exc)) from exc
            # Kick off neighbour transcodes AFTER releasing the
            # foreground marker so they themselves can be paused by
            # the next foreground request.
            session.prefetch_neighbors(idx)
            return FileResponse(path, media_type="video/mp2t")
        raise HTTPException(status_code=404, detail=f"unknown hls resource {filename!r}")

    return app


async def _watch_disconnect(request: Request) -> None:
    """Resolve when the client closes the connection. Polls every 0.5s."""
    while True:
        await asyncio.sleep(0.5)
        if await request.is_disconnected():
            return


def _pick_sidecar(sidecars: list[SubtitleSidecar], lang: str) -> SubtitleSidecar | None:
    """Return the sidecar whose language matches `lang` exactly, or None."""
    for s in sidecars:
        if s.language == lang:
            return s
    return None


# Short ISO-639 -> readable name map for the SPA's subtitle picker. Not
# exhaustive - falls back to the raw tag for anything not listed.
_LANG_NAMES = {
    "en": "English", "eng": "English",
    "fr": "French", "fre": "French", "fra": "French",
    "de": "German", "ger": "German", "deu": "German",
    "es": "Spanish", "spa": "Spanish",
    "it": "Italian", "ita": "Italian",
    "pt": "Portuguese", "por": "Portuguese",
    "ja": "Japanese", "jpn": "Japanese",
    "ko": "Korean", "kor": "Korean",
    "zh": "Chinese", "chi": "Chinese", "zho": "Chinese",
    "ru": "Russian", "rus": "Russian",
    "ar": "Arabic", "ara": "Arabic",
    "nl": "Dutch", "dut": "Dutch", "nld": "Dutch",
    "sv": "Swedish", "swe": "Swedish",
    "no": "Norwegian", "nor": "Norwegian",
    "da": "Danish", "dan": "Danish",
    "fi": "Finnish", "fin": "Finnish",
    "pl": "Polish", "pol": "Polish",
    "und": "Subtitles",
}


_ENGLISH_LANGS = frozenset({"en", "eng"})

# Substring patterns that suggest a subtitle track is intended for the
# deaf / hard-of-hearing (or US-style closed captions, which include
# sound-effect descriptions and speaker IDs and are functionally
# equivalent). Matched case-insensitively against the track label.
# Spaces / brackets around "cc" keep us from matching unrelated words
# like "Picollo" or "Soccer".
_SDH_PATTERNS = (
    "sdh",
    "(cc)", "[cc]", " cc", "cc ",
    "hearing impaired",
    "hoh ", " hoh", "(hoh)", "[hoh]",
)


def _is_english(track: dict[str, object]) -> bool:
    return str(track.get("lang", "")).lower() in _ENGLISH_LANGS


def _looks_like_sdh(track: dict[str, object]) -> bool:
    label = str(track.get("label", "")).lower()
    return any(pat in label for pat in _SDH_PATTERNS)


def _apply_default_priority(tracks: list[dict[str, object]]) -> None:
    """Set `default` on exactly one track using a priority chain.

    Priority:
      1. Any sidecar (`.srt` / `.vtt`). The user explicitly placed a
         subtitle file next to the video, so they want it on. Prefer
         English / English-SDH when there are multiple sidecars.
      2. Embedded English (SDH / closed-captions / hearing-impaired).
      3. Embedded plain English.
      4. No default.

    Mutates in place so the caller's listing reflects the choice.
    """
    if not tracks:
        return
    sidecars = [t for t in tracks if t.get("kind") == "sidecar"]
    if sidecars:
        chosen: dict[str, object] | None = next(
            (t for t in sidecars if _is_english(t) and _looks_like_sdh(t)),
            None,
        ) or next(
            (t for t in sidecars if _is_english(t)),
            None,
        ) or sidecars[0]
    else:
        chosen = next(
            (t for t in tracks if _is_english(t) and _looks_like_sdh(t)),
            None,
        ) or next(
            (t for t in tracks if _is_english(t)),
            None,
        )
    for t in tracks:
        t["default"] = t is chosen


def _track_label(lang: str, title: str | None) -> str:
    """Build a human label for the subtitle picker.

    Prefers an explicit stream `title` (e.g. "English (SDH)") when set,
    otherwise falls back to a readable language name, finally to the raw
    tag so unmapped languages still show something.
    """
    if title:
        return title
    return _LANG_NAMES.get(lang.lower(), lang.upper() if lang else "Subtitles")


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
