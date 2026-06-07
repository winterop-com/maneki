"""Pluggable H.264 encoder selection for the HLS transcode pipeline.

Software ``libx264`` cannot transcode 4K/HDR in realtime, so on hardware that
offers an H.264 encoder we hand the encode to the GPU:

- **VAAPI** (``h264_vaapi``) on Linux — AMD/Intel iGPU/dGPU via the kernel's
  ``/dev/dri`` render node. (AMD's ROCm stack is *compute*; video encode rides
  the GPU's dedicated VCN block through VAAPI/libva.)
- **VideoToolbox** (``h264_videotoolbox``) on macOS / Apple Silicon.
- **libx264** everywhere else, and as the always-available fallback.

Design choices that keep this robust rather than maximal:

- **Encode-only.** We decode + tonemap in software and only hand the *encode*
  to the GPU. The encode is the expensive part; full-GPU decode pipelines
  (``-hwaccel vaapi -hwaccel_output_format vaapi``) are far more driver- and
  codec-fragile. HW decode can come later as an optimization.
- **Probe, don't trust.** A VAAPI encoder being *listed* by ffmpeg does not
  mean the device works (containers, missing Mesa drivers, perms). We run a
  tiny probe-encode and fall back to software on any failure.
- **HDR is tonemapped in software** (`zscale`+`tonemap`) before the encoder so
  the H.264/SDR output is correct on browsers, independent of encoder.

Selection order (cached for process lifetime): the ``MANEKI_HWENC`` override
(``auto`` | ``vaapi`` | ``videotoolbox`` | ``none``) → VAAPI (if it probes OK)
→ VideoToolbox (macOS) → libx264.
"""

from __future__ import annotations

import functools
import logging
import os
import platform
import subprocess
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

from maneki.ffmpeg import ffmpeg_path, ffprobe_path

log = logging.getLogger(__name__)

Encoder = Literal["libx264", "h264_vaapi", "h264_videotoolbox"]

# Encoder env knobs are read at CALL time (cached), not at import. Reading them
# at import meant an env var set after this module loaded was silently ignored;
# `@functools.cache` keeps the one-read-per-process behaviour while deferring it.
# These mirror the `[media]` section of `maneki.settings`; the hot path reads
# os.environ directly to avoid importing the settings object here.


@functools.cache
def _vaapi_device() -> str:
    """VAAPI render node (`MANEKI_VAAPI_DEVICE`). Overridable for multi-GPU boxes."""
    return os.environ.get("MANEKI_VAAPI_DEVICE", "/dev/dri/renderD128")


@functools.cache
def _hw_bitrate() -> str:
    """Hardware-encoder target bitrate (`MANEKI_HWENC_BITRATE`, default 6M)."""
    return os.environ.get("MANEKI_HWENC_BITRATE", "6M")


@functools.cache
def _hw_maxrate() -> str:
    """Hardware-encoder VBV max rate (`MANEKI_HWENC_MAXRATE`, default 8M)."""
    return os.environ.get("MANEKI_HWENC_MAXRATE", "8M")


@functools.cache
def _hw_bufsize() -> str:
    """Hardware-encoder VBV buffer (`MANEKI_HWENC_BUFSIZE`, default 12M)."""
    return os.environ.get("MANEKI_HWENC_BUFSIZE", "12M")


# Software HDR (PQ / HLG) -> SDR BT.709 tonemap. Runs before the encoder so the
# H.264 output displays correctly in browsers (which don't handle HDR H.264).
# Needs an ffmpeg built with zscale (libzimg); the per-file software fallback
# catches builds without it.
_TONEMAP_SW = (
    "zscale=t=linear:npl=100,format=gbrpf32le,"
    "tonemap=tonemap=hable:desat=0,"
    "zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p"
)

# color_transfer values that mean the source is HDR.
_HDR_TRANSFERS = frozenset({"smpte2084", "arib-std-b67"})


