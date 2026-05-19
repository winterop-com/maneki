"""Tests for the bearer-token TokenStore and the auth-protected serve_app routes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.audio.serve.config import ServeConfig
from maneki.auth import Token, TokenStore
from maneki.serve_app import create_combined_app

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
