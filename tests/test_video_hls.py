"""Tests for HLS endpoint routing + manifest planning (no real ffmpeg run)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mediakit.video.serve import create_app
from mediakit.video.serve.hls import (
    SEG_LEN,
    build_manifest,
    plan_segments,
)


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    # Single video at the library root - no subdir convention.
    (tmp_path / "movie.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    return tmp_path


@pytest.fixture
def client(library_root: Path) -> TestClient:
    return TestClient(create_app(library_root))


def test_hls_unknown_id_is_404(client: TestClient) -> None:
    resp = client.get("/api/videos/does-not-exist/hls/index.m3u8")
    assert resp.status_code == 404


def test_hls_rejects_path_traversal(client: TestClient) -> None:
    resp = client.get("/api/videos/movie/hls/.hidden")
    assert resp.status_code == 400


def test_hls_503_when_ffmpeg_missing(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    import shutil

    monkeypatch.setattr(shutil, "which", lambda _: None)
    resp = client.get("/api/videos/movie/hls/index.m3u8")
    assert resp.status_code == 503
    assert "ffmpeg" in resp.json()["detail"]


def test_plan_segments_chops_evenly() -> None:
    plan = plan_segments(30.0, seg_len=6.0)
    assert [s.index for s in plan] == [0, 1, 2, 3, 4]
    assert all(s.duration_s == 6.0 for s in plan)
    assert [s.start_s for s in plan] == [0.0, 6.0, 12.0, 18.0, 24.0]


def test_plan_segments_handles_remainder() -> None:
    plan = plan_segments(14.5, seg_len=6.0)
    assert len(plan) == 3
    assert plan[-1].duration_s == pytest.approx(2.5)


def test_plan_segments_empty_for_zero_duration() -> None:
    assert plan_segments(0) == []
    assert plan_segments(-5) == []


def test_build_manifest_is_vod_with_endlist() -> None:
    plan = plan_segments(18.0, seg_len=6.0)
    text = build_manifest(plan, seg_len=6.0)
    assert text.startswith("#EXTM3U")
    assert "#EXT-X-PLAYLIST-TYPE:VOD" in text
    assert "seg-0000.ts" in text
    assert "seg-0002.ts" in text
    assert text.rstrip().endswith("#EXT-X-ENDLIST")
    # MPEG-TS segments are self-contained, so no #EXT-X-MAP init reference.
    assert "#EXT-X-MAP" not in text


def test_build_manifest_target_duration_rounds_up() -> None:
    text = build_manifest(plan_segments(10.0, seg_len=SEG_LEN), seg_len=SEG_LEN)
    assert "#EXT-X-TARGETDURATION:6" in text
