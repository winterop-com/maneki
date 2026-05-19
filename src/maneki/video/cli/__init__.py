"""Typer subcommand group for video.

Video serving lives under the top-level `maneki serve` command, which
auto-detects audio and video in a single library root. This group is
reserved for video-specific tooling that doesn't belong on the unified
serve command (organise / probe / library tools, added later).
"""

from __future__ import annotations

import typer

app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help="Video tooling (placeholders - see `maneki serve` for serving).",
)


@app.command()
def convert() -> None:
    """No-op placeholder; reserved for organize/transcode semantics in a later stage."""
    typer.echo("maneki video convert - not implemented yet (reserved for a later phase)")
    raise typer.Exit(code=1)


@app.command()
def library() -> None:
    """No-op placeholder; reserves the symmetric namespace with `maneki audio library`."""
    typer.echo("maneki video library - not implemented yet (reserved for a later phase)")
    raise typer.Exit(code=1)
