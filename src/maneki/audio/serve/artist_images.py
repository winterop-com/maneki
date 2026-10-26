"""Artist pictures, from the most trusted source that has one.

1. The artist's own file: `artist.jpg` (or .jpeg/.png/.webp) in the artist folder. Read where it
   lies, every time; nothing is copied.
2. Wikimedia Commons, found through Wikidata by the MusicBrainz artist id in the files' tags.
   Commons photos are openly licensed, so the picture is STORED under
   `<root>/.maneki/artist-images/` with its author and licence, which the client shows as a
   credit line.
3. Deezer, by exact artist name. ONLY THE URL IS KEPT: Deezer's developer terms do not allow
   storing their images, so the server redirects to their CDN and the browser caches it on the
   CDN's own headers.
4. Nothing: `getCoverArt` falls back to the artist's first album cover, as it always has.

Lookups run on a background thread after each scan, one artist at a time and throttled per host.
With lookups off (`[server] artist_images = false` or `serve --no-artist-images`) the server makes
no outbound requests and stops redirecting to Deezer; the artist's own files and pictures already
stored from Commons still show.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
from collections.abc import Callable, Iterable
from html import unescape
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

import httpx2 as httpx
import mutagen
from pydantic import BaseModel, ConfigDict

from maneki.audio.enrich import _http
from maneki.audio.library.models import LibraryAlbum

log = logging.getLogger(__name__)

ARTIST_FILE_NAMES = ("artist.jpg", "artist.jpeg", "artist.png", "artist.webp")
STORE_DIR = Path(".maneki") / "artist-images"
INDEX_FILE = "index.json"

# A miss, or a Deezer link, is asked again after this long: a photo may have been added since.
RECHECK_AFTER_S = 30 * 24 * 3600

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
DEEZER_SEARCH = "https://api.deezer.com/search/artist"
# Where Deezer's CDN sends a picture that does not exist: the MD5 of an empty file.
DEEZER_PLACEHOLDER = "d41d8cd98f00b204e9800998ecf8427e"

# Commons serves a thumbnail at any width; this is what the artist screen draws largest.
STORED_WIDTH = 1000

# The folder names that are compilations rather than an artist: nobody's photo belongs on them.
COMPILATION_NAMES = frozenset({"various artists", "various", "va"})

_MBID_KEYS = (
    "----:com.apple.iTunes:MusicBrainz Album Artist Id",
    "----:com.apple.iTunes:MusicBrainz Artist Id",
    "TXXX:MusicBrainz Album Artist Id",
    "TXXX:MusicBrainz Artist Id",
    "musicbrainz_albumartistid",
    "musicbrainz_artistid",
)
_MBID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


class ImageCredit(BaseModel):
    """Who took a stored photo and under what licence, as Commons states it."""

    model_config = ConfigDict(frozen=True)

    author: str
    license: str
    page: str


class ArtistImage(BaseModel):
    """What the lookup found for one artist."""

    model_config = ConfigDict(frozen=True)

    source: Literal["wikimedia", "deezer", "none"]
    file: str | None = None
    url: str | None = None
    credit: ImageCredit | None = None
    mbid: str | None = None
    checked_at: float = 0.0


def local_image(albums: Iterable[LibraryAlbum]) -> Path | None:
    """The artist's own picture file, if the artist folder has one."""
    for album in albums:
        folder = album.path.parent
        for name in ARTIST_FILE_NAMES:
            candidate = folder / name
            if candidate.is_file():
                return candidate
        return None
    return None


def read_artist_mbid(albums: Iterable[LibraryAlbum]) -> str | None:
    """The MusicBrainz artist id in the first tagged track, album artist first."""
    for album in albums:
        for track in album.tracks[:1]:
            try:
                tags = mutagen.File(track.path)
            except Exception:  # noqa: BLE001 - an unreadable file is just a file with no id
                continue
            # mutagen's tag containers differ per format; every one of them answers `get`.
            tag_map: Any = None if tags is None else tags.tags
            if tag_map is None:
                continue
            for key in _MBID_KEYS:
                found = _mbid_in(tag_map.get(key))
                if found is not None:
                    return found
    return None


