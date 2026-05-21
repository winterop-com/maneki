"""Subtitle discovery + WebVTT conversion (sidecars + embedded streams).

Two sources, both surfaced through `/subtitles`:

1. **Sidecars** living next to the video with the same stem:

       videos/bat.mp4
       videos/bat.srt              -> language "und" (undetermined)
       videos/bat.en.srt           -> language "en"
       videos/bat.eng.srt          -> language "eng"
       videos/bat.fr.forced.srt    -> language "fr" (modifier ignored for v0)

2. **Embedded streams** inside .mkv / .mp4 containers, found via ffprobe
   and extracted to WebVTT on demand. Image-based codecs (PGS, DVD
   VobSub, DVB) are filtered out - they're bitmap subtitles and would
   need OCR to become WebVTT.

Browsers can't render .srt or .ass natively but can render WebVTT (.vtt)
via the HTML5 <track> element. Sidecars get a minimal text conversion;
embedded streams go through `ffmpeg -c:s webvtt` and the result is
cached under `<root>/.maneki/subs/<id>/embed-<index>.vtt`.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
from pathlib import Path

from pydantic import BaseModel, ConfigDict

SUBTITLE_EXTENSIONS = frozenset({".srt", ".vtt"})

# Subtitle codecs we can convert to WebVTT. Image-based codecs (PGS,
# DVD VobSub, DVB) are intentionally absent - they need OCR to become
# text, which is a separate problem.
TEXT_SUBTITLE_CODECS = frozenset({"subrip", "srt", "ass", "ssa", "mov_text", "webvtt"})

# Per-path embedded-subtitle cache. ffprobe per file is ~50-100ms so a
# 100-video browse listing would take seconds on every call. The cache
# is filled by `probe_embedded_subtitles()` and survives the process
# lifetime. The prewarm task at server startup walks every video and
# populates this proactively so the first browse-after-restart is fast.
_EMBEDDED_CACHE: dict[str, tuple[EmbeddedSubtitle, ...]] = {}


class SubtitleSidecar(BaseModel):
    """One subtitle file associated with a video."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    path: Path
    language: str
    fmt: str  # "srt" or "vtt"


class EmbeddedSubtitle(BaseModel):
    """One subtitle stream inside a video container."""

    model_config = ConfigDict(frozen=True)

    stream_index: int
    language: str  # ISO 639 from stream tags, or "und"
    codec_name: str  # subrip, ass, mov_text, etc. (image-based filtered out)
    title: str | None  # `tags.title`, e.g. "English (SDH)"
    default: bool  # `disposition.default == 1`
    forced: bool  # `disposition.forced == 1`


_LANG_TAG = re.compile(r"^[a-z]{2,3}$")


def discover_sidecars(video_path: Path) -> list[SubtitleSidecar]:
    """Find all subtitle files next to the given video.

    Looks for files in the same directory whose stem starts with the video's
    stem followed by an optional `.<lang>` (and optional modifiers we ignore).
    Returns one SubtitleSidecar per discovered file.
    """
    if not video_path.is_file():
        return []
    base = video_path.stem
    parent = video_path.parent
    out: list[SubtitleSidecar] = []
    for sibling in sorted(parent.iterdir()):
        if not sibling.is_file():
            continue
        ext = sibling.suffix.lower()
        if ext not in SUBTITLE_EXTENSIONS:
            continue
        lang = _extract_language(sibling.stem, base)
        if lang is None:
            continue
        out.append(SubtitleSidecar(path=sibling, language=lang, fmt=ext.lstrip(".")))
    return out


def _extract_language(sub_stem: str, video_stem: str) -> str | None:
    """Return the language code for a sidecar whose stem extends the video stem.

    `bat.srt` (stem 'bat') for video 'bat' -> "und".
    `bat.en.srt` (stem 'bat.en') for video 'bat' -> "en".
    `bat.fr.forced.srt` (stem 'bat.fr.forced') for video 'bat' -> "fr".
    Returns None if the stem isn't related to the video stem.
    """
    if sub_stem == video_stem:
        return "und"
    prefix = video_stem + "."
    if not sub_stem.startswith(prefix):
        return None
    tail = sub_stem[len(prefix) :]
    # First dot-separated piece is the language; modifiers (.forced, .sdh) follow.
    head = tail.split(".", 1)[0].lower()
    if _LANG_TAG.match(head):
        return head
    # Not a language tag -> still associated but undetermined.
    return "und"


def to_webvtt(source_path: Path) -> str:
    """Return the subtitle file's contents as WebVTT.

    .vtt is returned as-is; .srt is converted minimally (timestamps + header).
    Anything else returns the raw text - the browser will reject it cleanly.
    """
    text = source_path.read_text(encoding="utf-8", errors="replace")
    ext = source_path.suffix.lower()
    if ext == ".vtt":
        return _ensure_webvtt_header(text)
    if ext == ".srt":
        return srt_to_vtt(text)
    return text


