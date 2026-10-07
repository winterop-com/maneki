"""Curated internet-radio station list.

Three sources merge at runtime:
  1. `~/.config/maneki/radio.toml`: the user's own stations, written by hand.
     The server only ever reads it, so comments and notes in it are safe.
  2. `~/.config/maneki/radio.db`: stations added from a client (the station
     search). A small SQLite table, so adding and removing never rewrites
     the hand-written file.
  3. `DEFAULT_STATIONS`: baked into the code and shipped with maneki.

`load_stations()` returns the union in that order, deduped by URL (the
first source wins on collision). Only stations from the database can be
removed from a client.
"""

from __future__ import annotations

import hashlib
import sqlite3
import tomllib
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel


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
    # The demoscene: tracker music, C64 remixes and scene productions, most of
    # them listener-requested. MP3 or AAC streams where a station offers one,
    # since Ogg is unreliable in the desktop app's WebKit.
    RadioStation(
        name="Nectarine Demoscene Radio",
        url="http://nectarine.from-de.com/necta192",
        description="Demoscene and tracker music, played by listener request",
        homepage="https://scenestream.net/demovibes/",
        logo=str(LOGOS_DIR / "scene-necta.png"),
    ),
    RadioStation(
        name="SceneSat Radio",
        url="https://streams.scenesat.com/main/hq.mp3",
        description="Demoscene music and live shows",
        homepage="https://scenesat.com/",
        logo=str(LOGOS_DIR / "scene-scenesat.png"),
    ),
    RadioStation(
        name="Kohina",
        url="https://player.kohina.com/icecast/stream.aac",
        description="Old school game and demo music",
        homepage="https://kohina.com/",
        logo=str(LOGOS_DIR / "scene-kohina.png"),
    ),
    RadioStation(
        name="SLAY Radio",
        url="http://relay3.slayradio.org:8000/",
        description="C64 remixes, live shows",
        homepage="https://www.slayradio.org/",
        logo=str(LOGOS_DIR / "scene-slay.png"),
    ),
    RadioStation(
        name="CVGM",
        url="https://slacker.cvgm.net/cvgm192",
        description="Chiptune, demoscene and game music, by listener request",
        homepage="https://radio.cvgm.net/demovibes/",
        logo=str(LOGOS_DIR / "scene-cvgm.png"),
    ),
    RadioStation(
        name="HYPR",
        url="https://hypr.website/hypr.mp3",
        description="Demoscene radio",
        homepage="https://hypr.website/",
        logo=str(LOGOS_DIR / "scene-hypr.png"),
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
# maneki never writes this file. Stations added from the app's station search
# are kept in radio.db beside it, and removed there too.
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
    """Return the user's stations (radio.toml, then those added from a client) and the defaults.

    Dedup by URL: an earlier source wins, so a hand-written entry overrides
    an added one and either overrides a default with the same URL.
    """
    user = _load_user_stations(path)
    by_url: dict[str, RadioStation] = {}
    ordered: list[RadioStation] = []
    for station in [*user, *_load_added_stations(path), *DEFAULT_STATIONS]:
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


class StationExistsError(ValueError):
    """The station is already in the list, by stream URL."""


def added_stations_path(path: Path | None = None) -> Path:
    """The database of stations added from a client: `radio.db` beside `radio.toml`."""
    return (path or stations_path()).with_name("radio.db")


def _connect(path: Path | None = None) -> sqlite3.Connection:
    target = added_stations_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(target)
    db.execute(
        "CREATE TABLE IF NOT EXISTS stations ("
        " url TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT, logo TEXT, added_at TEXT NOT NULL)"
    )
    return db


def _load_added_stations(path: Path | None = None) -> list[RadioStation]:
    """The stations added from a client, oldest first. None when there is no database yet."""
    if not added_stations_path(path).exists():
        return []
    db = _connect(path)
    try:
        rows = db.execute("SELECT name, url, homepage, logo FROM stations ORDER BY added_at, rowid").fetchall()
    finally:
        db.close()
    return [RadioStation(name=name, url=url, homepage=homepage, logo=logo) for name, url, homepage, logo in rows]


def user_station_urls(path: Path | None = None) -> set[str]:
    """The stream URLs of the stations added from a client: the ones a client may remove."""
    return {station.url for station in _load_added_stations(path)}


def add_station(station: RadioStation, path: Path | None = None) -> RadioStation:
    """Keep a station added from a client. Raises when its URL is already listed."""
    if any(existing.url == station.url for existing in load_stations(path)):
        raise StationExistsError(station.url)
    db = _connect(path)
    try:
        with db:
            db.execute(
                "INSERT INTO stations (url, name, homepage, logo, added_at) VALUES (?, ?, ?, ?, ?)",
                (station.url, station.name, station.homepage, station.logo, datetime.now(UTC).isoformat()),
            )
    except sqlite3.IntegrityError as exc:
        raise StationExistsError(station.url) from exc
    finally:
        db.close()
    return station


def remove_station(url: str, path: Path | None = None) -> bool:
    """Drop a station added from a client. False when it is not one (radio.toml or built in)."""
    if not added_stations_path(path).exists():
        return False
    db = _connect(path)
    try:
        with db:
            removed = db.execute("DELETE FROM stations WHERE url = ?", (url,)).rowcount
    finally:
        db.close()
    return removed > 0
