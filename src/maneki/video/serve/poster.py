"""Generate a contact-sheet style poster for a video.

For a single video, produces one PNG combining:
- A header strip with filename + codec / resolution / duration / size
- A grid of N evenly-spaced frame thumbnails (timestamped) sampled
  across the timeline (avoiding the leading + trailing 5%).

The poster is what the SPA shows in the player area BEFORE the user
clicks play - far more informative than the black rectangle + empty
play button overlay video.js shows by default.

Cached to disk so re-requests are file-serve cheap. Cache lives in
`<root>/.maneki/posters/<id>.png` so it survives server restarts and
is library-local (matches the audio side's `<root>/.maneki/` data dir
convention).
"""

from __future__ import annotations

import asyncio
import logging
import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, ConfigDict

from maneki.video.serve.scan import cache_stem, probe_duration
from maneki.video.serve.transcode import low_priority_kwargs
from maneki.video.serve.transcode_budget import TranscodeBudget

log = logging.getLogger(__name__)

POSTER_THUMB_WIDTH = 320
POSTER_PADDING = 6
POSTER_HEADER_HEIGHT = 64
POSTER_COLS = 3
POSTER_FRAMES = 9
POSTER_BG = (24, 26, 35)  # matches --panel
POSTER_HEADER_FG = (220, 224, 232)
POSTER_HEADER_DIM = (140, 150, 175)
POSTER_TS_BG = (0, 0, 0, 180)
POSTER_TS_FG = (245, 247, 252)

# How often `prewarm()` logs a per-phase heartbeat. The actual interval
# auto-shrinks for small libraries (so a 30-video library still shows
# ticks instead of one line) - this is the upper bound used for big
# libraries.
_PREWARM_LOG_EVERY = 25
_FONT_CANDIDATES = (
    "/System/Library/Fonts/SFMono-Regular.otf",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Monaco.dfont",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
)


class _StreamInfo(BaseModel):
    """ffprobe-extracted video stream summary used by the header strip."""

    model_config = ConfigDict(frozen=True)

    width: int
    height: int
    codec: str


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _ffmpeg_bin() -> str | None:
    return shutil.which("ffmpeg")


def _ffprobe_bin() -> str | None:
    return shutil.which("ffprobe")


def _format_duration(seconds: float) -> str:
    if not math.isfinite(seconds) or seconds < 0:
        return "--:--"
    total = int(round(seconds))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _format_size(size_bytes: int) -> str:
    gb = size_bytes / 1_073_741_824
    if gb >= 1:
        return f"{gb:.2f} GB"
    mb = size_bytes / 1_048_576
    return f"{mb:.0f} MB"


async def _probe_stream(input_path: Path) -> _StreamInfo:
    """Return width/height/codec of the first video stream, or zeros if missing."""
    ffprobe = _ffprobe_bin()
    if ffprobe is None:
        return _StreamInfo(width=0, height=0, codec="unknown")
    proc = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height",
        "-of",
        "csv=p=0",
        str(input_path),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    parts = out.decode("utf-8", errors="replace").strip().split(",")
    codec = parts[0] if parts else "unknown"
    width = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    height = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0
    return _StreamInfo(width=width, height=height, codec=codec or "unknown")


