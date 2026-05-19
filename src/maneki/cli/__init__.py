"""Top-level maneki CLI - dispatches into the audio and video subcommand groups.

Shared verbs (`library`, `serve` later) live at the top level. Kind-specific
deep features stay under `maneki audio <verb>` / `maneki video <verb>`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from maneki import __version__
from maneki.audio.cli import app as audio_app
from maneki.library import (
    LibrarySummary,
    ScanResult,
    scan_files,
    summarize,
)
from maneki.video.cli import app as video_app

_APP_HELP = (
    f"Self-hosted media toolkit (v{__version__}) - one server, one library, audio + video."
    """

[bold]Top-level commands[/]

  [cyan]maneki serve[/]    Start the server against a library root
  [cyan]maneki library[/]  Summarise / scan one or more libraries

[bold]Subcommand groups[/]

  [cyan]maneki audio[/]    Music: convert, audit, retag, playlist tools
  [cyan]maneki video[/]    Video: inspect, probe, library tools

Pass [cyan]--help[/] after any group for its commands.

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
    root: Annotated[Path, typer.Argument(help="Library root - scanned recursively for both audio and video files")],
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
                "0 (default) = cpu_count() // 2, capped at 4. Foreground player requests always "
                "preempt background work regardless of this value."
            ),
        ),
    ] = 0,
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

    from maneki.serve_app import create_combined_app

    combined = create_combined_app(
        root=root.resolve(),
        enable_auth=auth,
        enable_ui=ui,
        transcode_workers=workers or None,
    )
    flags: list[str] = []
    if auth:
        flags.append("auth on /video/*")
    if ui:
        flags.append("SPA at /")
    actual_workers = workers or "auto"
    flags.append(f"workers={actual_workers}")
    flag_note = f" ({', '.join(flags)})"
    typer.echo(f"maneki serve - {root.resolve()} on http://{host}:{port}{flag_note}")
    uvicorn.run(combined, host=host, port=port, log_level="info")


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


library_app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help="Inspect a library root - cross-cutting audio + video.",
)


@library_app.command("info")
def library_info(
    root: Annotated[Path, typer.Argument(help="Library root to describe.")],
) -> None:
    """Print audio + video file counts for one library root."""
    _print_summaries([summarize(root.resolve())])


@library_app.command("list")
@library_app.command("ls", hidden=True)
def library_list(
    root: Annotated[Path, typer.Argument(help="Library root to walk.")],
) -> None:
    """List every audio and video file under a library root (cheap stat walk, no probe)."""
    _print_scans([scan_files(root.resolve())])


@library_app.command("inspect")
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
    from rich.box import SIMPLE_HEAVY
    from rich.console import Console
    from rich.table import Table

    console = Console()
    for i, s in enumerate(summaries):
        if i > 0:
            console.print("")
        table = Table.grid(padding=(0, 2))
        table.add_column(style="dim")
        table.add_column()
        table.add_row("root", str(s.root))
        table.add_row("audio", f"{s.audio_count:,} tracks")
        table.add_row("video", f"{s.video_count:,} files")
        if s.is_empty:
            table.add_row("", "[yellow](no audio or video files found)[/]")
        from rich.panel import Panel

        console.print(Panel(table, title="[bold]Library[/bold]", border_style="cyan", box=SIMPLE_HEAVY))


def _print_scans(scans: list[ScanResult]) -> None:
    from rich.box import SIMPLE_HEAVY
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table

    console = Console()
    for i, s in enumerate(scans):
        if i > 0:
            console.print("")
        console.print(Panel(f"[bold]{s.root}[/]", border_style="cyan", box=SIMPLE_HEAVY))
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


app.add_typer(library_app, name="library")
app.add_typer(
    audio_app,
    name="audio",
    help="Music library: convert / audit / retag, stream via Subsonic server.",
)
app.add_typer(
    video_app,
    name="video",
    help="Video server (base layer).",
)