def srt_to_vtt(srt_text: str) -> str:
    """Minimal SubRip-to-WebVTT conversion.

    Differences handled:
      - WEBVTT header prepended (required by the spec)
      - Timestamps use '.' for the millisecond separator, not ','
      - SubRip cue indices (the bare numbers above each cue) are valid in
        WebVTT but optional; we leave them in place

    Anything else SubRip-specific (HTML tags, positioning) passes through;
    browsers tolerate the rest of the SubRip syntax under WebVTT parsing.
    """
    converted = re.sub(r"(\d\d:\d\d:\d\d),(\d{3})", r"\1.\2", srt_text)
    return "WEBVTT\n\n" + converted.lstrip("﻿").lstrip()


def _ensure_webvtt_header(text: str) -> str:
    """Defensive: many .vtt files in the wild are missing the WEBVTT magic line."""
    stripped = text.lstrip("﻿").lstrip()
    if stripped.startswith("WEBVTT"):
        return stripped
    return "WEBVTT\n\n" + stripped


def probe_embedded_subtitles(video_path: Path) -> list[EmbeddedSubtitle]:
    """Return text-based subtitle streams embedded in the video container.

    Uses ffprobe to enumerate every subtitle stream, then filters out
    image-based codecs (PGS, DVD VobSub, DVB) since they need OCR rather
    than transcode to become WebVTT.

    Cached per-path for the process lifetime - the prewarm task at
    startup populates this proactively so interactive browse + player
    open don't pay the ffprobe cost.

    Returns an empty list when ffprobe is missing, the file can't be
    parsed, or no usable subtitle streams exist.
    """
    key = str(video_path)
    cached = _EMBEDDED_CACHE.get(key)
    if cached is not None:
        return list(cached)
    if not video_path.is_file():
        return []
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return []
    args = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "s",
        "-show_entries",
        "stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced",
        "-of",
        "json",
        str(video_path),
    ]
    try:
        result = subprocess.run(  # noqa: S603 - args are constructed locally
            args,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10.0,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return []
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []
    out: list[EmbeddedSubtitle] = []
    for stream in data.get("streams", []):
        codec = (stream.get("codec_name") or "").lower()
        if codec not in TEXT_SUBTITLE_CODECS:
            continue
        tags = stream.get("tags") or {}
        disp = stream.get("disposition") or {}
        out.append(
            EmbeddedSubtitle(
                stream_index=int(stream.get("index", 0)),
                language=str(tags.get("language") or "und"),
                codec_name=codec,
                title=tags.get("title"),
                default=bool(disp.get("default")),
                forced=bool(disp.get("forced")),
            )
        )
    _EMBEDDED_CACHE[key] = tuple(out)
    return out


async def extract_embedded_to_vtt(
    video_path: Path,
    stream_index: int,
    out_path: Path,
) -> Path:
    """Extract one embedded subtitle stream to a .vtt file via ffmpeg.

    Thin wrapper around `extract_embedded_streams_to_vtt` for the
    single-stream case. Most production callers should use the batch
    API to avoid running ffmpeg once per stream when many tracks need
    extracting at the same time.
    """
    await extract_embedded_streams_to_vtt(video_path, [(stream_index, out_path)])
    return out_path


async def extract_embedded_streams_to_vtt(
    video_path: Path,
    targets: list[tuple[int, Path]],
) -> None:
    """Extract many embedded subtitle streams in a single ffmpeg invocation.

    ffmpeg accepts one `-map 0:<idx>` + output path per stream, so this
    reads the source file ONCE and writes every requested .vtt in one
    pass. Replaces the older "spawn one ffmpeg per stream" pattern that
    fell apart for .mkvs with 40+ embedded tracks - 40 concurrent
    ffmpegs each re-reading an 800 MB file pegged disk and CPU and
    head-of-line-blocked HLS playback.

    Image-based codecs (PGS, VobSub) will fail here even if accidentally
    requested - probe_embedded_subtitles already filters them out.

    After ffmpeg completes, each .vtt is post-processed to subtract the
    source's first-frame PTS from every cue timestamp (see
    extract_embedded_to_vtt's previous docstring for the why).

    No-op if `targets` is empty.
    """
    if not targets:
        return
    if not video_path.is_file():
        raise FileNotFoundError(video_path)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is required to extract embedded subtitles")

    # Tmp output paths so the .vtt only appears at its final location
    # after ffmpeg + offset-shift succeed. Atomic replace avoids the
    # cache thinking a partial extraction is a valid cached file.
    tmp_paths: list[tuple[int, Path, Path]] = []
    for stream_index, out_path in targets:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_paths.append((stream_index, out_path, out_path.with_suffix(".vtt.tmp")))

    args = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(video_path),
    ]
    for stream_index, _, tmp in tmp_paths:
        args.extend(
            [
                "-map",
                f"0:{stream_index}",
                # `-copyts` keeps source PTS in the output instead of
                # letting the webvtt muxer rebase. Without it, .mkv
                # subtitle PTS can drift relative to the video stream
                # (visible after seeking). We compensate for the
                # source's start offset in the post-process step below.
                "-copyts",
                "-c:s",
                "webvtt",
                "-f",
                "webvtt",
                str(tmp),
            ]
        )

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        msg = stderr.decode("utf-8", errors="replace").strip().splitlines()
        tail = " | ".join(msg[-3:]) if msg else "(no stderr)"
        for _, _, tmp in tmp_paths:
            tmp.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg failed for streams {[s for s, _, _ in tmp_paths]} (rc={proc.returncode}): {tail}")

    offset = _probe_video_start_time(video_path)
    for stream_index, out_path, tmp in tmp_paths:
        if not tmp.exists() or tmp.stat().st_size == 0:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg ran but produced no output for stream {stream_index}")
        if offset > 0.001:
            shifted = shift_vtt_timestamps(tmp.read_text(encoding="utf-8", errors="replace"), -offset)
            tmp.write_text(shifted, encoding="utf-8")
        tmp.replace(out_path)


