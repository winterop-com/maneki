"""Consolidated maneki configuration — one `Settings` object for everything.

Historically config was split across `maneki.config` (library roots),
`maneki.audio.config` (server creds + acoustid), and a scatter of ad-hoc
`os.environ` reads (ffmpeg/encoder/log overrides). This module is the single
source of truth: one `~/.config/maneki/maneki.toml`, one `Settings` model,
`get_settings()` to read it.

Resolution precedence (highest first):

  CLI flag  >  env var  >  ~/.config/maneki/maneki.toml  >  default

Every flat `MANEKI_*` env var shipped to date keeps working — `MANEKI_FFMPEG`,
`MANEKI_FFPROBE`, `MANEKI_HWENC[_BITRATE/_MAXRATE/_BUFSIZE]`, `MANEKI_VAAPI_DEVICE`,
`MANEKI_LOG_LEVEL/_FORMAT`, `MANEKI_ACOUSTID_KEY`, plus the nested
`MANEKI_SERVER__USERNAME` form — they map onto the matching section field here.

The hot, low-level modules (`maneki.ffmpeg`, `video.serve.encoders`) deliberately
keep their own cheap `os.environ` reads rather than importing this module, to
avoid an import cycle and the `BaseSettings` build cost on the transcode path;
the `media` section mirrors/documents those same vars so `maneki config show`
and any structured consumer see one consistent picture.
"""

from __future__ import annotations

import os
import tomllib
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    TomlConfigSettingsSource,
)

# Reuse the existing value models so there's exactly one definition of each.
from maneki.audio.config import AcoustIDSection, ServerSection, config_dir, config_path, legacy_serve_path

__all__ = [
    "AcoustIDSection",
    "LibrariesSection",
    "LoggingSection",
    "MediaSection",
    "ServerSection",
    "Settings",
    "UserAccount",
    "config_dir",
    "config_path",
    "get_settings",
    "legacy_serve_path",
    "reset_settings_cache",
]


# ---------------------------------------------------------------------------
# Section models
# ---------------------------------------------------------------------------


class UserAccount(BaseModel):
    """One `[[users]]` account.

    The password is stored PLAINTEXT and that is structural, not an oversight:
    Subsonic salted-token auth computes `md5(password + salt)` server-side and
    the native `/auth/login` compares cleartext, so the password must be
    recoverable. Protect `maneki.toml` with file perms (`chmod 600`), not hashing.
    """

    model_config = ConfigDict(frozen=True, extra="ignore")

    name: str
    password: str
    admin: bool = False


class LibrariesSection(BaseModel):
    """`[libraries]` — the library roots maneki serves / manages."""

    model_config = ConfigDict(extra="ignore")

    # `locations` is the historical TOML key; keep it as the alias so existing
    # `[libraries] locations = [...]` files keep working.
    roots: list[Path] = Field(default_factory=list, validation_alias="locations")

    @field_validator("roots", mode="after")
    @classmethod
    def _expand(cls, value: list[Path]) -> list[Path]:
        return [Path(str(p)).expanduser() for p in value]


class MediaSection(BaseModel):
    """`[media]` — ffmpeg/ffprobe binaries + hardware-encoder knobs.

    Mirrors the flat `MANEKI_*` env vars the transcode path reads directly.
    Values here are the resolved snapshot (env overlaid over TOML by
    `get_settings()`); the runtime hot path still reads `os.environ` itself.
    """

    model_config = ConfigDict(frozen=True, extra="ignore")

    ffmpeg: str | None = None
    ffprobe: str | None = None
    hwenc: str = "auto"
    hwenc_bitrate: str = "6M"
    hwenc_maxrate: str = "8M"
    hwenc_bufsize: str = "12M"
    vaapi_device: str = "/dev/dri/renderD128"


class LoggingSection(BaseModel):
    """`[logging]` — server log level + renderer (mirrors `MANEKI_LOG_*`)."""

    model_config = ConfigDict(frozen=True, extra="ignore")

    level: str = "INFO"
    format: str = "pretty"


