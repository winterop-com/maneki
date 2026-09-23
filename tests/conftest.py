"""Shared pytest fixtures."""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _no_forced_color(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep rich from injecting ANSI codes into captured CLI output.

    Terminals such as Ghostty export `FORCE_COLOR`, which rich honours even
    when stdout is not a TTY. Tests that assert on `result.stdout` substrings
    (`config show` and friends) then fail on colour escapes wrapped around
    the highlighted words. Strip the override for the whole session.
    """
    monkeypatch.delenv("FORCE_COLOR", raising=False)
    monkeypatch.delenv("CLICOLOR_FORCE", raising=False)


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


def require_ffmpeg() -> None:
    """Skip the calling test when ffmpeg or ffprobe is missing."""
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        pytest.skip("ffmpeg / ffprobe not on PATH")


def make_silent_mp3(dst: Path, seconds: float, *, title: str | None = None, album: str | None = None) -> Path:
    """Encode a small silent mono MP3 of `seconds` at `dst`, optionally with title and album tags."""
    require_ffmpeg()
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono"]
    cmd += ["-t", str(seconds), "-c:a", "libmp3lame", "-b:a", "32k"]
    if title:
        cmd += ["-metadata", f"title={title}"]
    if album:
        cmd += ["-metadata", f"album={album}"]
    subprocess.run([*cmd, str(dst)], check=True)
    return dst


def audio_md5(path: Path) -> str:
    """MD5 of the audio stream alone, so a tag rewrite leaves it unchanged."""
    out = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path), "-map", "0:a", "-c", "copy", "-f", "md5", "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def jpeg_bytes(size: int = 1200) -> bytes:
    """A plain square JPEG, larger than the default cover edge so resizing is exercised."""
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (size, size), (200, 40, 40)).save(buffer, format="JPEG")
    return buffer.getvalue()
