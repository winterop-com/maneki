"""Tests for the base video FastAPI app."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mediakit.video.serve import create_app


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "ep1.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"A" * 1020)  # 1024 bytes total
    return tmp_path


@pytest.fixture
def client(library_root: Path) -> TestClient:
    return TestClient(create_app(library_root))


def test_capabilities_reports_video_present(client: TestClient) -> None:
    resp = client.get("/capabilities")
    assert resp.status_code == 200
    data = resp.json()
    assert data["server"] == "mediakit"
    assert data["audio"] is False
    assert data["video"] is True
    assert data["video_count"] == 1


def test_capabilities_reports_no_video_when_empty(tmp_path: Path) -> None:
    client = TestClient(create_app(tmp_path))
    data = client.get("/capabilities").json()
    assert data["video"] is False
    assert data["video_count"] == 0


def test_list_videos_returns_entries(client: TestClient) -> None:
    resp = client.get("/api/videos")
    assert resp.status_code == 200
    entries = resp.json()
    assert len(entries) == 1
    assert entries[0]["name"] == "ep1"
    assert entries[0]["size_bytes"] == 1024


def test_stream_full_file(client: TestClient, library_root: Path) -> None:
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/stream")
    assert resp.status_code == 200
    assert resp.headers["accept-ranges"] == "bytes"
    assert resp.content == (library_root / "videos" / "ep1.mkv").read_bytes()


def test_stream_range_partial(client: TestClient) -> None:
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=0-3"})
    assert resp.status_code == 206
    assert resp.headers["content-range"] == "bytes 0-3/1024"
    assert resp.headers["content-length"] == "4"
    assert resp.content == b"\x1a\x45\xdf\xa3"  # MKV EBML magic


def test_stream_range_suffix_and_mid(client: TestClient) -> None:
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    # Mid-file slice
    resp = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=100-199"})
    assert resp.status_code == 206
    assert resp.headers["content-range"] == "bytes 100-199/1024"
    assert len(resp.content) == 100


def test_stream_out_of_bounds_range_is_416(client: TestClient) -> None:
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=999999-"})
    assert resp.status_code == 416


def test_stream_unknown_id_is_404(client: TestClient) -> None:
    resp = client.get("/api/videos/does-not-exist/stream")
    assert resp.status_code == 404
