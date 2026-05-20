"""Tests for the persistent SQLite-backed video scan cache."""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from maneki.video.serve.scan import VideoEntry, prewarm_scan
from maneki.video.serve.scan_cache import SCHEMA_VERSION, VideoIndex, db_path
from maneki.video.serve.scan_state import VideoScanTracker


@pytest.fixture
def library(tmp_path: Path) -> Path:
    """Library root with two real-ish video files."""
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "ep1.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"A" * 1020)
    (videos / "ep2.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"B" * 1024)
    return tmp_path


def test_video_index_fresh_db_creates_schema(library: Path) -> None:
    """A new VideoIndex creates the DB file with the expected schema."""
    idx = VideoIndex(library)
    try:
        assert db_path(library).exists()
        assert idx.load_all() == {}
        assert idx.fingerprints() == {}
    finally:
        idx.close()


def test_video_index_persists_across_instances(library: Path) -> None:
    """Rows written by one index survive a close/reopen cycle (the whole point of persistence)."""
    entry = VideoEntry(
        id="ep1-abc12345",
        name="ep1",
        path=str(library / "videos" / "ep1.mkv"),
        size_bytes=1024,
        rel_path="videos/ep1.mkv",
        duration_s=42.0,
        subtitles=[],
    )
    idx1 = VideoIndex(library)
    try:
        idx1.upsert(entry, mtime=123.0)
    finally:
        idx1.close()

    idx2 = VideoIndex(library)
    try:
        loaded = idx2.load_all()
        assert "ep1-abc12345" in loaded
        assert loaded["ep1-abc12345"]["name"] == "ep1"
        assert loaded["ep1-abc12345"]["duration_s"] == 42.0
        assert idx2.fingerprints() == {"ep1-abc12345": (123.0, 1024)}
    finally:
        idx2.close()


def test_video_index_rebuilds_on_schema_mismatch(library: Path) -> None:
    """Stale schema_version in the meta table triggers a wipe + fresh schema."""
    idx = VideoIndex(library)
    try:
        idx.upsert(
            VideoEntry(
                id="old-row",
                name="old",
                path="/nope",
                size_bytes=0,
                rel_path="nope",
                duration_s=None,
                subtitles=[],
            ),
            mtime=0.0,
        )
    finally:
        idx.close()

    # Corrupt our namespaced video_schema_version -> next open()
    # should drop + recreate the videos table (leaving any audio-side
    # tables alongside intact, which we don't have here but rely on
    # in production).
    path = db_path(library)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            "UPDATE meta SET value = ? WHERE key = 'video_schema_version'",
            (str(SCHEMA_VERSION + 99),),
        )
        conn.commit()
    finally:
        conn.close()

    idx2 = VideoIndex(library)
    try:
        # The reset dropped the old row.
        assert idx2.load_all() == {}
    finally:
        idx2.close()


def test_video_index_rebuilds_on_library_root_change(tmp_path: Path) -> None:
    """A DB written for one root won't be reused under a different root."""
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    root_a.mkdir()
    root_b.mkdir()

    idx_a = VideoIndex(root_a)
    try:
        idx_a.upsert(
            VideoEntry(
                id="row",
                name="x",
                path="/x",
                size_bytes=0,
                rel_path="x",
                duration_s=None,
                subtitles=[],
            ),
            mtime=0.0,
        )
    finally:
        idx_a.close()

    # Move the DB from root_a's .maneki into root_b's. Opening
    # root_b's index should notice the library_root_abs mismatch
    # and rebuild.
    src = db_path(root_a)
    dst = db_path(root_b)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())

    idx_b = VideoIndex(root_b)
    try:
        assert idx_b.load_all() == {}
    finally:
        idx_b.close()


def test_video_index_delete_missing_prunes_orphans(library: Path) -> None:
    """delete_missing drops rows whose ids aren't in the live set."""
    idx = VideoIndex(library)
    try:
        for vid in ("a", "b", "c"):
            idx.upsert(
                VideoEntry(
                    id=vid,
                    name=vid,
                    path=f"/{vid}",
                    size_bytes=0,
                    rel_path=vid,
                    duration_s=None,
                    subtitles=[],
                ),
                mtime=0.0,
            )
        removed = idx.delete_missing({"a", "b"})
        assert removed == 1
        remaining = set(idx.load_all().keys())
        assert remaining == {"a", "b"}
    finally:
        idx.close()


