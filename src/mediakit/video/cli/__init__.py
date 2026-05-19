"""Typer subcommand group for video - minimal base for Stage 2.

`mediakit video serve` starts the FastAPI app from `mediakit.video.serve`.
`convert` and `library` remain no-op placeholders reserved for later
phases - see MEDIAKIT-STAGE2.md.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help="Video commands - base layer (scan / list / range-stream).",
)


@app.command()
def serve(
    root: Annotated[Path, typer.Argument(help="Library root - expects a videos/ subdirectory")],
    host: Annotated[str, typer.Option("--host", help="Host to bind")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port", "-p", help="Port to bind")] = 8765,
) -> None:
    """Start the minimal MediaKit-native video server.

    Endpoints exposed:
      GET /capabilities                 server identity + kind presence
      GET /api/videos                   flat list of video files under <root>/videos/
      GET /api/videos/{id}/stream       raw bytes with HTTP Range support
    """
    import uvicorn

    from mediakit.video.serve import create_app

    server_app = create_app(root.resolve())
    typer.echo(f"mediakit video serve - {root.resolve()} on http://{host}:{port}")
    uvicorn.run(server_app, host=host, port=port, log_level="info")


@app.command()
def convert() -> None:
    """No-op placeholder; reserved for organize/transcode semantics in a later stage."""
    typer.echo("mediakit video convert - not implemented yet (reserved for a later phase)")
    raise typer.Exit(code=1)


@app.command()
def library() -> None:
    """No-op placeholder; reserves the symmetric namespace with `mediakit audio library`."""
    typer.echo("mediakit video library - not implemented yet (reserved for a later phase)")
    raise typer.Exit(code=1)
