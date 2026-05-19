"""Tests for the --ui SPA mount on the unified server."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mediakit.audio.serve.config import ServeConfig
from mediakit.serve_app import create_combined_app

_CFG = ServeConfig(username="admin", password="admin")


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    (tmp_path / "audio").mkdir()
    return tmp_path


@pytest.fixture
def fake_spa(tmp_path: Path) -> Path:
    spa = tmp_path / "spa-dist"
    spa.mkdir()
    (spa / "index.html").write_text("<html><body><div id=root></div></body></html>", encoding="utf-8")
    (spa / "assets").mkdir()
    (spa / "assets" / "app.js").write_text("console.log('hi')", encoding="utf-8")
    return spa


def test_ui_disabled_by_default(library_root: Path) -> None:
    """Without --ui, hitting /ui/ should 404 rather than leaking files."""
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_CFG))
    assert client.get("/ui/").status_code == 404


def test_ui_serves_index_when_enabled(library_root: Path, fake_spa: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_CFG, enable_ui=True, ui_dir=fake_spa))
    resp = client.get("/ui/")
    assert resp.status_code == 200
    assert "id=root" in resp.text


def test_ui_serves_asset_files(library_root: Path, fake_spa: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_CFG, enable_ui=True, ui_dir=fake_spa))
    resp = client.get("/ui/assets/app.js")
    assert resp.status_code == 200
    assert resp.text == "console.log('hi')"


def test_ui_raises_when_bundle_missing(library_root: Path, tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist"
    with pytest.raises(RuntimeError, match="--ui requested"):
        create_combined_app(root=library_root, audio_cfg=_CFG, enable_ui=True, ui_dir=missing)


def test_api_routes_unaffected_by_ui_mount(library_root: Path, fake_spa: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_CFG, enable_ui=True, ui_dir=fake_spa))
    # /capabilities is an explicit route - takes precedence over the static mount
    resp = client.get("/capabilities")
    assert resp.status_code == 200
    assert resp.json()["server"] == "mediakit"
