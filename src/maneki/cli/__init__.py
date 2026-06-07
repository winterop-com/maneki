"""Top-level maneki CLI.

The hero `serve` command plus cross-cutting top-level verbs (`info` / `list` /
`inspect`, `ui`, `doctor`); music-library deep features stay under the
`maneki audio <verb>` subcommand group.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from maneki import __version__
from maneki.audio.cli import app as audio_app
from maneki.cli.config_cmd import config_app
from maneki.cli.doctor import doctor_cmd
from maneki.cli.ui import ui_cmd
from maneki.library import (
    LibrarySummary,
    ScanResult,
    scan_files,
    summarize,
)

_APP_HELP = (
    f"Self-hosted media toolkit (v{__version__}) - one server, one library, audio + video."
    """

[bold]Top-level commands[/]

  [cyan]maneki serve[/]                  Start the server against a library root
  [cyan]maneki ui[/]                     Web UI client for any Subsonic server
  [cyan]maneki doctor[/]                 Check ffmpeg + the video encoder setup
  [cyan]maneki info[/] / [cyan]list[/] / [cyan]inspect[/]    Summarise / scan / probe any library root

[bold]Subcommand groups[/]

  [cyan]maneki config[/]   Inspect / scaffold settings (`config init`, `show`, `path`)
  [cyan]maneki audio[/]    Music: convert, audit, retag, playlist tools

Pass [cyan]--help[/] after the group for its commands.

[bold]Links[/]

  Docs:  https://winterop-com.github.io/maneki/
  PyPI:  https://pypi.org/project/maneki/
  Repo:  https://github.com/winterop-com/maneki
