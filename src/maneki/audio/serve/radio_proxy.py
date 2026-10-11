"""Same-origin proxy for radio station streams plus ICY metadata parsing.

Why: browser audio elements with `crossOrigin = "anonymous"` (set by
the visualizer so Web Audio can read FFT samples) trigger CORS for any
cross-origin `audio.src`. Most Icecast / SHOUTcast servers don't return
CORS headers, so a direct cross-origin radio fetch fails silently and
playback never starts. Routing the stream through maneki serve
sidesteps the issue because the server's CORS middleware advertises
`Access-Control-Allow-Origin: *` on every response.

This module is the renderer-neutral half of that solution: the upstream
proxy generator + ICY-title parser. Two routes call into it:

  - `/web/radio-stream` (session-auth'd, browser UI from `web/routes.py`)
  - `/rest/radioStream` (Subsonic-auth'd, desktop wrappers from
    `serve/endpoints/radio.py`)
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from collections.abc import AsyncIterator

import httpx2 as httpx
from fastapi import Response
from fastapi.responses import StreamingResponse

from maneki import __version__
from maneki.audio import radio, radio_browser

_icy_titles: dict[str, str] = {}
# Up to the first `';`, not the first apostrophe: "Don't Stop Me Now" stopped at "Don" and never
# matched, and the song before it stayed on screen.
_ICY_TITLE_RE = re.compile(rb"StreamTitle='(.*?)';", re.DOTALL)


async def _points_inside(url: str) -> bool:
    """Whether a URL's host is (or resolves to) a private, loopback or otherwise local address."""
    host = httpx.URL(url).host
    if not host:
        return True
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError:
        # Unresolvable here is unreachable here; the fetch will fail on its own.
        return False
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            return True
    return False


async def _refuse_inside(request: httpx.Request) -> None:
    """Every hop of an offered station, redirects included, has to stay outside."""
    if await _points_inside(str(request.url)):
        raise httpx.ConnectError("refused: the station points inside this network", request=request)


def stream_title(meta: bytes) -> str | None:
    """The song a metadata frame announces, or None when it announces nothing."""
    match = _ICY_TITLE_RE.search(meta.rstrip(b"\x00"))
    if not match:
        return None
    title = match.group(1).decode("utf-8", errors="replace").strip()
    return title or None


def latest_icy_title(url: str) -> str:
    """Return the last-seen ICY StreamTitle for a station URL, or empty."""
    return _icy_titles.get(url, "")


async def proxy_station_stream(url: str) -> Response:
    """Proxy a single radio station's upstream stream with ICY-title parsing.

    Validates `url` against `radio.load_stations()` so this isn't an open
    proxy. If the upstream advertises `icy-metaint`, the response body is
    split into audio bytes (yielded to the client) and inline metadata
    frames (parsed for StreamTitle and stashed in `_icy_titles`).
    """
    # Known stations, and what a recent station search offered (so a result
    # can be tried before it is added). Anything else is refused: this is not
    # an open relay.
    allowed = {s.url for s in radio.load_stations()}
    offered = url not in allowed
    if offered and not radio_browser.was_offered(url):
        return Response("Unknown station", status_code=403)
    # A STATION FROM THE DIRECTORY STAYS OUTSIDE. radio-browser.info is open to anyone, so a station
    # found there, or a redirect it answers with, could make this server fetch an address on its
    # own network. Stations an admin added are trusted with the LAN; offered ones are not.
    if offered and await _points_inside(url):
        return Response("That station points inside this network", status_code=403)

    # A FRESH CONNECTION KNOWS NO TITLE YET. The last one seen was kept after the stream ended, so a
    # station played again showed a song from minutes before until its next title frame.
    _icy_titles.pop(url, None)
    hooks = {"request": [_refuse_inside]} if offered else {}
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None), event_hooks=hooks)
    try:
        upstream = await client.send(
            client.build_request(
                "GET",
                url,
                headers={"User-Agent": f"maneki/audio/{__version__}", "Icy-MetaData": "1"},
            ),
            stream=True,
            follow_redirects=True,
        )
    except httpx.HTTPError as exc:
        # Refused, unresolvable, timed out: the station's fault, said as a 502 rather than a 500
        # with a traceback, and the client let go of rather than left open.
        await client.aclose()
        return Response(f"Upstream unreachable: {type(exc).__name__}", status_code=502)
    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        return Response(f"Upstream {upstream.status_code}", status_code=502)

    metaint_header = upstream.headers.get("icy-metaint")
    metaint = int(metaint_header) if metaint_header and metaint_header.isdigit() else 0

    async def streamer() -> AsyncIterator[bytes]:
        try:
            if metaint == 0:
                async for chunk in upstream.aiter_raw():
                    yield chunk
                return
            buf = bytearray()
            state = "audio"
            audio_left = metaint
            meta_len = 0
            async for chunk in upstream.aiter_raw():
                buf.extend(chunk)
                while True:
                    if state == "audio":
                        if not buf:
                            break
                        n = min(audio_left, len(buf))
                        yield bytes(buf[:n])
                        del buf[:n]
                        audio_left -= n
                        if audio_left == 0:
                            state = "meta_len"
                        continue
                    if state == "meta_len":
                        if not buf:
                            break
                        meta_len = buf[0] * 16
                        del buf[:1]
                        if meta_len == 0:
                            audio_left = metaint
                            state = "audio"
                        else:
                            state = "meta_body"
                        continue
                    if len(buf) < meta_len:
                        break
                    meta_bytes = bytes(buf[:meta_len])
                    del buf[:meta_len]
                    title = stream_title(meta_bytes)
                    if title:
                        _icy_titles[url] = title
                    audio_left = metaint
                    state = "audio"
        finally:
            # The title goes with the stream: kept, a station played again showed a song from
            # minutes before, because the client asks for the title as it asks for the stream.
            _icy_titles.pop(url, None)
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        streamer(),
        media_type=upstream.headers.get("content-type", "audio/mpeg"),
    )
