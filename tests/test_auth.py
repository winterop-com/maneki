"""Tests for the bearer-token TokenStore and the auth-protected serve_app routes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from structlog.testing import capture_logs

from maneki.audio.serve.config import ServeConfig
from maneki.auth import Token, TokenStore
from maneki.serve_app import accepts_media_token, create_combined_app

_CFG = ServeConfig(username="admin", password="hunter2")


# -----------------------------------------------------------------------------
# TokenStore unit tests
# -----------------------------------------------------------------------------


def test_issue_returns_unique_tokens() -> None:
    store = TokenStore()
    a = store.issue("alice")
    b = store.issue("alice")
    assert a.value != b.value
    assert a.username == b.username == "alice"


def test_validate_returns_token_when_present() -> None:
    store = TokenStore()
    issued = store.issue("admin")
    found = store.validate(issued.value)
    assert found is not None
    assert found.username == "admin"


def test_validate_returns_none_for_unknown_value() -> None:
    store = TokenStore()
    assert store.validate("not-a-real-token") is None


def test_validate_evicts_expired_tokens() -> None:
    store = TokenStore(ttl_seconds=1)
    issued = store.issue("admin")
    # Manually force expiry by mutating the stored entry
    expired = Token(
        value=issued.value,
        username=issued.username,
        issued_at=issued.issued_at,
        expires_at=datetime.now(UTC) - timedelta(seconds=10),
    )
    store._tokens[issued.value] = expired  # noqa: SLF001 - test setup
    assert store.validate(issued.value) is None
    assert len(store) == 0


def test_revoke_removes_token() -> None:
    store = TokenStore()
    issued = store.issue("admin")
    assert store.revoke(issued.value) is True
    assert store.validate(issued.value) is None
    assert store.revoke(issued.value) is False  # idempotent


# -----------------------------------------------------------------------------
# End-to-end through serve_app
# -----------------------------------------------------------------------------


@pytest.fixture
def library_root(tmp_path: Path) -> Path:
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "song.m4a").write_bytes(b"audio")
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "movie.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"v" * 100)
    return tmp_path


@pytest.fixture
def open_client(library_root: Path) -> TestClient:
    return TestClient(create_combined_app(root=library_root, audio_cfg=_CFG, enable_auth=False))


@pytest.fixture
def authed_client(library_root: Path) -> TestClient:
    return TestClient(create_combined_app(root=library_root, audio_cfg=_CFG, enable_auth=True))


def test_capabilities_reports_auth_flag(open_client: TestClient, authed_client: TestClient) -> None:
    assert open_client.get("/capabilities").json()["auth_required"] is False
    assert authed_client.get("/capabilities").json()["auth_required"] is True


def test_login_returns_token_on_correct_credentials(open_client: TestClient) -> None:
    resp = open_client.post("/auth/login", json={"username": "admin", "password": "hunter2"})
    assert resp.status_code == 200
    data = resp.json()
    assert "token" in data
    assert data["username"] == "admin"
    assert "expires_at" in data


def test_login_401_on_wrong_credentials(open_client: TestClient) -> None:
    resp = open_client.post("/auth/login", json={"username": "admin", "password": "wrong"})
    assert resp.status_code == 401


def test_me_requires_bearer(open_client: TestClient) -> None:
    assert open_client.get("/auth/me").status_code == 401


def test_me_returns_user_with_valid_token(open_client: TestClient) -> None:
    token = open_client.post("/auth/login", json={"username": "admin", "password": "hunter2"}).json()["token"]
    resp = open_client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["username"] == "admin"


def test_me_401_with_garbage_token(open_client: TestClient) -> None:
    resp = open_client.get("/auth/me", headers={"Authorization": "Bearer not-a-token"})
    assert resp.status_code == 401


def test_video_open_without_auth_when_disabled(open_client: TestClient) -> None:
    resp = open_client.get("/video/api/videos")
    assert resp.status_code == 200


def test_video_requires_bearer_when_auth_enabled(authed_client: TestClient) -> None:
    resp = authed_client.get("/video/api/videos")
    assert resp.status_code == 401


def test_video_accepts_valid_bearer_when_auth_enabled(authed_client: TestClient) -> None:
    token = authed_client.post("/auth/login", json={"username": "admin", "password": "hunter2"}).json()["token"]
    resp = authed_client.get("/video/api/videos", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert len(resp.json()) == 1


def test_capabilities_and_auth_login_stay_public_under_auth(authed_client: TestClient) -> None:
    """Auth-required mode must still let unauthenticated callers reach /capabilities
    and POST /auth/login - otherwise they could never bootstrap into a token."""
    assert authed_client.get("/capabilities").status_code == 200
    # Login should still work without prior auth
    resp = authed_client.post("/auth/login", json={"username": "admin", "password": "hunter2"})
    assert resp.status_code == 200


def test_subsonic_auth_unaffected_by_house_auth(authed_client: TestClient) -> None:
    """The /audio/rest/* mount keeps its own Subsonic auth; the house bearer token
    is irrelevant there. With --auth on but a valid Subsonic query string, ping
    still returns ok."""
    resp = authed_client.get("/audio/rest/ping.view?u=admin&p=hunter2&v=1.16.1&c=test&f=json")
    assert resp.status_code == 200
    assert resp.json()["subsonic-response"]["status"] == "ok"


# -----------------------------------------------------------------------------
# The media token: the same bearer token, in the URL, for the elements that
# cannot carry a header
# -----------------------------------------------------------------------------


def _token(client: TestClient) -> str:
    """Sign in and hand back the bearer token, which is what a media URL carries."""
    return str(client.post("/auth/login", json={"username": "admin", "password": "hunter2"}).json()["token"])


def _first_video_id(client: TestClient, token: str) -> str:
    """The id of the one video in the fixture library. Hashed, so it is asked for."""
    listed = client.get("/video/api/videos", headers={"Authorization": f"Bearer {token}"}).json()
    return str(listed[0]["id"])


@pytest.fixture
def books_client(library_root: Path) -> TestClient:
    """An authed server with a books mount, which the video-only fixture has not got."""
    (library_root / "Audiobooks").mkdir()
    return TestClient(create_combined_app(root=library_root, audio_cfg=_CFG, enable_auth=True))


@pytest.mark.parametrize(
    "path",
    [
        "/video/api/videos/abc/stream",
        "/video/api/videos/abc/play",
        "/video/api/videos/abc/poster",
        "/video/api/videos/abc/thumbnail",
        "/video/api/videos/abc/hls/index.m3u8",
        "/video/api/videos/abc/hls/seg-0000.ts",
        "/video/api/videos/abc/subtitles/en",
        "/video/api/youtube/videos/abc/hls/index.m3u8",
        "/video/api/stats/stream",
        "/books/api/books/abc/cover",
        "/books/api/books/abc/files/0",
    ],
)
def test_media_routes_accept_a_token_in_the_url(path: str) -> None:
    assert accepts_media_token("GET", path) is True


@pytest.mark.parametrize(
    "path",
    [
        "/video/api/videos",
        "/video/api/videos/abc",
        "/video/api/videos/abc/subtitles",
        "/video/api/browse",
        "/video/api/scan_status",
        "/video/api/youtube/channels",
        "/video/api/youtube/videos/abc",
        "/books/api/books",
        "/books/api/books/abc",
        "/books/api/books/abc/progress",
    ],
)
def test_json_routes_do_not_accept_a_token_in_the_url(path: str) -> None:
    """The header is the grammar wherever `fetch` is what asks, which is every JSON call."""
    assert accepts_media_token("GET", path) is False


def test_only_reads_accept_a_token_in_the_url() -> None:
    """Nothing that changes state is reachable with a token taken out of a URL."""
    assert accepts_media_token("HEAD", "/video/api/videos/abc/stream") is True
    assert accepts_media_token("DELETE", "/video/api/videos/abc/stream") is False
    assert accepts_media_token("POST", "/video/api/videos/abc/stream") is False


def test_media_route_takes_the_token_from_the_url(authed_client: TestClient) -> None:
    """A <video src> has nowhere to put a header, so the stream takes `?token=`."""
    token = _token(authed_client)
    video_id = _first_video_id(authed_client, token)
    resp = authed_client.get(f"/video/api/videos/{video_id}/stream?token={token}")
    assert resp.status_code == 200
    assert resp.content.endswith(b"v" * 100)


def test_media_route_still_takes_the_header(authed_client: TestClient) -> None:
    """The URL is the second way in, not a replacement for the first."""
    token = _token(authed_client)
    video_id = _first_video_id(authed_client, token)
    resp = authed_client.get(
        f"/video/api/videos/{video_id}/stream",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200


def test_media_route_401_on_a_wrong_token_in_the_url(authed_client: TestClient) -> None:
    token = _token(authed_client)
    video_id = _first_video_id(authed_client, token)
    resp = authed_client.get(f"/video/api/videos/{video_id}/stream?token=not-a-token")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "invalid or expired token"


def test_media_route_401_with_no_token_at_all(authed_client: TestClient) -> None:
    token = _token(authed_client)
    video_id = _first_video_id(authed_client, token)
    assert authed_client.get(f"/video/api/videos/{video_id}/stream").status_code == 401


def test_json_route_401_when_the_token_is_only_in_the_url(authed_client: TestClient) -> None:
    """A good token in the query is no sign-in on a route that could have sent a header."""
    token = _token(authed_client)
    video_id = _first_video_id(authed_client, token)
    assert authed_client.get(f"/video/api/videos?token={token}").status_code == 401
    # The subtitle listing sits one segment above the track itself, which does take it.
    assert authed_client.get(f"/video/api/videos/{video_id}/subtitles?token={token}").status_code == 401
    assert authed_client.post(f"/video/api/scan?token={token}").status_code == 401


def test_books_media_route_takes_the_token_from_the_url(books_client: TestClient) -> None:
    """No such book — but a 404 is the mount answering, which is what past the door looks like."""
    token = _token(books_client)
    assert books_client.get("/books/api/books/nope/cover").status_code == 401
    assert books_client.get(f"/books/api/books/nope/cover?token={token}").status_code == 404
    assert books_client.get(f"/books/api/books/nope?token={token}").status_code == 401


def _one_video_app(monkeypatch: pytest.MonkeyPatch, library_root: Path) -> TestClient:
    """An authed server whose one video has a duration, so its manifest can be built.

    The fixture file is four magic bytes and a hundred v's, which ffprobe reads
    no duration out of — and without a duration there are no segments to stamp
    anything onto. Nothing here runs ffmpeg: a manifest is arithmetic on a length.
    """
    from maneki.video.serve import app as video_app
    from maneki.video.serve.scan import VideoEntry

    entry = VideoEntry(
        id="movie-0000",
        name="movie.mkv",
        path=str(library_root / "videos" / "movie.mkv"),
        size_bytes=104,
        rel_path="videos/movie.mkv",
        duration_s=18.0,  # three six-second segments
        subtitles=[],
    )
    monkeypatch.setattr(video_app, "scan_videos", lambda _root: [entry])
    monkeypatch.setattr(video_app, "assert_ffmpeg_available", lambda: None)
    return TestClient(create_combined_app(root=library_root, audio_cfg=_CFG, enable_auth=True))


def test_manifest_stamps_the_token_onto_its_segments(monkeypatch: pytest.MonkeyPatch, library_root: Path) -> None:
    """Segment URIs are relative, so they do not inherit the manifest's own query.

    Without the stamp a player fetches the manifest with a token and then every
    segment named in it without one, and playback 401s before the first frame.
    """
    client = _one_video_app(monkeypatch, library_root)
    token = _token(client)
    body = client.get(f"/video/api/videos/movie-0000/hls/index.m3u8?token={token}").text
    segments = [line for line in body.splitlines() if line.startswith("seg-")]
    assert segments
    assert all(line.endswith(f".ts?token={token}") for line in segments), segments


def test_manifest_fetched_with_the_header_names_bare_segments(
    monkeypatch: pytest.MonkeyPatch, library_root: Path
) -> None:
    """Whoever could put a header on the manifest can put one on the segments too."""
    client = _one_video_app(monkeypatch, library_root)
    token = _token(client)
    body = client.get(
        "/video/api/videos/movie-0000/hls/index.m3u8",
        headers={"Authorization": f"Bearer {token}"},
    ).text
    segments = [line for line in body.splitlines() if line.startswith("seg-")]
    assert segments
    assert all(line.endswith(".ts") for line in segments), segments


def test_the_token_never_reaches_the_access_log(authed_client: TestClient) -> None:
    """The line carries the path and not the query, which is what keeps the secret out of it."""
    token = _token(authed_client)
    video_id = _first_video_id(authed_client, token)
    with capture_logs() as lines:
        resp = authed_client.get(f"/video/api/videos/{video_id}/stream?token={token}")
    assert resp.status_code == 200
    logged = [line for line in lines if line.get("event") == "request"]
    assert logged, "the request never reached the access log"
    assert logged[-1]["path"] == f"/video/api/videos/{video_id}/stream"
    assert token not in repr(lines)
