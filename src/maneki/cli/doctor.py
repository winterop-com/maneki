"""`maneki doctor` - check the media-tooling environment.

Reports whether ffmpeg/ffprobe are installed, which H.264 encoder the video
transcoder will use (and why), VAAPI/VideoToolbox availability, and whether
the optional HDR->SDR tonemap path is present. Exits non-zero only when a hard
requirement (ffmpeg/ffprobe) is missing, so it's usable in scripts/CI.
"""

from __future__ import annotations

import os
import platform

import typer

from maneki.video.serve.encoders import probe_encoders


def doctor_cmd() -> None:
    """Check ffmpeg + the video transcode encoder (hardware accel, HDR tonemap)."""
    from rich.console import Console
    from rich.table import Table

    report = probe_encoders()
    console = Console()

    ok = "[green]ok[/green]"
    warn = "[yellow]warn[/yellow]"
    bad = "[red]missing[/red]"

    table = Table(show_header=True, header_style="bold", title="maneki doctor")
    table.add_column("check")
    table.add_column("status")
    table.add_column("detail", overflow="fold")

    from maneki import __version__

    table.add_row("maneki", ok, f"{__version__}  (python {platform.python_version()})")

    # ffmpeg / ffprobe - hard requirements for serving + converting. The path
    # honours MANEKI_FFMPEG / MANEKI_FFPROBE; a path that's set but doesn't run
    # (bad override) shows as a warn rather than a silent ok.
    ff_over = "  [dim](MANEKI_FFMPEG)[/dim]" if os.environ.get("MANEKI_FFMPEG") else ""
    fp_over = "  [dim](MANEKI_FFPROBE)[/dim]" if os.environ.get("MANEKI_FFPROBE") else ""
    if report.ffmpeg_path and report.ffmpeg_version:
        ff_status = ok
    elif report.ffmpeg_path:
        ff_status = warn  # found but didn't run - bad override / not executable?
    else:
        ff_status = bad
    ff_where = report.ffmpeg_path or "not found (install ffmpeg, or set MANEKI_FFMPEG)"
    table.add_row("ffmpeg", ff_status, f"{report.ffmpeg_version or '-'}  {ff_where}{ff_over}")
    table.add_row(
        "ffprobe",
        ok if report.ffprobe_path else bad,
        f"{report.ffprobe_path or 'not found (install ffmpeg, or set MANEKI_FFPROBE)'}{fp_over}",
    )

    # The encoder serve will actually use.
    is_hw = report.selected != "libx264"
    detail = f"{report.selected} ({'hardware' if is_hw else 'software'})"
    if report.hwenc_override:
        detail += f"  [dim](MANEKI_HWENC={report.hwenc_override})[/dim]"
    table.add_row("H.264 encoder", ok, detail)

    if report.hw_encoders:
        table.add_row("HW encoders", ok, f"ffmpeg lists: {', '.join(report.hw_encoders)}")
    else:
        table.add_row("HW encoders", warn, "none - software libx264 only (a GPU H.264 encoder would speed up 4K/HDR)")

    # VAAPI device - only interesting on Linux / when the encoder is listed.
    if "h264_vaapi" in report.hw_encoders or platform.system() == "Linux":
        if report.vaapi_works:
            table.add_row("VAAPI", ok, f"{report.vaapi_device} (probe-encode ok)")
        elif report.vaapi_device_present:
            table.add_row(
                "VAAPI",
                warn,
                f"{report.vaapi_device} present but probe-encode failed. fix: install the VA "
                "driver (mesa-va-drivers / intel-media-va-driver) and add your user to the "
                "'render'/'video' group.",
            )
        else:
            table.add_row(
                "VAAPI",
                warn,
                f"{report.vaapi_device} not present - no GPU render node (in a container, map "
                "/dev/dri in and match the group id).",
            )

    if report.tonemap_zscale:
        zscale_detail = "available"
    elif platform.system() == "Darwin":
        zscale_detail = (
            "no zscale/libzimg - HDR plays washed-out (no SDR tonemap). "
            "fix: the stock Homebrew ffmpeg omits libzimg; install a fuller build "
            "(the homebrew-ffmpeg tap, or a static ffmpeg) that bundles zscale."
        )
    else:
        zscale_detail = (
            "no zscale/libzimg - HDR plays washed-out (no SDR tonemap). "
            "fix: install an ffmpeg built with libzimg (most distro packages include zscale)."
        )
    table.add_row("HDR tonemap (zscale)", ok if report.tonemap_zscale else warn, zscale_detail)

    # Web SPA - needed by `maneki ui` and `maneki serve --ui`.
    from maneki.cli.ui import _resolve_static_dir

    try:
        spa_dir = _resolve_static_dir()
        table.add_row("web UI (SPA)", ok, str(spa_dir))
    except FileNotFoundError:
        table.add_row(
            "web UI (SPA)",
            warn,
            "not built - `maneki ui` / `serve --ui` need it. fix: pip-installed wheels bundle "
            "it; from source run `make desktop-build-frontend`.",
        )

    # fpcalc / Chromaprint - optional, only for `audio convert --enrich` (AcoustID).
    from maneki.audio.enrich.acoustid import fpcalc_available

    if fpcalc_available():
        table.add_row("fpcalc (AcoustID)", ok, "Chromaprint present")
    else:
        table.add_row(
            "fpcalc (AcoustID)",
            warn,
            "optional - only for `audio convert --enrich` fingerprinting. fix: `brew install "
            "chromaprint` (macOS) / `apt install libchromaprint-tools` (Linux).",
        )

    console.print(table)

    if not report.ffmpeg_path or not report.ffprobe_path:
        console.print("[red]ffmpeg + ffprobe are required for serving and converting.[/red]")
        raise typer.Exit(code=1)
