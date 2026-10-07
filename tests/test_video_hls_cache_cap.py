"""The HLS cache cap: least recently used segments are evicted past it."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from maneki.video.serve.hls import EVICT_GRACE_S, HLS_CACHE_VERSION, HLSManager, OnDemandHLS
from maneki.video.serve.transcode_budget import TranscodeBudget

NOW = 1_000_000.0
OLD = NOW - EVICT_GRACE_S - 3600


def _manager(base: Path, max_bytes: int | None) -> HLSManager:
    base.mkdir(parents=True, exist_ok=True)
    (base / ".cache-version").write_text(HLS_CACHE_VERSION, encoding="utf-8")
    return HLSManager(base_dir=base, max_bytes=max_bytes)


def _segment(base: Path, stem: str, idx: int, size: int, used_at: float) -> Path:
    path = base / stem / f"seg-{idx:04d}.ts"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    os.utime(path, (used_at, used_at))
    return path


def test_under_the_cap_nothing_goes(tmp_path: Path) -> None:
    mgr = _manager(tmp_path, max_bytes=1000)
    a = _segment(tmp_path, "a", 0, 400, OLD)
    assert mgr.trim(now=NOW) == 0
    assert a.exists()


def test_over_the_cap_the_least_recently_used_go_first(tmp_path: Path) -> None:
    mgr = _manager(tmp_path, max_bytes=1000)
    oldest = _segment(tmp_path, "a", 0, 400, OLD)
    middle = _segment(tmp_path, "b", 0, 400, OLD + 10)
    newest = _segment(tmp_path, "b", 1, 400, OLD + 20)
    # 1200 bytes against a 1000 cap: trimming to 900 takes the oldest only.
    assert mgr.trim(now=NOW) == 1
    assert not oldest.exists()
    assert middle.exists()
    assert newest.exists()


def test_it_trims_below_the_cap_so_one_new_segment_does_not_trim_again(tmp_path: Path) -> None:
    mgr = _manager(tmp_path, max_bytes=1000)
    for idx in range(5):
        _segment(tmp_path, "a", idx, 250, OLD + idx)
    # 1250 bytes; down to 90% of the cap (900) means two of the five go.
    assert mgr.trim(now=NOW) == 2


def test_what_is_being_watched_is_kept_even_over_the_cap(tmp_path: Path) -> None:
    mgr = _manager(tmp_path, max_bytes=100)
    playing = _segment(tmp_path, "a", 0, 400, NOW - 5)
    assert mgr.trim(now=NOW) == 0
    assert playing.exists()


def test_session_folders_stay_for_the_next_segment(tmp_path: Path) -> None:
    mgr = _manager(tmp_path, max_bytes=10)
    _segment(tmp_path, "a", 0, 400, OLD)
    mgr.trim(now=NOW)
    assert (tmp_path / "a").is_dir()


def test_no_cap_never_evicts(tmp_path: Path) -> None:
    for cap in (None, 0):
        mgr = _manager(tmp_path, max_bytes=cap)
        seg = _segment(tmp_path, "a", 0, 10_000, OLD)
        assert mgr.trim(now=NOW) == 0
        assert seg.exists()


def test_a_cache_hit_marks_the_segment_used(tmp_path: Path) -> None:
    source = tmp_path / "video.mkv"
    source.write_bytes(b"")
    session = OnDemandHLS("vid", source, 60.0, tmp_path / "sess", TranscodeBudget())
    cached = _segment(tmp_path, "sess", 0, 10, OLD)

    asyncio.run(session.ensure_segment(0))

    assert cached.stat().st_mtime > OLD + 3600


def test_a_written_segment_over_the_cap_sets_off_a_trim(tmp_path: Path) -> None:
    mgr = _manager(tmp_path, max_bytes=1000)
    _segment(tmp_path, "a", 0, 800, OLD)
    mgr.trim(now=NOW)  # measures the cache: 800 bytes, under the cap
    fresh = _segment(tmp_path, "a", 1, 400, OLD + 1)

    async def write() -> None:
        mgr.note_written(fresh)
        assert mgr._trim_task is not None
        await mgr._trim_task

    asyncio.run(write())
    assert not (tmp_path / "a" / "seg-0000.ts").exists()
