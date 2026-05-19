"""Top-level mediakit CLI - dispatches into the audio and video subcommand groups.

Shared verbs (`library`, `serve` later) live at the top level. Kind-specific
deep features stay under `mediakit audio <verb>` / `mediakit video <verb>`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

from mediakit import __version__
from mediakit.audio.cli import app as audio_app
from mediakit.config import config_path, load_library_locations
from mediakit.library import (
    FileEntry,
    LibrarySummary,
    ScanResult,
    scan_files,
    scan_many,
    summarize,
    summarize_many,
)
from mediakit.video.cli import app as video_app

_APP_HELP = (
    f"Self-hosted media toolkit (v{__version__}) - audio + video under one roof."
    """

[bold]Top-level commands[/]

  [cyan]mediakit serve[/]    Start the combined audio + video server (one process)
  [cyan]mediakit library[/]  Summarise / scan one or more libraries

[bold]Subcommand groups[/]

  [cyan]mediakit audio[/]    Music: convert, audit, TUI, standalone Subsonic server, web UI
  [cyan]mediakit video[/]    Video: standalone video server

Pass [cyan]--help[/] after any group for its commands.

[bold]Links[/]

  Docs:  https://winterop-com.github.io/mediakit/
  PyPI:  https://pypi.org/project/mediakit/
  Repo:  https://github.com/winterop-com/mediakit
