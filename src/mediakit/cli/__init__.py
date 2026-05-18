"""Top-level mediakit CLI — dispatches into the audio and video subcommand groups.

The audio group is the entire lifted MusicKit CLI (convert, library, tui, serve,
playlist, ui, ...). The video group is a stub for now; it will gain commands when
the video server lands.
"""

from __future__ import annotations

from typing import Annotated

import typer

from mediakit import __version__
from mediakit.audio.cli import app as audio_app
from mediakit.video.cli import app as video_app

_APP_HELP = (
    f"Self-hosted media toolkit (v{__version__}) — audio today, video next."
    """

[bold]Subcommand groups[/]

  [cyan]mediakit audio[/]   Music library: convert, audit, TUI, Subsonic server, web UI
  [cyan]mediakit video[/]   Video library (planned - not yet wired up)

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


app.add_typer(
    audio_app,
    name="audio",
    help="Music library: convert / audit / retag, browse via TUI, stream via Subsonic server.",
)
app.add_typer(
    video_app,
    name="video",
    help="Video library (planned).",
)
