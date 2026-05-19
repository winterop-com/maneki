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


def test_stream_range_suffix_returns_last_N_bytes(client: TestClient) -> None:
    """`Range: bytes=-N` is RFC 7233 suffix - the LAST N bytes, not 0..N.

    Clients that probe the moov atom at the file tail (mpv, exoplayer,
    some media probes) depend on this. Treating it as a prefix range
    (the old behaviour) returned the wrong bytes and broke seeking.
    """
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=-100"})
    assert resp.status_code == 206
    # Last 100 bytes of a 1024-byte file = bytes 924..1023
    assert resp.headers["content-range"] == "bytes 924-1023/1024"
    assert resp.headers["content-length"] == "100"
    assert len(resp.content) == 100


def test_stream_range_suffix_larger_than_file_clamps(client: TestClient) -> None:
    """Asking for more suffix bytes than the file has returns the whole file (start clamped to 0)."""
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=-99999"})
    assert resp.status_code == 206
    assert resp.headers["content-range"] == "bytes 0-1023/1024"
    assert resp.headers["content-length"] == "1024"


def test_stream_range_zero_suffix_is_416(client: TestClient) -> None:
    """`bytes=-0` is malformed (RFC says the suffix length must be > 0)."""
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=-0"})
    assert resp.status_code == 416


def test_stream_out_of_bounds_range_is_416(client: TestClient) -> None:
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/stream", headers={"Range": "bytes=999999-"})
    assert resp.status_code == 416


def test_stream_unknown_id_is_404(client: TestClient) -> None:
    resp = client.get("/api/videos/does-not-exist/stream")
    assert resp.status_code == 404


def test_demo_page_served_at_root(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    body = resp.text
    # Sanity-check that the key DOM hooks the page's JS relies on are present.
    assert 'id="caps"' in body
    assert 'id="picker"' in body
    assert 'id="player"' in body
    assert "/api/videos" in body  # JS hits this endpoint


def test_play_unknown_id_is_404(client: TestClient) -> None:
    resp = client.get("/api/videos/does-not-exist/play")
    assert resp.status_code == 404


def test_play_returns_503_when_ffmpeg_missing(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """If ffmpeg is not on PATH, /play surfaces a 503 rather than crashing."""
    import shutil

    monkeypatch.setattr(shutil, "which", lambda _: None)
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/play")
    assert resp.status_code == 503
    assert "ffmpeg" in resp.json()["detail"]
