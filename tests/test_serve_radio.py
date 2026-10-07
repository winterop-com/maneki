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


def test_updating_a_station_is_a_success_noop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Update stays a no-op: a station is added or removed, and edited in radio.toml by hand."""
    body = _client(tmp_path, monkeypatch).get("/rest/updateInternetRadioStation", params=_params()).json()
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


def _stations(client: TestClient) -> list[dict]:
    body = client.get("/rest/getInternetRadioStations", params=_params()).json()
    stations: list[dict] = body["subsonic-response"]["internetRadioStations"]["internetRadioStation"]
    return stations


def test_station_ids_are_stable_whatever_the_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    before = {s["streamUrl"]: s["id"] for s in _stations(client)}
    client.get(
        "/rest/createInternetRadioStation",
        params=_params(streamUrl="https://new.example/stream", name="New One"),
    )
    after = {s["streamUrl"]: s["id"] for s in _stations(client)}
    for url, sid in before.items():
        assert after[url] == sid


def test_adding_a_station_keeps_it_without_touching_radio_toml(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hand_written = '# my notes\n[[stations]]\nname = "Mine"\nurl = "https://mine.example/s"\n'
    (tmp_path / "radio.toml").write_text(hand_written, encoding="utf-8")
    client = _client(tmp_path, monkeypatch)
    body = client.get(
        "/rest/createInternetRadioStation",
        params=_params(
            streamUrl="https://new.example/stream",
            name="New One",
            homepageUrl="https://new.example/",
            logo="https://new.example/logo.png",
        ),
    ).json()
    assert body["subsonic-response"]["status"] == "ok"
    added = next(s for s in _stations(client) if s["name"] == "New One")
    assert added["custom"] is True
    assert added["coverArt"].startswith("rs_")
    added_rows = radio._load_added_stations(tmp_path / "radio.toml")
    assert added_rows[0].logo == "https://new.example/logo.png"
    # The hand-written file is read, never written: notes and comments in it stay.
    assert (tmp_path / "radio.toml").read_text(encoding="utf-8") == hand_written


def test_adding_a_station_twice_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    params = _params(streamUrl=DEFAULT_STATIONS[0].url, name="Again")
    body = client.get("/rest/createInternetRadioStation", params=params).json()
    assert body["subsonic-response"]["status"] == "failed"
    assert len(_stations(client)) == len(DEFAULT_STATIONS)


def test_a_station_that_was_added_can_be_removed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    client = _client(tmp_path, monkeypatch)
    client.get("/rest/createInternetRadioStation", params=_params(streamUrl="https://x.example/s", name="X"))
    added = next(s for s in _stations(client) if s["name"] == "X")
    body = client.get("/rest/deleteInternetRadioStation", params=_params(id=added["id"])).json()
    assert body["subsonic-response"]["status"] == "ok"
    assert all(s["name"] != "X" for s in _stations(client))


def test_a_built_in_or_hand_written_station_is_not_removed_here(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "radio.toml").write_text(
        '[[stations]]\nname = "Mine"\nurl = "https://mine.example/s"\n', encoding="utf-8"
    )
    client = _client(tmp_path, monkeypatch)
    for station in _stations(client)[:2]:  # the hand-written one, then a built-in one
        assert "custom" not in station
        body = client.get("/rest/deleteInternetRadioStation", params=_params(id=station["id"])).json()
        assert body["subsonic-response"]["error"]["code"] == 50
    assert len(_stations(client)) == len(DEFAULT_STATIONS) + 1


def test_search_returns_radio_browser_results_marked_when_already_added(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from maneki.audio import radio_browser

    async def fake_search(query: str, *, limit: int = 30) -> list[radio_browser.FoundStation]:
        assert query == "jazz"
        return [
            radio_browser.FoundStation(
                id="uuid-1",
                name="Jazz FM",
                stream_url="https://jazz.example/stream",
                logo="https://jazz.example/logo.png",
                country="Norway",
                tags=("jazz", "smooth"),
                codec="MP3",
                bitrate=128,
            ),
            radio_browser.FoundStation(id="uuid-2", name="NRK mP3 again", stream_url=DEFAULT_STATIONS[0].url),
        ]

    monkeypatch.setattr(radio_browser, "search", fake_search)
    body = _client(tmp_path, monkeypatch).get("/rest/searchRadioStations", params=_params(query="jazz")).json()
    found = body["subsonic-response"]["radioSearch"]["station"]
    assert found[0]["name"] == "Jazz FM"
    assert found[0]["tags"] == ["jazz", "smooth"]
    assert found[0]["bitrate"] == 128
    assert found[0]["added"] is False
    assert found[1]["added"] is True


def test_the_proxy_plays_what_a_search_offered_and_nothing_else() -> None:
    from maneki.audio import radio_browser

    assert not radio_browser.was_offered("https://offered.example/stream")
    radio_browser._remember(["https://offered.example/stream"])
    assert radio_browser.was_offered("https://offered.example/stream")


def test_a_search_row_without_a_stream_is_dropped() -> None:
    from maneki.audio import radio_browser

    assert radio_browser._parse({"name": "No stream"}) is None
    parsed = radio_browser._parse(
        {
            "stationuuid": "u",
            "name": " Jazz ",
            "url_resolved": "https://j.example/s",
            "tags": "jazz,,smooth ",
            "bitrate": 0,
            "favicon": "",
        }
    )
    assert parsed is not None
    assert parsed.name == "Jazz"
    assert parsed.tags == ("jazz", "smooth")
    assert parsed.bitrate is None
    assert parsed.logo is None
