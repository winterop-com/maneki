"""Tests for orphan cleanup across the three video caches."""

from __future__ import annotations

from pathlib import Path

from mediakit.video.serve.hls import HLS_CACHE_VERSION, HLSManager
from mediakit.video.serve.poster import PosterManager
from mediakit.video.serve.subtitles import SubtitleCache


def _pre_seed_hls_marker(base: Path) -> None:
    """Write the current HLS_CACHE_VERSION marker so the manager's init
    skip the version-mismatch wipe (which would otherwise destroy the
    test fixtures before clean_orphans even runs)."""
    base.mkdir(parents=True, exist_ok=True)
    (base / ".cache-version").write_text(HLS_CACHE_VERSION, encoding="utf-8")


def test_poster_cleanup_keeps_live_drops_orphans(tmp_path: Path) -> None:
    """Files for live ids stay; files for orphan ids are deleted."""
    mgr = PosterManager(cache_dir=tmp_path)
    tmp_path.mkdir(exist_ok=True)
    (tmp_path / "alive.png").write_bytes(b"x")
    (tmp_path / "alive.thumb.jpg").write_bytes(b"x")
    (tmp_path / "gone.png").write_bytes(b"x")
    (tmp_path / "gone.thumb.jpg").write_bytes(b"x")
    (tmp_path / "noise.txt").write_text("unrelated")

    removed = mgr.clean_orphans({"alive"})

    assert removed == 2
    assert (tmp_path / "alive.png").exists()
    assert (tmp_path / "alive.thumb.jpg").exists()
    assert not (tmp_path / "gone.png").exists()
    assert not (tmp_path / "gone.thumb.jpg").exists()
    # Unrelated files in the cache dir are left alone.
    assert (tmp_path / "noise.txt").exists()


def test_poster_cleanup_no_cache_dir(tmp_path: Path) -> None:
    """Pointing at a non-existent dir is a safe no-op."""
    mgr = PosterManager(cache_dir=tmp_path / "missing")
    assert mgr.clean_orphans({"anything"}) == 0


def test_hls_cleanup_removes_orphan_session_dirs(tmp_path: Path) -> None:
    _pre_seed_hls_marker(tmp_path)
    mgr = HLSManager(base_dir=tmp_path)
    (tmp_path / "alive").mkdir()
    (tmp_path / "alive" / "seg-0000.ts").write_bytes(b"x")
    (tmp_path / "gone").mkdir()
    (tmp_path / "gone" / "seg-0000.ts").write_bytes(b"x")

    removed = mgr.clean_orphans({"alive"})

    assert removed == 1
    assert (tmp_path / "alive").exists()
    assert not (tmp_path / "gone").exists()


def test_hls_cleanup_drops_stale_in_memory_session(tmp_path: Path) -> None:
    """Sessions for orphan ids are also evicted from the manager dict."""
    _pre_seed_hls_marker(tmp_path)
    mgr = HLSManager(base_dir=tmp_path)
    (tmp_path / "gone").mkdir()
    fake_session = object()
    mgr.sessions["gone"] = fake_session  # type: ignore[assignment]

    mgr.clean_orphans({"alive"})

    assert "gone" not in mgr.sessions


def test_subtitle_cleanup_removes_orphan_dirs(tmp_path: Path) -> None:
    cache = SubtitleCache(cache_dir=tmp_path)
    (tmp_path / "alive").mkdir()
    (tmp_path / "alive" / "embed-2.vtt").write_text("WEBVTT")
    (tmp_path / "gone").mkdir()
    (tmp_path / "gone" / "embed-2.vtt").write_text("WEBVTT")

    removed = cache.clean_orphans({"alive"})

    assert removed == 1
    assert (tmp_path / "alive").exists()
    assert not (tmp_path / "gone").exists()


def test_all_three_caches_clean_orphans(tmp_path: Path) -> None:
    """Same `live_ids` set works for all three cache types."""
    poster_dir = tmp_path / "posters"
    hls_dir = tmp_path / "hls"
    subs_dir = tmp_path / "subs"
    poster_dir.mkdir()
    hls_dir.mkdir()
    subs_dir.mkdir()

    (poster_dir / "keep.png").write_bytes(b"x")
    (poster_dir / "drop.png").write_bytes(b"x")
    (hls_dir / "keep").mkdir()
    (hls_dir / "drop").mkdir()
    (subs_dir / "keep").mkdir()
    (subs_dir / "drop").mkdir()
    # HLSManager's init wipes everything when the cache-version marker
    # is missing; pre-seed it so the orphan-cleanup logic gets to run
    # against the fixture dirs.
    _pre_seed_hls_marker(hls_dir)

    live = {"keep"}
    assert PosterManager(cache_dir=poster_dir).clean_orphans(live) == 1
    assert HLSManager(base_dir=hls_dir).clean_orphans(live) == 1
    assert SubtitleCache(cache_dir=subs_dir).clean_orphans(live) == 1

    for d in (poster_dir, hls_dir, subs_dir):
        assert (d / "keep").exists() or (d / "keep.png").exists()
        assert not (d / "drop").exists()
        assert not (d / "drop.png").exists()