"""
)


app = typer.Typer(
    name="mediakit",
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help=_APP_HELP,
)


def _print_version(value: bool) -> None:
    if not value:
        return
    typer.echo(f"mediakit {__version__}")
    raise typer.Exit()


@app.command("serve")
def serve_cmd(
    root: Annotated[Path, typer.Argument(help="Library root containing audio/ and/or videos/ subdirectories")],
    host: Annotated[str, typer.Option("--host", help="Interface to bind")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port", "-p", help="Port to bind")] = 8765,
    audio_only: Annotated[bool, typer.Option("--audio-only", help="Mount only the audio (Subsonic) endpoints")] = False,
    video_only: Annotated[bool, typer.Option("--video-only", help="Mount only the video endpoints")] = False,
    auth: Annotated[
        bool,
        typer.Option("--auth", help="Require bearer-token auth on /video/* (Subsonic keeps its own auth)"),
    ] = False,
    ui: Annotated[
        bool,
        typer.Option("--ui", help="Also serve the MediaKit SPA at /ui/ (from desktop/react/)"),
    ] = False,
) -> None:
    """Start the combined audio + video server.

    Auto-detects what's at the root (audio/, videos/ subdirs) and mounts
    the corresponding sub-apps. URL layout:

      /capabilities         server identity + what's mounted
      POST /auth/login      exchange credentials for a bearer token
      GET /auth/me          echo back the authed user (requires bearer)
      /audio/rest/*         Subsonic API (set this as the base URL in Subsonic clients)
      /video/api/*          MediaKit-native video JSON API
      /video/               throwaway demo HTML page (works without auth)

    Pass --auth to require Authorization: Bearer <token> on /video/*. The
    demo page at /video/ doesn't speak the auth flow yet, so --auth and the
    demo are currently mutually exclusive in practice.
    """
    import uvicorn

    from mediakit.serve_app import create_combined_app

    if audio_only and video_only:
        typer.echo("--audio-only and --video-only are mutually exclusive", err=True)
        raise typer.Exit(code=2)

    combined = create_combined_app(
        root=root.resolve(),
        enable_audio=not video_only,
        enable_video=not audio_only,
        enable_auth=auth,
        enable_ui=ui,
    )
    flags: list[str] = []
    if auth:
        flags.append("auth on /video/*")
    if ui:
        flags.append("SPA at /ui/")
    flag_note = f" ({', '.join(flags)})" if flags else ""
    typer.echo(f"mediakit serve - {root.resolve()} on http://{host}:{port}{flag_note}")
    uvicorn.run(combined, host=host, port=port, log_level="info")


@app.callback()
def _global_options(
    version: Annotated[
        bool,
        typer.Option(
            "--version",
            callback=_print_version,
            is_eager=True,
            help="Show the mediakit version and exit.",
        ),
    ] = False,
) -> None:
    del version


library_app = typer.Typer(
    no_args_is_help=False,
    add_completion=False,
    rich_markup_mode="rich",
    invoke_without_command=True,
    help="Summarise / scan one or more media libraries (audio + video).",
)


@library_app.callback(invoke_without_command=True)
def _library_default(ctx: typer.Context) -> None:
    """When invoked without a subcommand, summarise every configured library."""
    if ctx.invoked_subcommand is not None:
        return
    locations = _resolve_library_locations()
    _print_summaries(summarize_many(locations))


@library_app.command("summary")
def library_summary(
    root: Annotated[
        Path | None,
        typer.Argument(help="One library root. Default: all configured locations."),
    ] = None,
) -> None:
    """Summarise one or all configured libraries (kind counts)."""
    if root is not None:
        _print_summaries([summarize(root.resolve())])
        return
    locations = _resolve_library_locations()
    _print_summaries(summarize_many(locations))


@library_app.command("scan")
def library_scan(
    root: Annotated[
        Path | None,
        typer.Argument(help="One library root. Default: all configured locations."),
    ] = None,
) -> None:
    """Walk one or all configured libraries and print every file found."""
    if root is not None:
        _print_scans([scan_files(root.resolve())])
        return
    locations = _resolve_library_locations()
    _print_scans(scan_many(locations))


def _resolve_library_locations() -> list[Path]:
    locations = load_library_locations()
    if not locations:
        typer.echo(
            f"no libraries configured. Create {config_path()} with:\n\n"
            "  [libraries]\n"
            '  locations = ["~/Downloads/library"]\n\n'
            "Or pass a path: mediakit library [<path>] | mediakit library scan [<path>]",
            err=True,
        )
        raise typer.Exit(code=1)
    return locations


def _print_summaries(summaries: list[LibrarySummary]) -> None:
    for i, s in enumerate(summaries):
        if i > 0:
            typer.echo("")
        typer.echo(f"Library: {s.root}")
        if s.audio_dir is not None:
            typer.echo(f"  audio: {s.audio_count:>6} tracks   ({s.audio_dir.name}/)")
        else:
            typer.echo("  audio:    (no audio/ or music/ subdir)")
        if s.video_dir is not None:
            typer.echo(f"  video: {s.video_count:>6} files    ({s.video_dir.name}/)")
        else:
            typer.echo("  video:    (no videos/ or video/ subdir)")


def _print_scans(scans: list[ScanResult]) -> None:
    for i, s in enumerate(scans):
        if i > 0:
            typer.echo("")
        typer.echo(f"Library: {s.root}")
        if s.audio_dir is not None:
            typer.echo(f"\n  audio ({s.audio_dir.name}/) - {len(s.audio)} tracks")
            for entry in s.audio:
                typer.echo(f"    {entry.rel_path}  ({_fmt_size(entry.size_bytes)})")
        if s.video_dir is not None:
            typer.echo(f"\n  video ({s.video_dir.name}/) - {len(s.video)} files")
            for entry in s.video:
                typer.echo(f"    {entry.rel_path}  ({_fmt_size(entry.size_bytes)})")
        if s.audio_dir is None and s.video_dir is None:
            typer.echo("  (empty - no audio/ or videos/ subdir)")


def _fmt_size(n: int) -> str:
    """Render a byte count in a human-friendly unit."""
    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(n)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} {unit}"
        size /= 1024
    return f"{n} B"


# Mark unused imports as touched (Typer registration handles the actual wiring).
_ = (FileEntry,)


app.add_typer(library_app, name="library")
app.add_typer(
    audio_app,
    name="audio",
    help="Music library: convert / audit / retag, browse via TUI, stream via Subsonic server.",
)
app.add_typer(
    video_app,
    name="video",
    help="Video server (base layer).",
)
