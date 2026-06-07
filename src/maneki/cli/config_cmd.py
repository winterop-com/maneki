"""`maneki config` — inspect / scaffold / migrate the consolidated config.

Config lives at `~/.config/maneki/maneki.toml` (or `$XDG_CONFIG_HOME`, or
`MANEKI_CONFIG`). It's cross-cutting — libraries, users, server, media,
logging — so the command sits at the top level, not under `audio`.
"""

from __future__ import annotations

import typer
from rich.console import Console

from maneki.audio.config import migrate_legacy_config
from maneki.settings import (
    config_path,
    get_settings,
    legacy_serve_path,
    render_settings_summary,
    reset_settings_cache,
    write_starter_config,
)

config_app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help="Inspect / scaffold / migrate `~/.config/maneki/maneki.toml`.",
)


@config_app.command("show")
def show() -> None:
    """Print the resolved config (sensitive values masked)."""
    Console().print(render_settings_summary(get_settings()))


@config_app.command("path")
def path() -> None:
    """Print the config file path (honours `MANEKI_CONFIG` / `$XDG_CONFIG_HOME`)."""
    typer.echo(str(config_path()))


@config_app.command("init")
def init(
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite an existing file."),
) -> None:
    """Write a starter `maneki.toml` with every section as commented examples."""
    try:
        written = write_starter_config(force=force)
    except FileExistsError:
        typer.secho(
            f"{config_path()} already exists; pass --force to overwrite.",
            fg=typer.colors.YELLOW,
        )
        raise typer.Exit(code=1) from None
    reset_settings_cache()
    typer.secho(f"Wrote {written}", fg=typer.colors.GREEN)
    typer.echo("Edit it, then `chmod 600` it — it can hold plaintext passwords.")


@config_app.command("migrate")
def migrate(
    keep_legacy: bool = typer.Option(
        False,
        "--keep-legacy",
        help="Don't delete `serve.toml` after the migration.",
    ),
) -> None:
    """Move a legacy `~/.config/maneki/serve.toml` → `maneki.toml` (idempotent)."""
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
