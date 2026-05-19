"""Tests for the /api/browse folder navigator endpoint + the underlying scanner."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mediakit.video.serve import create_app
from mediakit.video.serve.scan import browse_dir


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    """Library with two subfolders and a video at the root + one deeper.

    Layout is rooted directly at tmp_path - there is no `videos/` subdir
    convention anymore. The scanner walks the library root recursively.
    """
    (tmp_path / "movies").mkdir(parents=True)
    (tmp_path / "tv" / "Show A" / "Season 1").mkdir(parents=True)
    # Root-level video
    (tmp_path / "loose.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"x" * 100)
    # Inside movies/
    (tmp_path / "movies" / "Flick.mp4").write_bytes(b"x" * 100)
    # Two episodes deep in tv/Show A/Season 1/
    (tmp_path / "tv" / "Show A" / "Season 1" / "S01E01.mkv").write_bytes(b"x" * 100)
    (tmp_path / "tv" / "Show A" / "Season 1" / "S01E02.mkv").write_bytes(b"x" * 100)
    # An empty subdir at the root - should not appear in the listing.
    (tmp_path / "empty").mkdir()
    return tmp_path


@pytest.fixture
def client(library_root: Path) -> TestClient:
    return TestClient(create_app(library_root))


def test_browse_root_lists_folders_and_videos(client: TestClient) -> None:
    resp = client.get("/api/browse")
    assert resp.status_code == 200
    body = resp.json()
    assert body["rel_path"] == ""
    assert body["crumbs"] == []
    folder_names = [f["name"] for f in body["folders"]]
    # `empty` is hidden because it has no videos in its subtree.
    assert folder_names == ["movies", "tv"]
    video_names = [v["name"] for v in body["videos"]]
    assert video_names == ["loose"]


def test_browse_folder_counts_descendants(client: TestClient) -> None:
    body = client.get("/api/browse").json()
    counts = {f["name"]: f["video_count"] for f in body["folders"]}
    assert counts["movies"] == 1
    # tv/ has the two episodes deep under Show A/Season 1/
    assert counts["tv"] == 2


def test_browse_subfolder_crumbs(client: TestClient) -> None:
    resp = client.get("/api/browse", params={"path": "tv/Show A"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["rel_path"] == "tv/Show A"
    assert body["crumbs"] == ["tv", "Show A"]
    # Only one subfolder (Season 1), no videos at this level.
    assert [f["name"] for f in body["folders"]] == ["Season 1"]
    assert body["videos"] == []


def test_browse_deeply_nested_lists_videos(client: TestClient) -> None:
    body = client.get("/api/browse", params={"path": "tv/Show A/Season 1"}).json()
    names = [v["name"] for v in body["videos"]]
    assert names == ["S01E01", "S01E02"]


def test_browse_path_traversal_returns_404(client: TestClient) -> None:
    # Resolved path escapes the videos dir.
    resp = client.get("/api/browse", params={"path": "../.."})
    assert resp.status_code == 404


def test_browse_unknown_path_returns_404(client: TestClient) -> None:
    resp = client.get("/api/browse", params={"path": "does-not-exist"})
    assert resp.status_code == 404


def test_browse_dir_empty_root_lists_nothing(tmp_path: Path) -> None:
    """An empty library root returns an empty (but valid) browse response."""
    body = browse_dir(tmp_path, "")
    assert body is not None
    assert body["folders"] == []
    assert body["videos"] == []


def test_browse_dir_returns_none_when_root_missing(tmp_path: Path) -> None:
    """Pointing at a non-existent directory is None, not an error."""
    assert browse_dir(tmp_path / "nope", "") is None