# Flat env var -> (section attribute, field) overlay table. Applied last in
# `get_settings()` so env beats TOML for these single-name overrides.
_MEDIA_ENV: dict[str, str] = {
    "MANEKI_FFMPEG": "ffmpeg",
    "MANEKI_FFPROBE": "ffprobe",
    "MANEKI_HWENC": "hwenc",
    "MANEKI_HWENC_BITRATE": "hwenc_bitrate",
    "MANEKI_HWENC_MAXRATE": "hwenc_maxrate",
    "MANEKI_HWENC_BUFSIZE": "hwenc_bufsize",
    "MANEKI_VAAPI_DEVICE": "vaapi_device",
}
_LOG_ENV: dict[str, str] = {
    "MANEKI_LOG_LEVEL": "level",
    "MANEKI_LOG_FORMAT": "format",
}


# ---------------------------------------------------------------------------
# Top-level Settings
# ---------------------------------------------------------------------------


class Settings(BaseSettings):
    """The whole maneki configuration, resolved from TOML + env + defaults."""

    model_config = SettingsConfigDict(
        toml_file=str(config_path()),
        env_prefix="MANEKI_",
        env_nested_delimiter="__",
        extra="ignore",
    )

    libraries: LibrariesSection = Field(default_factory=LibrariesSection)
    users: list[UserAccount] = Field(default_factory=list)
    server: ServerSection = Field(default_factory=ServerSection)
    acoustid: AcoustIDSection = Field(default_factory=AcoustIDSection)
    media: MediaSection = Field(default_factory=MediaSection)
    logging: LoggingSection = Field(default_factory=LoggingSection)

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """Init kwargs > env > TOML > file secrets (TOML between env and secrets)."""
        return (init_settings, env_settings, TomlConfigSettingsSource(settings_cls), file_secret_settings)

    # -- derived user helpers ------------------------------------------------

    def accounts(self) -> list[UserAccount]:
        """The configured accounts.

        If no `[[users]]` are declared, synthesize a single admin from the
        back-compat `[server]` username/password so existing installs keep one
        working account.
        """
        if self.users:
            return list(self.users)
        return [UserAccount(name=self.server.username, password=self.server.password, admin=True)]

    def primary_admin(self) -> UserAccount:
        """The first admin account (or the first account if none are flagged)."""
        accounts = self.accounts()
        return next((u for u in accounts if u.admin), accounts[0])


# ---------------------------------------------------------------------------
# Accessor
# ---------------------------------------------------------------------------


def _overlay_flat_env(settings: Settings) -> Settings:
    """Apply the flat `MANEKI_*` overrides for media/logging/acoustid (env wins)."""
    media_over = {field: os.environ[env] for env, field in _MEDIA_ENV.items() if env in os.environ}
    log_over = {field: os.environ[env] for env, field in _LOG_ENV.items() if env in os.environ}
    acoustid_key = os.environ.get("MANEKI_ACOUSTID_KEY")

    update: dict[str, object] = {}
    if media_over:
        update["media"] = settings.media.model_copy(update=media_over)
    if log_over:
        update["logging"] = settings.logging.model_copy(update=log_over)
    if acoustid_key:
        update["acoustid"] = settings.acoustid.model_copy(update={"api_key": acoustid_key})
    return settings.model_copy(update=update) if update else settings


def _build_settings() -> Settings:
    """Construct Settings from maneki.toml (or the legacy serve.toml fallback)."""
    if config_path().exists():
        return _overlay_flat_env(Settings())
    # Legacy fallback: map serve.toml's server creds into the new shape so a
    # pre-0.11 install still authenticates until `maneki config migrate` runs.
    legacy = legacy_serve_path()
    if legacy.exists():
        try:
            with legacy.open("rb") as f:
                raw = tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError):
            raw = {}
        server_kwargs = {k: raw[k] for k in ("username", "password") if isinstance(raw.get(k), str) and raw[k]}
        if isinstance(raw.get("scrobble"), dict):
            server_kwargs["scrobble"] = raw["scrobble"]
        return _overlay_flat_env(Settings(server=ServerSection(**server_kwargs)))
    return _overlay_flat_env(Settings())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the resolved settings (cached). Call `reset_settings_cache()` to reload."""
    return _build_settings()


def reset_settings_cache() -> None:
    """Drop the cached settings — for tests and after writing the config file."""
    get_settings.cache_clear()
