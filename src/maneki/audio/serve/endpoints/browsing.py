"""Subsonic browsing endpoints — artists, albums, songs, indexes, album lists."""

from __future__ import annotations

import random as random_mod
from typing import Any

from fastapi import APIRouter, Query, Request

from maneki.audio.serve.app import envelope, error_envelope
from maneki.audio.serve.ids import album_id
from maneki.audio.serve.index import IndexCache
from maneki.audio.serve.payloads import album_payload, artist_summary, song_payload
from maneki.audio.serve.stars import StarStore
from maneki.books.library import BooksIndex
from maneki.books.subsonic import (
    BOOKS_FOLDER_ID,
    MUSIC_FOLDER_ID,
    author_summary,
    authors,
    book_payload,
    books_by,
    file_payload,
    find_author,
    find_book,
    find_file,
)
from maneki.books.subsonic import (
    GENRE as BOOK_GENRE,
)

router = APIRouter()

_IGNORED_ARTICLES = "The El La Los Las Le Les"


def _books(request: Request) -> BooksIndex | None:
    """The audiobook index, when this root has one."""
    return getattr(request.app.state, "books", None)


def _wants(music_folder_id: int | None, folder: int) -> bool:
    """True when a request for `music_folder_id` covers `folder`. No id means every folder."""
    return music_folder_id is None or music_folder_id == folder


def _position(request: Request, book_id: str) -> float:
    """Where this account stopped in the book, in seconds."""
    saved = request.state.progress.get(book_id)
    return saved.position_s if saved else 0.0


def _get_cache(request: Request) -> IndexCache:
    return request.app.state.cache  # type: ignore[no-any-return]


def _get_stars(request: Request) -> StarStore:
    return request.state.stars  # type: ignore[no-any-return]


def _index_letter(name: str) -> str:
    """Bucket a name into an A-Z group. Articles + non-letters fold to '#'."""
    stripped = name.lstrip()
    for article in _IGNORED_ARTICLES.split():
        prefix = article + " "
        if stripped.lower().startswith(prefix.lower()):
            stripped = stripped[len(prefix) :]
            break
    if not stripped:
        return "#"
    first = stripped[0].upper()
    return first if first.isalpha() else "#"


@router.api_route("/getArtists", methods=["GET", "POST", "HEAD"])
@router.api_route("/getArtists.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_artists(  # noqa: N803 - Subsonic spec uses camelCase
    request: Request,
    musicFolderId: int | None = Query(default=None, description="Limit to one folder from `getMusicFolders`."),
) -> dict:
    """Alphabetically grouped artist list — the modern (ID3) browse root.

    Without `musicFolderId`, music artists and book authors appear together;
    with one, only that folder's.
    """
    return envelope(
        "artists",
        {"ignoredArticles": _IGNORED_ARTICLES, "index": _artist_index(request, musicFolderId)},
    )


@router.api_route("/getIndexes", methods=["GET", "POST", "HEAD"])
@router.api_route("/getIndexes.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_indexes(  # noqa: N803 - Subsonic spec uses camelCase
    request: Request,
    musicFolderId: int | None = Query(default=None, description="Limit to one folder from `getMusicFolders`."),
) -> dict:
    """Legacy folder-based browse — same shape as getArtists, different envelope key."""
    return envelope(
        "indexes",
        {
            "ignoredArticles": _IGNORED_ARTICLES,
            "lastModified": 0,
            "index": _artist_index(request, musicFolderId),
        },
    )


def _artist_index(request: Request, music_folder_id: int | None) -> list[dict[str, Any]]:
    """Artists and book authors bucketed A-Z, for whichever folders the request covers."""
    buckets: dict[str, list[dict[str, Any]]] = {}
    if _wants(music_folder_id, MUSIC_FOLDER_ID):
        cache = _get_cache(request)
        for ar_id in cache.artists_by_id:
            letter = _index_letter(cache.artist_name_by_id[ar_id])
            buckets.setdefault(letter, []).append(artist_summary(cache, ar_id))
    books = _books(request)
    if books is not None and _wants(music_folder_id, BOOKS_FOLDER_ID):
        for author in authors(books):
            buckets.setdefault(_index_letter(author), []).append(author_summary(books, author))
    index = []
    for letter in sorted(buckets):
        listed = sorted(buckets[letter], key=lambda a: str(a["name"]).casefold())
        index.append({"name": letter, "artist": listed})
    return index


