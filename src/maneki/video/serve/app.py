"""Maneki-native video FastAPI app.

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
import logging
import time
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel

from maneki import __version__
from maneki.access_log import make_access_log_middleware
from maneki.video.serve.demo import DEMO_HTML
from maneki.video.serve.hls import SEG_LEN, HLSManager, SessionStats
from maneki.video.serve.poster import PosterManager
from maneki.video.serve.scan import BrowseResponse, VideoEntry, browse_dir, scan_videos
from maneki.video.serve.scan_state import ScanState, VideoScanTracker
from maneki.video.serve.subtitles import (
    SubtitleCache,
    SubtitleSidecar,
    discover_sidecars,
    probe_embedded_subtitles,
    to_webvtt,
)
from maneki.video.serve.transcode import (
    FFmpegNotFoundError,
    assert_ffmpeg_available,
    transcode_to_mp4,
)
from maneki.video.serve.transcode_budget import BudgetState, TranscodeBudget

log = logging.getLogger(__name__)

# Inline SVG used as the row-icon placeholder while a real thumbnail is
# still being generated. Vector so one source scales for both the 320px
# row icon and any zoom; rect background matches `--panel` from the SPA
# so it blends with the surrounding pane. A small play triangle hints
# that the placeholder is "a video" rather than a missing file. Served
# verbatim with `Cache-Control: no-store` so the browser refetches when
# the SPA bumps the img src after a /thumbnails/ready poll.
_THUMB_PLACEHOLDER_SVG: bytes = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" '
    b'preserveAspectRatio="xMidYMid meet">'
    b'<rect width="320" height="180" fill="#1c2030"/>'
    b'<g transform="translate(160 90)">'
    b'<circle r="26" fill="#2a3045"/>'
    b'<polygon points="-7,-11 11,0 -7,11" fill="#5a6280"/>'
    b"</g></svg>"
)

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

# Stats SSE: one frame per second; a session is "active" (and so included
# in a frame) if it transcoded within this window. The window outlives a
# brief pause/buffer so a paused stream doesn't blink out of the panel.
_STATS_INTERVAL_S = 1.0
_STATS_ACTIVE_WINDOW_S = 30.0


class VideoStatsResponse(BaseModel):
    """One stats frame: the shared transcode budget plus every active session.

    With multiple viewers `sessions` holds several entries against the one
    shared `budget`, which is how the panel surfaces cross-client
    contention for the transcode pool.
    """

    seg_len: float
    budget: BudgetState
    sessions: list[SessionStats]


def build_video_stats(hls_manager: HLSManager, budget: TranscodeBudget, *, now: float) -> VideoStatsResponse:
    """Assemble a stats frame from the live sessions + shared budget.

    Module-level (not a closure) so it is unit-testable without standing up
    the SSE endpoint. Filters to sessions that transcoded within
    `_STATS_ACTIVE_WINDOW_S` so the panel shows who's actually streaming.
    """
    sessions = [
        session.stats(now=now)
        for session in hls_manager.sessions.values()
        if session.last_activity > 0.0 and now - session.last_activity < _STATS_ACTIVE_WINDOW_S
    ]
    return VideoStatsResponse(seg_len=SEG_LEN, budget=budget.state(), sessions=sessions)


def create_app(
    root: Path,
    *,
    budget: TranscodeBudget | None = None,
    no_cover_images: bool = False,
) -> FastAPI:
    """Build the FastAPI app rooted at the given library directory.

    Args:
        root: library root. The app scans <root>/videos/ on each request (no
            persistent cache in this base layer - simplicity over performance
            for v0; SQLite cache is the next layer up).
        budget: shared foreground-priority transcode scheduler. When None
            a fresh one is created with the default worker count.
        no_cover_images: when True, the /poster endpoint serves the
            single-frame thumbnail instead of generating a 9-frame
            contact sheet. Same flag is honoured by the prewarm path
            to skip the poster phase entirely.
    """
    app = FastAPI(title="maneki-video", version=__version__)
    # One structured access-log line per /video/* request — same shape
    # as the audio (Subsonic) side so a single tail/grep covers all
    # traffic. Without this the video routes were silent because
    # configure_logging() suppresses uvicorn's default access log in
    # favour of this richer one.
    app.add_middleware(make_access_log_middleware("maneki.video.serve.access"))
    shared_budget = budget if budget is not None else TranscodeBudget()
    hls_manager = HLSManager(budget=shared_budget)
    # Posters live under <root>/.maneki/posters/ - library-local cache
    # so they survive server restarts and follow the library if moved.
    poster_manager = PosterManager(
        cache_dir=root / ".maneki" / "posters",
        budget=shared_budget,
    )
    subtitle_cache = SubtitleCache(cache_dir=root / ".maneki" / "subs")
    # Exposed on app.state so callers running this app as a mounted
    # sub-app (maneki serve --ui) can trigger prewarm from their own
    # lifespan - FastAPI does NOT run sub-app lifespans automatically.
    app.state.poster_manager = poster_manager
    app.state.hls_manager = hls_manager
    app.state.subtitle_cache = subtitle_cache
    app.state.library_root = root
    app.state.budget = shared_budget
    app.state.no_cover_images = no_cover_images
    # Background-prewarm state. The parent app's lifespan walks the
    # library once at startup, populates `video_cache`, and ticks
    # `scan_tracker` per file so the SPA can render a progressbar.
    # Listing endpoints below read from `video_cache` when it's warm
    # (typical case after the first second of uptime); they fall back
    # to a synchronous `scan_videos(root)` on cold misses so the API
    # still works without the prewarm (tests, direct sub-app use).
    # Mirrored onto app.state so the parent app's lifespan can mutate
    # them via the mount handle.
    scan_tracker = VideoScanTracker()
    video_cache: list[VideoEntry] = []
    app.state.scan_tracker = scan_tracker
    app.state.video_cache = video_cache
    # Track in-flight background thumbnail / poster generations so the
    # endpoint's instant-placeholder path doesn't spawn duplicate ffmpeg
    # tasks on rapid polling (the SPA refreshes /thumbnails/ready every
    # few seconds while a folder is open).
    _thumb_in_flight: set[str] = set()
    _poster_in_flight: set[str] = set()

    def _videos() -> list[VideoEntry]:
        # Re-read app.state every call so updates from the lifespan
        # prewarm (which writes `video_sub.state.video_cache = ...`)
        # are visible here.
        cache: list[VideoEntry] = app.state.video_cache
        if cache:
            return cache
        return scan_videos(root)

    @app.get("/", response_class=HTMLResponse)
    def demo_page() -> str:
        """Minimal demo page that lists videos and plays the chosen one."""
        return DEMO_HTML

    @app.get("/capabilities")
    def capabilities() -> dict[str, object]:
        """Return server identity + which kinds are present at the root."""
        videos = _videos()
        return {
            "server": "maneki",
            "version": __version__,
            "audio": False,
            "video": len(videos) > 0,
            "video_count": len(videos),
        }

    @app.get("/api/videos")
    def list_videos() -> list[VideoEntry]:
        """Return a flat list of every video file under the library root."""
        return _videos()

    @app.get("/api/scan_status")
    def scan_status() -> ScanState:
        """Return the current scan progress for the SPA's loading bar.

        While `scanning=true` the SPA polls this endpoint and renders a
        progressbar from `scanned / total`. Once `scanning=false` it
        hits `/api/videos` (now backed by the warm cache) for the real
        listing.
        """
        return scan_tracker.snapshot()

    @app.post("/api/scan")
    async def trigger_scan() -> dict[str, object]:
        """Kick a manual library rescan. Mirrors the audio /rest/startScan.

        Fire-and-forget: returns immediately with the tracker's current
        snapshot. The client polls /api/scan_status for live progress.
        No-op if a scan is already running (the rescan callback itself
        guards against re-entry via the scan_tracker phase). Returns
        503 if the parent app's lifespan hasn't wired up the callback
        yet (cold start race) or when running without a parent (tests
        importing the sub-app directly).
        """
        trigger = getattr(app.state, "trigger_rescan", None)
        if trigger is None:
            raise HTTPException(
                status_code=503,
                detail="scan trigger not yet available; the server is still starting up",
            )
        # Don't await -- the rescan can take many seconds on a big
        # library, the caller wants the request to return now and poll
        # /api/scan_status instead.
        asyncio.create_task(trigger())
        snap = scan_tracker.snapshot()
        return {"started": True, "status": snap.model_dump()}

    @app.get("/api/search")
    def search_videos(q: str = "", limit: int = 200) -> list[VideoEntry]:
        """Substring-match `q` against video name + rel_path; return ranked matches.

        Case-insensitive. Empty / whitespace-only `q` returns no results so
        the SPA can swap views cheaply on every keystroke without spamming
        the network. Capped at `limit` (default 200) to keep the payload
        reasonable on huge libraries.

        Filename-only search is deliberate (no ffprobe tags / no AI
        title parsing). Real-world video libraries are searched by
        release name today; a smarter title-aware pass can layer on
        later without changing the endpoint shape.
        """
        needle = q.strip().lower()
        if not needle:
            return []
        out: list[VideoEntry] = []
        for entry in _videos():
            hay = (entry["name"] + " " + entry["rel_path"]).lower()
            if needle in hay:
                out.append(entry)
                if len(out) >= limit:
                    break
        return out

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
        entry = _find(app, video_id, root)
        return _range_response(Path(entry["path"]), request)

    @app.get("/api/videos/{video_id}/play")
    async def play_video(video_id: str) -> StreamingResponse:
        """Stream the video as fragmented MP4 via ffmpeg.

        Audio is re-encoded to stereo AAC; video stream is copied. Suitable
        for browser <video> playback when the source container or audio codec
        is not natively supported (most MKV files).
        """
        entry = _find(app, video_id, root)
        try:
            assert_ffmpeg_available()
        except FFmpegNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return StreamingResponse(
            transcode_to_mp4(Path(entry["path"])),
            media_type="video/mp4",
            headers={"Cache-Control": "no-cache"},
        )

    def _placeholder_response() -> Response:
        """Return the inline SVG placeholder for an asset still being generated.

        Status 202 says "request accepted, work is in progress". Browsers
        render the body as a normal image regardless of status code, but
        the 202 leaves a clear breadcrumb in network logs while debugging.
        `no-store` keeps the browser from caching the placeholder so the
        SPA's later `?v=<token>` bump always hits the server again.
        """
        return Response(
            content=_THUMB_PLACEHOLDER_SVG,
            media_type="image/svg+xml",
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    def _schedule_thumbnail(video_id: str, path: Path, duration_s: float | None) -> None:
        if video_id in _thumb_in_flight:
            return
        _thumb_in_flight.add(video_id)

        async def _run() -> None:
            try:
                async with shared_budget.background_slot(quiet=False):
                    await poster_manager.ensure_thumbnail(
                        video_id,
                        path,
                        duration_s=duration_s,
                    )
            except Exception:  # noqa: BLE001 - background work must not crash the server
                log.warning("thumbnail generation failed for %s", video_id, exc_info=True)
            finally:
                _thumb_in_flight.discard(video_id)

        asyncio.create_task(_run())

    def _schedule_poster(
        video_id: str,
        path: Path,
        *,
        size_bytes: int,
        title: str,
        duration_s: float | None,
    ) -> None:
        if video_id in _poster_in_flight:
            return
        _poster_in_flight.add(video_id)

        async def _run() -> None:
            try:
                async with shared_budget.background_slot(quiet=False):
                    await poster_manager.ensure_poster(
                        video_id,
                        path,
                        size_bytes=size_bytes,
                        title=title,
                        duration_s=duration_s,
                    )
            except Exception:  # noqa: BLE001
                log.warning("poster generation failed for %s", video_id, exc_info=True)
            finally:
                _poster_in_flight.discard(video_id)

        asyncio.create_task(_run())

    @app.get("/api/videos/{video_id}/poster")
    async def video_poster(video_id: str) -> Response:
        """Serve the contact-sheet poster, or a placeholder while it's being generated.

        Cache hit: returns the cached PNG (200 OK). Cache miss: returns the
        inline-SVG placeholder (202 Accepted) and schedules background
        generation. The SPA polls /api/thumbnails/ready to discover when
        the real poster lands and bumps its img src to refetch.

        With `no_cover_images=True`, the contact sheet is skipped entirely:
        the endpoint serves (or generates) the single-frame thumbnail and
        labels it as the poster. Cheaper, no 9-frame ffmpeg fan-out.
        """
        entry = _find(app, video_id, root)
        if no_cover_images:
            thumb = poster_manager.thumbnail_path(video_id)
            if thumb.exists():
                return FileResponse(thumb, media_type="image/jpeg")
            try:
                assert_ffmpeg_available()
            except FFmpegNotFoundError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            _schedule_thumbnail(video_id, Path(entry["path"]), entry["duration_s"])
            return _placeholder_response()
        cached = poster_manager.poster_path(video_id)
        if cached.exists():
            return FileResponse(cached, media_type="image/png")
        try:
            assert_ffmpeg_available()
        except FFmpegNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        _schedule_poster(
            video_id,
            Path(entry["path"]),
            size_bytes=entry["size_bytes"],
            title=entry["name"],
            duration_s=entry["duration_s"],
        )
        return _placeholder_response()

    @app.get("/api/videos/{video_id}/thumbnail")
    async def video_thumbnail(video_id: str) -> Response:
        """Serve a single-frame thumbnail, or a placeholder while it's generating.

        Cache hit: returns the cached JPEG. Cache miss: returns the inline-SVG
        placeholder (202) and schedules background generation; the SPA
        polls /api/thumbnails/ready to flip from placeholder to real frame.
        """
        entry = _find(app, video_id, root)
        cached = poster_manager.thumbnail_path(video_id)
        if cached.exists():
            return FileResponse(cached, media_type="image/jpeg")
        try:
            assert_ffmpeg_available()
        except FFmpegNotFoundError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        _schedule_thumbnail(video_id, Path(entry["path"]), entry["duration_s"])
        return _placeholder_response()

    @app.delete("/api/videos/{video_id}/session")
    def cancel_session(video_id: str) -> dict[str, int]:
        """Cancel any in-flight HLS prefetch tasks for this video.

        Called from the SPA's VideoPlayerPane cleanup right after
        `player.dispose()`. Without this, speculative neighbour-segment
        transcodes kicked off by the user's last segment request can
        keep draining CPU for tens of seconds after the user has clicked
        Close - the server was happily reporting `seg-0245.ts ... seg-0260.ts`
        long after playback visibly stopped.

        Returns the number of tasks cancelled (0 when there's no active
        session, e.g. the SPA's image preloader hit thumbnails but never
        actually opened the video). Idempotent - safe to call multiple
        times or for ids that never streamed.
        """
        session = hls_manager.get(video_id)
        if session is None:
            return {"cancelled": 0}
        return {"cancelled": session.cancel_prefetch()}

    @app.get("/api/stats/stream")
    async def stats_stream(request: Request) -> StreamingResponse:
        """Server-Sent Events stream of live transcode stats (~1 Hz).

        One `data:` frame per second carrying the shared budget plus every
        actively-streaming session, so the SPA's stats panel can show
        encoder load, per-segment realtime ratios, and cross-client
        contention - without polling. The generator stops when the client
        disconnects; EventSource handles reconnection on the browser side.
        """

        async def event_stream() -> AsyncGenerator[str, None]:
            while True:
                if await request.is_disconnected():
                    break
                frame = build_video_stats(hls_manager, shared_budget, now=time.monotonic())
                yield f"data: {frame.model_dump_json()}\n\n"
                await asyncio.sleep(_STATS_INTERVAL_S)

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                # Defeat proxy/Tailscale buffering so frames arrive promptly
                # instead of being held until the response "completes".
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/thumbnails/ready")
    def thumbnails_ready() -> dict[str, list[str]]:
        """Return the set of video IDs whose row thumbnail / player poster is cached.

        SPA polls this every few seconds while a folder is open. When an
        id newly appears under `ready`, the SPA bumps that row's <img>
        src with a version-bump query string so the placeholder gets
        swapped for the real frame without a page reload. Same trick
        for `posters_ready` against the currently-open player so the
        big contact-sheet poster swaps in once it finishes generating.

        Cache filenames are sha256-derived stems (so deeply nested rel
        paths can't blow the OS's 255-byte NAME_MAX), which means we
        can't reverse-map a filename back to its video id. Instead,
        iterate the known live ids from the in-memory video cache and
        stat each one's expected cache path.
        """
        videos: list[VideoEntry] = getattr(app.state, "video_cache", None) or []
        ready: list[str] = []
        posters_ready: list[str] = []
        for v in videos:
            vid = v["id"]
            if poster_manager.thumbnail_path(vid).exists():
                ready.append(vid)
            if poster_manager.poster_path(vid).exists():
                posters_ready.append(vid)
        return {"ready": ready, "posters_ready": posters_ready}

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
        entry = _find(app, video_id, root)
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
        under `<root>/.maneki/subs/<id>/embed-<N>.vtt`.
        """
        entry = _find(app, video_id, root)
        video_path = Path(entry["path"])
        if key.startswith("embed-"):
            try:
                idx = int(key[len("embed-") :])
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
        entry = _find(app, video_id, root)
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
            # A seek shows up as a foreground request far from the previous
            # one. Cancel any foreground transcode / prefetch the player has
            # left behind BEFORE we queue on the foreground semaphore, so the
            # abandoned ffmpegs release their slots and this segment doesn't
            # wait behind work nobody is watching. No-op during linear play.
            session.note_active(idx)
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
                # Register so a *later* seek can cancel this transcode too
                # (a backstop for clients that don't abort the superseded
                # XHR). If that happens, `work` is cancelled out from under
                # us and surfaces below as a 499.
                session.register_foreground(idx, work)
                watcher = asyncio.create_task(_watch_disconnect(request))
                done: set[asyncio.Future[object]] = set()
                try:
                    done_raw, _ = await asyncio.wait(
                        {work, watcher},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    done = done_raw  # type: ignore[assignment]
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
                if work.cancelled():
                    # A later request's note_active superseded this segment -
                    # the player has seeked away, so there's nothing to serve.
                    raise HTTPException(status_code=499, detail="segment superseded by seek")
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
    "en": "English",
    "eng": "English",
    "fr": "French",
    "fre": "French",
    "fra": "French",
    "de": "German",
    "ger": "German",
    "deu": "German",
    "es": "Spanish",
    "spa": "Spanish",
    "it": "Italian",
    "ita": "Italian",
    "pt": "Portuguese",
    "por": "Portuguese",
    "ja": "Japanese",
    "jpn": "Japanese",
    "ko": "Korean",
    "kor": "Korean",
    "zh": "Chinese",
    "chi": "Chinese",
    "zho": "Chinese",
    "ru": "Russian",
    "rus": "Russian",
    "ar": "Arabic",
    "ara": "Arabic",
    "nl": "Dutch",
    "dut": "Dutch",
    "nld": "Dutch",
    "sv": "Swedish",
    "swe": "Swedish",
    "no": "Norwegian",
    "nor": "Norwegian",
    "da": "Danish",
    "dan": "Danish",
    "fi": "Finnish",
    "fin": "Finnish",
    "pl": "Polish",
    "pol": "Polish",
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
    "(cc)",
    "[cc]",
    " cc",
    "cc ",
    "hearing impaired",
    "hoh ",
    " hoh",
    "(hoh)",
    "[hoh]",
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
        chosen: dict[str, object] | None = (
            next(
                (t for t in sidecars if _is_english(t) and _looks_like_sdh(t)),
                None,
            )
            or next(
                (t for t in sidecars if _is_english(t)),
                None,
            )
            or sidecars[0]
        )
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


def _find(app: FastAPI, video_id: str, root: Path) -> VideoEntry:
    """Look up a video by id, preferring the in-memory cache.

    Every video endpoint (/poster, /thumbnail, /hls/*, /subtitles, ...)
    funnels through here. The old implementation walked the entire
    filesystem and ffprobed every file ON EVERY CALL — fine on a 10-
    video test library, catastrophic on a 1300+ file library where a
    single video click triggered ~6 full library re-probes that
    blocked the FastAPI threadpool and stalled subsequent requests
    until they all finished.

    Fast path: the lifespan prewarm populates `app.state.video_cache`
    (a list[VideoEntry]) within ~6s of startup. A dict cache built on
    first use here makes lookups O(1). Cold-start fallback to a single
    scan_videos walk keeps the API functional when the prewarm hasn't
    populated the list yet (e.g. tests running create_app directly).
    """
    cache: list[VideoEntry] = getattr(app.state, "video_cache", None) or []
    if cache:
        by_id: dict[str, VideoEntry] | None = getattr(app.state, "_video_by_id", None)
        cache_id = id(cache)
        cache_id_marker: int | None = getattr(app.state, "_video_by_id_for", None)
        # Rebuild the dict when the underlying list reference changes
        # (rescan replaces it wholesale via `video_sub.state.video_cache = ...`).
        if by_id is None or cache_id_marker != cache_id:
            by_id = {v["id"]: v for v in cache}
            app.state._video_by_id = by_id
            app.state._video_by_id_for = cache_id
        entry = by_id.get(video_id)
        if entry is not None:
            return entry
        raise HTTPException(status_code=404, detail=f"video {video_id!r} not found")
    # Cold fallback: cache hasn't been populated yet. Walk once.
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
        if not start_str:
            # Suffix range: "bytes=-N" means "the last N bytes" per
            # RFC 7233 § 2.1, NOT "0 .. N". Some clients (mpv, exoplayer,
            # media probes that fetch the moov atom at the file tail)
            # depend on this; treating it as a prefix range returns the
            # wrong bytes and breaks seeking / metadata detection.
            if not end_str:
                raise HTTPException(status_code=416, detail="malformed range")
            suffix_len = int(end_str)
            if suffix_len <= 0:
                raise HTTPException(status_code=416, detail="malformed range")
            start = max(0, file_size - suffix_len)
            end = file_size - 1
        else:
            start = int(start_str)
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
