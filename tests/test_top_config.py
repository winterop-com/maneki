"""Tests for the cross-cutting maneki user config (libraries list)."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from unittest.mock import patch

import pytest

import maneki.config as mk_config


@pytest.fixture
def fake_config(tmp_path: Path) -> Iterator[Path]:
    """Point CONFIG_PATH at a tmp file for the duration of the test."""
    cfg = tmp_path / "maneki.toml"
    with patch.object(mk_config, "CONFIG_PATH", cfg):
        yield cfg


def test_load_returns_empty_when_no_file(fake_config: Path) -> None:
    # File doesn't exist yet
    assert mk_config.load_library_locations() == []


def test_load_returns_empty_when_no_libraries_section(fake_config: Path) -> None:
    fake_config.write_text('[unrelated]\nfoo = "bar"\n', encoding="utf-8")
    assert mk_config.load_library_locations() == []


def test_load_returns_locations_list(fake_config: Path, tmp_path: Path) -> None:
    fake_config.write_text(
        '[libraries]\nlocations = ["/tmp/lib1", "/tmp/lib2"]\n',
        encoding="utf-8",
    )
    locs = mk_config.load_library_locations()
    assert locs == [Path("/tmp/lib1"), Path("/tmp/lib2")]


def test_load_expands_tildes(fake_config: Path) -> None:
    fake_config.write_text(
        '[libraries]\nlocations = ["~/some-lib"]\n',
        encoding="utf-8",
    )
    locs = mk_config.load_library_locations()
    assert locs == [Path.home() / "some-lib"]


def test_coexists_with_audio_config_sections(fake_config: Path) -> None:
    """Top-level loader ignores sections it doesn't own (e.g. audio's [server])."""
    fake_config.write_text(
        '[server]\nusername = "admin"\npassword = "secret"\n\n[libraries]\nlocations = ["/tmp/lib"]\n',
        encoding="utf-8",
    )
    assert mk_config.load_library_locations() == [Path("/tmp/lib")]
