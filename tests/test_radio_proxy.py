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