"""
)


app = typer.Typer(
    name="maneki",
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help=_APP_HELP,
)


def _print_version(value: bool) -> None:
    if not value:
        return
    typer.echo(f"maneki {__version__}")
    raise typer.Exit()


@app.command("serve")
def serve_cmd(
    root: Annotated[
        Path,
        typer.Argument(
            envvar="MANEKI_LIBRARY", help="Library root - scanned recursively for both audio and video files"
        ),
    ],
    host: Annotated[str, typer.Option("--host", help="Interface to bind")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port", "-p", help="Port to bind")] = 8765,
    auth: Annotated[
        bool,
        typer.Option("--auth", help="Require bearer-token auth on /video/* (Subsonic keeps its own auth)"),
    ] = False,
    ui: Annotated[
        bool,
        typer.Option("--ui", help="Serve the Maneki SPA at / (from desktop/react/)"),
    ] = False,
    workers: Annotated[
        int,
        typer.Option(
            "--workers",
            "-w",
            min=0,
            help=(
                "Background transcode workers (HLS prewarm + neighbour prefetch + posters). "
                "0 (default) = cpu_count() // 2, capped at 8. Foreground player requests always "
                "preempt background work regardless of this value."
            ),
        ),
    ] = 0,
    rescan: Annotated[
        bool,
        typer.Option(
            "--rescan",
            help=(
                "Wipe the cached thumbnails / posters before startup so they regenerate. "
                "Use this when files changed underneath the server (renames, edits)."
            ),
        ),
    ] = False,
    prewarm_cache: Annotated[
        bool,
        typer.Option(
            "--prewarm-cache",
            help=(
                "Warm every video's caches during startup: embedded-subtitle probe, row "
                "thumbnail, contact-sheet poster. Heavy: ~1-2s per thumbnail + ~3-5s per "
                "poster. Default off - thumbs generate on first SPA browse, posters on "
                "first /poster request. Pair with --rescan to force a full rebuild; pair "
                "with --no-cover-images to skip just the contact-sheet phase."
            ),
        ),
    ] = False,
    no_cover_images: Annotated[
        bool,
        typer.Option(
            "--no-cover-images",
            help=(
                "Skip contact-sheet poster generation entirely (on-demand AND prewarm). "
                "The first frame of the row thumbnail is used as the player's poster fallback "
                "instead. Useful on slow disks or huge libraries where the 9-frame poster "
                "isn't worth the wait."
            ),
        ),
    ] = False,
) -> None:
    """Start the Maneki server.

    Pass a single library root. The server scans the whole tree at startup
    and mounts only the kinds that actually have content: a root with just
    music gets no /video/* routes; a root with just movies gets no
    /audio/rest/* routes; mixed roots mount both.

    URL layout (per-kind paths exist only when the kind is mounted):

      /capabilities         server identity + what's mounted
      POST /auth/login      exchange credentials for a bearer token
      GET /auth/me          echo back the authed user (requires bearer)
      /audio/rest/*         Subsonic API (set this as the base URL in Subsonic clients)
      /video/api/*          Maneki-native video JSON API
      /video/               throwaway demo HTML page (works without auth)

    Pass --auth to require Authorization: Bearer <token> on /video/*. The
    demo page at /video/ doesn't speak the auth flow yet, so --auth and the
    demo are currently mutually exclusive in practice.
    """
    import uvicorn

    from maneki.audio.serve.logging import configure_logging
    from maneki.serve_app import create_combined_app

    # Single unified log config for everything the server emits. Both
    # `maneki.*` and `uvicorn.*` loggers reparent through structlog's
    # ProcessorFormatter so every line — startup banner, scan progress,
    # request logs from AccessLogMiddleware, errors — flows through the
    # same renderer. Pretty (coloured ConsoleRenderer) by default;
    # `MANEKI_LOG_FORMAT=json` switches to JSONRenderer for shipping.
    configure_logging()
    # Tell uvicorn to NOT install its own logging config — configure_logging()
    # already wired up the root handler and reparented uvicorn's loggers
    # through it. Passing log_config=None preserves our setup.
    uvicorn_log_config = None

    combined = create_combined_app(
        root=root.resolve(),
        enable_auth=auth,
        enable_ui=ui,
        transcode_workers=workers or None,
        rescan=rescan,
        prewarm_cache=prewarm_cache,
        no_cover_images=no_cover_images,
    )
    import structlog

    flags: list[str] = []
    if auth:
        flags.append("auth on /video/*")
    if ui:
        flags.append("SPA at /")
    if rescan:
        flags.append("rescan")
    if prewarm_cache:
        flags.append("prewarm-cache")
    if no_cover_images:
        flags.append("no-cover-images")
    actual_workers = workers or "auto"
    flags.append(f"workers={actual_workers}")
    # Banner through structlog so it matches the rest of the server's
    # output (timestamp + level + key=value); the previous `typer.echo`
    # call printed a plain line that broke the alignment of an
    # otherwise-uniform stream.
    structlog.get_logger("maneki.serve").info(
        "maneki serve starting",
        root=str(root.resolve()),
        host=host,
        port=port,
        flags=", ".join(flags),
    )
    uvicorn.run(combined, host=host, port=port, log_config=uvicorn_log_config)


@app.callback()
def _global_options(
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            callback=_print_version,
            is_eager=True,
            help="Show the maneki version and exit.",
        ),
    ] = False,
) -> None:
    del version


@app.command("info")
def library_info(
    root: Annotated[Path, typer.Argument(envvar="MANEKI_LIBRARY", help="Library root to describe.")],
) -> None:
    """Print audio + video file counts for one library root."""
    _print_summaries([summarize(root.resolve())])


@app.command("list")
@app.command("ls", hidden=True)
def library_list(
    root: Annotated[Path, typer.Argument(envvar="MANEKI_LIBRARY", help="Library root to walk.")],
) -> None:
    """List every audio and video file under a library root (cheap stat walk, no probe)."""
    _print_scans([scan_files(root.resolve())])


@app.command("inspect")
def library_inspect(
    path: Annotated[
        Path,
        typer.Argument(exists=True, dir_okay=False, help="Single audio or video file to inspect."),
    ],
) -> None:
    """Inspect one file - dispatches to the audio (tags + cover) or video (streams) inspector by extension."""
    from rich.console import Console

    from maneki.audio.cli.inspect import inspect_audio_file
    from maneki.audio.metadata import SUPPORTED_AUDIO_EXTS
    from maneki.video.inspect import inspect_video_file
    from maneki.video.serve.scan import VIDEO_EXTENSIONS

    console = Console()
    suffix = path.suffix.lower()
    if suffix in SUPPORTED_AUDIO_EXTS:
        inspect_audio_file(path, console=console)
    elif suffix in VIDEO_EXTENSIONS:
        inspect_video_file(path, console=console)
    else:
        typer.echo(f"unsupported extension: {path.suffix} (not audio, not video)", err=True)
        raise typer.Exit(code=1)


def _print_summaries(summaries: list[LibrarySummary]) -> None:
    from rich.console import Console
    from rich.table import Table

    console = Console()
    for i, s in enumerate(summaries):
        if i > 0:
            console.print("")
        table = Table(title=f"[bold]{s.root}[/bold]", title_justify="left", title_style="cyan")
        table.add_column("kind", style="cyan")
        table.add_column("count", justify="right")
        table.add_row("audio", f"{s.audio_count:,} tracks")
        table.add_row("video", f"{s.video_count:,} files")
        if s.is_empty:
            table.add_row("[yellow]—[/]", "[yellow]no audio or video files found[/]")
        console.print(table)


def _print_scans(scans: list[ScanResult]) -> None:
    from rich.console import Console
    from rich.table import Table

    console = Console()
    for i, s in enumerate(scans):
        if i > 0:
            console.print("")
        console.print(f"[bold cyan]{s.root}[/]")
        if s.audio:
            console.print(f"\n[bold cyan]Audio[/]  [dim]{len(s.audio)} tracks[/]")
            table = Table(box=None, show_header=False, pad_edge=False, padding=(0, 2))
            table.add_column()
            table.add_column(justify="right", style="dim")
            for entry in s.audio:
                table.add_row(str(entry.rel_path), _fmt_size(entry.size_bytes))
            console.print(table)
        if s.video:
            console.print(f"\n[bold cyan]Video[/]  [dim]{len(s.video)} files[/]")
            table = Table(box=None, show_header=False, pad_edge=False, padding=(0, 2))
            table.add_column()
            table.add_column(justify="right", style="dim")
            for entry in s.video:
                table.add_row(str(entry.rel_path), _fmt_size(entry.size_bytes))
            console.print(table)
        if not s.audio and not s.video:
            console.print("[yellow](empty - no audio or video files found)[/]")


def _fmt_size(n: int) -> str:
    """Render a byte count in a human-friendly unit."""
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(n)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} {unit}"
        size /= 1024
    return f"{n} B"


app.command("ui")(ui_cmd)
app.command("doctor")(doctor_cmd)
app.add_typer(config_app, name="config")
app.add_typer(
    audio_app,
    name="audio",
    help="Music library: convert / audit / retag, stream via Subsonic server.",
)
