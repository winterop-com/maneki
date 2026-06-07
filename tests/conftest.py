"""Shared pytest fixtures."""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path_factory: pytest.TempPathFactory) -> Iterator[None]:
    """Point `get_settings()` at an empty per-test config.

    Without this, `get_settings()` (read by `create_app` / `create_combined_app`
    to decide the user set) would pick up the developer's real
    `~/.config/maneki/maneki.toml` and leak `[[users]]` into unrelated tests,
    and its `lru_cache` would carry config written by one test into the next.
    Tests that need a specific config re-point these themselves.
    """
    from maneki.settings import Settings, reset_settings_cache

    # `Settings()` reads its TOML from `model_config["toml_file"]`; pointing it at
    # a nonexistent per-test file makes `get_settings()` resolve to defaults
    # (no `[[users]]`), regardless of the dev machine's real config. We don't
    # touch `config_dir`/`config_path` so tests of those keep their real values;
    # per-test fixtures that set their own `toml_file` win (set after this).
    empty = tmp_path_factory.mktemp("settings") / "maneki.toml"
    original_toml = Settings.model_config.get("toml_file")
    Settings.model_config["toml_file"] = str(empty)
    reset_settings_cache()
    yield
    Settings.model_config["toml_file"] = original_toml
    reset_settings_cache()


@pytest.fixture(scope="session")
def silent_flac_template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Generate a tiny silent FLAC once per session for tag round-trip tests."""
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not on PATH")
    out = tmp_path_factory.mktemp("flac") / "silent.flac"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-t",
            "0.2",
            "-c:a",
            "flac",
            str(out),
        ],
        check=True,
    )
    return out


@pytest.fixture
def silent_flac(silent_flac_template: Path, tmp_path: Path) -> Path:
    """A fresh, mutable copy of the silent FLAC for one test."""
    dst = tmp_path / "silent.flac"
    shutil.copy2(silent_flac_template, dst)
    return dst


@pytest.fixture(scope="session")
def silent_m4a(silent_flac_template: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Session-scoped silent .m4a converted from the FLAC template.

    Module-scope was the previous shape, but multiple test files calling
    `convert.to_alac` in the same session triggered a libav segfault on
    the second container open. Session-scope means one conversion total
    per pytest run, regardless of how many files use it.
    """
    from maneki.audio import convert as convert_mod

    out = tmp_path_factory.mktemp("silent_m4a") / "silent.m4a"
    convert_mod.to_alac(silent_flac_template, out)
    return out


def make_silent_flac(dst: Path, *, duration: float = 0.2) -> Path:
    """Encode a silent FLAC of `duration` seconds at `dst`. Used for tests
    that need distinct file sizes (e.g. dedup logic that gates on size).
    """
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not on PATH")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=44100:cl=stereo",
            "-t",
            str(duration),
            "-c:a",
            "flac",
            str(dst),
        ],
        check=True,
    )
    return dst
