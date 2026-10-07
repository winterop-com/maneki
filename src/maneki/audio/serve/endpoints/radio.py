"""Subsonic internet-radio endpoints, backed by `radio.load_stations()`.

`radio.toml` (defaults + user-edited) is the source of truth.
`getInternetRadioStations` exposes that list to Subsonic clients (Symfonium,
Amperfy, the local web UI). Write endpoints (create/update/delete) stay as
success no-ops — stations are managed in the TOML file, not via the API.
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse, Response

from maneki.audio import radio, radio_browser
from maneki.audio.serve.app import envelope, error_envelope
from maneki.audio.serve.radio_proxy import latest_icy_title, proxy_station_stream

router = APIRouter()


def _station_payload() -> list[dict[str, str | bool]]:
    """Render `radio.load_stations()` into Subsonic spec shape."""
    out: list[dict[str, str | bool]] = []
    user = radio.user_station_urls()
    for station in radio.load_stations():
        item: dict[str, str | bool] = {"id": radio.station_id(station), "name": station.name, "streamUrl": station.url}
        if station.homepage:
            item["homepageUrl"] = station.homepage
        if station.logo:
            # Not in the Subsonic spec for stations, the way `coverArt` is for
            # albums; clients that do not know it ignore it, and ours shows it.
            item["coverArt"] = radio.station_cover_id(station)
        if station.url in user:
            # Maneki extension: added from a client (radio.db), so it can be removed.
            item["custom"] = True
        out.append(item)
    return out


@router.api_route("/getInternetRadioStations", methods=["GET", "POST", "HEAD"])
@router.api_route("/getInternetRadioStations.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_internet_radio_stations() -> dict:
    """Return defaults + radio.toml stations in Subsonic shape."""
    return envelope("internetRadioStations", {"internetRadioStation": _station_payload()})


@router.api_route("/createInternetRadioStation", methods=["GET", "POST", "HEAD"])
@router.api_route("/createInternetRadioStation.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def create_internet_radio_station(
    streamUrl: str = Query(...),  # noqa: N803 - Subsonic spec uses camelCase
    name: str = Query(...),
    homepageUrl: str | None = Query(default=None),  # noqa: N803
    logo: str | None = Query(default=None),
) -> dict:
    """Keep a station on this server (radio.db). `logo` (an image URL) is a Maneki extension."""
    if not streamUrl.startswith(("http://", "https://")):
        return error_envelope(10, "streamUrl must be an http(s) URL")
    station = radio.RadioStation(
        name=name.strip() or streamUrl,
        url=streamUrl,
        homepage=homepageUrl or None,
        logo=logo if logo and logo.startswith(("http://", "https://")) else None,
    )
    try:
        radio.add_station(station)
    except radio.StationExistsError:
        return error_envelope(0, f"{station.name} is already in the list")
    except (OSError, sqlite3.Error) as exc:
        return error_envelope(0, f"The station could not be saved: {exc}")
    return envelope()


@router.api_route("/updateInternetRadioStation", methods=["GET", "POST", "HEAD"])
@router.api_route("/updateInternetRadioStation.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def update_internet_radio_station() -> dict:
    """No-op — stations live in the local config."""
    return envelope()


@router.api_route("/deleteInternetRadioStation", methods=["GET", "POST", "HEAD"])
@router.api_route("/deleteInternetRadioStation.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def delete_internet_radio_station(id: str = Query(...)) -> dict:
    """Remove a station added from a client. Built-in and radio.toml stations stay."""
    station = next((s for s in radio.load_stations() if radio.station_id(s) == id), None)
    if station is None:
        return error_envelope(70, f"Station not found: {id}")
    try:
        removed = radio.remove_station(station.url)
    except (OSError, sqlite3.Error) as exc:
        return error_envelope(0, f"The station could not be removed: {exc}")
    if not removed:
        return error_envelope(50, f"{station.name} is built in or listed in radio.toml, so it is not removed here")
    return envelope()


@router.api_route("/searchRadioStations", methods=["GET", "POST", "HEAD"])
@router.api_route("/searchRadioStations.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def search_radio_stations(query: str = Query(...), limit: int = Query(default=30, ge=1, le=100)) -> dict:
    """Search radio-browser.info for stations. Non-standard Maneki extension.

    Each result can be played straight away through `radioStream` (a search
    offers it to the proxy) and kept with `createInternetRadioStation`.
    """
    if len(query.strip()) < 2:
        return envelope("radioSearch", {"station": []})
    try:
        found = await radio_browser.search(query, limit=limit)
    except radio_browser.RadioBrowserError as exc:
        return error_envelope(0, str(exc))
    listed = {station.url for station in radio.load_stations()}
    return envelope(
        "radioSearch",
        {
            "station": [
                {
                    "id": f.id,
                    "name": f.name,
                    "streamUrl": f.stream_url,
                    **({"homepageUrl": f.homepage} if f.homepage else {}),
                    **({"logo": f.logo} if f.logo else {}),
                    **({"country": f.country} if f.country else {}),
                    **({"countryCode": f.country_code} if f.country_code else {}),
                    "tags": list(f.tags),
                    **({"codec": f.codec} if f.codec else {}),
                    **({"bitrate": f.bitrate} if f.bitrate else {}),
                    "added": f.stream_url in listed,
                }
                for f in found
            ]
        },
    )


@router.api_route("/radioStream", methods=["GET", "POST", "HEAD"])
@router.api_route("/radioStream.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def radio_stream(url: str) -> Response:
    """Same-origin proxy for a radio station's upstream stream (Subsonic-auth'd).

    Non-standard Maneki extension. Designed for the desktop wrappers
    (Tauri / Electron): their `<audio>` element keeps `crossOrigin =
    "anonymous"` so the visualizer can read FFT samples, which means
    any cross-origin `audio.src` triggers a CORS preflight. Icecast /
    SHOUTcast stations don't return CORS headers, so direct playback
    fails silently. Routing the stream through this endpoint adds the
    server's open CORS headers and audio loads. Same allowlist gate
    as `/web/radio-stream` (URL must be in `radio.load_stations()`).
    """
    return await proxy_station_stream(url)


@router.api_route("/radioMeta", methods=["GET", "POST", "HEAD"])
@router.api_route("/radioMeta.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def radio_meta(url: str) -> Response:
    """Return the last-seen ICY StreamTitle for a station URL, parsed by the proxy.

    Cheap polling endpoint mirroring `/web/radio-meta` for Subsonic clients.
    Returns `{"title": ""}` when the station hasn't sent metadata yet.
    """
    return JSONResponse({"title": latest_icy_title(url)})
