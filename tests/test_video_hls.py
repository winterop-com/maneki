"""Tests for HLS endpoint routing + manifest planning (no real ffmpeg run)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.video.serve import create_app
from maneki.video.serve.hls import (
    HLS_PREFETCH_AHEAD,
    SEG_LEN,
    OnDemandHLS,
    _video_codec_args,
    build_manifest,
    plan_segments,
)
from maneki.video.serve.transcode_budget import TranscodeBudget


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
    # ID format includes a stable hash suffix - fetch it from the list
    # rather than hard-coding.
    video_id = client.get("/api/videos").json()[0]["id"]
    resp = client.get(f"/api/videos/{video_id}/hls/index.m3u8")
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


def test_video_codec_args_hardware_uses_videotoolbox() -> None:
    decode, encode = _video_codec_args(hw=True)
    assert decode == ["-hwaccel", "videotoolbox"]
    assert "h264_videotoolbox" in encode
    assert "libx264" not in encode


def test_video_codec_args_software_uses_libx264() -> None:
    decode, encode = _video_codec_args(hw=False)
    assert decode == []
    assert "libx264" in encode
    assert "h264_videotoolbox" not in encode


def test_prefetch_neighbors_warms_forward_window(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """prefetch_neighbors warms HLS_PREFETCH_AHEAD segments ahead + one behind.

    The forward window is what keeps the player's ~30s buffer landing on a
    warm cache over a high-latency link instead of cold on-demand transcodes.
    """
    session = OnDemandHLS(
        "vid",
        tmp_path / "in.mkv",
        duration_s=600.0,
        session_dir=tmp_path / "sess",
        budget=TranscodeBudget(),
    )
    warmed: list[int] = []
    monkeypatch.setattr(session, "_prefetch_one", warmed.append)

    session.prefetch_neighbors(10)

    forward = list(range(11, 11 + HLS_PREFETCH_AHEAD))
    assert warmed == [*forward, 9]