@router.api_route("/getArtist", methods=["GET", "POST", "HEAD"])
@router.api_route("/getArtist.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_artist(
    request: Request,
    id: str = Query(..., description="Artist id, e.g. `ar_abc123`. Returned by `getArtists`."),
) -> dict:
    """Albums for one artist, or the books of one author."""
    cache = _get_cache(request)
    stars = _get_stars(request)
    books = _books(request)
    if books is not None:
        author = find_author(books, id)
        if author is not None:
            written = books_by(books, author)
            payload = author_summary(books, author)
            payload["album"] = [book_payload(b, with_songs=False) for b in written]
            return envelope("artist", payload)
    albums = cache.artists_by_id.get(id)
    if albums is None:
        return error_envelope(70, f"Artist not found: {id}")
    sorted_albums = sorted(albums, key=lambda a: (a.tag_year or "9999", (a.tag_album or a.album_dir).casefold()))
    payload = {
        "id": id,
        "name": cache.artist_name_by_id[id],
        "albumCount": len(sorted_albums),
        "coverArt": id,
        "album": [stars.enrich(album_payload(a, with_songs=False)) for a in sorted_albums],
    }
    stars.enrich(payload)
    return envelope("artist", payload)


@router.api_route("/getAlbum", methods=["GET", "POST", "HEAD"])
@router.api_route("/getAlbum.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_album(
    request: Request,
    id: str = Query(
        ..., description="Album id, e.g. `al_abc123`. Returned by `getArtist` / `getAlbumList2` / `search3`."
    ),
) -> dict:
    """One album with its tracks, or one book with its files."""
    cache = _get_cache(request)
    stars = _get_stars(request)
    books = _books(request)
    if books is not None:
        book = find_book(books, id)
        if book is not None:
            return envelope("album", book_payload(book, with_songs=True, position_s=_position(request, book.id)))
    album = cache.albums_by_id.get(id)
    if album is None:
        return error_envelope(70, f"Album not found: {id}")
    payload = album_payload(album, with_songs=True)
    stars.enrich(payload)
    for song in payload.get("song", []):
        stars.enrich(song)
    return envelope("album", payload)


@router.api_route("/getSong", methods=["GET", "POST", "HEAD"])
@router.api_route("/getSong.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_song(
    request: Request,
    id: str = Query(..., description="Song id, e.g. `tr_abc123`. Returned by `getAlbum` / `search3` / `getStarred2`."),
) -> dict:
    """One track, or one file of a book."""
    cache = _get_cache(request)
    books = _books(request)
    if books is not None:
        found = find_file(books, id)
        if found is not None:
            book, number = found
            return envelope("song", file_payload(book, number, position_s=_position(request, book.id)))
    pair = cache.tracks_by_id.get(id)
    if pair is None:
        return error_envelope(70, f"Song not found: {id}")
    album, track = pair
    return envelope("song", song_payload(album, track))


