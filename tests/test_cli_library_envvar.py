"""MANEKI_LIBRARY env var fills the library-root argument when omitted."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from maneki.cli import app


def test_info_reads_root_from_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_LIBRARY", str(tmp_path))
    result = CliRunner().invoke(app, ["info"])  # no positional root
    assert result.exit_code == 0
    assert tmp_path.name in result.stdout


def test_info_without_root_or_env_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MANEKI_LIBRARY", raising=False)
    result = CliRunner().invoke(app, ["info"])
    # Click's usage-error exit code for a missing required argument.
    assert result.exit_code == 2


def test_explicit_root_beats_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.setenv("MANEKI_LIBRARY", str(tmp_path / "from_env"))  # nonexistent
    # An explicit valid path is used even though the env points elsewhere.
    result = CliRunner().invoke(app, ["info", str(other)])
    assert result.exit_code == 0
    assert "from_env" not in result.stdout
