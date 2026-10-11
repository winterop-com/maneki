"""`maneki serve` requires sign-in unless told otherwise."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import uvicorn
from typer.testing import CliRunner

import maneki.serve_app
from maneki.cli import app


def _serve(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, *flags: str) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    def fake_app(**kwargs: Any) -> object:
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(maneki.serve_app, "create_combined_app", fake_app)
    monkeypatch.setattr(uvicorn, "run", lambda *_a, **_k: None)
    result = CliRunner().invoke(app, ["serve", str(tmp_path), *flags])
    assert result.exit_code == 0, result.output
    return seen


def test_serve_requires_sign_in_by_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Without it the video and book APIs answered anyone on the network, and every account's
    positions landed on the first admin."""
    assert _serve(monkeypatch, tmp_path)["enable_auth"] is True


def test_no_auth_opts_out(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert _serve(monkeypatch, tmp_path, "--no-auth")["enable_auth"] is False