def _mbid_in(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    raw = getattr(value, "text", value)
    if isinstance(raw, list):
        raw = raw[0] if raw else None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    match = _MBID_RE.search(str(raw).lower()) if raw is not None else None
    return match.group(0) if match else None


def name_key(name: str) -> str:
    """A name as two spellings of the same artist compare: folded, `&` as `and`, letters and digits only.

    "AC-DC" (a folder cannot hold a slash) and Deezer's "AC/DC" are the same artist; "Röyksopp"
    and "Royksopp" too.
    """
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().casefold()
    folded = folded.replace("&", " and ")
    return re.sub(r"[^a-z0-9]", "", folded)


def is_compilation(name: str, albums: Iterable[LibraryAlbum]) -> bool:
    """Whether the folder is a compilation shelf rather than an artist."""
    if name.casefold() in COMPILATION_NAMES:
        return True
    owners = {(album.tag_album_artist or "").casefold() for album in albums}
    return bool(owners) and owners <= COMPILATION_NAMES


def deezer_sized(url: str, size: int | None) -> str:
    """A Deezer picture URL at the size asked for; their CDN draws any square size."""
    side = max(56, min(1000, size or 1000))
    return re.sub(r"/\d+x\d+-", f"/{side}x{side}-", url, count=1)


def _strip_html(text: str) -> str:
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", text)).split())


class Lookups:
    """The two online sources. One `httpx.Client`, throttled per host through the enrich helpers."""

    def __init__(self, http: httpx.Client | None = None) -> None:
        self.http = http or _http.get_client()

    def _get(self, url: str, host: str, **params: str) -> httpx.Response:
        return _http.throttled_get(self.http, url, host_key=host, params=params)

    def wikimedia(self, mbid: str) -> tuple[bytes, str, ImageCredit] | None:
        """The Commons photo Wikidata names for this MusicBrainz artist, with its credit."""
        found = self._get(
            WIKIDATA_API,
            "wikidata",
            action="query",
            list="search",
            srsearch=f"haswbstatement:P434={mbid}",
            format="json",
        ).json()
        hits = found.get("query", {}).get("search", [])
        if not hits:
            return None
        entity = hits[0]["title"]
        claims = self._get(
            WIKIDATA_API, "wikidata", action="wbgetclaims", entity=entity, property="P18", format="json"
        ).json()
        images = claims.get("claims", {}).get("P18", [])
        if not images:
            return None
        filename = images[0]["mainsnak"]["datavalue"]["value"]
        info = self._get(
            COMMONS_API,
            "commons",
            action="query",
            titles=f"File:{filename}",
            prop="imageinfo",
            iiprop="url|extmetadata",
            iiurlwidth=str(STORED_WIDTH),
            format="json",
        ).json()
        pages = list(info.get("query", {}).get("pages", {}).values())
        details = (pages[0].get("imageinfo") or [None])[0] if pages else None
        if not details:
            return None
        meta = details.get("extmetadata", {})
        credit = ImageCredit(
            author=_strip_html(meta.get("Artist", {}).get("value", "")) or "Unknown",
            license=meta.get("LicenseShortName", {}).get("value", "") or "see source",
            page=details.get("descriptionurl", f"https://commons.wikimedia.org/wiki/File:{quote(filename)}"),
        )
        picture = self._get(details.get("thumburl") or details["url"], "commons-upload")
        picture.raise_for_status()
        mime = picture.headers.get("content-type", "image/jpeg").split(";")[0]
        return picture.content, mime, credit

    def deezer(self, name: str) -> str | None:
        """Deezer's picture URL for the artist with exactly this name, most-followed first."""
        response = self._get(DEEZER_SEARCH, "deezer", q=name, limit="10")
        want = name_key(name)
        matches = [
            artist for artist in response.json().get("data", []) if name_key(str(artist.get("name", ""))) == want
        ]
        for artist in sorted(matches, key=lambda a: -int(a.get("nb_fan") or 0)):
            url = str(artist.get("picture_xl") or "")
            # An artist without a photo still answers with a URL: to an empty hash, or to a hash
            # of its own that the CDN redirects to the placeholder silhouette.
            if url and "/artist//" not in url and self._deezer_has_photo(str(artist.get("picture_small") or url)):
                return url
        return None

    def _deezer_has_photo(self, url: str) -> bool:
        """Whether the CDN serves a photo here rather than redirecting to its "no image" placeholder.

        Asked of the 56px size without following redirects, so a real photo costs a few hundred bytes
        that are read and dropped, never kept.
        """
        response = _http.throttled_get(self.http, url, host_key="deezer-cdn", follow_redirects=False)
        if response.is_redirect:
            return DEEZER_PLACEHOLDER not in response.headers.get("location", "")
        return response.status_code == 200


class ArtistImages:
    """The stored lookups for one library, and the background pass that fills them."""

    def __init__(
        self,
        root: Path,
        *,
        online: bool,
        lookups: Lookups | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.root = root
        self.online = online
        self._lookups = lookups
        self._clock = clock
        self._dir = root / STORE_DIR
        self._lock = threading.Lock()
        self._running = False
        self._again = False
        self._entries: dict[str, ArtistImage] = self._load()

    # -- the store ---------------------------------------------------------

    def _load(self) -> dict[str, ArtistImage]:
        try:
            raw = json.loads((self._dir / INDEX_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        entries: dict[str, ArtistImage] = {}
        for ar_id, value in raw.items():
            try:
                entries[ar_id] = ArtistImage.model_validate(value)
            except ValueError:
                continue
        return entries

    def _save(self) -> None:
        payload = {ar_id: entry.model_dump(exclude_none=True) for ar_id, entry in self._entries.items()}
        target = self._dir / INDEX_FILE
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(payload, indent=1, sort_keys=True), encoding="utf-8")
        temporary.replace(target)

    def entry(self, ar_id: str) -> ArtistImage | None:
        """What is known about this artist's picture, if it has been looked up."""
        return self._entries.get(ar_id)

    def stored_file(self, entry: ArtistImage) -> Path | None:
        """The stored Commons photo for an entry, if it is still on disk."""
        if entry.source != "wikimedia" or entry.file is None:
            return None
        path = self._dir / entry.file
        return path if path.is_file() else None

    # -- the background pass -----------------------------------------------

    def refresh(self, artists: dict[str, list[LibraryAlbum]], names: dict[str, str]) -> None:
        """Look up whatever is missing or stale, on a daemon thread. A pass already running runs again after."""
        if not self.online:
            return
        with self._lock:
            if self._running:
                self._again = True
                return
            self._running = True
        snapshot = (dict(artists), dict(names))
        threading.Thread(target=self._run, args=snapshot, name="maneki-artist-images", daemon=True).start()

    def _run(self, artists: dict[str, list[LibraryAlbum]], names: dict[str, str]) -> None:
        try:
            self.run_pass(artists, names)
        except Exception:  # pragma: no cover - a pass must never take the server down
            log.exception("artist images: lookup pass failed")
        finally:
            with self._lock:
                self._running = False
                again, self._again = self._again, False
            if again:
                self.refresh(artists, names)

    def run_pass(self, artists: dict[str, list[LibraryAlbum]], names: dict[str, str]) -> int:
        """Look up every artist that needs it, synchronously. Returns how many were asked about."""
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            log.warning("artist images: cannot create %s; lookups disabled for this library", self._dir)
            return 0
        lookups = self._lookups or Lookups()
        self._lookups = lookups
        asked = 0
        for ar_id, albums in artists.items():
            name = names.get(ar_id, "")
            if not name or is_compilation(name, albums) or local_image(albums) is not None:
                continue
            known = self._entries.get(ar_id)
            if known is not None and not self._stale(known):
                continue
            asked += 1
            try:
                found = self._look_up(ar_id, name, albums, lookups)
            except (httpx.HTTPError, ValueError, KeyError, OSError) as error:
                log.info("artist images: %s: %s", name, error)
                continue
            self._entries[ar_id] = found
            self._save()
        if asked:
            log.info("artist images: looked up %d artists", asked)
        return asked

    def _stale(self, entry: ArtistImage) -> bool:
        if entry.source == "wikimedia":
            return self.stored_file(entry) is None
        return self._clock() - entry.checked_at > RECHECK_AFTER_S

    def _look_up(self, ar_id: str, name: str, albums: list[LibraryAlbum], lookups: Lookups) -> ArtistImage:
        now = self._clock()
        mbid = read_artist_mbid(albums)
        if mbid is not None:
            photo = lookups.wikimedia(mbid)
            if photo is not None:
                data, mime, credit = photo
                suffix = {"image/png": ".png", "image/webp": ".webp"}.get(mime, ".jpg")
                file = f"{ar_id}{suffix}"
                (self._dir / file).write_bytes(data)
                return ArtistImage(source="wikimedia", file=file, credit=credit, mbid=mbid, checked_at=now)
        url = lookups.deezer(name)
        if url is not None:
            return ArtistImage(source="deezer", url=url, mbid=mbid, checked_at=now)
        return ArtistImage(source="none", mbid=mbid, checked_at=now)
