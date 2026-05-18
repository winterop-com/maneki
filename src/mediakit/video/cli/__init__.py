"""Typer subcommand group for video. Empty until Stage 2 lands."""

from __future__ import annotations

import typer

app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help="Video commands - none yet. The video server lands in a follow-up.",
)


@app.command()
def todo() -> None:
    """Placeholder so `mediakit video` is not empty. Replace once Stage 2 lands."""
    typer.echo("video commands not yet implemented - see MEDIAKIT.md for the plan")
    raise typer.Exit(code=1)