def _probe_video_start_time(video_path: Path) -> float:
    """Return the first video frame's PTS in seconds. 0.0 if unknown."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return 0.0
    try:
        result = subprocess.run(  # noqa: S603 - args constructed locally
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=start_time",
                "-of",
                "csv=p=0",
                str(video_path),
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=5.0,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return 0.0
    raw = result.stdout.strip()
    if not raw or raw == "N/A":
        return 0.0
    try:
        return float(raw)
    except ValueError:
        return 0.0


_VTT_TIMESTAMP = re.compile(r"(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})")


def shift_vtt_timestamps(text: str, offset_s: float) -> str:
    """Add `offset_s` seconds to every HH:MM:SS.mmm in a WebVTT string.

    Negative offsets clamp to 00:00:00.000 so a cue near the very start
    can't end up with negative time (which a few players reject). Only
    timestamps in the standard WebVTT cue format are touched; cue ids,
    payload text, and headers pass through.
    """

    def _shift(match: re.Match[str]) -> str:
        h, m, s, ms = (int(g) for g in match.groups())
        total = h * 3600 + m * 60 + s + ms / 1000.0 + offset_s
        if total < 0:
            total = 0.0
        hh = int(total // 3600)
        mm = int((total % 3600) // 60)
        ss = int(total % 60)
        mmm = int(round((total - int(total)) * 1000))
        if mmm == 1000:  # rounding overflow
            ss += 1
            mmm = 0
        return f"{hh:02d}:{mm:02d}:{ss:02d}.{mmm:03d}"

    return _VTT_TIMESTAMP.sub(_shift, text)


class SubtitleCache:
    """Lazy on-disk cache for extracted embedded subtitle WebVTT files.

    Layout: `<cache_dir>/<video_id>/embed-<stream_index>.vtt`. One lock
    per video so concurrent first-requests for any track of the same
    file share one ffmpeg invocation that extracts every missing
    embedded stream in a single pass.

    Before the per-video lock + single-pass extract, a .mkv with 46
    embedded subtitle tracks would spawn 46 ffmpeg subprocesses on the
    first video open, each re-reading the 800 MB source. Now: one
    ffmpeg, one read, all .vtts produced together.
    """

    def __init__(self, cache_dir: Path) -> None:
        self.cache_dir = cache_dir
        self._locks: dict[str, asyncio.Lock] = {}

    def path_for(self, video_id: str, stream_index: int) -> Path:
        return self.cache_dir / video_id / f"embed-{stream_index}.vtt"

    async def ensure(self, video_id: str, video_path: Path, stream_index: int) -> Path:
        out = self.path_for(video_id, stream_index)
        if out.exists() and out.stat().st_size > 0:
            return out
        lock = self._locks.setdefault(video_id, asyncio.Lock())
        async with lock:
            # Recheck after acquiring the lock - a sibling request for
            # the same video may have just extracted everything.
            if out.exists() and out.stat().st_size > 0:
                return out
            # Probe is memoised, so this is free on the second call.
            probed = probe_embedded_subtitles(video_path)
            missing: list[tuple[int, Path]] = []
            for entry in probed:
                target = self.path_for(video_id, entry.stream_index)
                if not (target.exists() and target.stat().st_size > 0):
                    missing.append((entry.stream_index, target))
            if not missing:
                # Requested stream not in probed list, fall back to
                # single-stream extract so the caller still gets a
                # meaningful error path.
                return await extract_embedded_to_vtt(video_path, stream_index, out)
            await extract_embedded_streams_to_vtt(video_path, missing)
            return out

    def clean_orphans(self, live_ids: set[str]) -> int:
        """Delete cached subtitle dirs whose video id isn't in `live_ids`."""
        if not self.cache_dir.is_dir():
            return 0
        removed = 0
        for path in self.cache_dir.iterdir():
            if not path.is_dir():
                continue
            if path.name in live_ids:
                continue
            try:
                shutil.rmtree(path)
                removed += 1
            except OSError:
                pass
        return removed