@router.api_route("/getAlbumList2", methods=["GET", "POST", "HEAD"])
@router.api_route("/getAlbumList2.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_album_list2(  # noqa: PLR0912 — Subsonic's `type` enum has many cases
    request: Request,
    type: str = Query(
        default="alphabeticalByName",
        description=(
            "Sort / filter mode. Subsonic spec values: `alphabeticalByName`, "
            "`alphabeticalByArtist`, `newest`, `recent`, `frequent`, `starred`, "
            "`random`, `byYear` (needs `fromYear`/`toYear`), `byGenre` (needs "
            "`genre`)."
        ),
    ),
    size: int = Query(default=10, ge=1, le=500, description="Max albums to return (1-500)."),
    offset: int = Query(default=0, ge=0, description="Skip this many albums (pagination)."),
    fromYear: int | None = Query(default=None, description="`byYear` only: inclusive lower bound."),
    toYear: int | None = Query(default=None, description="`byYear` only: inclusive upper bound."),
    genre: str | None = Query(default=None, description="`byGenre` only: genre name to filter on."),
    musicFolderId: int | None = Query(  # noqa: N803 - Subsonic spec uses camelCase
        default=None, description="Limit to one folder from `getMusicFolders`."
    ),
) -> dict:
    """Flat album list for browse-screens (NEW / RANDOM / A-Z / By Year / By Genre).

    Books join the list as albums of their own folder, so a client pointed at
    Audiobooks browses only books.
    """
    cache = _get_cache(request)
    albums = list(cache.albums_by_id.values()) if _wants(musicFolderId, MUSIC_FOLDER_ID) else []

    if type == "random":
        random_mod.shuffle(albums)
    elif type == "byYear":
        if fromYear is None or toYear is None:
            return error_envelope(10, "byYear requires fromYear and toYear")
        lo, hi = (fromYear, toYear) if fromYear <= toYear else (toYear, fromYear)
        albums = [a for a in albums if a.tag_year and lo <= _year_int(a.tag_year) <= hi]
        # Subsonic sorts byYear chronologically (ascending fromYear → toYear, descending if reversed).
        descending = fromYear > toYear
        albums.sort(key=lambda a: _year_int(a.tag_year or "0"), reverse=descending)
    elif type == "byGenre":
        if not genre:
            return error_envelope(10, "byGenre requires genre")
        target = genre.casefold()
        albums = [
            a
            for a in albums
            if (a.tag_genre and a.tag_genre.casefold() == target) or any(_track_has_genre(t, target) for t in a.tracks)
        ]
        albums.sort(key=lambda a: (a.tag_album or a.album_dir).casefold())
    elif type == "alphabeticalByArtist":
        albums.sort(key=lambda a: (a.artist_dir.casefold(), (a.tag_album or a.album_dir).casefold()))
    elif type in ("recent", "frequent"):
        # Per-user history: distinct albums of the user's recently- or most-
        # played tracks, in that order. Empty when the user has no history yet.
        cache = _get_cache(request)
        history = request.state.history
        track_ids = history.recent_track_ids(1000) if type == "recent" else history.frequent_track_ids(1000)
        seen: set[str] = set()
        ranked = []
        for tid in track_ids:
            pair = cache.tracks_by_id.get(tid)
            if pair is None:
                continue
            al = pair[0]
            aid = album_id(al)
            if aid not in seen:
                seen.add(aid)
                ranked.append(al)
        albums = ranked
    else:
        # alphabeticalByName + remaining unsupported types (newest, highest)
        # fall back to alphabetical-by-name. Cleaner than erroring for clients
        # that reach for "newest" by default.
        albums.sort(key=lambda a: (a.tag_album or a.album_dir).casefold())

    listed = [album_payload(a, with_songs=False) for a in albums]
    listed += _book_albums(request, type, musicFolderId, from_year=fromYear, to_year=toYear, genre=genre)
    if type == "alphabeticalByName":
        listed.sort(key=lambda a: str(a["name"]).casefold())
    elif type == "alphabeticalByArtist":
        listed.sort(key=lambda a: (str(a["artist"]).casefold(), str(a["name"]).casefold()))
    elif type == "random":
        random_mod.shuffle(listed)
    page = listed[offset : offset + size]
    return envelope("albumList2", {"album": page})


@router.api_route("/getAlbumList", methods=["GET", "POST", "HEAD"])
@router.api_route("/getAlbumList.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_album_list(
    request: Request,
    type: str = Query(default="alphabeticalByName", description="Same modes as `getAlbumList2`."),
    size: int = Query(default=10, ge=1, le=500, description="Max albums to return (1-500)."),
    offset: int = Query(default=0, ge=0, description="Skip this many albums (pagination)."),
    fromYear: int | None = Query(default=None, description="`byYear` only: inclusive lower bound."),
    toYear: int | None = Query(default=None, description="`byYear` only: inclusive upper bound."),
    genre: str | None = Query(default=None, description="`byGenre` only: genre name to filter on."),
    musicFolderId: int | None = Query(  # noqa: N803 - Subsonic spec uses camelCase
        default=None, description="Limit to one folder from `getMusicFolders`."
    ),
) -> dict:
    """The same list in the directory grammar, which is what the older clients ask for.

    play:Sub and DSub browse folders rather than ID3 tags, and reach for this
    rather than `getAlbumList2`; with no handler they get a 404 on their first
    screen and report the server as broken. The selection is the one
    `getAlbumList2` makes -- one list, one set of rules -- and only the shape
    of each entry differs: a `Child` with a title and `isDir`, not an
    `AlbumID3` with a name.
    """
    answered = await get_album_list2(
        request,
        type=type,
        size=size,
        offset=offset,
        fromYear=fromYear,
        toYear=toYear,
        genre=genre,
        musicFolderId=musicFolderId,
    )
    body = answered["subsonic-response"]
    if body.get("status") != "ok":
        return answered
    albums = body.get("albumList2", {}).get("album", [])
    return envelope("albumList", {"album": [_as_directory_album(a) for a in albums]})


