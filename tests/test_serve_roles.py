"""What a listener (a non-admin account) may change on the server, and what it may not."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.audio import radio
from maneki.audio.serve import ServeConfig, create_app
from maneki.audio.serve.users import ResolvedUser, UserRegistry

STREAM = "https://example.org/stream.mp3"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(radio, "stations_path", lambda: tmp_path / "radio.toml")
    users = UserRegistry(
        tmp_path,
        [
            ResolvedUser(name="alice", password="apw", admin=True),
            ResolvedUser(name="bob", password="bpw", admin=False),
        ],
    )
    return TestClient(create_app(root=tmp_path, cfg=ServeConfig(username="alice", password="apw"), users=users))


def _as(user: str, **params: str) -> dict[str, str]:
    return {"u": user, "p": {"alice": "apw", "bob": "bpw"}[user], "f": "json", **params}


def _call(client: TestClient, method: str, user: str, **params: str) -> dict:
    return client.get(f"/rest/{method}", params=_as(user, **params)).json()["subsonic-response"]


def _added(client: TestClient) -> list[str]:
    stations = _call(client, "getInternetRadioStations", "alice")["internetRadioStations"]["internetRadioStation"]
    return [s["streamUrl"] for s in stations if s["streamUrl"] == STREAM]


def test_a_listener_cannot_add_a_station(client: TestClient) -> None:
    """Added stations are the server's: one listener's would be every listener's, and the relay
    fetches whatever was added."""
    body = _call(client, "createInternetRadioStation", "bob", streamUrl=STREAM, name="Mine")
    assert body["status"] == "failed"
    assert body["error"]["code"] == 50
    assert _added(client) == []


def test_a_listener_cannot_remove_a_station_an_admin_added(client: TestClient) -> None:
    assert _call(client, "createInternetRadioStation", "alice", streamUrl=STREAM, name="Kept")["status"] == "ok"
    station_id = next(
        s["id"]
        for s in _call(client, "getInternetRadioStations", "bob")["internetRadioStations"]["internetRadioStation"]
        if s["streamUrl"] == STREAM
    )
    body = _call(client, "deleteInternetRadioStation", "bob", id=station_id)
    assert body["error"]["code"] == 50
    assert _added(client) == [STREAM]
    assert _call(client, "deleteInternetRadioStation", "alice", id=station_id)["status"] == "ok"


def test_a_listener_cannot_start_a_rescan(client: TestClient) -> None:
    assert _call(client, "startScan", "bob")["error"]["code"] == 50
    assert _call(client, "startScan", "alice")["status"] == "ok"


@pytest.mark.parametrize("method", ["changePassword", "createUser", "updateUser", "deleteUser"])
def test_user_management_is_never_a_silent_ok(client: TestClient, method: str) -> None:
    """Accounts live in maneki.toml. Answering ok made a phone app say a password had changed."""
    listener = _call(client, method, "bob", username="alice", password="x")
    assert listener["status"] == "failed"
    assert listener["error"]["code"] == 50
    admin = _call(client, method, "alice", username="bob", password="x")
    assert admin["status"] == "failed"
    assert "maneki.toml" in admin["error"]["message"]


def test_editing_a_station_is_not_a_silent_ok(client: TestClient) -> None:
    assert _call(client, "updateInternetRadioStation", "bob", id="x", streamUrl=STREAM, name="n")["error"]["code"] == 50
    assert _call(client, "updateInternetRadioStation", "alice", id="x", streamUrl=STREAM, name="n")["status"] == "failed"


def test_a_listener_asking_for_another_account_is_not_authorized(client: TestClient) -> None:
    assert _call(client, "getUser", "bob", username="alice")["error"]["code"] == 50
