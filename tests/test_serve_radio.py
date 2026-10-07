"""Subsonic internet-radio endpoints — backed by `radio.load_stations()`."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from maneki.audio import radio
from maneki.audio.radio import DEFAULT_STATIONS
from maneki.audio.serve import ServeConfig, create_app


def _client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    cfg = ServeConfig(username="mort", password="secret")
    # Point stations_path() at a tmp file so the test doesn't depend on
    # the developer's `~/.config/maneki/radio.toml`.
    monkeypatch.setattr(radio, "stations_path", lambda: tmp_path / "radio.toml")
    return TestClient(create_app(root=tmp_path, cfg=cfg))


def _params(**extra: str | int) -> dict[str, str | int]:
    return {"u": "mort", "p": "secret", "f": "json", **extra}


def test_get_internet_radio_stations_returns_defaults(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """With no user radio.toml the endpoint returns the baked-in defaults."""
    body = _client(tmp_path, monkeypatch).get("/rest/getInternetRadioStations", params=_params()).json()
    inner = body["subsonic-response"]
    assert inner["status"] == "ok"
    stations = inner["internetRadioStations"]["internetRadioStation"]
    assert len(stations) == len(DEFAULT_STATIONS)
    # Every station has the spec-required fields.
    for s in stations:
        assert s["id"]
        assert s["name"]
        assert s["streamUrl"]


def test_get_internet_radio_stations_user_entries_first(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """User TOML entries appear ahead of defaults, mirroring `load_stations`."""
    (tmp_path / "radio.toml").write_text(
        '[[stations]]\nname = "User One"\nurl = "https://user.example/stream"\nhomepage = "https://user.example/"\n',
        encoding="utf-8",
    )
    body = _client(tmp_path, monkeypatch).get("/rest/getInternetRadioStations", params=_params()).json()
    stations = body["subsonic-response"]["internetRadioStations"]["internetRadioStation"]
    assert stations[0]["name"] == "User One"
    assert stations[0]["streamUrl"] == "https://user.example/stream"
    assert stations[0]["homepageUrl"] == "https://user.example/"
    # Defaults follow.
    assert len(stations) == len(DEFAULT_STATIONS) + 1


@pytest.mark.parametrize(
    "path",
    [
        "/createInternetRadioStation",
        "/updateInternetRadioStation",
        "/deleteInternetRadioStation",
    ],
)
def test_radio_write_endpoints_are_success_noops(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, path: str) -> None:
    """Write endpoints return ok — stations live in radio.toml, not the API."""
    body = _client(tmp_path, monkeypatch).get(f"/rest{path}", params=_params()).json()
    assert body["subsonic-response"]["status"] == "ok"


def test_get_internet_radio_stations_authgated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Without creds the endpoint goes through the auth dep."""
    monkeypatch.setattr(radio, "stations_path", lambda: tmp_path / "radio.toml")
    cfg = ServeConfig(username="mort", password="secret")
    body = (
        TestClient(create_app(root=tmp_path, cfg=cfg))
        .get("/rest/getInternetRadioStations", params={"f": "json"})
        .json()
    )
    inner = body["subsonic-response"]
    assert inner["status"] == "failed"
    assert inner["error"]["code"] == 40


def test_built_in_stations_carry_their_logo_as_cover_art(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    stations = client.get("/rest/getInternetRadioStations", params=_params()).json()["subsonic-response"][
        "internetRadioStations"
    ]["internetRadioStation"]
    for s in stations:
        assert s["coverArt"].startswith("rs_")
    resp = client.get("/rest/getCoverArt", params=_params(id=stations[0]["coverArt"]))
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content.startswith(b"\x89PNG")


def test_a_station_logo_is_resized_like_an_album_cover(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from io import BytesIO

    from PIL import Image

    client = _client(tmp_path, monkeypatch)
    cover = radio.station_cover_id(DEFAULT_STATIONS[0])
    resp = client.get("/rest/getCoverArt", params=_params(id=cover, size=64))
    assert resp.status_code == 200
    assert max(Image.open(BytesIO(resp.content)).size) <= 64


def test_a_user_station_logo_can_be_a_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from PIL import Image

    logo = tmp_path / "logo.png"
    Image.new("RGB", (32, 32), "red").save(logo)
    (tmp_path / "radio.toml").write_text(
        f'[[stations]]\nname = "Mine"\nurl = "https://mine.example/stream"\nlogo = "{logo}"\n',
        encoding="utf-8",
    )
    client = _client(tmp_path, monkeypatch)
    stations = client.get("/rest/getInternetRadioStations", params=_params()).json()["subsonic-response"][
        "internetRadioStations"
    ]["internetRadioStation"]
    mine = next(s for s in stations if s["name"] == "Mine")
    resp = client.get("/rest/getCoverArt", params=_params(id=mine["coverArt"]))
    assert resp.content == logo.read_bytes()


def test_a_station_without_a_readable_logo_gets_the_placeholder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "radio.toml").write_text(
        '[[stations]]\nname = "Gone"\nurl = "https://gone.example/stream"\nlogo = "/nowhere/logo.png"\n',
        encoding="utf-8",
    )
    client = _client(tmp_path, monkeypatch)
    cover = radio.station_cover_id(radio.RadioStation(name="Gone", url="https://gone.example/stream"))
    resp = client.get("/rest/getCoverArt", params=_params(id=cover))
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/svg+xml")