async def _gather_frames(
    input_path: Path,
    duration_s: float,
    count: int,
    tmp_dir: Path,
) -> list[tuple[float, Path]]:
    """Extract `count` frames across the middle 90% of the timeline in one ffmpeg pass.

    Previously each frame was a separate ffmpeg subprocess. On a 1313-
    video library that meant 1313 * 9 = ~12k ffmpeg launches during a
    cold prewarm, with each new process paying ~50-150ms of startup
    cost (loading codecs, parsing args, allocating buffers) before
    doing any useful work. Collapsing the per-poster fan-out to a
    single ffmpeg with N inputs (each input fast-seeked via `-ss`
    before its `-i`) keeps the same random-access seek behaviour but
    drops 8x the startup overhead per poster.
    """
    start = duration_s * 0.05
    end = duration_s * 0.95
    if count <= 1:
        timestamps = [duration_s * 0.5]
    else:
        step = (end - start) / (count - 1)
        timestamps = [start + i * step for i in range(count)]
    paths = [tmp_dir / f"f_{i:03d}.jpg" for i in range(count)]
    ffmpeg = _ffmpeg_bin()
    if ffmpeg is None:
        return []
    tmp_dir.mkdir(parents=True, exist_ok=True)
    args: list[str] = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
    ]
    for ts in timestamps:
        # `-ss` before each `-i` is input-seek (fast / random-access);
        # `-i` re-opens the source so each output gets an independent
        # decoder state. Same I/O profile as the old 9-process pattern
        # minus the per-process startup.
        args.extend(["-ss", f"{ts:.3f}", "-i", str(input_path)])
    for idx, out_path in enumerate(paths):
        args.extend(["-map", f"{idx}:v:0", "-frames:v", "1", "-q:v", "2", "-y", str(out_path)])
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        **low_priority_kwargs(),
    )
    rc = await proc.wait()
    if rc != 0:
        # Don't fail the whole poster — pick up whichever frames did
        # land. Empty list shows up as "no frames" downstream and the
        # caller raises a clean RuntimeError.
        return [(ts, p) for ts, p in zip(timestamps, paths, strict=True) if p.exists()]
    return [(ts, p) for ts, p in zip(timestamps, paths, strict=True) if p.exists()]


