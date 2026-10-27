"""Stub endpoints — keep clients quiet on features we don't track.

These return well-formed empty responses for things maneki doesn't
actually store (scrobbles, stars/favourites, playlists, artist bios).
Implementing them as no-ops is much friendlier than letting clients
log 404s on every play.

Real implementations would back these with persistent state; for now,
the goal is just to make the API surface complete enough that:
  - play:Sub stops reporting "scrobble failed" errors
  - artist screens render (even with empty bios) instead of erroring
  - "Random songs" / "Starred" tabs in clients show empty lists
    instead of error toasts
"""

from __future__ import annotations

import random as random_mod
from typing import Any

from fastapi import APIRouter, Query, Request

from maneki.audio.serve.app import envelope, error_envelope
from maneki.audio.serve.artist_images import ArtistImages, deezer_sized
from maneki.audio.serve.index import IndexCache
from maneki.audio.serve.payloads import album_payload, artist_summary, song_payload
from maneki.audio.serve.scrobble import ScrobbleDispatcher, ScrobbleEvent
from maneki.audio.serve.stars import StarStore
from maneki.books.library import BooksIndex
from maneki.books.subsonic import (
    author_id,
    book_payload,
    books_by,
    collection_groups,
    collection_id,
    file_payload,
    find_author,
    find_book,
    find_collection,
    find_group,
    group_items,
    group_name,
    group_payload,
    is_book_id,
)

router = APIRouter()


def _get_cache(request: Request) -> IndexCache:
    return request.app.state.cache  # type: ignore[no-any-return]


def _get_stars(request: Request) -> StarStore:
    return request.state.stars  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------
# Scrobble — clients send this after every play. We don't track plays.
# ---------------------------------------------------------------------------

# How far back a client's own `time` is believed. A play kept while the server was out of reach
# is sent with the moment it happened, so history lands in order; anything older than this, or
# ahead of the server's clock, is a wrong clock rather than a late play, and is filed as now.
_LATE_PLAY_S = 30 * 24 * 3600
_CLOCK_SKEW_S = 60


def _played_at(time_ms: int | None, now: float) -> float:
    """When a play happened: the client's `time` if it is believable, otherwise now."""
    if time_ms is None:
        return now
    told = time_ms / 1000
    return told if now - _LATE_PLAY_S <= told <= now + _CLOCK_SKEW_S else now


