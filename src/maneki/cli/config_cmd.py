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
    UserAccount,
    config_path,
    get_settings,
    legacy_serve_path,
    render_settings_summary,
    reset_settings_cache,
    write_starter_config,
    write_users,
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


# ---------------------------------------------------------------------------
# `maneki config user` — manage the [[users]] accounts in maneki.toml.
# ---------------------------------------------------------------------------

user_app = typer.Typer(
    no_args_is_help=True,
    add_completion=False,
    rich_markup_mode="rich",
    help="Manage user accounts (`[[users]]` in maneki.toml).",
)
config_app.add_typer(user_app, name="user")


@user_app.command("list")
def user_list() -> None:
    """List configured accounts (passwords masked)."""
    console = Console()
    accounts = get_settings().accounts()
    for u in accounts:
        flag = " [cyan](admin)[/cyan]" if u.admin else ""
        console.print(f"  {u.name}{flag}")
    if not get_settings().users:
        console.print("[dim](single-user fallback from [server] — no [[users]] defined yet)[/dim]")


@user_app.command("add")
def user_add(
    name: str,
    admin: bool = typer.Option(False, "--admin", help="Grant admin (may manage users)."),
    password: str | None = typer.Option(None, "--password", help="Set inline instead of prompting."),
) -> None:
    """Add a new account (seeds [[users]] from [server] on first use)."""
    users = list(get_settings().accounts())
    if any(u.name == name for u in users):
        typer.secho(f"User {name!r} already exists; use `config user passwd`.", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)
    pw = password or typer.prompt(f"Password for {name}", hide_input=True, confirmation_prompt=True)
    users.append(UserAccount(name=name, password=pw, admin=admin))
    write_users(users)
    typer.secho(f"Added {name}{' (admin)' if admin else ''} -> {config_path()}", fg=typer.colors.GREEN)


@user_app.command("passwd")
def user_passwd(
    name: str,
    password: str | None = typer.Option(None, "--password", help="Set inline instead of prompting."),
) -> None:
    """Change an account's password."""
    users = list(get_settings().accounts())
    idx = next((i for i, u in enumerate(users) if u.name == name), None)
    if idx is None:
        typer.secho(f"No such user: {name!r}", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)
    pw = password or typer.prompt(f"New password for {name}", hide_input=True, confirmation_prompt=True)
    users[idx] = users[idx].model_copy(update={"password": pw})
    write_users(users)
    typer.secho(f"Updated password for {name}.", fg=typer.colors.GREEN)


@user_app.command("rm")
def user_rm(name: str) -> None:
    """Remove an account."""
    users = list(get_settings().accounts())
    remaining = [u for u in users if u.name != name]
    if len(remaining) == len(users):
        typer.secho(f"No such user: {name!r}", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)
    if users and not any(u.admin for u in remaining) and remaining:
        typer.secho("Refusing to remove the last admin account.", fg=typer.colors.YELLOW)
        raise typer.Exit(code=1)
    write_users(remaining)
    typer.secho(f"Removed {name}.", fg=typer.colors.GREEN)