def _compose_sheet(
    *,
    title: str,
    stream: _StreamInfo,
    duration_s: float,
    size_bytes: int,
    frames: list[tuple[float, Path]],
    cols: int = POSTER_COLS,
) -> Image.Image:
    """Lay out header + thumbnail grid into a single PIL Image. Pure-ish."""
    thumb_w = POSTER_THUMB_WIDTH
    aspect = stream.height / stream.width if stream.width > 0 and stream.height > 0 else 9 / 16
    thumb_h = int(thumb_w * aspect)
    rows = (len(frames) + cols - 1) // cols
    pad = POSTER_PADDING
    header_h = POSTER_HEADER_HEIGHT

    grid_w = cols * thumb_w + (cols + 1) * pad
    grid_h = header_h + rows * thumb_h + (rows + 1) * pad
    # Pad to 16:9 so the player's <video> and <img class="vjs-poster">
    # share the same box and there's no visible "grow" when playback
    # starts. Without this, the contact-sheet aspect (typically
    # ~3:2 for a 3x3 grid of 16:9 thumbs + header) gets letterboxed
    # by video.js's `object-fit: contain`.
    target_w = max(grid_w, int(grid_h * 16 / 9))
    target_h = max(grid_h, int(grid_w * 9 / 16))
    sheet_w = target_w
    sheet_h = target_h
    grid_offset_x = (sheet_w - grid_w) // 2
    grid_offset_y = (sheet_h - grid_h) // 2
    sheet = Image.new("RGB", (sheet_w, sheet_h), color=POSTER_BG)
    draw = ImageDraw.Draw(sheet, "RGBA")

    font_title = _load_font(15)
    font_info = _load_font(12)
    font_ts = _load_font(11)

    bits = [
        stream.codec.upper(),
        f"{stream.width}x{stream.height}" if stream.width and stream.height else "?x?",
        _format_duration(duration_s),
        _format_size(size_bytes),
    ]
    draw.text((grid_offset_x + pad + 2, grid_offset_y + 10), title, fill=POSTER_HEADER_FG, font=font_title)
    draw.text(
        (grid_offset_x + pad + 2, grid_offset_y + 34),
        "  |  ".join(bits),
        fill=POSTER_HEADER_DIM,
        font=font_info,
    )
    draw.line(
        [
            (grid_offset_x + pad, grid_offset_y + header_h - 3),
            (grid_offset_x + grid_w - pad, grid_offset_y + header_h - 3),
        ],
        fill=(60, 64, 80),
        width=1,
    )

    for idx, (ts, frame_path) in enumerate(frames):
        row = idx // cols
        col = idx % cols
        with Image.open(frame_path) as img:
            thumb = img.convert("RGB").resize((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        x = grid_offset_x + col * thumb_w + (col + 1) * pad
        y = grid_offset_y + header_h + row * thumb_h + (row + 1) * pad
        sheet.paste(thumb, (x, y))

        label = _format_duration(ts)
        bbox = draw.textbbox((0, 0), label, font=font_ts)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        draw.rectangle(
            [x + 4, y + 4, x + tw + 12, y + th + 12],
            fill=POSTER_TS_BG,
        )
        draw.text((x + 8, y + 6), label, fill=POSTER_TS_FG, font=font_ts)

    return sheet


async def generate_poster(
    input_path: Path,
    out_path: Path,
    *,
    size_bytes: int,
    title: str,
    duration_s: float | None = None,
    frames: int = POSTER_FRAMES,
    cols: int = POSTER_COLS,
) -> Path:
    """Produce the poster PNG for `input_path` at `out_path`. Returns out_path."""
    duration = duration_s if duration_s is not None else probe_duration(input_path)
    if duration is None or duration <= 0:
        raise RuntimeError(f"cannot determine duration for {input_path}")
    if _ffmpeg_bin() is None or _ffprobe_bin() is None:
        raise RuntimeError("ffmpeg + ffprobe are required to generate posters")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    import tempfile

    stream = await _probe_stream(input_path)
    with tempfile.TemporaryDirectory(prefix="maneki-poster-") as tmp:
        gathered = await _gather_frames(input_path, duration, frames, Path(tmp))
        if not gathered:
            raise RuntimeError("ffmpeg did not produce any frames")
        sheet = _compose_sheet(
            title=title,
            stream=stream,
            duration_s=duration,
            size_bytes=size_bytes,
            frames=gathered,
            cols=cols,
        )
    sheet.save(out_path, "PNG", optimize=True)
    return out_path


async def generate_thumbnail(
    input_path: Path,
    out_path: Path,
    *,
    duration_s: float | None = None,
    width: int = 320,
) -> Path:
    """Produce a single-frame JPEG thumbnail at ~30% into the video."""
    duration = duration_s if duration_s is not None else probe_duration(input_path)
    if duration is None or duration <= 0:
        raise RuntimeError(f"cannot determine duration for {input_path}")
    ffmpeg = _ffmpeg_bin()
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is required to generate thumbnails")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ts = duration * 0.3
    # `-threads 1` + OS-idle priority so a folder of N row-thumbnail
    # generations can't starve the foreground HLS segment transcoder.
    args = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-ss",
        f"{ts:.3f}",
        "-i",
        str(input_path),
        "-frames:v",
        "1",
        "-vf",
        f"scale={width}:-2",
        "-q:v",
        "3",
        "-y",
        str(out_path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        **low_priority_kwargs(),
    )
    rc = await proc.wait()
    if rc != 0 or not out_path.exists():
        raise RuntimeError(f"ffmpeg failed to produce thumbnail for {input_path}")
    return out_path


class PosterManager:
    """Cache + lazy-build coordinator for video posters AND row thumbnails.

    Both kinds live under the same `<root>/.maneki/posters/` dir but
    use different file extensions / suffixes so they don't collide:
    `<id>.png` for the contact-sheet poster, `<id>.thumb.jpg` for the
    single-frame row icon. JPEG for the thumbnail because it's ~10x
    smaller than PNG for a single photograph.
    """

    def __init__(self, cache_dir: Path, budget: TranscodeBudget | None = None) -> None:
        self.cache_dir = cache_dir
        # One lock per (video_id, kind) so concurrent first requests for
        # the same asset don't both fire ffmpeg, but poster + thumbnail
        # requests for the same video can run in parallel.
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        # Shared with HLSManager so prewarm yields to active playback.
        # Falls back to a fresh budget when callers (tests) don't supply.
        self.budget = budget or TranscodeBudget()

    def poster_path(self, video_id: str) -> Path:
        return self.cache_dir / f"{cache_stem(video_id)}.png"

    def thumbnail_path(self, video_id: str) -> Path:
        return self.cache_dir / f"{cache_stem(video_id)}.thumb.jpg"

    def invalidate(self, video_id: str) -> int:
        """Drop the cached poster + thumbnail for one id. Returns count removed.

        Use this when a file was edited in place (same path, new
        content): the SQLite row gets refreshed via mtime/size
        diffing, but the cached poster PNG / thumbnail JPEG are
        keyed by the path-derived id and would otherwise show stale
        frames forever. The next /poster or /thumbnail request
        regenerates from the new file.
        """
        removed = 0
        for path in (self.poster_path(video_id), self.thumbnail_path(video_id)):
            try:
                path.unlink()
                removed += 1
            except FileNotFoundError:
                pass
            except OSError:
                pass
        return removed

    def clean_orphans(self, live_ids: set[str]) -> int:
        """Delete cached posters / thumbs whose video id isn't in `live_ids`.

        Catches the case where a file was renamed, moved, or deleted
        from the library since the last server run - the old cache
        entries would otherwise accumulate forever. Returns the number
        of files removed.

        Walks the cache dir and keeps any `.png` / `.thumb.jpg` whose
        stem matches `cache_stem(id)` for some id in `live_ids`.
        Files using the legacy `<full-id>.png` naming convention land
        outside the kept set and get swept here on first run after
        the hash-stem migration; the lost generations regenerate on
        the next /poster or /thumbnail request.
        """
        if not self.cache_dir.is_dir():
            return 0
        live_stems = {cache_stem(vid) for vid in live_ids}
        removed = 0
        for path in self.cache_dir.iterdir():
            if not path.is_file():
                continue
            name = path.name
            if name.endswith(".thumb.jpg"):
                stem = name[: -len(".thumb.jpg")]
            elif name.endswith(".png"):
                stem = name[: -len(".png")]
            else:
                continue
            if stem not in live_stems:
                try:
                    path.unlink()
                    removed += 1
                except OSError:
                    pass
        # Drop any in-memory locks for ids that no longer exist in the
        # library. Without this the dict grows monotonically across
        # rescans / file moves on a long-running server (each id ever
        # touched lingers forever, asyncio.Lock instances aren't free).
        stale_lock_keys = [key for key in self._locks if key[0] not in live_ids]
        for key in stale_lock_keys:
            self._locks.pop(key, None)
        return removed

    async def ensure_poster(
        self,
        video_id: str,
        input_path: Path,
        *,
        size_bytes: int,
        title: str,
        duration_s: float | None,
    ) -> Path:
        out = self.poster_path(video_id)
        if out.exists():
            return out
        lock = self._locks.setdefault((video_id, "poster"), asyncio.Lock())
        async with lock:
            if out.exists():
                return out
            return await generate_poster(
                input_path,
                out,
                size_bytes=size_bytes,
                title=title,
                duration_s=duration_s,
            )

    async def ensure_thumbnail(
        self,
        video_id: str,
        input_path: Path,
        *,
        duration_s: float | None,
    ) -> Path:
        out = self.thumbnail_path(video_id)
        if out.exists():
            return out
        lock = self._locks.setdefault((video_id, "thumb"), asyncio.Lock())
        async with lock:
            if out.exists():
                return out
            return await generate_thumbnail(
                input_path,
                out,
                duration_s=duration_s,
            )

    async def prewarm(self, entries: list[dict[str, object]], *, skip_posters: bool = False) -> None:
        """Warm caches for every video: subtitle probe, thumbnail, poster.

        Walks the supplied video listing and ensures all three are
        ready. Embedded-subtitle probes go first because the browse
        listing reads them synchronously - warming them up front means
        cold browse-after-restart is instant. Thumbnails next (row
        icons); posters last (only visible after a row is clicked).

        skip_posters=True drops the poster phase entirely so the
        --no-cover-images mode doesn't pay the 9-frame-per-video cost.

        Concurrency is bounded by the shared TranscodeBudget - background
        slots automatically yield to any in-flight foreground player
        request. Designed to be fire-and-forget from the FastAPI lifespan
        hook.

        Each entry is a dict with keys: id, path, size_bytes, name,
        duration_s. Matches VideoEntry.

        Emits a terminal heartbeat every _PREWARM_LOG_EVERY completions
        in each phase so a `maneki serve --prewarm-cache /huge/library`
        shows live progress instead of one "starting" line followed by
        minutes of silence.
        """
        if not entries:
            return

        total = len(entries)
        # Per-phase heartbeat. Each phase fans out asyncio.gather() so
        # completions arrive in roughly the order the budget grants
        # slots; the counter is incremented exactly once per finished
        # task. Logging every 25 keeps a 1313-video library showing a
        # tick every few seconds without spamming a small library.
        log_every = max(1, min(_PREWARM_LOG_EVERY, total // 20 or 1))
        # Per-phase failure counters. Each task catches its own
        # exception (so one bad file doesn't take down the gather()
        # call) and bumps the matching counter; the phase runner logs
        # the total at the end so an `--prewarm-cache` run with
        # silently-failing ffmpeg jobs surfaces as a clear "N failures"
        # line instead of an opaque "20% of thumbnails missing".
        failures: dict[str, int] = {"subtitle-probe": 0, "thumbnails": 0, "posters": 0}

        async def _phase_runner(
            label: str,
            workers: list[asyncio.Future[None]],
        ) -> None:
            done = 0
            log.info("prewarm-cache: %s phase starting (%d videos)", label, total)
            for fut in asyncio.as_completed(workers):
                await fut
                done += 1
                if done % log_every == 0 or done == total:
                    log.info("prewarm-cache: %s %d / %d", label, done, total)
            n_failed = failures[label]
            if n_failed:
                log.warning(
                    "prewarm-cache: %s phase finished with %d failure(s) out of %d",
                    label,
                    n_failed,
                    total,
                )

        async def _probe_subs(entry: dict[str, object]) -> None:
            # The probe itself is sync (subprocess.run blocks), so run
            # it in a thread to keep the event loop responsive.
            from maneki.video.serve.subtitles import probe_embedded_subtitles

            async with self.budget.background_slot():
                try:
                    await asyncio.to_thread(probe_embedded_subtitles, Path(str(entry["path"])))
                except Exception as exc:  # noqa: BLE001 - one bad file mustn't crash the prewarm
                    failures["subtitle-probe"] += 1
                    log.warning(
                        "prewarm-cache: subtitle probe failed for %s: %s",
                        entry.get("id"),
                        exc,
                    )

        async def _thumb(entry: dict[str, object]) -> None:
            async with self.budget.background_slot():
                try:
                    await self.ensure_thumbnail(
                        str(entry["id"]),
                        Path(str(entry["path"])),
                        duration_s=entry.get("duration_s"),  # type: ignore[arg-type]
                    )
                except Exception as exc:  # noqa: BLE001
                    failures["thumbnails"] += 1
                    log.warning(
                        "prewarm-cache: thumbnail generation failed for %s: %s",
                        entry.get("id"),
                        exc,
                    )

        async def _poster(entry: dict[str, object]) -> None:
            async with self.budget.background_slot():
                try:
                    raw_size = entry["size_bytes"]
                    raw_dur = entry.get("duration_s")
                    await self.ensure_poster(
                        str(entry["id"]),
                        Path(str(entry["path"])),
                        size_bytes=int(raw_size) if isinstance(raw_size, (int, str, bytes)) else 0,
                        title=str(entry["name"]),
                        duration_s=float(raw_dur) if isinstance(raw_dur, (int, float)) else None,
                    )
                except Exception as exc:  # noqa: BLE001
                    failures["posters"] += 1
                    log.warning(
                        "prewarm-cache: poster generation failed for %s: %s",
                        entry.get("id"),
                        exc,
                    )

        await _phase_runner("subtitle-probe", [asyncio.ensure_future(_probe_subs(e)) for e in entries])
        await _phase_runner("thumbnails", [asyncio.ensure_future(_thumb(e)) for e in entries])
        if not skip_posters:
            await _phase_runner("posters", [asyncio.ensure_future(_poster(e)) for e in entries])
