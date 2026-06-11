"""Tests for the unified `maneki serve` factory (audio + video on one port).

The unified app auto-detects which kinds are present at the library
root and mounts only those. There is no kind-toggle flag — pointing
at a root with only audio yields no /video/* routes; only videos yield
no /audio/rest/* routes; mixed yields both.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.audio.serve.config import ServeConfig
from maneki.serve_app import create_combined_app

# Explicit credentials so tests don't depend on (or get polluted by) the
# class-level toml_file cache that other test files mutate.
_TEST_AUDIO_CFG = ServeConfig(username="admin", password="admin")


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    """A library root with both audio and video content (conventional subdirs)."""
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "song.m4a").write_bytes(b"audio")
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "movie.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    return tmp_path


@pytest.fixture
def audio_only_root(tmp_path: Path) -> Path:
    """Library root with audio files but no videos anywhere."""
    (tmp_path / "Music" / "Artist" / "Album").mkdir(parents=True)
    (tmp_path / "Music" / "Artist" / "Album" / "01.flac").write_bytes(b"a" * 64)
    return tmp_path


@pytest.fixture
def video_only_root(tmp_path: Path) -> Path:
    """Library root with video files but no audio anywhere."""
    (tmp_path / "Movies").mkdir()
    (tmp_path / "Movies" / "ep.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 64)
    return tmp_path


def test_capabilities_reports_both_kinds(library_root: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["server"] == "maneki"
    assert data["audio"] is True
    assert data["video"] is True
    assert data["endpoints"]["audio_subsonic"] == "/audio/rest"
    assert data["endpoints"]["video_api"] == "/video/api"


def test_capabilities_video_only_when_no_audio(video_only_root: Path) -> None:
    client = TestClient(create_combined_app(root=video_only_root, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["audio"] is False
    assert data["video"] is True
    assert data["endpoints"]["audio_subsonic"] is None


def test_capabilities_audio_only_when_no_video(audio_only_root: Path) -> None:
    client = TestClient(create_combined_app(root=audio_only_root, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["audio"] is True
    assert data["video"] is False
    # YouTube is a remote source, available regardless of local media; the
    # native app (and its API base) is mounted to host its endpoints.
    assert data["youtube"] is True
    assert data["endpoints"]["video_api"] == "/video/api"


def test_capabilities_empty_root_still_offers_youtube(tmp_path: Path) -> None:
    """A directory with no media still offers YouTube (audio/video both off)."""
    client = TestClient(create_combined_app(root=tmp_path, audio_cfg=_TEST_AUDIO_CFG))
    data = client.get("/capabilities").json()
    assert data["audio"] is False
    assert data["video"] is False
    assert data["youtube"] is True
    assert data["endpoints"]["audio_subsonic"] is None
    assert data["endpoints"]["video_api"] == "/video/api"


def test_local_video_list_empty_when_audio_only(audio_only_root: Path) -> None:
    """Audio-only root: the native app is mounted (for YouTube), but the local
    video listing is empty rather than 404 — the YouTube routes still work."""
    client = TestClient(create_combined_app(root=audio_only_root, audio_cfg=_TEST_AUDIO_CFG))
    resp = client.get("/video/api/videos")
    assert resp.status_code == 200
    assert resp.json() == []


def test_audio_routes_absent_when_video_only(video_only_root: Path) -> None:
    """Pointing at a video-only root means /audio/rest/ping.view must 404."""
    client = TestClient(create_combined_app(root=video_only_root, audio_cfg=_TEST_AUDIO_CFG))
    resp = client.get("/audio/rest/ping.view?u=admin&p=admin&v=1.16.1&c=test&f=json")
    assert resp.status_code == 404


def test_video_endpoints_mounted_under_video_prefix(library_root: Path) -> None:
    client = TestClient(create_combined_app(root=library_root, audio_cfg=_TEST_AUDIO_CFG))
    # List - the one video under videos/ should surface.
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
    assert payload["subsonic-response"]["type"] == "maneki"
