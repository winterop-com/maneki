"""Consolidated `Settings`: env aliases, TOML, user accounts, precedence."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from maneki import settings as settings_mod
from maneki.settings import Settings, get_settings, reset_settings_cache


@pytest.fixture(autouse=True)
def _isolate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Point the config at a temp file + clear the cache around each test."""
    cfg = tmp_path / "maneki.toml"
    monkeypatch.setattr(settings_mod, "config_path", lambda: cfg)
    # TomlConfigSettingsSource reads the path from model_config, bound at class
    # definition to the real home — repoint it at the temp file for the test.
    Settings.model_config["toml_file"] = str(cfg)
    # Drop any MANEKI_* env the host shell set so tests are deterministic.
    for key in [k for k in os.environ if k.startswith("MANEKI_")]:
        monkeypatch.delenv(key, raising=False)
    reset_settings_cache()
    yield
    reset_settings_cache()


def test_defaults_no_config() -> None:
    s = get_settings()
    assert s.server.username == "admin"
    assert s.media.hwenc == "auto"
    assert s.media.vaapi_device == "/dev/dri/renderD128"
    assert s.logging.level == "INFO"
    assert s.users == []


def test_flat_media_env_aliases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_FFMPEG", "/opt/ff/ffmpeg")
    monkeypatch.setenv("MANEKI_HWENC", "vaapi")
    monkeypatch.setenv("MANEKI_HWENC_BITRATE", "9M")
    monkeypatch.setenv("MANEKI_LOG_LEVEL", "DEBUG")
    reset_settings_cache()
    s = get_settings()
    assert s.media.ffmpeg == "/opt/ff/ffmpeg"
    assert s.media.hwenc == "vaapi"
    assert s.media.hwenc_bitrate == "9M"
    assert s.logging.level == "DEBUG"


def test_nested_server_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_SERVER__USERNAME", "alice")
    monkeypatch.setenv("MANEKI_SERVER__PASSWORD", "secret")
    reset_settings_cache()
    s = get_settings()
    assert s.server.username == "alice"
    assert s.server.password == "secret"


def test_acoustid_flat_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_ACOUSTID_KEY", "abc123")
    reset_settings_cache()
    assert get_settings().acoustid.api_key == "abc123"


def test_users_from_toml(tmp_path: Path) -> None:
    cfg = tmp_path / "maneki.toml"
    cfg.write_text(
        '[[users]]\nname = "alice"\npassword = "a"\nadmin = true\n\n[[users]]\nname = "bob"\npassword = "b"\n',
        encoding="utf-8",
    )
    reset_settings_cache()
    s = get_settings()
    assert [u.name for u in s.users] == ["alice", "bob"]
    assert s.users[0].admin is True
    assert s.users[1].admin is False
    assert s.primary_admin().name == "alice"


def test_accounts_backcompat_from_server() -> None:
    # No [[users]] -> one admin synthesized from [server].
    s = get_settings()
    accts = s.accounts()
    assert len(accts) == 1
    assert accts[0].name == "admin"
    assert accts[0].admin is True


def test_env_beats_toml_for_media(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = tmp_path / "maneki.toml"
    cfg.write_text('[media]\nhwenc = "videotoolbox"\n', encoding="utf-8")
    reset_settings_cache()
    assert get_settings().media.hwenc == "videotoolbox"  # from TOML
    monkeypatch.setenv("MANEKI_HWENC", "none")
    reset_settings_cache()
    assert get_settings().media.hwenc == "none"  # env overrides TOML
