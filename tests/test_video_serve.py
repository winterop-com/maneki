"""Tests for the base video FastAPI app."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.video.serve import create_app


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "ep1.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"A" * 1020)  # 1024 bytes total
    return tmp_path


@pytest.fixture
def client(library_root: Path) -> TestClient:
    return TestClient(create_app(library_root))


def test_scan_status_idle_before_prewarm(client: TestClient) -> None:
    """Without the parent app's lifespan running, the tracker stays idle.

    The endpoint must still return a valid `ScanState` so the SPA's
    poll loop never sees a 404 / 500 — that would lock the progressbar
    in its initial state forever.
    """
    resp = client.get("/api/scan_status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["scanning"] is False
    assert data["phase"] == "idle"
    assert data["scanned"] == 0
    assert data["total"] == 0
    assert data["walked"] == 0


def test_scan_status_reports_done_after_prewarm(library_root: Path) -> None:
    """After running the prewarm helper, the tracker reads `done` + total + walked."""
    import asyncio

    from maneki.video.serve.scan import prewarm_scan

    app = create_app(library_root)
    videos = asyncio.run(prewarm_scan(library_root, app.state.scan_tracker))
    app.state.video_cache = videos

    client = TestClient(app)
    data = client.get("/api/scan_status").json()
    assert data["scanning"] is False
    assert data["phase"] == "done"
    assert data["total"] == 1
    assert data["scanned"] == 1
    # walk_tick should have been called once per file discovered (the
    # walking-phase progress counter the SPA renders before total is
    # known).
    assert data["walked"] == 1
    # Listing endpoints now read from the warm cache.
    assert client.get("/api/videos").json()[0]["name"] == "ep1"


def test_thumbnails_ready_empty_when_cache_cold(client: TestClient) -> None:
    """Fresh server has nothing cached, so /thumbnails/ready returns empty lists."""
    data = client.get("/api/thumbnails/ready").json()
    assert data == {"ready": [], "posters_ready": []}


def test_thumbnails_ready_lists_cached_ids(library_root: Path) -> None:
    """When a thumbnail / poster file lives on disk under the cache, its id appears.

    The endpoint maps live ids -> hashed cache stems and stats each one,
    so the test seeds the cache at the manager's resolved paths and
    primes app.state.video_cache so the endpoint has something to iterate.
    """
    from maneki.video.serve.scan import VideoEntry

    app = create_app(library_root)
    entry: VideoEntry = {
        "id": "abc-12345678",
        "name": "abc",
        "path": str(library_root / "videos" / "ep1.mkv"),
        "size_bytes": 1024,
        "rel_path": "videos/ep1.mkv",
        "duration_s": 10.0,
        "subtitles": [],
    }
    app.state.video_cache = [entry]
    poster_mgr = app.state.poster_manager
    poster_mgr.cache_dir.mkdir(parents=True, exist_ok=True)
    poster_mgr.thumbnail_path("abc-12345678").write_bytes(b"\xff\xd8\xff")
    poster_mgr.poster_path("abc-12345678").write_bytes(b"\x89PNG\r\n\x1a\n")
    client = TestClient(app)
    data = client.get("/api/thumbnails/ready").json()
    assert data == {"ready": ["abc-12345678"], "posters_ready": ["abc-12345678"]}


def test_thumbnail_endpoint_returns_placeholder_on_cache_miss(client: TestClient) -> None:
    """Cache miss => 202 + SVG placeholder + Cache-Control: no-store.

    The SPA renders the SVG into the row icon instantly; the server
    schedules background ffmpeg generation. The next /thumbnails/ready
    poll picks up the new file and triggers a refetch.
    """
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/thumbnail")
    assert resp.status_code == 202
    assert resp.headers["content-type"].startswith("image/svg+xml")
    assert resp.headers.get("cache-control") == "no-store"
    assert b"<svg" in resp.content


def test_scan_endpoint_returns_503_without_trigger(client: TestClient) -> None:
    """The sub-app on its own (no parent lifespan) has no `trigger_rescan`.

    The endpoint should surface that as a 503, not crash or 500. The
    parent app's lifespan attaches `state.trigger_rescan` so this only
    bites tests / direct sub-app users.
    """
    resp = client.post("/api/scan")
    assert resp.status_code == 503
    assert "trigger" in resp.json()["detail"]


def test_scan_endpoint_kicks_rescan_when_wired(library_root: Path) -> None:
    """When the parent lifespan has wired `trigger_rescan`, POST /api/scan calls it."""
    import asyncio as _asyncio

    app = create_app(library_root)
    called: list[bool] = []

    async def fake_trigger() -> None:
        called.append(True)

    app.state.trigger_rescan = fake_trigger
    with TestClient(app) as client:
        resp = client.post("/api/scan")
        assert resp.status_code == 200
        body = resp.json()
        assert body["started"] is True
        # Status snapshot included for the SPA poll-loop fast-path.
        assert "status" in body
        # Give the event loop a tick to run the create_task we kicked.
        _asyncio.run(_asyncio.sleep(0))
    # The fake trigger ran on the loop spawned by TestClient.
    assert called == [True]


def test_cancel_session_when_no_session_is_idempotent(client: TestClient) -> None:
    """Closing the player for a video that never streamed is a no-op (0 cancelled)."""
    entries = client.get("/api/videos").json()
    video_id = entries[0]["id"]
    resp = client.delete(f"/api/videos/{video_id}/session")
    assert resp.status_code == 200
    assert resp.json() == {"cancelled": 0}


def test_capabilities_reports_video_present(client: TestClient) -> None:
    resp = client.get("/capabilities")
    assert resp.status_code == 200
    data = resp.json()
    assert data["server"] == "maneki"
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