def _as_directory_album(album: dict[str, Any]) -> dict[str, Any]:
    """One album as a directory child, which is how the pre-ID3 endpoints name it.

    `title` rather than `name`, `parent` rather than `artistId`, and `isDir`,
    because a client walking folders expects to be able to hand the id it was
    given straight back to `getMusicDirectory`.
    """
    child: dict[str, Any] = {
        "id": album["id"],
        "parent": album.get("artistId", ""),
        "isDir": True,
        "title": album.get("name", ""),
        "album": album.get("name", ""),
        "artist": album.get("artist", ""),
        "coverArt": album.get("coverArt", album["id"]),
        "created": album.get("created", "1970-01-01T00:00:00.000Z"),
    }
    for carried in ("year", "genre", "duration", "songCount", "artistId", "starred"):
        if carried in album:
            child[carried] = album[carried]
    return child


@router.api_route("/getSongsByGenre", methods=["GET", "POST", "HEAD"])
@router.api_route("/getSongsByGenre.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_songs_by_genre(
    request: Request,
    genre: str = Query(..., description="Genre name, as `getGenres` spells it."),
    count: int = Query(default=10, ge=1, le=500, description="Max songs to return (1-500)."),
    offset: int = Query(default=0, ge=0, description="Skip this many songs (pagination)."),
    musicFolderId: int | None = Query(  # noqa: N803 - Subsonic spec uses camelCase
        default=None, description="Limit to one folder from `getMusicFolders`."
    ),
) -> dict:
    """Every song of one genre.

    `getGenres` already answers with counts, and a client that draws that list
    sends somebody straight here when they pick one; without this the genre
    screen is a dead end. A track matches on either its single genre or any of
    its `genres[]`, which is the same rule `getAlbumList2?type=byGenre` uses.

    Books carry one genre of their own and are not songs, so they are not here.
    """
    if not _wants(musicFolderId, MUSIC_FOLDER_ID):
        return envelope("songsByGenre", {"song": []})
    cache = _get_cache(request)
    target = genre.casefold()
    found: list[dict[str, Any]] = []
    for album in cache.albums_by_id.values():
        album_genre = (album.tag_genre or "").casefold()
        for track in album.tracks:
            if _track_has_genre(track, target) or album_genre == target:
                found.append(song_payload(album, track))
    page = found[offset : offset + count]
    return envelope("songsByGenre", {"song": page})


def _book_albums(
    request: Request,
    type: str,
    music_folder_id: int | None,
    *,
    from_year: int | None,
    to_year: int | None,
    genre: str | None,
) -> list[dict[str, Any]]:
    """The books that belong in this album list, as album payloads.

    `recent`, `frequent` and `starred` are per-user music history and
    favourites, which books do not take part in, so they return none.
    """
    books = _books(request)
    if books is None or not _wants(music_folder_id, BOOKS_FOLDER_ID):
        return []
    if type in ("recent", "frequent", "starred"):
        return []
    listed = books.books
    if type == "byGenre":
        if not genre or genre.casefold() != BOOK_GENRE.casefold():
            return []
    elif type == "byYear":
        if from_year is None or to_year is None:
            return []
        lo, hi = (from_year, to_year) if from_year <= to_year else (to_year, from_year)
        listed = [b for b in listed if b.year and b.year.isdigit() and lo <= int(b.year) <= hi]
    return [book_payload(b, with_songs=False) for b in listed]


def _track_has_genre(track: object, target_casefold: str) -> bool:
    """Match a track's genre by either its single `genre` or any of its `genres[]`.

    OpenSubsonic's `multipleGenres` extension exposes per-track lists; the
    legacy single-genre field is still populated, but a track tagged
    `genres=["Rock", "Indie"]` should match `byGenre=Indie` even when
    `track.genre == "Rock"`.
    """
    single = getattr(track, "genre", None) or ""
    if single.casefold() == target_casefold:
        return True
    for g in getattr(track, "genres", None) or ():
        if g.casefold() == target_casefold:
            return True
    return False


def _year_int(year: str) -> int:
    try:
        return int(year)
    except ValueError:
        return 0
