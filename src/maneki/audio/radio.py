"""Curated internet-radio station list.

Two sources merge at runtime:
  1. `DEFAULT_STATIONS` — baked into the code. Updated by us when we ship
     new stations; users automatically see them on next launch.
  2. `~/.config/maneki/radio.toml` — purely for the user's own additions.
     Format is the simple `[[stations]]` array-of-tables.

`load_stations()` returns the union, deduped by URL (user entries take
precedence on collision). That means the default list only grows in code,
the user's file only grows from their hand, and neither stomps the other.
"""

from __future__ import annotations

import hashlib
import threading
import tomllib
from pathlib import Path

from pydantic import BaseModel

from maneki.audio import _toml_dump


class RadioStation(BaseModel):
    """One curated streaming source."""

    name: str
    url: str
    description: str | None = None
    homepage: str | None = None
    # The station's logo: an http(s) URL or a path to an image file. Served to
    # clients as the station's cover art (`getCoverArt?id=rs_...`), so phone
    # apps and the web client load it from this server, never from the
    # station's own site.
    logo: str | None = None


# The built-in stations' logos, rendered once from NRK's own channel logos and
# shipped with maneki so the defaults show a logo without asking NRK each time.
LOGOS_DIR = Path(__file__).parent / "radio_logos"


def station_id(station: RadioStation) -> str:
    """`st_<sha1[:16] of the stream URL>`: the same station keeps its id as the list changes."""
    return "st_" + hashlib.sha1(station.url.encode("utf-8")).hexdigest()[:16]


def station_cover_id(station: RadioStation) -> str:
    """`rs_<sha1[:16] of the stream URL>`: stable across restarts and list order."""
    return "rs_" + hashlib.sha1(station.url.encode("utf-8")).hexdigest()[:16]


# Baked-in defaults. Add new entries here — `load_stations()` will pick
# them up on next launch without touching the user's TOML.
DEFAULT_STATIONS: list[RadioStation] = [
    RadioStation(
        name="NRK mP3",
        url="https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/mp3",
        description="NRK's pop / hits station",
        homepage="https://radio.nrk.no/direkte/mp3",
        logo=str(LOGOS_DIR / "nrk-mp3.png"),
    ),
    RadioStation(
        name="NRK P3",
        url="https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/p3",
        description="NRK P3 — youth talk + music",
        homepage="https://radio.nrk.no/direkte/p3",
        logo=str(LOGOS_DIR / "nrk-p3.png"),
    ),
    RadioStation(
        name="NRK P3 Musikk",
        url="https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/p3musikk",
        description="P3-style music, no talk",
        homepage="https://radio.nrk.no/direkte/p3musikk",
        logo=str(LOGOS_DIR / "nrk-p3-musikk.png"),
    ),
    RadioStation(
        name="NRK Nyheter",
        url="https://lyd.nrk.no/icecast/aac/high/s0w7hwn47m/nyheter",
        description="NRK news (no music)",
        homepage="https://radio.nrk.no/direkte/nyheter",
        logo=str(LOGOS_DIR / "nrk-nyheter.png"),
    ),
]


_USER_TEMPLATE = """\
# maneki radio stations — your custom additions go here.
#
# maneki ships curated defaults (see `DEFAULT_STATIONS` in
# `src/maneki/audio/radio.py`). Anything you add below appears alongside
# them in the SPA's Radio list. Stations are deduped by URL; if a user
# entry shares a URL with a baked-in default, your version wins.
#
# Format:
#   [[stations]]
#   name = "Station name"
#   url = "https://example/stream"
#   description = "Short description"   # optional
#   homepage = "https://example.com"    # optional
#   logo = "https://example.com/logo.png" # optional; a URL or an image file path
"""


def stations_path() -> Path:
    """Default location of the user's `radio.toml`."""
    return Path.home() / ".config" / "maneki" / "radio.toml"


def load_stations(path: Path | None = None) -> list[RadioStation]:
    """Return user-defined stations (from `radio.toml`) merged with defaults.

    User entries come first in the result; default-only entries are appended
    behind them. Dedup by URL — a user entry with the same URL as a default
    silently overrides the default.
    """
    user = _load_user_stations(path)
    by_url: dict[str, RadioStation] = {}
    ordered: list[RadioStation] = []
    for station in [*user, *DEFAULT_STATIONS]:
        if station.url in by_url:
            continue
        by_url[station.url] = station
        ordered.append(station)
    return ordered


def _load_user_stations(path: Path | None = None) -> list[RadioStation]:
    """Read just the user's `radio.toml` — no defaults merged in."""
    target = path or stations_path()
    if not target.exists():
        return []
    with target.open("rb") as f:
        data = tomllib.load(f)
    raw = data.get("stations") or []
    stations: list[RadioStation] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        try:
            stations.append(RadioStation(**entry))
        except (TypeError, ValueError):
            continue
    return stations


def seed_default_config(path: Path | None = None) -> Path:
    """Create an empty user-template `radio.toml` if none exists.

    Defaults live in code now, so the file we seed is just a comment
    explaining the format — the user's TOML is purely for their own
    additions.
    """
    target = path or stations_path()
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_USER_TEMPLATE, encoding="utf-8")
    return target


# One writer at a time: two clients adding stations at once would each read the
# file, add theirs and write, and one of the two would be lost.
_write_lock = threading.Lock()


class StationExistsError(ValueError):
    """The station is already in the list, by stream URL."""


def user_station_urls(path: Path | None = None) -> set[str]:
    """The stream URLs of the stations from `radio.toml`: the ones that may be removed."""
    return {station.url for station in _load_user_stations(path)}


def add_station(station: RadioStation, path: Path | None = None) -> RadioStation:
    """Append a station to the user's `radio.toml`. Raises when its URL is already listed."""
    with _write_lock:
        if any(existing.url == station.url for existing in load_stations(path)):
            raise StationExistsError(station.url)
        _write_user_stations([*_load_user_stations(path), station], path)
    return station


def remove_station(url: str, path: Path | None = None) -> bool:
    """Drop a station from the user's `radio.toml`. False when it is not one of the user's."""
    with _write_lock:
        user = _load_user_stations(path)
        kept = [station for station in user if station.url != url]
        if len(kept) == len(user):
            return False
        _write_user_stations(kept, path)
    return True


def _write_user_stations(stations: list[RadioStation], path: Path | None = None) -> None:
    """Rewrite `radio.toml` as the format comment followed by one table per station."""
    target = path or stations_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    body = _toml_dump.dumps({"stations": [s.model_dump(exclude_none=True) for s in stations]}) if stations else ""
    target.write_text(_USER_TEMPLATE + ("\n" + body if body else ""), encoding="utf-8")
