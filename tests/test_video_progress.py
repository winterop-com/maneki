"""Where a viewer stopped: the per-user video store and the endpoints over it."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.audio.serve.config import ServeConfig
from maneki.audio.serve.users import UserRegistry
from maneki.video.serve import create_app
from maneki.video.serve.progress import VideoProgressStore

_CFG = ServeConfig(username="admin", password="admin")


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "ep1.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"A" * 1020)
    (videos / "ep2.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"B" * 1020)
    return tmp_path


@pytest.fixture
def client(library_root: Path) -> TestClient:
    users = UserRegistry.single_user(library_root, _CFG)
    return TestClient(create_app(library_root, users=users))


def _id(client: TestClient, name: str) -> str:
    return str(next(v["id"] for v in client.get("/api/videos").json() if v["name"] == name))


# --- the store -----------------------------------------------------------------


def test_the_store_records_moves_and_forgets(tmp_path: Path) -> None:
    store = VideoProgressStore(tmp_path / "videos.db")
    assert store.get("v1") is None
    assert store.all() == []

    first = store.save("v1", 120.0, duration_s=2700.0, now=1000.0)
    assert (first.position_s, first.finished) == (120.0, False)
    later = store.save("v1", 900.0, duration_s=2700.0, now=2000.0)
    assert (later.position_s, later.updated_at) == (900.0, 2000.0)
    # One row per video however often a player reports, which is what makes a
    # PUT every ten seconds safe.
    assert [p.video_id for p in store.all()] == ["v1"]

    store.delete("v1")
    assert store.get("v1") is None


def test_the_most_recently_watched_comes_first(tmp_path: Path) -> None:
    store = VideoProgressStore(tmp_path / "videos.db")
    store.save("v1", 10.0, now=1000.0)
    store.save("v2", 10.0, now=3000.0)
    store.save("v3", 10.0, now=2000.0)
    assert [p.video_id for p in store.all()] == ["v2", "v3", "v1"]


def test_the_credits_count_as_watched(tmp_path: Path) -> None:
    store = VideoProgressStore(tmp_path / "videos.db")
    assert store.save("v1", 2500.0, duration_s=2700.0).finished is False
    assert store.save("v1", 2650.0, duration_s=2700.0).finished is True
    # An explicit answer always wins, in either direction.
    assert store.save("v1", 2699.0, duration_s=2700.0, finished=False).finished is False
    assert store.save("v1", 10.0, duration_s=2700.0, finished=True).finished is True


def test_a_short_video_is_not_swallowed_whole(tmp_path: Path) -> None:
    """The tail is a fraction of a short file, or a one-minute clip opens finished."""
    store = VideoProgressStore(tmp_path / "videos.db")
    assert store.save("v1", 5.0, duration_s=60.0).finished is False
    assert store.save("v1", 59.0, duration_s=60.0).finished is True


def test_a_position_is_clamped_to_the_video(tmp_path: Path) -> None:
    store = VideoProgressStore(tmp_path / "videos.db")
    assert store.save("v1", -5.0, duration_s=600.0).position_s == 0.0
    assert store.save("v1", 9999.0, duration_s=600.0).position_s == 600.0


# --- the endpoints -------------------------------------------------------------


def test_a_video_nobody_started_reads_as_the_top(client: TestClient) -> None:
    answer = client.get(f"/api/videos/{_id(client, 'ep1')}/progress").json()
    assert (answer["position_s"], answer["finished"], answer["updated_at"]) == (0.0, False, 0.0)


def test_a_reported_position_comes_back(client: TestClient) -> None:
    video_id = _id(client, "ep1")
    saved = client.put(f"/api/videos/{video_id}/progress", json={"position_s": 610.5}).json()
    assert saved["position_s"] == 610.5
    assert client.get(f"/api/videos/{video_id}/progress").json()["position_s"] == 610.5


def test_reporting_twice_leaves_one_position(client: TestClient) -> None:
    video_id = _id(client, "ep1")
    for at in (10.0, 20.0, 30.0):
        client.put(f"/api/videos/{video_id}/progress", json={"position_s": at})
    listed = client.get("/api/progress").json()
    assert [(p["video_id"], p["position_s"]) for p in listed] == [(video_id, 30.0)]


def test_the_listing_answers_every_started_video(client: TestClient) -> None:
    first, second = _id(client, "ep1"), _id(client, "ep2")
    client.put(f"/api/videos/{first}/progress", json={"position_s": 30.0})
    client.put(f"/api/videos/{second}/progress", json={"position_s": 60.0, "finished": True})
    by_id = {p["video_id"]: p for p in client.get("/api/progress").json()}
    assert by_id[first]["finished"] is False
    assert by_id[second]["finished"] is True


def test_the_listing_leaves_out_a_video_the_library_no_longer_holds(
    client: TestClient,
    library_root: Path,
) -> None:
    """A row nothing can play is a row that leads nowhere."""
    video_id = _id(client, "ep1")
    client.put(f"/api/videos/{video_id}/progress", json={"position_s": 30.0})
    (library_root / "videos" / "ep1.mkv").unlink()
    assert client.get("/api/progress").json() == []


def test_a_position_can_be_forgotten(client: TestClient) -> None:
    video_id = _id(client, "ep1")
    client.put(f"/api/videos/{video_id}/progress", json={"position_s": 30.0})
    assert client.delete(f"/api/videos/{video_id}/progress").status_code == 204
    assert client.get(f"/api/videos/{video_id}/progress").json()["position_s"] == 0.0


def test_progress_needs_a_video_that_exists(client: TestClient) -> None:
    assert client.get("/api/videos/nope/progress").status_code == 404
    assert client.put("/api/videos/nope/progress", json={"position_s": 1.0}).status_code == 404


def test_a_position_before_the_start_is_refused(client: TestClient) -> None:
    video_id = _id(client, "ep1")
    assert client.put(f"/api/videos/{video_id}/progress", json={"position_s": -1.0}).status_code == 422


def test_without_a_registry_nothing_is_saved_and_the_server_says_so(library_root: Path) -> None:
    """Built standalone -- tests, audio-only embedders -- there is no account to save against."""
    bare = TestClient(create_app(library_root))
    video_id = next(v["id"] for v in bare.get("/api/videos").json() if v["name"] == "ep1")
    assert bare.get(f"/api/videos/{video_id}/progress").status_code == 503
    assert bare.put(f"/api/videos/{video_id}/progress", json={"position_s": 5.0}).status_code == 503


def test_each_account_keeps_its_own_position(library_root: Path) -> None:
    """Two accounts watching one episode do not share where they got to."""
    registry = UserRegistry.single_user(library_root, _CFG)
    ada = registry.video_progress_for("ada")
    bo = registry.video_progress_for("bo")
    ada.save("v1", 300.0)
    bo.save("v1", 1200.0)
    assert ada.get("v1") is not None
    assert bo.get("v1") is not None
    assert (ada.get("v1").position_s, bo.get("v1").position_s) == (300.0, 1200.0)  # type: ignore[union-attr]


def test_a_position_survives_a_new_server(library_root: Path) -> None:
    users = UserRegistry.single_user(library_root, _CFG)
    first = TestClient(create_app(library_root, users=users))
    video_id = next(v["id"] for v in first.get("/api/videos").json() if v["name"] == "ep1")
    first.put(f"/api/videos/{video_id}/progress", json={"position_s": 450.0})

    second = TestClient(create_app(library_root, users=UserRegistry.single_user(library_root, _CFG)))
    assert second.get(f"/api/videos/{video_id}/progress").json()["position_s"] == 450.0
