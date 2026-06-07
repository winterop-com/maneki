"""Pretty-printed inspect for one video file.

Calls ffprobe once per file and groups the interesting fields into
rich panels (file / format, video stream, audio streams, subtitles).
Used by `maneki inspect` to surface the same kind of detail
the audio side has had since day one.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from pydantic import BaseModel, ConfigDict
from rich.box import SIMPLE_HEAVY
from rich.console import Console, Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from maneki.ffmpeg import ffprobe_path


class VideoStream(BaseModel):
    """Subset of an ffprobe video stream we surface in inspect output."""

    model_config = ConfigDict(frozen=True)

    codec: str
    width: int
    height: int
    fps: float | None
    bitrate_bps: int | None
    pix_fmt: str | None
    profile: str | None


class AudioStream(BaseModel):
    """Subset of an ffprobe audio stream we surface in inspect output."""

    model_config = ConfigDict(frozen=True)

    codec: str
    channels: int
    sample_rate: int | None
    bitrate_bps: int | None
    language: str | None
    title: str | None


class SubtitleStream(BaseModel):
    """Subset of an ffprobe subtitle stream we surface in inspect output."""

    model_config = ConfigDict(frozen=True)

    codec: str
    language: str | None
    title: str | None
    forced: bool
    default: bool


class FormatInfo(BaseModel):
    """Container-level info from ffprobe."""

    model_config = ConfigDict(frozen=True)

    format_name: str | None
    duration_s: float | None
    bitrate_bps: int | None
    size_bytes: int | None
    # Container-level metadata (mkv's Tags section, mp4 moov atom).
    # Video files don't have ID3, but well-encoded files often carry
    # title / comment / year / encoder strings worth surfacing.
    tags: dict[str, str]


class VideoProbe(BaseModel):
    """All the inspect-worthy info we pull out of one video file."""

    model_config = ConfigDict(frozen=True)

    format: FormatInfo
    video: list[VideoStream]
    audio: list[AudioStream]
    subtitles: list[SubtitleStream]


def probe_video_file(path: Path) -> VideoProbe | None:
    """Run ffprobe and return a typed summary, or None if ffprobe is missing / fails."""
    ffprobe = ffprobe_path()
    if ffprobe is None:
        return None
    try:
        result = subprocess.run(  # noqa: S603 - args constructed locally
            [
                ffprobe,
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=10.0,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    try:
        raw = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return _parse_ffprobe(raw)


def _parse_ffprobe(raw: dict[str, object]) -> VideoProbe:
    fmt = raw.get("format") or {}
    streams = raw.get("streams") or []
    video: list[VideoStream] = []
    audio: list[AudioStream] = []
    subs: list[SubtitleStream] = []
    if isinstance(streams, list):
        for s in streams:
            if not isinstance(s, dict):
                continue
            kind = s.get("codec_type")
            if kind == "video":
                video.append(_parse_video(s))
            elif kind == "audio":
                audio.append(_parse_audio(s))
            elif kind == "subtitle":
                subs.append(_parse_subtitle(s))
    if isinstance(fmt, dict):
        fmt_tags_raw = fmt.get("tags") if isinstance(fmt.get("tags"), dict) else {}
        tags = (
            {str(k).lower(): str(v) for k, v in fmt_tags_raw.items() if v is not None and str(v).strip()}
            if isinstance(fmt_tags_raw, dict)
            else {}
        )
        fmt_info = FormatInfo(
            format_name=_str_or_none(fmt.get("format_long_name") or fmt.get("format_name")),
            duration_s=_float_or_none(fmt.get("duration")),
            bitrate_bps=_int_or_none(fmt.get("bit_rate")),
            size_bytes=_int_or_none(fmt.get("size")),
            tags=tags,
        )
    else:
        fmt_info = FormatInfo(format_name=None, duration_s=None, bitrate_bps=None, size_bytes=None, tags={})
    return VideoProbe(format=fmt_info, video=video, audio=audio, subtitles=subs)


def _parse_video(stream: dict[str, object]) -> VideoStream:
    return VideoStream(
        codec=_str_or_default(stream.get("codec_name"), "unknown"),
        width=_int_or_default(stream.get("width"), 0),
        height=_int_or_default(stream.get("height"), 0),
        fps=_parse_fps(stream.get("avg_frame_rate") or stream.get("r_frame_rate")),
        bitrate_bps=_int_or_none(stream.get("bit_rate")),
        pix_fmt=_str_or_none(stream.get("pix_fmt")),
        profile=_str_or_none(stream.get("profile")),
    )


def _parse_audio(stream: dict[str, object]) -> AudioStream:
    tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
    return AudioStream(
        codec=_str_or_default(stream.get("codec_name"), "unknown"),
        channels=_int_or_default(stream.get("channels"), 0),
        sample_rate=_int_or_none(stream.get("sample_rate")),
        bitrate_bps=_int_or_none(stream.get("bit_rate")),
        language=_str_or_none(tags.get("language") if isinstance(tags, dict) else None),
        title=_str_or_none(tags.get("title") if isinstance(tags, dict) else None),
    )


def _parse_subtitle(stream: dict[str, object]) -> SubtitleStream:
    tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
    disp = stream.get("disposition") if isinstance(stream.get("disposition"), dict) else {}
    return SubtitleStream(
        codec=_str_or_default(stream.get("codec_name"), "unknown"),
        language=_str_or_none(tags.get("language") if isinstance(tags, dict) else None),
        title=_str_or_none(tags.get("title") if isinstance(tags, dict) else None),
        forced=bool(disp.get("forced") if isinstance(disp, dict) else False),
        default=bool(disp.get("default") if isinstance(disp, dict) else False),
    )


def _parse_fps(value: object) -> float | None:
    if not isinstance(value, str) or "/" not in value:
        return None
    num, _, den = value.partition("/")
    try:
        n = float(num)
        d = float(den)
    except ValueError:
        return None
    if d == 0:
        return None
    return n / d


def _str_or_none(v: object) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _str_or_default(v: object, default: str) -> str:
    return _str_or_none(v) or default


def _int_or_none(v: object) -> int | None:
    if v is None:
        return None
    if not isinstance(v, (int, str, bytes)):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _int_or_default(v: object, default: int) -> int:
    out = _int_or_none(v)
    return default if out is None else out


def _float_or_none(v: object) -> float | None:
    if v is None:
        return None
    if not isinstance(v, (int, float, str, bytes)):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def inspect_video_file(path: Path, *, console: Console) -> None:
    """Pretty-print the format + streams for one video file."""
    probe = probe_video_file(path)
    if probe is None:
        console.print(f"[red]Could not probe[/red] {path} (ffprobe missing or file unreadable)")
        return
    panels: list[Panel] = [_render_file_panel(path, probe.format)]
    if probe.video:
        panels.append(_render_video_panel(probe.video))
    if probe.audio:
        panels.append(_render_audio_panel(probe.audio))
    if probe.subtitles:
        panels.append(_render_subs_panel(probe.subtitles))
    console.print(Group(*panels))


def _render_file_panel(path: Path, fmt: FormatInfo) -> Panel:
    table = Table.grid(padding=(0, 2))
    table.add_column(style="dim")
    table.add_column()
    table.add_row("path", str(path.resolve()))
    table.add_row("container", fmt.format_name or path.suffix.lstrip(".") or "unknown")
    if fmt.duration_s is not None:
        table.add_row("duration", _fmt_duration(fmt.duration_s))
    if fmt.size_bytes is not None:
        table.add_row("size", _fmt_size(fmt.size_bytes))
    if fmt.bitrate_bps is not None:
        table.add_row("bitrate", _fmt_bitrate(fmt.bitrate_bps))
    # Container-level tags (title, comment, year, encoder, ...) when
    # the file carries them. Surfaces TV-show / movie metadata that
    # encoders sometimes embed.
    for key in ("title", "comment", "date", "year", "encoder"):
        value = fmt.tags.get(key)
        if value:
            table.add_row(key, value)
    return Panel(table, title="[bold]File[/bold]", border_style="cyan", box=SIMPLE_HEAVY)


def _render_video_panel(streams: list[VideoStream]) -> Panel:
    table = Table(box=None, show_header=True, header_style="dim", pad_edge=False, padding=(0, 2))
    table.add_column("#")
    table.add_column("codec")
    table.add_column("resolution")
    table.add_column("fps")
    table.add_column("bitrate")
    table.add_column("profile / pix_fmt", style="dim")
    for i, s in enumerate(streams):
        table.add_row(
            str(i),
            s.codec,
            f"{s.width}x{s.height}" if s.width and s.height else "?",
            f"{s.fps:.2f}" if s.fps else "?",
            _fmt_bitrate(s.bitrate_bps) if s.bitrate_bps else "?",
            " / ".join(x for x in (s.profile, s.pix_fmt) if x) or "?",
        )
    return Panel(table, title="[bold]Video[/bold]", border_style="cyan", box=SIMPLE_HEAVY)


def _render_audio_panel(streams: list[AudioStream]) -> Panel:
    table = Table(box=None, show_header=True, header_style="dim", pad_edge=False, padding=(0, 2))
    table.add_column("#")
    table.add_column("codec")
    table.add_column("channels")
    table.add_column("rate")
    table.add_column("bitrate")
    table.add_column("lang")
    table.add_column("title", style="dim")
    for i, s in enumerate(streams):
        table.add_row(
            str(i),
            s.codec,
            f"{s.channels}ch" if s.channels else "?",
            f"{s.sample_rate} Hz" if s.sample_rate else "?",
            _fmt_bitrate(s.bitrate_bps) if s.bitrate_bps else "?",
            s.language or "?",
            s.title or "",
        )
    return Panel(table, title="[bold]Audio[/bold]", border_style="cyan", box=SIMPLE_HEAVY)


def _render_subs_panel(streams: list[SubtitleStream]) -> Panel:
    table = Table(box=None, show_header=True, header_style="dim", pad_edge=False, padding=(0, 2))
    table.add_column("#")
    table.add_column("codec")
    table.add_column("lang")
    table.add_column("title", style="dim")
    table.add_column("flags")
    for i, s in enumerate(streams):
        flags = []
        if s.default:
            flags.append("default")
        if s.forced:
            flags.append("forced")
        table.add_row(
            str(i),
            s.codec,
            s.language or "?",
            s.title or "",
            ", ".join(flags) or "",
        )
    return Panel(table, title="[bold]Subtitles[/bold]", border_style="cyan", box=SIMPLE_HEAVY)


def _fmt_duration(seconds: float) -> str:
    if seconds <= 0:
        return Text("—").plain
    total = int(round(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _fmt_size(n: int) -> str:
    f = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if f < 1024:
            return f"{f:.0f} {unit}" if unit == "B" else f"{f:.1f} {unit}"
        f /= 1024
    return f"{f:.1f} TiB"


def _fmt_bitrate(bps: int) -> str:
    if bps >= 1_000_000:
        return f"{bps / 1_000_000:.2f} Mbps"
    if bps >= 1_000:
        return f"{bps / 1_000:.0f} kbps"
    return f"{bps} bps"
