"""Finding stations in radio-browser.info, the open community directory of internet radio.

radio-browser is a free directory of some 50,000 stations with a public JSON API: stream
URLs, logos, country, tags, codec and bitrate. maneki asks it on the client's behalf, so the
client talks to one server and the server can play what it found.

PLAYING A RESULT BEFORE ADDING IT. The radio proxy only relays stations it knows, so it is
not an open relay. A search result is not known yet, so the stream URLs a search hands out
are remembered for a while (`was_offered`) and the proxy plays those as well: somebody can
listen to a station before deciding to keep it.
"""

from __future__ import annotations

from collections import OrderedDict
from threading import Lock

import httpx2 as httpx
from pydantic import BaseModel, ConfigDict

from maneki import __version__

#: Tried in order. `all.` resolves to whichever mirrors are up; the named ones are fallbacks.
HOSTS = ("all.api.radio-browser.info", "de1.api.radio-browser.info", "de2.api.radio-browser.info")

#: How many results one search returns at most.
DEFAULT_LIMIT = 30

#: How many offered stream URLs are remembered for the proxy, newest kept.
_OFFERED_MAX = 1000


class FoundStation(BaseModel):
    """One station as a search found it."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    stream_url: str
    homepage: str | None = None
    logo: str | None = None
    country: str | None = None
    country_code: str | None = None
    tags: tuple[str, ...] = ()
    codec: str | None = None
    bitrate: int | None = None


class RadioBrowserError(RuntimeError):
    """No radio-browser mirror answered."""


_offered: OrderedDict[str, None] = OrderedDict()
_offered_lock = Lock()


def was_offered(url: str) -> bool:
    """True when a recent search handed this stream URL out, so the proxy may play it."""
    with _offered_lock:
        return url in _offered


def _remember(urls: list[str]) -> None:
    with _offered_lock:
        for url in urls:
            _offered[url] = None
            _offered.move_to_end(url)
        while len(_offered) > _OFFERED_MAX:
            _offered.popitem(last=False)


def _parse(raw: dict[str, object]) -> FoundStation | None:
    """One API row as a `FoundStation`, or None for a row with nothing to play."""
    stream = str(raw.get("url_resolved") or raw.get("url") or "").strip()
    name = str(raw.get("name") or "").strip()
    if not stream.startswith(("http://", "https://")) or not name:
        return None

    def text(key: str) -> str | None:
        value = str(raw.get(key) or "").strip()
        return value or None

    bitrate = raw.get("bitrate")
    tags = tuple(tag.strip() for tag in str(raw.get("tags") or "").split(",") if tag.strip())
    return FoundStation(
        id=str(raw.get("stationuuid") or stream),
        name=name,
        stream_url=stream,
        homepage=text("homepage"),
        logo=text("favicon"),
        country=text("country"),
        country_code=text("countrycode"),
        tags=tags[:6],
        codec=text("codec"),
        bitrate=bitrate if isinstance(bitrate, int) and bitrate > 0 else None,
    )


async def search(query: str, *, limit: int = DEFAULT_LIMIT) -> list[FoundStation]:
    """Stations whose name matches `query`, the most listened to first, broken ones left out."""
    params: dict[str, str | int] = {
        "name": query.strip(),
        "hidebroken": "true",
        "order": "clickcount",
        "reverse": "true",
        "limit": max(1, min(limit, 100)),
    }
    headers = {"User-Agent": f"maneki/{__version__}"}
    async with httpx.AsyncClient(timeout=10.0, headers=headers, follow_redirects=True) as client:
        for host in HOSTS:
            try:
                response = await client.get(f"https://{host}/json/stations/search", params=params)
                response.raise_for_status()
                rows = response.json()
            except (httpx.HTTPError, ValueError):
                continue
            found = [station for row in rows if isinstance(row, dict) and (station := _parse(row))]
            _remember([station.stream_url for station in found])
            return found
    raise RadioBrowserError("no radio-browser mirror answered")
