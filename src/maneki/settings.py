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
import re
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


# ---------------------------------------------------------------------------
# `maneki config` helpers: summary + scaffold
# ---------------------------------------------------------------------------


def _mask(value: str | None) -> str:
    """Render a secret as `'****'` while distinguishing unset / empty."""
    if value is None:
        return "(unset)"
    if value == "":
        return "''"
    return "'****'"


def render_settings_summary(s: Settings) -> str:
    """Format the resolved settings for `maneki config show` (secrets masked)."""
    lines: list[str] = []
    lines.append("[libraries]")
    lines.append(f"  roots = {[str(p) for p in s.libraries.roots]}")
    lines.append("")
    lines.append(f"users ({len(s.accounts())}):")
    for u in s.accounts():
        flag = " (admin)" if u.admin else ""
        lines.append(f"  - {u.name}{flag}  password = {_mask(u.password)}")
    if not s.users:
        lines.append("  (synthesized from [server] — no [[users]] defined)")
    lines.append("")
    lines.append("[acoustid]")
    lines.append(f"  api_key = {_mask(s.acoustid.api_key)}")
    lines.append("")
    lines.append("[media]")
    lines.append(f"  ffmpeg = {s.media.ffmpeg or '(PATH)'}")
    lines.append(f"  ffprobe = {s.media.ffprobe or '(PATH)'}")
    lines.append(f"  hwenc = {s.media.hwenc!r}")
    lines.append(f"  vaapi_device = {s.media.vaapi_device!r}")
    lines.append("")
    lines.append("[logging]")
    lines.append(f"  level = {s.logging.level!r}   format = {s.logging.format!r}")
    lines.append("")
    lines.append(f"file: {config_path()}")
    lines.append(f"  exists: {config_path().exists()}")
    if legacy_serve_path().exists():
        lines.append(f"  legacy: {legacy_serve_path()} (run `maneki config migrate`)")
    env = sorted(k for k in os.environ if k.startswith("MANEKI_"))
    lines.append("")
    lines.append("env overrides set:")
    lines.extend(f"  {k} = {_mask(os.environ[k])}" for k in env) if env else lines.append("  (none)")
    return "\n".join(lines)


STARTER_TOML = """\
# maneki configuration — one file for every setting.
# Docs: https://winterop-com.github.io/maneki/
#
# Precedence (highest first): CLI flag > MANEKI_* env var > this file > default.
# This file may hold PLAINTEXT passwords (Subsonic auth needs them recoverable),
# so keep it private:  chmod 600 maneki.toml

# --- Library roots ----------------------------------------------------------
# Directories maneki scans recursively (audio + video). `maneki serve <root>`
# or MANEKI_LIBRARY override this.
# [libraries]
# locations = ["~/Music", "/Volumes/NAS/media"]

# --- User accounts ----------------------------------------------------------
# One block per person; each gets their own login + favourites / playlists /
# history. `admin = true` may manage other users. Passwords are plaintext.
# [[users]]
# name = "alice"
# password = "change-me"
# admin = true
#
# [[users]]
# name = "bob"
# password = "change-me"

# --- Single-user fallback ---------------------------------------------------
# Used only when no [[users]] are defined above. Defaults to admin/admin with a
# startup warning — change this (or add [[users]]) before exposing the server.
[server]
username = "admin"
password = "admin"

# Optional play-event forwarding (e.g. Home Assistant):
# [server.scrobble.webhook]
# url = "https://example.invalid/hook"
# [server.scrobble.mqtt]
# broker = "mqtt://homeassistant:1883"

# --- AcoustID ---------------------------------------------------------------
# Key for `maneki audio convert --enrich` fingerprinting (free at acoustid.org).
# [acoustid]
# api_key = "..."

# --- Media / transcoding ----------------------------------------------------
# Override ffmpeg/ffprobe + the H.264 hardware encoder. Each field also has a
# MANEKI_* env override (MANEKI_FFMPEG, MANEKI_HWENC, MANEKI_VAAPI_DEVICE, ...).
# [media]
# ffmpeg = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
# ffprobe = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe"
# hwenc = "auto"            # auto | vaapi | videotoolbox | none
# hwenc_bitrate = "6M"
# vaapi_device = "/dev/dri/renderD128"

# --- Logging ----------------------------------------------------------------
# [logging]
# level = "INFO"           # DEBUG | INFO | WARNING | ERROR
# format = "pretty"        # pretty | json
"""


# Matches a `[[users]]` block: the header line + the `key = value` lines under
# it, stopping at the next `[`-anchored table header (or EOF). Anchored on
# line-start `[` so a `[` inside a password value doesn't truncate the block.
_USERS_BLOCK_RE = re.compile(r"(?m)^\[\[users\]\][ \t]*\n(?:^(?!\[).*\n?)*")


def _user_to_toml_dict(u: UserAccount) -> dict[str, object]:
    d: dict[str, object] = {"name": u.name, "password": u.password}
    if u.admin:
        d["admin"] = True
    return d


def write_users(users: list[UserAccount]) -> Path:
    """Rewrite the `[[users]]` blocks in `maneki.toml`, preserving everything else.

    Strips the existing `[[users]]` blocks (comments inside them included) and
    appends freshly-rendered ones; the rest of the file — other sections,
    comments, nested scrobble — is left untouched. Drops the settings cache.
    """
    from maneki.audio import _toml_dump

    path = config_path()
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    text = _USERS_BLOCK_RE.sub("", text).rstrip()
    if users:
        blocks = _toml_dump.dumps({"users": [_user_to_toml_dict(u) for u in users]}).strip()
        text = f"{text}\n\n{blocks}\n" if text else f"{blocks}\n"
    elif text:
        text += "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    reset_settings_cache()
    return path


def write_starter_config(path: Path | None = None, *, force: bool = False) -> Path:
    """Write the commented starter `maneki.toml`. Raises `FileExistsError` unless `force`.

    Returns the path written. Creates the parent directory as needed.
    """
    target = path or config_path()
    if target.exists() and not force:
        raise FileExistsError(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(STARTER_TOML, encoding="utf-8")
    return target
