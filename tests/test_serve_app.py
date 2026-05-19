"""Tests for the unified `mediakit serve` factory (audio + video on one port)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mediakit.audio.serve.config import ServeConfig
from mediakit.serve_app import create_combined_app

# Explicit credentials so tests don't depend on (or get polluted by) the
# class-level toml_file cache that other test files mutate.
_TEST_AUDIO_CFG = ServeConfig(username="admin", password="admin")


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    """A library root with both an audio/ and videos/ subdirectory."""
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "song.m4a").write_bytes(b"audio")
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "movie.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    return tmp_path


def test_capabilities_reports_both_kinds(library_root: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["server"] == "mediakit"
    assert data["audio"] is True
    assert data["video"] is True
    assert data["endpoints"]["audio_subsonic"] == "/audio/rest"
    assert data["endpoints"]["video_api"] == "/video/api"


def test_capabilities_reports_video_only_when_no_audio_dir(tmp_path: Path) -> None:
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "ep.mkv").write_bytes(b"v")
    client = TestClient(create_combined_app(root=tmp_path, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["audio"] is False
    assert data["video"] is True
    assert data["endpoints"]["audio_subsonic"] is None


def test_capabilities_reports_audio_only_when_no_videos_dir(tmp_path: Path) -> None:
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "track.m4a").write_bytes(b"a")
    client = TestClient(create_combined_app(root=tmp_path, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["audio"] is True
    assert data["video"] is False
    assert data["endpoints"]["video_api"] is None


def test_video_only_flag_suppresses_audio_mount(library_root: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, enable_audio=False, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["audio"] is False
    assert data["video"] is True
    # Subsonic ping should NOT be reachable when audio is disabled.
    resp = client.get("/audio/rest/ping.view?u=admin&p=admin&v=1.16.1&c=test&f=json")
    assert resp.status_code == 404


def test_audio_only_flag_suppresses_video_mount(library_root: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, enable_video=False, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["audio"] is True
    assert data["video"] is False
    resp = client.get("/video/api/videos")
    assert resp.status_code == 404


def test_video_endpoints_mounted_under_video_prefix(library_root: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_TEST_AUDIO_CFG))
    # List
    entries = client.get("/video/api/videos").json()
    assert len(entries) == 1
    assert entries[0]["name"] == "movie"
    # Demo page
    resp = client.get("/video/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")


def test_audio_subsonic_mounted_under_audio_rest_prefix(library_root: Path) -> None:
    """The Subsonic ping endpoint should be reachable at /audio/rest/ping.view."""
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_TEST_AUDIO_CFG))
    resp = client.get("/audio/rest/ping.view?u=admin&p=admin&v=1.16.1&c=test&f=json")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["subsonic-response"]["status"] == "ok"
    assert payload["subsonic-response"]["type"] == "mediakit"
