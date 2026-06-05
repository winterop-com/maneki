"""Tests for the video transcode-stats snapshot + SSE stream."""

from __future__ import annotations

import json
import time
from pathlib import Path

from maneki.video.serve import create_app
from maneki.video.serve.app import build_video_stats
from maneki.video.serve.hls import HLSManager, OnDemandHLS
from maneki.video.serve.transcode_budget import TranscodeBudget


def _session(tmp_path: Path, vid: str, dur: float = 600.0) -> OnDemandHLS:
    return OnDemandHLS(vid, tmp_path / "in.mkv", dur, tmp_path / f"sess_{vid}", TranscodeBudget())


def test_session_stats_reports_realtime_ratio(tmp_path: Path) -> None:
    """realtime_ratio = transcode seconds / SEG_LEN; avg across the ring buffer."""
    session = _session(tmp_path, "v")
    session._record_transcode(0, 3.0, low_priority=False)  # noqa: SLF001 - 3s/6s = 0.5
    session._record_transcode(1, 9.0, low_priority=True)  # noqa: SLF001 - 9s/6s = 1.5 (falling behind)

    st = session.stats(now=time.monotonic())
    assert st.transcodes_done == 2
    assert st.recent[0].realtime_ratio == 0.5
    assert st.recent[1].realtime_ratio == 1.5
    assert st.recent[1].low_priority is True
    assert st.avg_realtime_ratio == 1.0


def test_session_stats_no_transcodes_yet(tmp_path: Path) -> None:
    """A session that never transcoded reports no average and a sentinel idle."""
    st = _session(tmp_path, "v").stats(now=time.monotonic())
    assert st.transcodes_done == 0
    assert st.avg_realtime_ratio is None
    assert st.recent == []
    assert st.idle_seconds == -1.0


def test_build_video_stats_filters_to_active_sessions(tmp_path: Path) -> None:
    """Only sessions active within the window appear; never-active are dropped."""
    budget = TranscodeBudget()
    mgr = HLSManager(base_dir=tmp_path / "hls", budget=budget)
    now = 1000.0  # arbitrary clock; build_video_stats only does arithmetic
    active = _session(tmp_path, "active")
    active._last_activity = now - 5.0  # noqa: SLF001 - inside the 30s window
    stale = _session(tmp_path, "stale")
    stale._last_activity = now - 100.0  # noqa: SLF001 - outside the window
    never = _session(tmp_path, "never")  # _last_activity stays 0.0
    mgr.sessions = {"active": active, "stale": stale, "never": never}

    resp = build_video_stats(mgr, budget, now=now)

    assert {s.video_id for s in resp.sessions} == {"active"}
    assert resp.seg_len == 6.0
    assert resp.budget.max_workers >= 1


def test_stats_frame_serializes_to_sse_payload(tmp_path: Path) -> None:
    """The JSON the SSE generator yields per frame has the expected shape.

    (The live infinite stream is exercised end-to-end in the browser; an
    in-process ASGI transport buffers an endless stream and can't be unit
    tested without hanging, so we assert the frame contract here.)
    """
    budget = TranscodeBudget()
    mgr = HLSManager(base_dir=tmp_path / "hls", budget=budget)
    payload = json.loads(build_video_stats(mgr, budget, now=1000.0).model_dump_json())
    assert payload["seg_len"] == 6.0
    assert payload["sessions"] == []
    assert set(payload["budget"]) >= {"max_workers", "foreground_in_flight", "background_in_flight"}


def test_stats_stream_route_is_registered(tmp_path: Path) -> None:
    """The SSE endpoint is wired at the expected path."""
    (tmp_path / "movie.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    app = create_app(tmp_path)
    paths = {getattr(route, "path", None) for route in app.routes}
    assert "/api/stats/stream" in paths
