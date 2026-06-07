"""Tests for HLS endpoint routing + manifest planning (no real ffmpeg run)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.video.serve import create_app
from maneki.video.serve.hls import (
    HLS_PREFETCH_AHEAD,
    SEG_LEN,
    OnDemandHLS,
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


# --- Forward-prefetch -------------------------------------------------------


def _session(tmp_path: Path) -> OnDemandHLS:
    # 600s @ 6s segments = 100 segments; no real file needed (we never run
    # ffmpeg here — only the prefetch bookkeeping is exercised).
    return OnDemandHLS(
        video_id="vid",
        input_path=tmp_path / "movie.mkv",
        duration_s=600.0,
        session_dir=tmp_path,
        budget=TranscodeBudget(),
    )


def test_prefetch_neighbors_fans_out_forward(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """prefetch_neighbors warms idx+1..idx+N (forward look-ahead) plus idx-1."""
    sess = _session(tmp_path)
    warmed: list[int] = []
    monkeypatch.setattr(sess, "_prefetch_one", warmed.append)

    sess.prefetch_neighbors(20)

    # idx+1..idx+HLS_PREFETCH_AHEAD in order, then the single backward neighbour.
    assert warmed == [*range(21, 21 + HLS_PREFETCH_AHEAD), 19]
    assert sum(1 for w in warmed if w > 20) == HLS_PREFETCH_AHEAD


def test_prefetch_depth_stays_within_active_window(tmp_path: Path) -> None:
    """The forward depth must fit the note_active window or it cancels itself."""
    from maneki.video.serve import hls as hls_mod

    assert HLS_PREFETCH_AHEAD <= hls_mod._ACTIVE_AHEAD


async def test_note_active_cancels_lookahead_outside_active_window(tmp_path: Path) -> None:
    """A seek cancels prefetch tasks the playhead has moved away from."""
    sess = _session(tmp_path)

    async def sleeper() -> None:
        await asyncio.sleep(10)

    inside = {19: asyncio.create_task(sleeper()), 25: asyncio.create_task(sleeper())}
    outside = {10: asyncio.create_task(sleeper()), 40: asyncio.create_task(sleeper())}
    sess._prefetch_tasks.update(inside)
    sess._prefetch_tasks.update(outside)

    sess.note_active(20)  # active window [20-2, 20+8] = [18, 28]
    await asyncio.sleep(0.02)  # let the cancellations propagate

    assert all(t.cancelled() for t in outside.values())
    assert not any(t.cancelled() for t in inside.values())
    for t in inside.values():
        t.cancel()


# --- HW-encode fallback vs. signal-kill -------------------------------------


class _FakeProc:
    def __init__(self, returncode: int, stderr: bytes = b"") -> None:
        self.returncode = returncode
        self._stderr = stderr

    async def communicate(self) -> tuple[bytes, bytes]:
        return (b"", self._stderr)


def _hw_session(tmp_path: Path) -> OnDemandHLS:
    sess = OnDemandHLS("vid", tmp_path / "movie.mkv", 600.0, tmp_path / "sess", TranscodeBudget())
    sess._encoder = "h264_videotoolbox"  # pretend a HW encoder was selected
    sess._hdr = False
    return sess


async def test_signal_killed_ffmpeg_is_cancel_not_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A negative returncode (Ctrl+C / shutdown) is a cancel, not an encode
    failure: no HW->software downgrade, no scary 'encode failed' warning."""
    sess = _hw_session(tmp_path)

    async def fake_exec(*_a: object, **_k: object) -> _FakeProc:
        # -2 == killed by SIGINT (the server shutting down mid-prefetch).
        return _FakeProc(-2, b"[h264_videotoolbox] Color range not set for yuv420p. Using MPEG range.")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    with pytest.raises(asyncio.CancelledError):
        await sess._transcode_segment(0)
    # The session must NOT have been downgraded by a mere signal-kill.
    assert sess._encoder == "h264_videotoolbox"


async def test_genuine_hw_failure_falls_back_to_software(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A real non-zero exit (positive rc) downgrades the session to libx264."""
    sess = _hw_session(tmp_path)

    async def fake_exec(*_a: object, **_k: object) -> _FakeProc:
        return _FakeProc(1, b"Error initializing output stream: some real failure")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    # First attempt (HW) fails -> downgrade -> retry (also fails under libx264
    # via the same fake) -> RuntimeError. The point is the downgrade happened.
    with pytest.raises(RuntimeError):
        await sess._transcode_segment(0)
    assert sess._encoder == "libx264"
