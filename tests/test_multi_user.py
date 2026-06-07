"""Multi-user: registry, per-user auth + stores, sanitization, migration."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from maneki.audio.serve.auth import AuthError, verify
from maneki.audio.serve.users import (
    ResolvedUser,
    UserRegistry,
    migrate_global_stars,
    sanitize_username,
)


def _registry(root: Path) -> UserRegistry:
    return UserRegistry(
        root,
        [
            ResolvedUser(name="alice", password="apw", admin=True),
            ResolvedUser(name="bob", password="bpw", admin=False),
        ],
    )


def _token(password: str, salt: str) -> str:
    return hashlib.md5((password + salt).encode("utf-8")).hexdigest()  # noqa: S324


def test_per_user_stores_are_independent(tmp_path: Path) -> None:
    reg = _registry(tmp_path)
    alice, bob = reg.stars_for("alice"), reg.stars_for("bob")
    assert alice is not bob
    alice.add("al_x")
    assert alice.is_starred("al_x")
    assert not bob.is_starred("al_x")
    # Same instance on re-fetch (cached).
    assert reg.stars_for("alice") is alice


def test_store_paths_are_per_user(tmp_path: Path) -> None:
    reg = _registry(tmp_path)
    assert reg.user_dir("alice") != reg.user_dir("bob")
    assert reg.user_dir("alice").is_relative_to(tmp_path / ".maneki" / "users")


def test_verify_token_is_per_user(tmp_path: Path) -> None:
    reg = _registry(tmp_path)
    account = verify(reg, user="alice", password=None, token=_token("apw", "s1"), salt="s1")
    assert account.name == "alice"
    assert account.admin is True
    # bob's password must not authenticate alice.
    with pytest.raises(AuthError):
        verify(reg, user="alice", password=None, token=_token("bpw", "s1"), salt="s1")


def test_verify_plain_and_unknown(tmp_path: Path) -> None:
    reg = _registry(tmp_path)
    assert verify(reg, user="bob", password="bpw", token=None, salt=None).name == "bob"
    with pytest.raises(AuthError):
        verify(reg, user="bob", password="wrong", token=None, salt=None)
    with pytest.raises(AuthError):
        verify(reg, user="nobody", password="x", token=None, salt=None)


def test_sanitize_username_contains_traversal() -> None:
    safe = sanitize_username("../../etc/passwd")
    assert "/" not in safe
    assert ".." not in safe
    # Distinct raw names never collide onto one directory (hash suffix).
    assert sanitize_username("alice") != sanitize_username("Alice")


def test_migrate_global_stars_to_admin(tmp_path: Path) -> None:
    legacy = tmp_path / ".maneki" / "stars.toml"
    legacy.parent.mkdir(parents=True)
    legacy.write_text('[items]\nal_x = "2026-01-01T00:00:00Z"\n', encoding="utf-8")
    reg = _registry(tmp_path)

    dest = migrate_global_stars(tmp_path, reg)
    assert dest == reg.user_dir("alice") / "stars.toml"
    assert not legacy.exists()
    assert reg.stars_for("alice").is_starred("al_x")
    assert not reg.stars_for("bob").is_starred("al_x")
    # Idempotent: nothing left to migrate.
    assert migrate_global_stars(tmp_path, reg) is None


def test_single_user_registry_is_admin(tmp_path: Path) -> None:
    from maneki.audio.serve.config import ServeConfig

    reg = UserRegistry.single_user(tmp_path, ServeConfig(username="solo", password="pw"))
    assert [u.name for u in reg.all()] == ["solo"]
    solo = reg.get("solo")
    assert solo is not None
    assert solo.admin is True


def _album(root: Path, artist: str, album: str):  # noqa: ANN202 - test helper
    from maneki.audio.library.models import LibraryAlbum, LibraryTrack

    p = root / artist / album
    return LibraryAlbum(
        path=p,
        artist_dir=artist,
        album_dir=album,
        tag_album=album,
        tag_year="2000",
        tag_album_artist=artist,
        track_count=1,
        tracks=[LibraryTrack(path=p / "01 - x.m4a", title="x", artist=artist, album=album, track_no=1, duration_s=1.0)],
    )


def test_two_users_independent_stars_over_http(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from maneki.audio.library.models import LibraryIndex
    from maneki.audio.serve import ServeConfig, create_app
    from maneki.audio.serve.ids import album_id

    app = create_app(root=tmp_path, cfg=ServeConfig(username="alice", password="apw"))
    app.state.users = _registry(tmp_path)  # inject the two-user registry
    abba, beck = _album(tmp_path, "ABBA", "Arrival"), _album(tmp_path, "Beck", "Sea Change")
    app.state.cache._reindex(LibraryIndex(root=tmp_path, albums=[abba, beck]))  # noqa: SLF001
    client = TestClient(app)
    abba_id, beck_id = album_id(abba), album_id(beck)

    # alice stars ABBA, bob stars Beck — over the wire, each with their own creds.
    assert client.get("/rest/star", params={"u": "alice", "p": "apw", "f": "json", "id": abba_id}).status_code == 200
    assert client.get("/rest/star", params={"u": "bob", "p": "bpw", "f": "json", "id": beck_id}).status_code == 200

    def _starred_album_ids(user: str, pw: str) -> set[str]:
        body = client.get("/rest/getStarred2", params={"u": user, "p": pw, "f": "json"}).json()
        return {a["id"] for a in body["subsonic-response"]["starred2"].get("album", [])}

    assert _starred_album_ids("alice", "apw") == {abba_id}
    assert _starred_album_ids("bob", "bpw") == {beck_id}


def test_wrong_password_rejected_over_http(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from maneki.audio.serve import ServeConfig, create_app

    app = create_app(root=tmp_path, cfg=ServeConfig(username="alice", password="apw"))
    app.state.users = _registry(tmp_path)
    body = TestClient(app).get("/rest/ping", params={"u": "alice", "p": "wrong", "f": "json"}).json()
    assert body["subsonic-response"]["status"] == "failed"
    assert body["subsonic-response"]["error"]["code"] == 40