@functools.cache
def _ffmpeg_encoders() -> frozenset[str]:
    """Video encoder names ffmpeg reports via ``-encoders`` (empty if absent)."""
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        return frozenset()
    try:
        out = subprocess.run(  # noqa: S603 - fixed args, no shell
            [ffmpeg, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return frozenset()
    names: set[str] = set()
    for line in out.splitlines():
        parts = line.split()
        # Lines look like " V....D h264_vaapi  VAAPI H.264 Encoder ...".
        if len(parts) >= 2 and parts[0][:1] == "V":
            names.add(parts[1])
    return frozenset(names)


@functools.cache
def _vaapi_works() -> bool:
    """True iff ``h264_vaapi`` is listed AND a trivial probe-encode succeeds.

    Listed-but-broken VAAPI is common (no Mesa VA driver, ``/dev/dri`` not
    mapped into a container, wrong group perms), so we actually exercise the
    device with a 0.1s nullsrc encode rather than trust the encoder list.
    """
    if "h264_vaapi" not in _ffmpeg_encoders() or not Path(_vaapi_device()).exists():
        return False
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        return False
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-vaapi_device", _vaapi_device(),
        "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.1",
        "-vf", "format=nv12,hwupload",
        "-c:v", "h264_vaapi", "-f", "null", "-",
    ]  # fmt: skip
    try:
        ok = (
            subprocess.run(  # noqa: S603 - fixed args, no shell
                cmd, capture_output=True, timeout=15, check=False
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if not ok:
        log.info("video: h264_vaapi is listed but the probe-encode failed; using software")
    return ok


@functools.cache
def tonemap_available() -> bool:
    """True iff ffmpeg has the ``zscale`` filter (libzimg) for the HDR tonemap.

    Many builds (incl. some Homebrew ones) ship without libzimg. Without it we
    must NOT emit the tonemap chain: it would fail the transcode outright, and
    since the per-file fallback would re-run the *same* chain under libx264 it
    would fail there too. Skipping tonemap means HDR plays with the old
    washed-out colours — degraded, but not broken.
    """
    ffmpeg = ffmpeg_path()
    if not ffmpeg:
        return False
    try:
        out = subprocess.run(  # noqa: S603 - fixed args, no shell
            [ffmpeg, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    # Filter lines look like " .S zscale            V->V   ...".
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "zscale":
            return True
    return False


@functools.cache
def select_encoder() -> Encoder:
    """Pick the H.264 encoder once per process: env override, else auto-detect."""
    override = os.environ.get("MANEKI_HWENC", "auto").strip().lower()
    encoders = _ffmpeg_encoders()
    if override in ("none", "off", "software", "libx264"):
        return "libx264"
    if override == "videotoolbox":
        return "h264_videotoolbox" if "h264_videotoolbox" in encoders else "libx264"
    if override == "vaapi":
        return "h264_vaapi" if _vaapi_works() else "libx264"
    # auto: VAAPI (Linux/AMD) -> VideoToolbox (macOS) -> software.
    if _vaapi_works():
        return "h264_vaapi"
    if platform.system() == "Darwin" and "h264_videotoolbox" in encoders:
        return "h264_videotoolbox"
    return "libx264"


def is_hdr(input_path: Path) -> bool:
    """Probe whether the source video's transfer function is HDR (PQ / HLG)."""
    ffprobe = ffprobe_path()
    if not ffprobe:
        return False
    cmd = [
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=color_transfer",
        "-of", "default=noprint_wrappers=1:nokey=1", str(input_path),
    ]  # fmt: skip
    try:
        out = subprocess.run(  # noqa: S603 - fixed args, no shell
            cmd, capture_output=True, text=True, timeout=10, check=False
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return False
    return out in _HDR_TRANSFERS


def video_codec_args(encoder: Encoder, *, hdr: bool) -> tuple[list[str], str | None, list[str]]:
    """Ffmpeg args for `encoder` as ``(decode_args, vf_filter, encode_args)``.

    - ``decode_args`` go *before* ``-i`` (VAAPI needs ``-vaapi_device`` there).
    - ``vf_filter`` is the ``-vf`` value (HDR tonemap and/or VAAPI hwupload),
      or ``None`` when no filter is needed.
    - ``encode_args`` replace the ``-c:v …`` block.

    Decode + tonemap stay in software (see module docstring); only the encode
    is handed to the GPU.
    """
    tonemap = _TONEMAP_SW if hdr else None
    if encoder == "h264_vaapi":
        # VAAPI needs frames uploaded to a GPU surface (nv12) to encode.
        upload = "format=nv12,hwupload"
        vf = f"{tonemap},{upload}" if tonemap else upload
        return (
            ["-vaapi_device", _vaapi_device()],
            vf,
            ["-c:v", "h264_vaapi", "-b:v", _hw_bitrate()],
        )
    if encoder == "h264_videotoolbox":
        return (
            [],
            tonemap,
            [
                "-c:v",
                "h264_videotoolbox",
                "-b:v",
                _hw_bitrate(),
                "-maxrate",
                _hw_maxrate(),
                "-bufsize",
                _hw_bufsize(),
            ],  # fmt: skip
        )
    # libx264 (software fallback) — the original CRF-based settings.
    return ([], tonemap, ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"])


def _tool_version(binary: str | None, name: str) -> str | None:
    """Version a tool reports via ``-version`` (e.g. ``8.1.1``), or None.

    Probes the actual `binary` (which may be a MANEKI_FFMPEG/FFPROBE override),
    so ffmpeg and ffprobe are reported independently - they can differ if the
    overrides point at different builds.
    """
    if not binary:
        return None
    try:
        out = subprocess.run(  # noqa: S603 - fixed args, no shell
            [binary, "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    # First line looks like "ffmpeg version 8.1.1 Copyright (c) ...".
    first = out.splitlines()[0] if out else ""
    parts = first.split()
    if len(parts) >= 3 and parts[0] == name and parts[1] == "version":
        return parts[2]
    return first or None


@functools.cache
def _ffmpeg_version() -> str | None:
    return _tool_version(ffmpeg_path(), "ffmpeg")


@functools.cache
def _ffprobe_version() -> str | None:
    return _tool_version(ffprobe_path(), "ffprobe")


class EncoderReport(BaseModel):
    """Snapshot of the media-tooling environment, for `maneki doctor`."""

    model_config = ConfigDict(frozen=True)

    ffmpeg_path: str | None
    ffprobe_path: str | None
    ffmpeg_version: str | None
    ffprobe_version: str | None
    hw_encoders: list[str]  # h264_vaapi / h264_videotoolbox that ffmpeg lists
    vaapi_device: str
    vaapi_device_present: bool
    vaapi_works: bool  # the listed VAAPI encoder actually probe-encodes
    tonemap_zscale: bool  # ffmpeg has zscale (libzimg) for HDR->SDR tonemap
    selected: Encoder  # what select_encoder() will use right now
    hwenc_override: str | None  # MANEKI_HWENC, if set


def probe_encoders() -> EncoderReport:
    """Gather the media-tooling environment into a report (for `maneki doctor`)."""
    listed = _ffmpeg_encoders()
    override = os.environ.get("MANEKI_HWENC")
    return EncoderReport(
        ffmpeg_path=ffmpeg_path(),
        ffprobe_path=ffprobe_path(),
        ffmpeg_version=_ffmpeg_version(),
        ffprobe_version=_ffprobe_version(),
        hw_encoders=[e for e in ("h264_vaapi", "h264_videotoolbox") if e in listed],
        vaapi_device=_vaapi_device(),
        vaapi_device_present=Path(_vaapi_device()).exists(),
        vaapi_works=_vaapi_works(),
        tonemap_zscale=tonemap_available(),
        selected=select_encoder(),
        hwenc_override=override.strip().lower() if override else None,
    )
