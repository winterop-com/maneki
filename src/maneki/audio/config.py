"""Top-level user config — `~/.config/maneki/maneki.toml`.

One TOML file with sections per concern (server / acoustid). Loaded via
`pydantic-settings` so type validation + env-var precedence come for
free:

  CLI flag > env var (MANEKI_SERVER__USERNAME=admin) > TOML > default

The legacy `~/.config/maneki/serve.toml` is read as a fallback while
`maneki.toml` is missing — keeps existing installs working until the
user runs `maneki config migrate` (or v0.12 drops the fallback).

Note: this file deliberately does NOT cover `state.toml` (mutable runtime
state owned by the audio server) or `radio.toml` (user-curated station list).
Those have different lifecycles; pydantic-settings is for read-only
config.
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    TomlConfigSettingsSource,
)

# These models are reused from `serve/config.py` — re-imported here so the
# top-level config object has a self-contained shape. The serve module
# keeps using them too.
from maneki.audio.serve.config import ScrobbleConfig


def config_dir() -> Path:
    """`$XDG_CONFIG_HOME/maneki` (or `~/.config/maneki`). Created on first write."""
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path.home() / ".config"
    return root / "maneki"


def config_path() -> Path:
    """The consolidated config file.

    `MANEKI_CONFIG` overrides the location entirely (point it at any `.toml`);
    otherwise it's `<config_dir>/maneki.toml`, honouring `$XDG_CONFIG_HOME`.
    """
    override = os.environ.get("MANEKI_CONFIG")
    if override:
        return Path(override).expanduser()
    return config_dir() / "maneki.toml"


def legacy_serve_path() -> Path:
    """Pre-0.11 location of server creds + scrobble config."""
    return config_dir() / "serve.toml"


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


class ServerSection(BaseModel):
    """`[server]` — Subsonic credentials + optional scrobble forwarders."""

    model_config = ConfigDict(extra="ignore")

    username: str = "admin"
    password: str = "admin"
    scrobble: ScrobbleConfig = Field(default_factory=ScrobbleConfig)


class AcoustIDSection(BaseModel):
    """`[acoustid]` — API key for `maneki convert --enrich`.

    When set, `convert` uses it automatically as the `--acoustid-key`
    fallback so the CLI flag is only needed for one-off overrides.
    """

    model_config = ConfigDict(extra="ignore")

    api_key: str | None = None


class MediakitConfig(BaseSettings):
    """Top-level config — every section is optional + has defaults."""

    model_config = SettingsConfigDict(
        toml_file=str(config_path()),
        env_prefix="MANEKI_",
        env_nested_delimiter="__",
        extra="ignore",
    )

    server: ServerSection = Field(default_factory=ServerSection)
    acoustid: AcoustIDSection = Field(default_factory=AcoustIDSection)

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """Source order: init kwargs > env vars > TOML > file secrets > defaults.

        We swap pydantic-settings' default `env > dotenv > file_secret`
        order so the TOML file sits between env and file_secret.
        `init_settings` is first so callers can pass overrides in tests.
        """
        return (
            init_settings,
            env_settings,
            TomlConfigSettingsSource(settings_cls),
            file_secret_settings,
        )


# ---------------------------------------------------------------------------
# Load + legacy fallback
# ---------------------------------------------------------------------------


def load_config(*, _silent: bool = False) -> MediakitConfig:
    """Return the resolved config.

    Resolution order:
      1. `~/.config/maneki/maneki.toml` (new home) — pydantic-settings
         loads it directly.
      2. `~/.config/maneki/serve.toml` (legacy) — read manually, mapped
         into the new shape. A one-line deprecation hint is printed unless
         `_silent` is set.
      3. Defaults — admin/admin server creds, no scrobble, no acoustid key.

    The legacy fallback is shipped through v0.11 and removed in v0.12.
    """
    if config_path().exists():
        return MediakitConfig()
    legacy = _load_legacy_serve_toml()
    if legacy is not None:
        if not _silent:
            print(
                "maneki: using legacy ~/.config/maneki/serve.toml — run "
                "`maneki config migrate` to move it to maneki.toml.",
            )
        return legacy
    return MediakitConfig()


def _load_legacy_serve_toml() -> MediakitConfig | None:
    """Map the old `serve.toml` into a `MediakitConfig` instance."""
    p = legacy_serve_path()
    if not p.exists():
        return None
    try:
        with p.open("rb") as f:
            raw = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    server_kwargs: dict[str, Any] = {}
    for key in ("username", "password"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            server_kwargs[key] = value
    scrobble = raw.get("scrobble")
    if isinstance(scrobble, dict):
        # ScrobbleConfig accepts the dict shape directly thanks to its
        # nested webhook / mqtt models.
        server_kwargs["scrobble"] = ScrobbleConfig.model_validate(scrobble)
    return MediakitConfig(server=ServerSection(**server_kwargs))


# ---------------------------------------------------------------------------
# Migration helper
# ---------------------------------------------------------------------------


def migrate_legacy_config(*, delete_source: bool = True) -> tuple[Path | None, Path | None]:
    """Move `serve.toml` → `maneki.toml`.

    Returns `(written_path, deleted_path)`. Both can be `None` if there
    was nothing to do (no legacy file, or `maneki.toml` already exists).
    """
    if config_path().exists():
        return None, None
    legacy = _load_legacy_serve_toml()
    if legacy is None:
        return None, None
    from maneki.audio import _toml_dump

    payload = _config_to_toml_dict(legacy)
    _toml_dump.dump_path(payload, config_path())
    deleted: Path | None = None
    if delete_source:
        try:
            legacy_serve_path().unlink()
            deleted = legacy_serve_path()
        except OSError:  # pragma: no cover — read-only mount
            pass
    return config_path(), deleted


def _config_to_toml_dict(cfg: MediakitConfig) -> dict[str, Any]:
    """Serialize `MediakitConfig` to the dict shape `_toml_dump.dumps` accepts.

    Only emits non-default fields so the user's hand-edited file stays
    minimal. The `_toml_dump` module supports flat sections only — for
    the (rare) nested `[server.scrobble.webhook]` blocks we'd need a
    richer writer; for now scrobble settings are migrated into the
    top-level `[server]` table as `scrobble_*` fields. A user with
    scrobble configured can rerun the migration once we ship the fuller
    writer in v0.12.
    """
    out: dict[str, Any] = {}
    server: dict[str, Any] = {}
    if cfg.server.username != "admin":
        server["username"] = cfg.server.username
    if cfg.server.password != "admin":
        server["password"] = cfg.server.password
    if server:
        out["server"] = server
    if cfg.acoustid.api_key:
        out["acoustid"] = {"api_key": cfg.acoustid.api_key}
    return out


# ---------------------------------------------------------------------------
# Display helpers (used by `maneki config show`)
# ---------------------------------------------------------------------------


def render_config_summary(cfg: MediakitConfig) -> str:
    """Format the resolved config for `maneki config show`.

    Sensitive values (passwords, API keys, scrobble secrets) are masked.
    Output is plain text — Rich rendering is layered on by the CLI.
    """
    lines: list[str] = []
    lines.append("[server]")
    lines.append(f"  username = {cfg.server.username!r}")
    lines.append(f"  password = {_mask(cfg.server.password)}")
    if cfg.server.scrobble.enabled:
        lines.append("  scrobble.enabled = true")
        if cfg.server.scrobble.webhook is not None:
            lines.append(f"  scrobble.webhook.url = {cfg.server.scrobble.webhook.url!r}")
        if cfg.server.scrobble.mqtt is not None:
            lines.append(f"  scrobble.mqtt.broker = {cfg.server.scrobble.mqtt.broker!r}")
    lines.append("")
    lines.append("[acoustid]")
    lines.append(f"  api_key = {_mask(cfg.acoustid.api_key)}")
    lines.append("")
    lines.append(f"file: {config_path()}")
    lines.append(f"  exists: {config_path().exists()}")
    legacy_present = legacy_serve_path().exists()
    if legacy_present:
        lines.append(f"  legacy: {legacy_serve_path()} (run `maneki config migrate` to move)")
    lines.append("")
    lines.append("env vars (prefix `MANEKI_`, nested delimiter `__`):")
    seen_env = sorted(k for k in os.environ if k.startswith("MANEKI_"))
    if seen_env:
        for k in seen_env:
            lines.append(f"  {k} = {_mask(os.environ[k])}")
    else:
        lines.append("  (none set)")
    return "\n".join(lines)


def _mask(value: str | None) -> str:
    """Render a sensitive value as `'****'` while distinguishing empty/None."""
    if value is None:
        return "(unset)"
    if value == "":
        return "''"
    return "'****'"
