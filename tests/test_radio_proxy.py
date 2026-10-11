"""The station relay: what it reads off a stream, and what it answers when a stream fails."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx2 as httpx
import pytest

from maneki.audio import radio
from maneki.audio.serve import radio_proxy

URL = "https://stream.example/live"


def test_a_title_with_an_apostrophe_is_read() -> None:
    """The title pattern stopped at the first apostrophe, so "Don't Stop Me Now" never matched and
    the previous song stayed on screen."""
    assert radio_proxy.stream_title(b"StreamTitle='Queen - Don't Stop Me Now';StreamUrl='';") == (
        "Queen - Don't Stop Me Now"
    )
    assert radio_proxy.stream_title(b"StreamTitle='Guns N' Roses - Patience';") == "Guns N' Roses - Patience"
    assert radio_proxy.stream_title(b"StreamTitle='';") is None


def _relaying(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    monkeypatch.setattr(radio, "load_stations", lambda: [radio.RadioStation(name="Live", url=URL)])
    real = httpx.AsyncClient

    def client(**kwargs: Any) -> httpx.AsyncClient:
        return real(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(radio_proxy.httpx, "AsyncClient", client)


def test_an_unreachable_station_is_a_502_not_a_traceback(monkeypatch: pytest.MonkeyPatch) -> None:
    """A refused or unresolvable host escaped as a 500 with a traceback, and the client was never
    closed."""

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    _relaying(monkeypatch, refuse)
    answer = asyncio.run(radio_proxy.proxy_station_stream(URL))
    assert answer.status_code == 502


def test_a_new_connection_forgets_the_last_title(monkeypatch: pytest.MonkeyPatch) -> None:
    """A station played again showed a song from minutes before until the next title came."""
    radio_proxy._icy_titles[URL] = "A song from earlier"
    _relaying(monkeypatch, lambda request: httpx.Response(200, content=b"audio"))
    asyncio.run(radio_proxy.proxy_station_stream(URL))
    assert radio_proxy.latest_icy_title(URL) == ""


def test_a_directory_logo_that_is_not_an_address_is_no_logo() -> None:
    """A directory row whose favicon was the text "null" made the client fetch `/null`."""
    from maneki.audio import radio_browser

    row: dict[str, object] = {"url_resolved": "https://s.example/live", "name": "Dubbo's 94.3", "favicon": "null"}
    found = radio_browser._parse(row)  # noqa: SLF001 - the row parser is the unit under test
    assert found is not None
    assert found.logo is None
    with_logo = radio_browser._parse({**row, "favicon": "https://s.example/logo.png"})  # noqa: SLF001
    assert with_logo is not None
    assert with_logo.logo == "https://s.example/logo.png"


def _offered(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    """A station a search offered (the public directory), not one an admin added."""
    from maneki.audio import radio_browser

    monkeypatch.setattr(radio, "load_stations", lambda: [])
    monkeypatch.setattr(radio_browser, "was_offered", lambda _url: True)
    real = httpx.AsyncClient

    def client(**kwargs: Any) -> httpx.AsyncClient:
        return real(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(radio_proxy.httpx, "AsyncClient", client)


def test_an_offered_station_may_not_point_inside(monkeypatch: pytest.MonkeyPatch) -> None:
    """The directory is open to anyone, so a station found there could make the server fetch an
    address on its own network."""
    _offered(monkeypatch, lambda request: httpx.Response(200, content=b"secret"))
    answer = asyncio.run(radio_proxy.proxy_station_stream("http://127.0.0.1:8790/books/api/progress"))
    assert answer.status_code == 403


def test_an_offered_station_may_not_redirect_inside(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "93.184.215.14":
            return httpx.Response(302, headers={"location": "http://10.0.0.1/admin"})
        return httpx.Response(200, content=b"secret")

    _offered(monkeypatch, handler)
    answer = asyncio.run(radio_proxy.proxy_station_stream("http://93.184.215.14/live"))
    assert answer.status_code == 502


def test_the_title_is_forgotten_when_the_stream_ends(monkeypatch: pytest.MonkeyPatch) -> None:
    """Kept after a stream ended, a station played again showed a song from minutes before: the
    client's first title poll goes out with the stream request and usually lands first."""
    meta = b"StreamTitle='Old Song';"
    block = bytes([len(meta) // 16 + 1]) + meta.ljust((len(meta) // 16 + 1) * 16, b"\x00")
    body = b"a" * 8 + block + b"b" * 8

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"icy-metaint": "8"}, stream=httpx.ByteStream(body))

    _relaying(monkeypatch, handler)

    async def listen() -> None:
        answer = await radio_proxy.proxy_station_stream(URL)
        async for _chunk in answer.body_iterator:  # type: ignore[attr-defined]
            assert radio_proxy.latest_icy_title(URL) in ("", "Old Song")

    asyncio.run(listen())
    assert radio_proxy.latest_icy_title(URL) == ""


def test_search_leaves_out_stations_the_relay_cannot_play() -> None:
    """An HLS station's playlist names its segments relative to itself, and through the relay they
    resolved against the API and failed: it never played, and WebKit called it Live meanwhile."""
    from maneki.audio import radio_browser

    hls: dict[str, object] = {"url_resolved": "https://s.example/groove.m3u8", "name": "Groove HLS", "hls": 1}
    plain: dict[str, object] = {"url_resolved": "https://s.example/groove.mp3", "name": "Groove", "hls": 0}
    assert radio_browser._parse(hls) is None  # noqa: SLF001 - the row parser is the unit under test
    assert radio_browser._parse({**hls, "hls": 0}) is None  # noqa: SLF001 - by the address alone
    assert radio_browser._parse(plain) is not None  # noqa: SLF001
