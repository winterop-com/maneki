"""Per-user playlists over the Subsonic API.

getPlaylists / getPlaylist / createPlaylist / updatePlaylist / deletePlaylist,
all scoped to the authenticated account via `request.state.playlists`. Track
entries are resolved from stored Subsonic IDs against the live library cache;
unresolved IDs are silently skipped so a moved/deleted file never breaks a
playlist.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request

from maneki.audio.serve.app import envelope, error_envelope
from maneki.audio.serve.index import IndexCache
from maneki.audio.serve.payloads import song_payload
from maneki.audio.serve.playlists import Playlist, PlaylistStore
from maneki.audio.serve.stars import StarStore

router = APIRouter()


def _store(request: Request) -> PlaylistStore:
    return request.state.playlists  # type: ignore[no-any-return]


def _cache(request: Request) -> IndexCache:
    return request.app.state.cache  # type: ignore[no-any-return]


def _stars(request: Request) -> StarStore:
    return request.state.stars  # type: ignore[no-any-return]


def _entries(pl: Playlist, cache: IndexCache, stars: StarStore) -> list[dict[str, Any]]:
    """Resolve the playlist's track IDs to enriched song payloads (skip missing)."""
    out: list[dict[str, Any]] = []
    for tid in pl.track_ids:
        pair = cache.tracks_by_id.get(tid)
        if pair is None:
            continue
        album, track = pair
        out.append(stars.enrich(song_payload(album, track)))
    return out


def _summary(pl: Playlist, entries: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": pl.id,
        "name": pl.name,
        "owner": pl.owner,
        "public": False,
        "songCount": len(entries),
        "duration": sum(int(e.get("duration", 0)) for e in entries),
        "created": pl.created,
        "changed": pl.changed,
        "coverArt": pl.id,
    }


@router.api_route("/getPlaylists", methods=["GET", "POST", "HEAD"])
@router.api_route("/getPlaylists.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_playlists(request: Request) -> dict:
    """List the current user's playlists."""
    store, cache, stars = _store(request), _cache(request), _stars(request)
    playlists = [_summary(pl, _entries(pl, cache, stars)) for pl in store.all()]
    return envelope("playlists", {"playlist": playlists})


@router.api_route("/getPlaylist", methods=["GET", "POST", "HEAD"])
@router.api_route("/getPlaylist.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_playlist(request: Request, id: str = Query(...)) -> dict:
    """A single playlist with its resolved song entries."""
    pl = _store(request).get(id)
    if pl is None:
        return error_envelope(70, f"Playlist not found: {id}")
    entries = _entries(pl, _cache(request), _stars(request))
    return envelope("playlist", {**_summary(pl, entries), "entry": entries})


@router.api_route("/createPlaylist", methods=["GET", "POST", "HEAD"])
@router.api_route("/createPlaylist.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def create_playlist(
    request: Request,
    name: str | None = Query(default=None),
    playlistId: str | None = Query(default=None),
    songId: list[str] = Query(default=[]),
) -> dict:
    """Create a playlist, or (with `playlistId`) replace an existing one's songs."""
    store = _store(request)
    if playlistId is not None:
        pl = store.update(playlistId, name=name, set_ids=list(songId))
        if pl is None:
            return error_envelope(70, f"Playlist not found: {playlistId}")
    else:
        pl = store.create(name or "Untitled", list(songId))
    entries = _entries(pl, _cache(request), _stars(request))
    return envelope("playlist", {**_summary(pl, entries), "entry": entries})


@router.api_route("/updatePlaylist", methods=["GET", "POST", "HEAD"])
@router.api_route("/updatePlaylist.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def update_playlist(
    request: Request,
    playlistId: str = Query(...),
    name: str | None = Query(default=None),
    songIdToAdd: list[str] = Query(default=[]),
    songIndexToRemove: list[int] = Query(default=[]),
) -> dict:
    """Rename and/or add/remove songs in a playlist."""
    pl = _store(request).update(
        playlistId,
        name=name,
        add_ids=list(songIdToAdd),
        remove_indices=list(songIndexToRemove),
    )
    if pl is None:
        return error_envelope(70, f"Playlist not found: {playlistId}")
    return envelope()


@router.api_route("/deletePlaylist", methods=["GET", "POST", "HEAD"])
@router.api_route("/deletePlaylist.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def delete_playlist(request: Request, id: str = Query(...)) -> dict:
    """Delete a playlist owned by the current user."""
    if not _store(request).delete(id):
        return error_envelope(70, f"Playlist not found: {id}")
    return envelope()
