"""Tests for orphan cleanup across the three video caches."""

from __future__ import annotations

from pathlib import Path

from maneki.video.serve.hls import HLS_CACHE_VERSION, HLSManager
from maneki.video.serve.poster import PosterManager
from maneki.video.serve.subtitles import SubtitleCache


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
    alive_p = mgr.poster_path("alive")
    alive_t = mgr.thumbnail_path("alive")
    gone_p = mgr.poster_path("gone")
    gone_t = mgr.thumbnail_path("gone")
    alive_p.write_bytes(b"x")
    alive_t.write_bytes(b"x")
    gone_p.write_bytes(b"x")
    gone_t.write_bytes(b"x")
    (tmp_path / "noise.txt").write_text("unrelated")

    removed = mgr.clean_orphans({"alive"})

    assert removed == 2
    assert alive_p.exists()
    assert alive_t.exists()
    assert not gone_p.exists()
    assert not gone_t.exists()
    # Unrelated files in the cache dir are left alone.
    assert (tmp_path / "noise.txt").exists()


def test_poster_cleanup_no_cache_dir(tmp_path: Path) -> None:
    """Pointing at a non-existent dir is a safe no-op."""
    mgr = PosterManager(cache_dir=tmp_path / "missing")
    assert mgr.clean_orphans({"anything"}) == 0


def test_hls_marker_written_on_fresh_dir_survives_restart(tmp_path: Path) -> None:
    """Fresh server -> marker is written eagerly -> next restart preserves segments.

    The previous bug skipped marker writes when base_dir didn't yet
    exist. The server then created segment dirs without a marker, and
    the next startup interpreted the missing marker as a version
    mismatch and wiped every segment. This regresses the entire
    persistent-HLS-cache feature, so guard against it.
    """
    base = tmp_path / "fresh-hls"
    # First run: fresh init must create the dir and write the marker.
    mgr_a = HLSManager(base_dir=base)
    del mgr_a  # noqa: F841 - just exercising __init__
    marker = base / ".cache-version"
    assert marker.is_file()
    assert marker.read_text(encoding="utf-8").strip() == HLS_CACHE_VERSION

    # Simulate a session writing segments after init.
    (base / "abc").mkdir()
    (base / "abc" / "seg-0000.ts").write_bytes(b"x")

    # Second run (server restart): marker matches, nothing should be wiped.
    HLSManager(base_dir=base)
    assert (base / "abc" / "seg-0000.ts").exists(), "segments wiped on a restart - cache marker not honoured"


def test_hls_cleanup_removes_orphan_session_dirs(tmp_path: Path) -> None:
    from maneki.video.serve.scan import cache_stem

    _pre_seed_hls_marker(tmp_path)
    mgr = HLSManager(base_dir=tmp_path)
    alive_dir = tmp_path / cache_stem("alive")
    gone_dir = tmp_path / cache_stem("gone")
    alive_dir.mkdir()
    (alive_dir / "seg-0000.ts").write_bytes(b"x")
    gone_dir.mkdir()
    (gone_dir / "seg-0000.ts").write_bytes(b"x")

    removed = mgr.clean_orphans({"alive"})

    assert removed == 1
    assert alive_dir.exists()
    assert not gone_dir.exists()


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
    from maneki.video.serve.scan import cache_stem

    cache = SubtitleCache(cache_dir=tmp_path)
    alive_dir = tmp_path / cache_stem("alive")
    gone_dir = tmp_path / cache_stem("gone")
    alive_dir.mkdir()
    (alive_dir / "embed-2.vtt").write_text("WEBVTT")
    gone_dir.mkdir()
    (gone_dir / "embed-2.vtt").write_text("WEBVTT")

    removed = cache.clean_orphans({"alive"})

    assert removed == 1
    assert alive_dir.exists()
    assert not gone_dir.exists()


def test_all_three_caches_clean_orphans(tmp_path: Path) -> None:
    """Same `live_ids` set works for all three cache types."""
    from maneki.video.serve.scan import cache_stem

    poster_dir = tmp_path / "posters"
    hls_dir = tmp_path / "hls"
    subs_dir = tmp_path / "subs"
    poster_dir.mkdir()
    hls_dir.mkdir()
    subs_dir.mkdir()

    keep_stem = cache_stem("keep")
    drop_stem = cache_stem("drop")
    (poster_dir / f"{keep_stem}.png").write_bytes(b"x")
    (poster_dir / f"{drop_stem}.png").write_bytes(b"x")
    (hls_dir / keep_stem).mkdir()
    (hls_dir / drop_stem).mkdir()
    (subs_dir / keep_stem).mkdir()
    (subs_dir / drop_stem).mkdir()
    # HLSManager's init wipes everything when the cache-version marker
    # is missing; pre-seed it so the orphan-cleanup logic gets to run
    # against the fixture dirs.
    _pre_seed_hls_marker(hls_dir)

    live = {"keep"}
    assert PosterManager(cache_dir=poster_dir).clean_orphans(live) == 1
    assert HLSManager(base_dir=hls_dir).clean_orphans(live) == 1
    assert SubtitleCache(cache_dir=subs_dir).clean_orphans(live) == 1

    for d in (poster_dir, hls_dir, subs_dir):
        assert (d / keep_stem).exists() or (d / f"{keep_stem}.png").exists()
        assert not (d / drop_stem).exists()
        assert not (d / f"{drop_stem}.png").exists()