@router.api_route("/scrobble", methods=["GET", "POST", "HEAD"])
@router.api_route("/scrobble.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def scrobble(
    request: Request,
    id: str | None = Query(default=None),
    time: int | None = Query(default=None),
    submission: bool = Query(default=True),
    u: str | None = Query(default=None),
) -> dict:
    """Forward the play event to configured webhook / MQTT targets, or no-op.

    The Subsonic spec defines `submission=false` as the "now playing"
    probe (fired at track start) and `submission=true` as the "I
    finished playing this" event (fired at track end / threshold).
    Forwarders default to true-only; flip `[scrobble].include_now_playing`
    to receive both.

    `time` is the start time of playback in unix-millis (per the spec). A client sends it
    for plays it kept while the server was out of reach; see `_played_at` for when it is
    believed. Falls back to "now" when the client doesn't send it.
    """
    cache = _get_cache(request)
    dispatcher: ScrobbleDispatcher = request.app.state.scrobble

    # No id → invalid request shape; still ack so the client doesn't bark.
    if not id:
        return envelope()
    # Resolve track for the payload. Unknown ID → still ack; just don't forward.
    pair = cache.tracks_by_id.get(id)
    if pair is None:
        return envelope()

    album, track = pair
    # The authenticated account (require_auth verified `u` against it).
    user = request.state.username

    import time as time_mod
    from datetime import UTC, datetime

    played = _played_at(time, time_mod.time())
    event = ScrobbleEvent(
        user=user,
        track_id=id,
        title=track.title or track.path.stem,
        artist=track.artist or album.artist_dir,
        album=album.tag_album or album.album_dir,
        duration_s=float(track.duration_s or 0.0),
        played_at=datetime.fromtimestamp(played, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        submission=bool(submission),
    )
    dispatcher.dispatch(event)
    # Record to the user's listening history (powers now-playing + recent/
    # frequent + play counts). submission=False is the now-playing probe.
    request.state.history.record(id, submission=bool(submission), now=played)
    return envelope()


# ---------------------------------------------------------------------------
# Artist info — biography + similar artists. We don't have either source.
# ---------------------------------------------------------------------------


def _empty_artist_info(_artist_id: str) -> dict[str, Any]:
    return {
        "biography": "",
        "musicBrainzId": "",
        "lastFmUrl": "",
        "smallImageUrl": "",
        "mediumImageUrl": "",
        "largeImageUrl": "",
        "similarArtist": [],
    }


def _artist_info(request: Request, artist_id: str) -> dict[str, Any]:
    """Artist info with what the picture lookup found: the MusicBrainz id, and where the photo is.

    A Deezer photo is named by its CDN URL at three sizes, which is what third-party clients
    draw. A stored Commons photo is reached through `getCoverArt` like any cover, so it adds no
    URL here; it adds `imageCredit`, the author and licence the photo must be shown with. Extra
    keys are ignored by clients that do not know them.
    """
    info = _empty_artist_info(artist_id)
    images: ArtistImages | None = getattr(request.app.state, "artist_images", None)
    entry = images.entry(artist_id) if images is not None else None
    if images is None or entry is None:
        return info
    if entry.mbid:
        info["musicBrainzId"] = entry.mbid
    if entry.source == "deezer" and entry.url and images.online:
        info["smallImageUrl"] = deezer_sized(entry.url, 250)
        info["mediumImageUrl"] = deezer_sized(entry.url, 500)
        info["largeImageUrl"] = deezer_sized(entry.url, 1000)
    if entry.source == "wikimedia" and entry.credit is not None and images.stored_file(entry) is not None:
        info["imageCredit"] = entry.credit.model_dump()
    return info


@router.api_route("/getArtistInfo", methods=["GET", "POST", "HEAD"])
@router.api_route("/getArtistInfo.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_artist_info(request: Request, id: str = Query(...)) -> dict:
    """Artist info (legacy v1 endpoint): no biography or similar artists, a picture where one was found."""
    return envelope("artistInfo", _artist_info(request, id))


@router.api_route("/getArtistInfo2", methods=["GET", "POST", "HEAD"])
@router.api_route("/getArtistInfo2.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_artist_info2(request: Request, id: str = Query(...)) -> dict:
    """Artist info (modern v3 endpoint): no biography or similar artists, a picture where one was found."""
    return envelope("artistInfo2", _artist_info(request, id))


# ---------------------------------------------------------------------------
# getMusicDirectory — legacy folder browse. Routes by ID prefix to the
# corresponding modern endpoint's data.
# ---------------------------------------------------------------------------


@router.api_route("/getMusicDirectory", methods=["GET", "POST", "HEAD"])
@router.api_route("/getMusicDirectory.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_music_directory(request: Request, id: str = Query(...)) -> dict:
    """Legacy folder browse. `ar_*` → albums; `al_*` → tracks; books the same way.

    This is how a folder-browsing client (play:Sub) walks the library, so an
    audiobook author and an audiobook have to answer it as an artist and an
    album do. Without it, books are reachable by ID3 browse alone.
    """
    cache = _get_cache(request)
    books = _books(request)
    if books is not None and is_book_id(id):
        return _book_directory(request, books, id)
    if id.startswith("ar_"):
        albums = cache.artists_by_id.get(id)
        if albums is None:
            return error_envelope(70, f"Directory not found: {id}")
        sorted_albums = sorted(albums, key=lambda a: (a.tag_year or "9999", (a.tag_album or a.album_dir).casefold()))
        return envelope(
            "directory",
            {
                "id": id,
                "name": cache.artist_name_by_id[id],
                "child": [_directory_child(album_payload(a, with_songs=False)) for a in sorted_albums],
            },
        )
    if id.startswith("al_"):
        album = cache.albums_by_id.get(id)
        if album is None:
            return error_envelope(70, f"Directory not found: {id}")
        return envelope(
            "directory",
            {
                "id": id,
                "name": album.tag_album or album.album_dir,
                "parent": next(iter([k for k, v in cache.artists_by_id.items() if album in v]), None),
                "child": [song_payload(album, t) for t in album.tracks],
            },
        )
    return error_envelope(70, f"Unknown directory id format: {id}")


def _directory_child(payload: dict) -> dict:
    """An album or a book as a folder inside a directory listing.

    The spec's `child` element names a folder by `title`, not `name`, and a
    client that reads it by the letter (Amperfy) drew every author and
    artist folder empty while `name` was the only word on it. Both are
    carried, because `name` is what the album payload says and what the
    clients that tolerated it still read.
    """
    return {**payload, "isDir": True, "title": payload["name"]}


def _books(request: Request) -> BooksIndex | None:
    """The audiobook index, when this root has one."""
    return getattr(request.app.state, "books", None)


def _book_directory(request: Request, books: BooksIndex, id: str) -> dict:
    """One audiobook author or book, as a legacy directory listing."""
    author = find_author(books, id)
    if author is not None:
        return envelope(
            "directory",
            {
                "id": id,
                "name": author,
                "child": [
                    _directory_child(book_payload(b, with_songs=False, added_s=books.added(b)))
                    for b in books_by(books, author)
                ],
            },
        )
    collection = find_collection(books, id)
    if collection is not None:
        return envelope(
            "directory",
            {
                "id": id,
                "name": collection,
                "child": [
                    _directory_child(group_payload(books, collection, g, with_songs=False))
                    for g in collection_groups(books, collection)
                ],
            },
        )
    found = find_group(books, id)
    if found is not None:
        collection, group = found
        saved_at = {p.book_id: p.position_s for p in request.state.progress.all()}
        return envelope(
            "directory",
            {
                "id": id,
                "name": group_name(collection, group),
                "parent": collection_id(collection),
                "child": [
                    {**file_payload(b, 0, position_s=saved_at.get(b.id, 0.0)), "track": n}
                    for n, b in enumerate(group_items(books, collection, group), start=1)
                ],
            },
        )
    book = find_book(books, id)
    if book is None:
        return error_envelope(70, f"Directory not found: {id}")
    saved = request.state.progress.get(book.id)
    position = saved.position_s if saved else 0.0
    return envelope(
        "directory",
        {
            "id": id,
            "name": book.title,
            "parent": author_id(book.author),
            "child": [file_payload(book, i, position_s=position) for i in range(len(book.files))],
        },
    )


# ---------------------------------------------------------------------------
# getRandomSongs — used by clients' home screens / "shuffle all" buttons.
# ---------------------------------------------------------------------------


@router.api_route("/getRandomSongs", methods=["GET", "POST", "HEAD"])
@router.api_route("/getRandomSongs.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_random_songs(
    request: Request,
    size: int = Query(default=10, ge=1, le=500),
    fromYear: int | None = Query(default=None),
    toYear: int | None = Query(default=None),
) -> dict:
    """Return up to `size` random songs from the cache."""
    cache = _get_cache(request)
    pool = list(cache.tracks_by_id.values())
    if fromYear is not None and toYear is not None:
        lo, hi = (fromYear, toYear) if fromYear <= toYear else (toYear, fromYear)
        pool = [(a, t) for a, t in pool if t.year and t.year.isdigit() and lo <= int(t.year) <= hi]
    if not pool:
        return envelope("randomSongs", {"song": []})
    sample = random_mod.sample(pool, min(size, len(pool)))
    return envelope("randomSongs", {"song": [song_payload(album, track) for album, track in sample]})


# ---------------------------------------------------------------------------
# Stars / favourites — return empty + accept no-op writes.
# ---------------------------------------------------------------------------


def _build_starred_payload(cache: IndexCache, stars: StarStore) -> dict[str, Any]:
    """Categorised lists of currently-starred entries.

    Resolves each starred ID against the cache and silently filters out
    "ghost" entries (file deleted / renamed since starring) — the
    client should never see broken rows. To clean up the underlying
    file, call `stars.prune(...)` separately.
    """
    artists: list[dict[str, Any]] = []
    albums: list[dict[str, Any]] = []
    songs: list[dict[str, Any]] = []

    for sid, ts in stars.all_ids().items():
        if sid.startswith("ar_") and sid in cache.artists_by_id:
            entry = artist_summary(cache, sid)
            entry["starred"] = ts
            artists.append(entry)
        elif sid.startswith("al_") and sid in cache.albums_by_id:
            entry = album_payload(cache.albums_by_id[sid], with_songs=False)
            entry["starred"] = ts
            albums.append(entry)
        elif sid.startswith("tr_") and sid in cache.tracks_by_id:
            album, track = cache.tracks_by_id[sid]
            entry = song_payload(album, track)
            entry["starred"] = ts
            songs.append(entry)

    # Sort within each kind by `starred` desc so the most-recent show up first.
    # Clients (Symfonium / Amperfy) don't sort the response themselves.
    artists.sort(key=lambda d: d.get("starred", ""), reverse=True)
    albums.sort(key=lambda d: d.get("starred", ""), reverse=True)
    songs.sort(key=lambda d: d.get("starred", ""), reverse=True)
    return {"artist": artists, "album": albums, "song": songs}


@router.api_route("/getStarred", methods=["GET", "POST", "HEAD"])
@router.api_route("/getStarred.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_starred(request: Request) -> dict:
    """Return artists / albums / songs currently starred by the user."""
    return envelope("starred", _build_starred_payload(_get_cache(request), _get_stars(request)))


@router.api_route("/getStarred2", methods=["GET", "POST", "HEAD"])
@router.api_route("/getStarred2.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_starred2(request: Request) -> dict:
    """v2 of getStarred — same payload shape; the wrapper key differs."""
    return envelope("starred2", _build_starred_payload(_get_cache(request), _get_stars(request)))


@router.api_route("/star", methods=["GET", "POST", "HEAD"])
@router.api_route("/star.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def star(
    request: Request,
    id: str | None = Query(default=None),
    albumId: str | None = Query(default=None),  # noqa: N803 — Subsonic spec uses camelCase
    artistId: str | None = Query(default=None),  # noqa: N803
) -> dict:
    """Star one or more entities. Subsonic accepts any combination of `id`, `albumId`, `artistId`.

    The `id` parameter accepts artist / album / track IDs (clients tend
    to pass through whatever is currently selected); `albumId` and
    `artistId` are explicit kind-typed variants. We star every ID
    provided — unknown IDs are silently ignored so a stale client
    request doesn't 500.
    """
    stars = _get_stars(request)
    cache = _get_cache(request)
    for sid in _collect_ids(id, albumId, artistId):
        if _id_resolves(cache, sid):
            stars.add(sid)
    return envelope()


@router.api_route("/unstar", methods=["GET", "POST", "HEAD"])
@router.api_route("/unstar.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def unstar(
    request: Request,
    id: str | None = Query(default=None),
    albumId: str | None = Query(default=None),  # noqa: N803
    artistId: str | None = Query(default=None),  # noqa: N803
) -> dict:
    """Unstar — symmetric with /star. Idempotent on already-unstarred IDs."""
    stars = _get_stars(request)
    for sid in _collect_ids(id, albumId, artistId):
        stars.remove(sid)
    return envelope()


def _collect_ids(*sources: str | None) -> list[str]:
    """Collect Subsonic IDs from /star query params, dedup, drop blanks."""
    out: list[str] = []
    seen: set[str] = set()
    for src in sources:
        if not src:
            continue
        # Subsonic clients sometimes send comma-separated lists for `id`.
        for sid in src.split(","):
            sid = sid.strip()
            if sid and sid not in seen:
                seen.add(sid)
                out.append(sid)
    return out


def _id_resolves(cache: IndexCache, sid: str) -> bool:
    """True iff `sid` matches a current artist / album / track in the cache."""
    if sid.startswith("ar_"):
        return sid in cache.artists_by_id
    if sid.startswith("al_"):
        return sid in cache.albums_by_id
    if sid.startswith("tr_"):
        return sid in cache.tracks_by_id
    return False


# ---------------------------------------------------------------------------
# Users — single-user server. Feishin / Supersonic / others probe getUser
# right after login to learn the role flags.
# ---------------------------------------------------------------------------


def _user_payload(username: str, *, admin: bool) -> dict[str, Any]:
    """Subsonic role flags for an account; `admin` gates the management roles."""
    return {
        "username": username,
        "email": f"{username}@maneki.audio.local",
        "scrobblingEnabled": True,
        "adminRole": admin,
        "settingsRole": admin,
        "downloadRole": True,
        "uploadRole": False,
        "playlistRole": True,
        "coverArtRole": True,
        "commentRole": False,
        "podcastRole": False,
        "streamRole": True,
        "jukeboxRole": False,
        "shareRole": False,
        "videoConversionRole": False,
        "folder": [1],
    }


@router.api_route("/getUser", methods=["GET", "POST", "HEAD"])
@router.api_route("/getUser.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_user(request: Request, username: str | None = Query(default=None)) -> dict:
    """Return an account's role flags. Non-admins may only query themselves."""
    registry = request.app.state.users
    target = username or request.state.username
    if not request.state.admin and target != request.state.username:
        return error_envelope(50, "Only an admin can look up another account.")
    account = registry.get(target)
    if account is None:
        return error_envelope(70, f"User not found: {target}")
    return envelope("user", _user_payload(account.name, admin=account.admin))


@router.api_route("/getUsers", methods=["GET", "POST", "HEAD"])
@router.api_route("/getUsers.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_users(request: Request) -> dict:
    """List accounts — admins see everyone, others see only themselves."""
    registry = request.app.state.users
    if request.state.admin:
        accounts = registry.all()
    else:
        me = registry.get(request.state.username)
        accounts = [me] if me is not None else []
    return envelope("users", {"user": [_user_payload(a.name, admin=a.admin) for a in accounts]})


# ---------------------------------------------------------------------------
# OpenSubsonic discovery — clients ask which extensions we support.
# We don't implement any optional extensions yet, so return an empty list.
# The `openSubsonic: true` flag in our standard envelope already advertises
# basic OpenSubsonic compliance.
# ---------------------------------------------------------------------------


@router.api_route("/getOpenSubsonicExtensions", methods=["GET", "POST", "HEAD"])
@router.api_route("/getOpenSubsonicExtensions.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_open_subsonic_extensions() -> dict:
    """Advertise the OpenSubsonic extensions we actually support.

    Clients use this to light up extra UI:
    - `formPost` lets them submit credentials in a POST body instead of the
      query string. Implemented by `PostFormToQueryMiddleware`.
    - `transcodeOffset` lets them seek mid-transcode by passing
      `?timeOffset=N` to `/stream`. Implemented by ffmpeg `-ss N` in
      `_transcode_response`.
    """
    return envelope(
        "openSubsonicExtensions",
        [
            {"name": "formPost", "versions": [1]},
            {"name": "transcodeOffset", "versions": [1]},
            {"name": "multipleGenres", "versions": [1]},
            {"name": "songLyrics", "versions": [1]},
        ],
    )


# ---------------------------------------------------------------------------
# Genres — counted from the library scan. `getGenres` returns one entry per
# distinct genre with songCount + albumCount; clients render a "Genres" tab.
# ---------------------------------------------------------------------------


@router.api_route("/getGenres", methods=["GET", "POST", "HEAD"])
@router.api_route("/getGenres.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_genres(request: Request) -> dict:
    """Distinct genres + per-genre song / album counts.

    Honours the OpenSubsonic `multipleGenres` extension: a track tagged
    `genres=["Rock", "Indie"]` contributes one song to BOTH counts, and
    its album is counted under both. Falls back to the legacy single
    `track.genre` (and album-level `tag_genre`) when the multi-list is
    absent.
    """
    cache = _get_cache(request)
    song_counts: dict[str, int] = {}
    album_genres: dict[str, set[str]] = {}  # genre → set of album IDs
    for album_id_str, album in cache.albums_by_id.items():
        seen_in_album: set[str] = set()
        for track in album.tracks:
            track_genres = list(track.genres) if track.genres else []
            if not track_genres and track.genre:
                track_genres = [track.genre]
            if not track_genres and album.tag_genre:
                track_genres = [album.tag_genre]
            for name in track_genres:
                song_counts[name] = song_counts.get(name, 0) + 1
                seen_in_album.add(name)
        # Also count album-level tag_genre even when no track had it explicitly.
        if album.tag_genre:
            seen_in_album.add(album.tag_genre)
        for name in seen_in_album:
            album_genres.setdefault(name, set()).add(album_id_str)
    payload = [
        {"value": name, "songCount": song_counts.get(name, 0), "albumCount": len(albums)}
        for name, albums in sorted(album_genres.items(), key=lambda kv: kv[0].casefold())
    ]
    return envelope("genres", {"genre": payload})