def test_prewarm_scan_reuses_cache_on_second_pass(library: Path) -> None:
    """Second prewarm with the same library + cache reuses every cached row."""
    idx = VideoIndex(library)
    tracker1 = VideoScanTracker()
    tracker2 = VideoScanTracker()
    try:
        first = asyncio.run(prewarm_scan(library, tracker1, index=idx))
        # Snapshot the fingerprints the first scan persisted.
        fps_after_first = idx.fingerprints()

        second = asyncio.run(prewarm_scan(library, tracker2, index=idx))

        ids_first = {e["id"] for e in first}
        ids_second = {e["id"] for e in second}
        assert ids_first == ids_second, "delta scan must yield the same set of videos"
        # Fingerprints unchanged means we reused the cache rather than re-probing.
        assert idx.fingerprints() == fps_after_first
        # And the listing endpoint sees both files.
        assert {e["name"] for e in second} == {"ep1", "ep2"}
    finally:
        idx.close()


def test_prewarm_scan_picks_up_new_file_without_reprobing_old(library: Path) -> None:
    """Adding a file triggers a probe for it; existing fingerprints unchanged."""
    idx = VideoIndex(library)
    tracker = VideoScanTracker()
    try:
        asyncio.run(prewarm_scan(library, tracker, index=idx))
        before_ids = set(idx.fingerprints().keys())

        # Drop a new file in.
        (library / "videos" / "ep3.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"C" * 512)

        tracker2 = VideoScanTracker()
        result = asyncio.run(prewarm_scan(library, tracker2, index=idx))
        after_ids = set(idx.fingerprints().keys())

        new_ids = after_ids - before_ids
        assert len(new_ids) == 1, "exactly one new id should appear after dropping a file"
        # The original entries remain in the listing too.
        assert len(result) == 3
        assert {e["name"] for e in result} == {"ep1", "ep2", "ep3"}
    finally:
        idx.close()


def test_prewarm_scan_prunes_deleted_files(library: Path) -> None:
    """Deleting a file removes its row from the cache on the next scan."""
    idx = VideoIndex(library)
    tracker = VideoScanTracker()
    try:
        asyncio.run(prewarm_scan(library, tracker, index=idx))
        assert len(idx.fingerprints()) == 2

        (library / "videos" / "ep2.mp4").unlink()

        tracker2 = VideoScanTracker()
        result = asyncio.run(prewarm_scan(library, tracker2, index=idx))

        assert len(result) == 1
        assert result[0]["name"] == "ep1"
        # The cache no longer carries the deleted id.
        assert len(idx.fingerprints()) == 1
    finally:
        idx.close()


def test_prewarm_scan_reprobes_when_mtime_changes(library: Path) -> None:
    """Touching a file's mtime invalidates the cached row and triggers a re-probe."""
    idx = VideoIndex(library)
    tracker = VideoScanTracker()
    try:
        asyncio.run(prewarm_scan(library, tracker, index=idx))
        fps_before = idx.fingerprints()

        # Bump mtime on ep1 by re-writing it (same bytes, new mtime).
        ep1 = library / "videos" / "ep1.mkv"
        import os
        import time

        new_mtime = time.time() + 100
        os.utime(ep1, (new_mtime, new_mtime))

        tracker2 = VideoScanTracker()
        asyncio.run(prewarm_scan(library, tracker2, index=idx))

        fps_after = idx.fingerprints()
        # The id is the same (same rel_path) but mtime updated.
        ep1_id = next(vid for vid, (_, _) in fps_before.items() if "ep1" in vid)
        assert fps_after[ep1_id][0] != fps_before[ep1_id][0]
    finally:
        idx.close()


def test_prewarm_scan_works_without_index(library: Path) -> None:
    """Legacy callers (tests, direct sub-app use) get the no-cache path."""
    tracker = VideoScanTracker()
    result = asyncio.run(prewarm_scan(library, tracker))
    assert {e["name"] for e in result} == {"ep1", "ep2"}
    # No DB file should have been created when the caller didn't pass one.
    assert not db_path(library).exists()
