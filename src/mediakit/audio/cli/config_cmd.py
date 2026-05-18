"""`mediakit config` — show + path + migrate the consolidated config file.

The config lives at `~/.config/mediakit/mediakit.toml`. This subcommand
group exists so users can:

  - inspect what the resolved config is (with sensitive values masked)
  - find the file path on this OS
  - migrate from the legacy `serve.toml` once

Implementation lives in `mediakit.audio.config`; this module is just the CLI
surface.
"""

from __future__ import annotations

import typer
from rich.console import Console

from mediakit.audio.cli import app
from mediakit.audio.config import (
    config_path,
    legacy_serve_path,
    load_config,
    migrate_legacy_config,
    render_config_summary,
)

config_app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help="Inspect / manage `~/.config/mediakit/mediakit.toml`.",
)
app.add_typer(config_app, name="config")


@config_app.command("show")
def show() -> None:
    """Print the resolved config (sensitive values masked)."""
    cfg = load_config(_silent=True)
    Console().print(render_config_summary(cfg))


@config_app.command("path")
def path() -> None:
    """Print the absolute path to `mediakit.toml`."""
    typer.echo(str(config_path()))


@config_app.command("migrate")
def migrate(
    keep_legacy: bool = typer.Option(
        False,
        "--keep-legacy",
        help="Don't delete `serve.toml` after the migration.",
    ),
) -> None:
    """Move `~/.config/mediakit/serve.toml` → `mediakit.toml`.

    Idempotent — bails cheerfully when there's nothing to do.
    """
    if config_path().exists():
        typer.echo(f"{config_path()} already exists; nothing to do.")
        return
    if not legacy_serve_path().exists():
        typer.echo(f"No legacy {legacy_serve_path()} found; nothing to do.")
        return
    written, deleted = migrate_legacy_config(delete_source=not keep_legacy)
    if written is None:
        typer.echo("Nothing to migrate.")
        return
    typer.secho(f"Wrote {written}", fg=typer.colors.GREEN)
    if deleted is not None:
        typer.echo(f"Removed {deleted}")
    elif keep_legacy:
        typer.echo(f"Kept legacy {legacy_serve_path()} (per --keep-legacy)")
