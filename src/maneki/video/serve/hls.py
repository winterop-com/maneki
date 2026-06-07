"""HLS playlist + on-demand fMP4 segment generation.

The video.js / hls.js / Safari player wants a HLS playlist that describes
the full timeline (every segment listed, total duration known, ENDLIST at
the bottom). Without that the player classifies the stream as live, hides
the scrub bar, and refuses to seek past the segments it can see.

Generating the whole stream upfront (`ffmpeg -i in -f hls out.m3u8`) only
finishes when ffmpeg reaches the end of input - minutes for a feature
film. So instead we:

1. Build the manifest synthetically from ffprobe's duration (every segment
   URL + EXTINF + #EXT-X-ENDLIST), served immediately on first request.
2. Materialise each segment lazily. When the player fetches `seg-NNNN.m4s`,
   spawn a short ffmpeg that seeks to `N * SEG_LEN`, encodes exactly that
   slice, writes a fragmented MP4 segment to disk, and we serve it.
3. Cache segments on disk so re-watches / re-buffers are free.

Trade-offs vs the single long-running ffmpeg approach:
- One short subprocess per segment (~1-3s wall time): acceptable; the
  player buffers 3 segments ahead so steady-state hides startup cost.
- Seek to any point in the video transcodes one segment then plays
  immediately - no wait for a linear transcode to catch up.
- Init.mp4 is regenerated alongside the first requested segment (HLS
  fMP4 muxer emits both together). Codec args are fixed across runs so
  the init is interchangeable across segments.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import shutil
import tempfile
import time
from collections import deque
from pathlib import Path

from pydantic import BaseModel, ConfigDict

from maneki.ffmpeg import ffmpeg_path
from maneki.video.serve.encoders import (
    Encoder,
    is_hdr,
    select_encoder,
    tonemap_available,
    video_codec_args,
)
from maneki.video.serve.transcode import FFmpegNotFoundError, log_safe, low_priority_kwargs
from maneki.video.serve.transcode_budget import TranscodeBudget

_log = logging.getLogger(__name__)

# 6s chunks: standard HLS recommendation - large enough that per-segment
# ffmpeg startup overhead isn't a bottleneck, small enough that seek
# latency is bounded (~1 segment to transcode).
SEG_LEN = 6.0

# "Active window" around the latest foreground segment request. The player
# fills its buffer a few segments ahead (and may have 2-3 sequential
# requests in flight at once), so segments within this forward / backward
# band of the newest request are normal playback, not a seek. Anything
# outside it belongs to a position the user has seeked away from and is
# cancelled on the next request - see `OnDemandHLS.note_active`. The band is
# deliberately generous: a real seek jumps tens to hundreds of segments, so
# wide margins never cancel legitimate buffer-fill while still catching
# every genuine jump.
_ACTIVE_AHEAD = 8
_ACTIVE_BEHIND = 2

# How many segments forward to prefetch after each foreground request. The
# browser's HLS engine buffers ~30s ahead, but over a high-latency link the
# per-segment request round-trips serialize and the playhead outruns a
# warm-only-the-next-one cache. Warming several ahead (on the near-zero-quiet
# prefetch lane, at OS-idle priority) keeps segments ready before the player
# asks. MUST stay <= _ACTIVE_AHEAD so note_active() doesn't immediately cancel
# the look-ahead as "seeked away from" during normal linear playback.
HLS_PREFETCH_AHEAD = 6

# Per-session ring-buffer depth for transcode timings. Enough to show a
# trend in the stats panel without unbounded growth on a long watch.
_RECENT_TRANSCODES = 20


class SegmentTiming(BaseModel):
    """Wall-clock cost of one completed segment transcode.

    `realtime_ratio` is the headline number for the stats panel:
    `seconds / SEG_LEN`. Below 1.0 the encoder is keeping ahead of
    playback; at or above 1.0 it is falling behind (the 4K-HDR case) and
    the player will eventually starve.
    """

    model_config = ConfigDict(frozen=True)

    idx: int
    seconds: float
    realtime_ratio: float
    low_priority: bool
    # Which H.264 encoder produced this segment: libx264 / h264_vaapi /
    # h264_videotoolbox. Surfaced in the stats panel so it's obvious whether
    # the GPU actually engaged (and whether a HW path silently fell back).
    encoder: str = "libx264"


class SessionStats(BaseModel):
    """Live transcode stats for one OnDemandHLS session.

    One per actively-streaming video. With multiple viewers the stats
    endpoint returns several of these alongside the single shared budget,
    so the panel can show cross-client contention for the transcode pool.
    """

    video_id: str
    name: str
    segments_total: int
    transcodes_done: int
    inflight_foreground: list[int]
    inflight_prefetch: list[int]
    recent: list[SegmentTiming]
    avg_realtime_ratio: float | None
    idle_seconds: float


def _ffmpeg_path() -> str:
    path = ffmpeg_path()
    if path is None:
        raise FFmpegNotFoundError("ffmpeg is required for HLS but was not found on PATH")
    return path


class SegmentSpec(BaseModel):
    """Position of a single segment in the source timeline."""

    model_config = ConfigDict(frozen=True)

    index: int
    start_s: float
    duration_s: float


def plan_segments(total_duration_s: float, seg_len: float = SEG_LEN) -> list[SegmentSpec]:
    """Chop a duration into fixed-length segments. Last one is shorter when needed."""
    if total_duration_s <= 0 or seg_len <= 0:
        return []
    count = int(math.ceil(total_duration_s / seg_len))
    out: list[SegmentSpec] = []
    for i in range(count):
        start = i * seg_len
        dur = min(seg_len, total_duration_s - start)
        out.append(SegmentSpec(index=i, start_s=start, duration_s=dur))
    return out


def build_manifest(segments: list[SegmentSpec], seg_len: float = SEG_LEN) -> str:
    """Compose a complete VOD manifest. Players treat this as scrub-anywhere.

    Uses MPEG-TS segments (not fragmented MP4) because each per-segment
    ffmpeg run is independent and fMP4 needs a single shared `init.mp4`
    across every segment. Per-run inits differ in subtle codec params and
    the player rejects subsequent segments with MEDIA_ERR_DECODE. MPEG-TS
    segments carry their own headers and stitch together cleanly.
    """
    target = int(math.ceil(seg_len))
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{target}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
    ]
    for seg in segments:
        lines.append(f"#EXTINF:{seg.duration_s:.6f},")
        lines.append(f"seg-{seg.index:04d}.ts")
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


class OnDemandHLS:
    """Per-video transcode session. Segments materialise on demand."""

    def __init__(
        self,
        video_id: str,
        input_path: Path,
        duration_s: float,
        session_dir: Path,
        budget: TranscodeBudget,
    ) -> None:
        self.video_id = video_id
        self.input_path = input_path
        self.duration_s = duration_s
        self.session_dir = session_dir
        self.segments = plan_segments(duration_s)
        # Per-segment lock so two concurrent requests for the same segment
        # only spawn one ffmpeg. dict grows once per touched segment - fine
        # for VOD sizes (a 2hr movie at 6s segments = 1200 entries max).
        self._segment_locks: dict[int, asyncio.Lock] = {}
        # Background prefetch tasks keyed by segment index. Drained on
        # completion so the dict reflects "currently in flight".
        # Concurrency is managed by the shared TranscodeBudget so
        # prefetch yields to foreground play requests automatically.
        self._prefetch_tasks: dict[int, asyncio.Task[None]] = {}
        # In-flight foreground (player-driven) transcodes keyed by segment
        # index. Tracked so a later seek can cancel the ones the player has
        # abandoned - the browser's HLS engine doesn't reliably abort the
        # superseded segment's XHR on seek (native Safari in particular), so
        # without this the abandoned ffmpeg keeps holding one of the three
        # foreground slots while the segment the user actually wants queues
        # behind it. Self-pruning via a done-callback.
        self._inflight_fg: dict[int, asyncio.Task[Path]] = {}
        self._budget = budget
        # Observability: a ring buffer of recent transcode timings + an
        # activity stamp, surfaced by `stats()` for the UI stats panel so
        # slowdowns (encoder falling behind realtime) are visible instead
        # of guessed at. `_last_activity` is monotonic; 0.0 = never ran.
        self._recent_transcodes: deque[SegmentTiming] = deque(maxlen=_RECENT_TRANSCODES)
        self._transcodes_done = 0
        self._last_activity = 0.0
        # Resolved lazily on the first transcode: the H.264 encoder for this
        # session (process-wide auto-detect) and whether the source is HDR (so
        # it gets tonemapped to SDR). `_encoder` is downgraded to libx264 for
        # the rest of the session if a hardware encode ever fails on this file.
        self._encoder: Encoder | None = None
        self._hdr: bool | None = None

    def manifest(self) -> str:
        return build_manifest(self.segments)

    @property
    def last_activity(self) -> float:
        """Monotonic timestamp of the most recent transcode start (0.0 = never)."""
        return self._last_activity

    def stats(self, *, now: float) -> SessionStats:
        """Snapshot this session's transcode load for the stats endpoint."""
        recent = list(self._recent_transcodes)
        avg = sum(r.realtime_ratio for r in recent) / len(recent) if recent else None
        return SessionStats(
            video_id=self.video_id,
            name=self.input_path.name,
            segments_total=len(self.segments),
            transcodes_done=self._transcodes_done,
            inflight_foreground=sorted(self._inflight_fg),
            inflight_prefetch=sorted(self._prefetch_tasks),
            recent=recent,
            avg_realtime_ratio=round(avg, 3) if avg is not None else None,
            idle_seconds=round(now - self._last_activity, 1) if self._last_activity else -1.0,
        )

    def _record_transcode(self, idx: int, seconds: float, *, low_priority: bool, encoder: str = "libx264") -> None:
        """Log a completed transcode's wall time into the stats ring buffer."""
        self._transcodes_done += 1
        self._recent_transcodes.append(
            SegmentTiming(
                idx=idx,
                seconds=round(seconds, 3),
                realtime_ratio=round(seconds / SEG_LEN, 3),
                low_priority=low_priority,
                encoder=encoder,
            )
        )

    def register_foreground(self, idx: int, task: asyncio.Task[Path]) -> None:
        """Track an in-flight foreground transcode for seek cancellation.

        The endpoint owns the task (it races it against a disconnect
        watcher); we only keep a reference so `note_active` can cancel it
        when a later request shows the player has moved elsewhere. The
        done-callback removes the entry, guarding on task identity so a
        re-request of the same index that replaced this entry isn't clobbered.
        """
        self._inflight_fg[idx] = task

        def _drop(done: asyncio.Task[Path], i: int = idx) -> None:
            if self._inflight_fg.get(i) is done:
                del self._inflight_fg[i]

        task.add_done_callback(_drop)

    def note_active(self, idx: int) -> None:
        """Cancel foreground + prefetch work the player has seeked away from.

        Called at the top of every foreground segment request. Any in-flight
        foreground transcode or queued prefetch for a segment outside the
        active window around `idx` (`[idx - _ACTIVE_BEHIND, idx +
        _ACTIVE_AHEAD]`) belongs to a position the user has left. Cancelling
        it immediately kills the ffmpeg subprocess (via the CancelledError
        handler in `_transcode_segment`) and frees its slot, so the segment
        the user actually wants doesn't queue behind abandoned work - the
        dominant added latency on a seek over a high-latency link.

        Linear playback never trips this: the requested index advances by one
        and stays well inside the window, so the sliding prefetch tasks and
        the previous in-flight segment are all "active".
        """
        lo, hi = idx - _ACTIVE_BEHIND, idx + _ACTIVE_AHEAD
        for registry in (self._inflight_fg, self._prefetch_tasks):
            for j, task in list(registry.items()):
                if not (lo <= j <= hi) and not task.done():
                    task.cancel()

    async def ensure_segment(self, idx: int, *, low_priority: bool = False) -> Path:
        """Return the path to segment `idx`, transcoding it if not cached.

        `low_priority=True` (used by the prefetch path) demotes the spawned
        ffmpeg to OS-idle priority + 1 thread so a foreground transcode
        kicked off mid-prefetch wins CPU.
        """
        if idx < 0 or idx >= len(self.segments):
            raise IndexError(f"segment {idx} out of range (have {len(self.segments)})")
        out_path = self.session_dir / f"seg-{idx:04d}.ts"
        if out_path.exists():
            return out_path
        lock = self._segment_locks.setdefault(idx, asyncio.Lock())
        async with lock:
            if out_path.exists():
                return out_path
            await self._transcode_segment(idx, low_priority=low_priority)
        return out_path

    def prefetch_neighbors(self, idx: int) -> None:
        """Warm `idx+1 .. idx+HLS_PREFETCH_AHEAD` (forward) and `idx-1` (back).

        Forward look-ahead is the point: on a high-latency link the player
        can't fetch segments fast enough to stay buffered, so we transcode
        several ahead of the playhead (on the near-zero-quiet `prefetch`
        lane, OS-idle priority) to keep them ready before they're asked for.
        We still warm `idx-1` because back-buttons happen. The forward depth
        stays within the `note_active` active window so linear playback
        doesn't cancel its own look-ahead. Fire-and-forget - returns
        immediately; `_prefetch_one` dedupes, range-checks and skips cached,
        and failures are swallowed since prefetch is best-effort.
        """
        for ahead in range(1, HLS_PREFETCH_AHEAD + 1):
            self._prefetch_one(idx + ahead)
        self._prefetch_one(idx - 1)

    def _prefetch_one(self, idx: int) -> None:
        if idx < 0 or idx >= len(self.segments):
            return
        if idx in self._prefetch_tasks:
            return
        out_path = self.session_dir / f"seg-{idx:04d}.ts"
        if out_path.exists():
            return
        task = asyncio.create_task(self._safe_prefetch(idx))
        self._prefetch_tasks[idx] = task

    async def _safe_prefetch(self, idx: int) -> None:
        try:
            async with self._budget.background_slot(lane="prefetch"):
                await self.ensure_segment(idx, low_priority=True)
        except asyncio.CancelledError:
            # Cancellation is the expected path when the player closes
            # mid-stream — quiet.
            raise
        except Exception as exc:  # noqa: BLE001 - background prefetch must not crash the server
            # Was previously a silent `pass`. A single corrupt source
            # file used to drop every neighbour transcode with no
            # signal in the logs; now the user sees the first failure
            # and can decide whether to investigate.
            _log.warning(
                "hls: prefetch failed for %s seg-%04d: %s",
                log_safe(self.video_id),
                idx,
                log_safe(exc),
            )
        finally:
            self._prefetch_tasks.pop(idx, None)

    async def _transcode_segment(self, idx: int, *, low_priority: bool = False) -> None:
        spec = self.segments[idx]
        self.session_dir.mkdir(parents=True, exist_ok=True)
        # Resolve the H.264 encoder + HDR-ness once per session: a process-wide
        # auto-detect for the encoder, a single ffprobe for HDR. The encoder
        # may already be downgraded to libx264 by a prior segment's HW failure.
        if self._encoder is None:
            self._encoder = select_encoder()
        encoder = self._encoder
        if self._hdr is None:
            # "_hdr" gates the SDR tonemap: only when the source is HDR AND
            # ffmpeg can actually tonemap (has zscale). Without zscale we skip
            # it — HDR plays washed-out (the pre-existing behaviour) instead of
            # failing the transcode.
            self._hdr = is_hdr(self.input_path) and tonemap_available()
        decode_args, vf, encode_args = video_codec_args(encoder, hdr=self._hdr)
        # Each segment is encoded as an independent slice, but its output
        # PTS is shifted with `-output_ts_offset` to exactly N*SEG_LEN.
        # Together with EXTINF=SEG_LEN in the playlist, segments end up
        # contiguous on the playback timeline:
        #
        #   seg-0 PTS [0, SEG_LEN]
        #   seg-1 PTS [SEG_LEN, 2*SEG_LEN]
        #   ...
        #
        # This matters because MSE (the browser's SourceBuffer) rejects
        # appended data whose PTS overlaps something already in the
        # buffer with "DECODE_ERROR". Without the offset, every per-
        # segment ffmpeg invocation produced segments starting near
        # PTS=0, so seg-1 collided with seg-0 -> the player exhausted
        # the playlist with "No available working or supported
        # playlists" after the first segment.
        #
        # `-avoid_negative_ts disabled` is required: the default
        # `make_zero` would undo our `-output_ts_offset` by shifting
        # the minimum PTS back to 0. `disabled` lets the offset stand.
        # `-force_key_frames expr:gte(t,0)` makes the first frame a
        # keyframe so the segment is independently decodable.
        dummy_m3u8 = self.session_dir / f"_dummy_{idx}.m3u8"
        # Prefetch / background segments are pinned to a single ffmpeg
        # thread so the OS-idle priority kicks in cleanly; foreground
        # segments use ffmpeg's default thread count (auto = many) so
        # the player's segment lands as fast as possible.
        thread_args = ["-threads", "1"] if low_priority else []
        # `-nostdin` + stdin=DEVNULL: keep ffmpeg from inheriting the
        # parent's controlling tty. Without these a Ctrl-C against
        # `maneki serve` mid-transcode can leave the terminal stuck
        # in raw mode (ffmpeg's interactive keypress controls flip
        # the tty's icanon / echo flags off).
        args = [
            _ffmpeg_path(),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "warning",
            *thread_args,
            *decode_args,
            "-ss",
            f"{spec.start_s:.6f}",
            "-i",
            str(self.input_path),
            "-t",
            f"{spec.duration_s:.6f}",
            "-output_ts_offset",
            f"{spec.start_s:.6f}",
            "-muxdelay",
            "0",
            "-muxpreload",
            "0",
            "-avoid_negative_ts",
            "disabled",
            *(["-vf", vf] if vf else []),
            *encode_args,
            "-force_key_frames",
            "expr:gte(t,0)",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ac",
            "2",
            "-f",
            "hls",
            "-hls_time",
            f"{SEG_LEN}",
            "-hls_segment_type",
            "mpegts",
            "-hls_segment_filename",
            str(self.session_dir / "seg-%04d.ts"),
            "-hls_list_size",
            "1",
            "-start_number",
            str(idx),
            str(dummy_m3u8),
        ]
        spawn_kwargs = low_priority_kwargs() if low_priority else {}
        # Stamp activity at spawn (so an in-flight session counts as active
        # even before its first segment lands) and time the ffmpeg run for
        # the stats panel's realtime-ratio.
        self._last_activity = time.monotonic()
        start = self._last_activity
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            **spawn_kwargs,
        )
        try:
            _, stderr = await proc.communicate()
        except asyncio.CancelledError:
            # Most common path: the browser cancelled the segment fetch
            # (the user scrubbed away before this one finished). Kill
            # the ffmpeg subprocess so it doesn't keep burning CPU on
            # output nobody is waiting for. Without this, rapid scrubs
            # pile up many concurrent ffmpegs and the whole pipeline
            # stalls. `proc.kill()` is fire-and-forget; we still await
            # `wait()` so the file descriptors are cleaned up.
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            with contextlib.suppress(Exception):
                await proc.wait()
            # CRITICAL: ffmpeg writes the .ts file incrementally as it
            # encodes. When we kill it mid-segment, the partial file is
            # left on disk. The cache check `out_path.exists()` at the
            # top of `ensure_segment` then returns this stub on the
            # next request — a ~100ms snippet with PTS from somewhere
            # near the keyframe before the seek target, NOT the full
            # 6 seconds at the correct PTS. The browser appends this
            # garbage to MSE and the player jumps to whatever PTS the
            # snippet declares (the user's "seek forward then back
            # jumps 4-5 min ahead" bug). Unlink any partial output so
            # the retry produces a clean transcode.
            self._unlink_partial(idx)
            raise
        finally:
            if dummy_m3u8.exists():
                try:
                    dummy_m3u8.unlink()
                except OSError:
                    pass
        if proc.returncode != 0:
            # A non-zero exit can leave partial bytes on disk either way.
            self._unlink_partial(idx)
            # Negative returncode == killed by a signal: the server shutting
            # down (SIGINT/SIGTERM reaches the ffmpeg child via the process
            # group) or our own kill on seek/disconnect. That's a cancellation,
            # NOT an encoder/content problem — don't misreport it as an encode
            # failure or run the HW->software fallback (which would also
            # spuriously downgrade the session). Treat it like a cancel.
            if proc.returncode is not None and proc.returncode < 0:
                raise asyncio.CancelledError
            msg = stderr.decode("utf-8", errors="replace").strip().splitlines()
            tail = " | ".join(msg[-3:]) if msg else "(no stderr)"
            # A hardware encode can genuinely fail on a specific file (pixel
            # format, codec quirk, flaky driver). Drop this session to software
            # and retry the segment once rather than failing the whole stream.
            if encoder != "libx264":
                _log.warning(
                    "hls: %s encode failed for %s seg-%04d (%s); falling back to libx264",
                    encoder,
                    log_safe(self.video_id),
                    idx,
                    log_safe(tail),
                )
                self._encoder = "libx264"
                await self._transcode_segment(idx, low_priority=low_priority)
                return
            raise RuntimeError(f"ffmpeg failed for segment {idx} (rc={proc.returncode}): {tail}")
        # Success: log the wall time for the stats panel. Cancels and
        # failures (which `raise` above) are deliberately not recorded -
        # the panel measures completed-segment throughput.
        self._record_transcode(idx, time.monotonic() - start, low_priority=low_priority, encoder=encoder)

    def _unlink_partial(self, idx: int) -> None:
        """Best-effort cleanup of a half-written segment file."""
        out_path = self.session_dir / f"seg-{idx:04d}.ts"
        with contextlib.suppress(FileNotFoundError, OSError):
            out_path.unlink()

    def cleanup_dir(self) -> None:
        shutil.rmtree(self.session_dir, ignore_errors=True)

    def cancel_prefetch(self) -> int:
        """Cancel every in-flight neighbour-prefetch task.

        Called when the SPA closes the player so speculative segment
        transcodes that were queued behind the user's last segment
        request don't keep draining CPU after the user has visibly
        stopped watching. Returns the number of tasks cancelled (mostly
        useful for tests). Best-effort: a task that has already crossed
        into ffmpeg subprocess.run will see CancelledError propagate
        from its `await proc.communicate()`, which kills the subprocess
        via the existing CancelledError handler in `_transcode_segment`.
        """
        cancelled = 0
        for task in list(self._prefetch_tasks.values()):
            if not task.done():
                task.cancel()
                cancelled += 1
        return cancelled


