"""`maneki config` CLI — show / path / migrate.

Exercises the user-facing surface of the config subcommand. The
underlying logic is tested in `test_config.py`; this file asserts the
CLI wraps it correctly: exit codes, output text, file mutations on
`migrate`. `migrate` is destructive (deletes serve.toml) so tests
operate on a tmp_path-redirected config dir.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from maneki.cli import app


def _redirect_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Point `config_path()` + `legacy_serve_path()` + the Settings TOML at tmp_path."""
    import os

    from maneki.settings import Settings, reset_settings_cache

    monkeypatch.setattr("maneki.audio.config.config_dir", lambda: tmp_path)
    Settings.model_config["toml_file"] = str(tmp_path / "maneki.toml")
    # Wipe MANEKI_* env vars so test isolation holds, then drop the cache.
    for key in list(os.environ):
        if key.startswith("MANEKI_"):
            monkeypatch.delenv(key, raising=False)
    reset_settings_cache()


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


# ---------------------------------------------------------------------------
# `maneki config path`
# ---------------------------------------------------------------------------


def test_config_path_prints_absolute_path(runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """`config path` prints the resolved absolute file path and exits 0."""
    _redirect_config(monkeypatch, tmp_path)
    result = runner.invoke(app, ["config", "path"])
    assert result.exit_code == 0
    out = result.stdout.strip()
    assert out == str(tmp_path / "maneki.toml")


# ---------------------------------------------------------------------------
# `maneki config show`
# ---------------------------------------------------------------------------


def test_config_show_with_defaults(runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No file + no env → admin/admin defaults rendered, secrets masked."""
    _redirect_config(monkeypatch, tmp_path)
    result = runner.invoke(app, ["config", "show"])
    assert result.exit_code == 0
    # No [[users]] -> a single admin account synthesized from [server].
    assert "admin (admin)" in result.stdout
    # Default password 'admin' is sensitive even when default-valued, mask it.
    assert "****" in result.stdout
    assert "exists: False" in result.stdout


def test_config_show_masks_password_and_apikey(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Hand-written values for sensitive fields aren't leaked to stdout."""
    _redirect_config(monkeypatch, tmp_path)
    (tmp_path / "maneki.toml").write_text(
        '[server]\nusername = "alice"\npassword = "supersecret"\n\n[acoustid]\napi_key = "topsecretkey"\n',
        encoding="utf-8",
    )
    result = runner.invoke(app, ["config", "show"])
    assert result.exit_code == 0
    assert "alice" in result.stdout
    assert "supersecret" not in result.stdout
    assert "topsecretkey" not in result.stdout
    assert "****" in result.stdout
    assert "exists: True" in result.stdout


def test_config_show_lists_env_overrides(runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Active MANEKI_* env vars get listed (with their values masked)."""
    _redirect_config(monkeypatch, tmp_path)
    monkeypatch.setenv("MANEKI_SERVER__USERNAME", "fromenv")
    result = runner.invoke(app, ["config", "show"])
    assert result.exit_code == 0
    assert "MANEKI_SERVER__USERNAME" in result.stdout
    # The env override should propagate to the resolved config too.
    assert "fromenv" in result.stdout


# ---------------------------------------------------------------------------
# `maneki config migrate`
# ---------------------------------------------------------------------------


def test_config_migrate_writes_new_file_and_deletes_legacy(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Legacy serve.toml gets moved into maneki.toml and removed."""
    _redirect_config(monkeypatch, tmp_path)
    legacy = tmp_path / "serve.toml"
    legacy.write_text(
        'username = "morten"\npassword = "wonderful"\n',
        encoding="utf-8",
    )
    result = runner.invoke(app, ["config", "migrate"])
    assert result.exit_code == 0
    assert "Wrote" in result.stdout
    assert (tmp_path / "maneki.toml").exists()
    assert not legacy.exists()


def test_config_migrate_keep_legacy(runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """`--keep-legacy` writes the new file but leaves serve.toml intact."""
    _redirect_config(monkeypatch, tmp_path)
    legacy = tmp_path / "serve.toml"
    legacy.write_text('username = "u"\npassword = "p"\n', encoding="utf-8")
    result = runner.invoke(app, ["config", "migrate", "--keep-legacy"])
    assert result.exit_code == 0
    assert (tmp_path / "maneki.toml").exists()
    assert legacy.exists()
    assert "Kept legacy" in result.stdout


def test_config_migrate_idempotent_when_target_exists(
    runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Re-running migrate when maneki.toml is present is a no-op."""
    _redirect_config(monkeypatch, tmp_path)
    (tmp_path / "maneki.toml").write_text("# already migrated\n", encoding="utf-8")
    (tmp_path / "serve.toml").write_text("username = 'x'\n", encoding="utf-8")
    result = runner.invoke(app, ["config", "migrate"])
    assert result.exit_code == 0
    assert "already exists" in result.stdout
    # serve.toml stays untouched in this branch (we only delete on success).
    assert (tmp_path / "serve.toml").exists()


def test_config_migrate_no_legacy_no_op(runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """No legacy file + no new file → friendly bail, exit 0."""
    _redirect_config(monkeypatch, tmp_path)
    result = runner.invoke(app, ["config", "migrate"])
    assert result.exit_code == 0
    assert "No legacy" in result.stdout


# ---------------------------------------------------------------------------
# `maneki config init`
# ---------------------------------------------------------------------------


def test_config_init_writes_starter(runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """`config init` scaffolds a commented starter file; `--force` overwrites."""
    _redirect_config(monkeypatch, tmp_path)
    result = runner.invoke(app, ["config", "init"])
    assert result.exit_code == 0
    target = tmp_path / "maneki.toml"
    assert target.exists()
    body = target.read_text()
    assert "[[users]]" in body
    assert "[server]" in body
    # Refuses to clobber without --force.
    again = runner.invoke(app, ["config", "init"])
    assert again.exit_code == 1
    assert "already exists" in again.stdout
    # --force overwrites.
    forced = runner.invoke(app, ["config", "init", "--force"])
    assert forced.exit_code == 0


# ---------------------------------------------------------------------------
# Subcommand wiring — `maneki config` (no args) shows the help.
# ---------------------------------------------------------------------------


def test_config_no_args_prints_help(runner: CliRunner) -> None:
    """`maneki config` (no subcommand) prints the help with the three commands."""
    result = runner.invoke(app, ["config"])
    # Typer prints help to stderr / exits 0 with `no_args_is_help=True`.
    assert result.exit_code == 0 or result.exit_code == 2
    out = result.stdout + result.output
    for cmd in ("show", "path", "migrate"):
        assert cmd in out


# ---------------------------------------------------------------------------
# `maneki config user`
# ---------------------------------------------------------------------------


def test_user_add_list_passwd_rm(runner: CliRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _redirect_config(monkeypatch, tmp_path)
    (tmp_path / "maneki.toml").write_text('[server]\nusername = "root"\npassword = "rootpw"\n', encoding="utf-8")

    assert runner.invoke(app, ["config", "user", "add", "alice", "--admin", "--password", "apw"]).exit_code == 0
    assert runner.invoke(app, ["config", "user", "add", "bob", "--password", "bpw"]).exit_code == 0

    listed = runner.invoke(app, ["config", "user", "list"]).stdout
    assert "alice" in listed and "bob" in listed and "root" in listed  # root seeded from [server]

    # Duplicate add is rejected.
    assert runner.invoke(app, ["config", "user", "add", "alice", "--password", "x"]).exit_code == 1
    # passwd + rm.
    assert runner.invoke(app, ["config", "user", "passwd", "bob", "--password", "new"]).exit_code == 0
    assert runner.invoke(app, ["config", "user", "rm", "bob"]).exit_code == 0
    assert "bob" not in runner.invoke(app, ["config", "user", "list"]).stdout
    # rm unknown is an error.
    assert runner.invoke(app, ["config", "user", "rm", "nobody"]).exit_code == 1


def test_write_users_preserves_other_sections(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from maneki import settings as settings_mod
    from maneki.settings import Settings, UserAccount, get_settings, reset_settings_cache, write_users

    cfg = tmp_path / "maneki.toml"
    monkeypatch.setattr(settings_mod, "config_path", lambda: cfg)
    Settings.model_config["toml_file"] = str(cfg)
    cfg.write_text('# keep me\n[media]\nhwenc = "none"\n', encoding="utf-8")
    reset_settings_cache()

    write_users([UserAccount(name="x", password="p", admin=True)])
    body = cfg.read_text()
    assert "# keep me" in body
    assert "[media]" in body and 'hwenc = "none"' in body
    assert "[[users]]" in body
    reset_settings_cache()
    assert [u.name for u in get_settings().users] == ["x"]