# Bump this whenever the HLS segment generation changes in a way that
# makes old cached segments incompatible with new ones (e.g. PTS
# scheme change, codec settings, segment duration). HLSManager wipes
# the entire HLS cache on startup if the on-disk version mismatches.
# Without this, segments produced by old code linger in the cache and
# the player loads them by URL even though their PTS is now wrong,
# causing position jumps / subtitle drift.
HLS_CACHE_VERSION = "5"  # pluggable HW encoder (vaapi/videotoolbox) + HDR tonemap


class HLSManager:
    """One OnDemandHLS per video; lives for the server process lifetime."""

    def __init__(self, base_dir: Path | None = None, budget: TranscodeBudget | None = None) -> None:
        self.base_dir = base_dir or Path(tempfile.gettempdir()) / "maneki-hls"
        self.sessions: dict[str, OnDemandHLS] = {}
        # A budget is required at runtime; default to a fresh one when
        # callers (mostly tests) don't supply one so the manager stays
        # usable in isolation.
        self.budget = budget or TranscodeBudget()
        self._invalidate_on_version_mismatch()

    def _invalidate_on_version_mismatch(self) -> None:
        """Ensure the on-disk version marker exists and matches; wipe on mismatch.

        Always writes the marker (creating base_dir if needed). A previous
        bug skipped the whole routine when base_dir was missing, so a
        fresh server happily created `<base>/<video_id>/seg-*.ts` later
        without ever writing `.cache-version`. The next restart then read
        the missing marker as a version mismatch and wiped every segment
        — defeating the entire point of the persistent cache.

        Now: mkdir + marker-write happen unconditionally. The wipe step
        only fires when there's a real mismatch (existing marker disagrees,
        or contents exist with no marker at all).
        """
        self.base_dir.mkdir(parents=True, exist_ok=True)
        marker = self.base_dir / ".cache-version"
        stored = marker.read_text(encoding="utf-8").strip() if marker.is_file() else ""
        if stored == HLS_CACHE_VERSION:
            return
        # Wipe all session dirs; segments from older code may have wrong PTS
        # or stale id keys.
        for path in self.base_dir.iterdir():
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
        marker.write_text(HLS_CACHE_VERSION, encoding="utf-8")

    def get_or_create(self, video_id: str, input_path: Path, duration_s: float) -> OnDemandHLS:
        from maneki.video.serve.scan import cache_stem

        existing = self.sessions.get(video_id)
        if existing is not None:
            return existing
        session_dir = self.base_dir / cache_stem(video_id)
        session = OnDemandHLS(video_id, input_path, duration_s, session_dir, self.budget)
        self.sessions[video_id] = session
        return session

    def get(self, video_id: str) -> OnDemandHLS | None:
        return self.sessions.get(video_id)

    def clean_orphans(self, live_ids: set[str]) -> int:
        """Delete cached HLS dirs whose video id isn't in `live_ids`.

        Catches the case where a file was renamed, moved, or deleted
        from the library since the last server run - the old segment
        cache would otherwise sit on disk forever. Returns the number
        of directories removed.
        """
        from maneki.video.serve.scan import cache_stem

        removed = 0
        if self.base_dir.is_dir():
            live_stems = {cache_stem(vid) for vid in live_ids}
            for path in self.base_dir.iterdir():
                if not path.is_dir():
                    continue
                if path.name in live_stems:
                    continue
                try:
                    shutil.rmtree(path)
                    removed += 1
                except OSError:
                    pass
        # Drop in-memory sessions whose ids are no longer in the
        # library. The on-disk loop above only catches sessions that
        # ever transcoded a segment (and thus have a session dir); a
        # session that opened a manifest but never had a seg request
        # has no directory yet but still holds an asyncio.Lock per
        # potential segment in `_segment_locks` — on a 2h video at
        # 6s segments that's 1200 lock slots per stale entry.
        for stale_id in [vid for vid in self.sessions if vid not in live_ids]:
            session = self.sessions.pop(stale_id, None)
            if session is not None:
                # `getattr` keeps this defensive against future
                # refactors (and against mocks in unit tests that
                # don't carry the full session interface).
                seg_locks = getattr(session, "_segment_locks", None)
                if seg_locks is not None:
                    seg_locks.clear()
                tasks = getattr(session, "_prefetch_tasks", None)
                if tasks is not None:
                    tasks.clear()
        return removed

    def reset(self) -> None:
        """Drop all sessions and their on-disk caches (used in tests)."""
        for session in self.sessions.values():
            session.cleanup_dir()
        self.sessions.clear()

    async def prewarm_seg0(self, entries: list[dict[str, object]]) -> None:
        """Pre-transcode segment 0 of every video so first-play is instant.

        Without this, clicking a video for the first time waits 1-3s for
        ffmpeg to transcode the first segment before the browser can
        start decoding. With it, the cold-play latency drops to just the
        HTTP fetch (~10ms) for any video the prewarm has reached.

        Concurrency is bounded by the shared TranscodeBudget - each
        prewarm transcode acquires a background slot, which automatically
        yields to any in-flight foreground player request. Skips entries
        that are already cached or have no usable duration.
        """
        if not entries:
            return

        async def _warm(entry: dict[str, object]) -> None:
            duration = entry.get("duration_s")
            if not isinstance(duration, (int, float)) or duration <= 0:
                return
            video_id = str(entry["id"])
            input_path = Path(str(entry["path"]))
            session = self.get_or_create(video_id, input_path, float(duration))
            if not session.segments:
                return
            try:
                async with self.budget.background_slot():
                    await session.ensure_segment(0)
            except Exception:  # noqa: BLE001 - prewarm must not crash the server
                pass

        await asyncio.gather(*(_warm(e) for e in entries))
