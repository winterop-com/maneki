"""Artist pictures: the artist's own file, a stored Commons photo, a Deezer link, or nothing."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

import httpx2 as httpx
import pytest
from fastapi.testclient import TestClient
from mutagen.mp4 import MP4, MP4FreeForm
from PIL import Image

from maneki.audio.library.models import LibraryAlbum, LibraryIndex, LibraryTrack
from maneki.audio.serve import ServeConfig, create_app
from maneki.audio.serve.artist_images import (
    ArtistImage,
    ArtistImages,
    ImageCredit,
    Lookups,
    deezer_sized,
    is_compilation,
    local_image,
    name_key,
    read_artist_mbid,
)
from maneki.audio.serve.ids import artist_id

Handler = Callable[[httpx.Request], httpx.Response]

MBID = "cc197bad-dc9c-440d-a5b5-d52ba2e14234"
DEEZER_URL = "https://cdn-images.dzcdn.net/images/artist/3087954b/1000x1000-000000-80-0-0.jpg"


@pytest.fixture(autouse=True)
def _fast_http(monkeypatch: pytest.MonkeyPatch) -> None:
    """No real throttling or backoff in unit tests; reset the per-host state each test."""
    from maneki.audio.enrich import _http

    monkeypatch.setattr(_http, "RATE_LIMIT_SECONDS", 0.0)
    monkeypatch.setattr(_http, "RETRY_BACKOFF_SECONDS", (0.0, 0.0))
    monkeypatch.setattr(_http, "_throttles", {})
    monkeypatch.setattr(_http, "_exhausted_ladders", {})


def _jpeg(side: int = 40) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (side, side), (200, 120, 40)).save(buffer, format="JPEG")
    return buffer.getvalue()


def _album(root: Path, artist: str, *, album_artist: str | None = None, track: Path | None = None) -> LibraryAlbum:
    folder = root / artist / "2021 - Record"
    folder.mkdir(parents=True, exist_ok=True)
    tracks = [LibraryTrack(path=track)] if track is not None else []
    return LibraryAlbum(
        path=folder, artist_dir=artist, album_dir="2021 - Record", tag_album_artist=album_artist, tracks=tracks
    )


def _lookups(handler: Handler) -> Lookups:
    return Lookups(http=httpx.Client(transport=httpx.MockTransport(handler)))


# -- matching -------------------------------------------------------------------------------


def test_name_key_matches_spellings_of_one_artist() -> None:
    assert name_key("AC-DC") == name_key("AC/DC")
    assert name_key("Röyksopp") == name_key("Royksopp")
    assert name_key("Simon & Garfunkel") == name_key("Simon and Garfunkel")
    assert name_key("Coldplay") != name_key("Coldplay Piano Covers")


def test_deezer_sized_asks_the_cdn_for_the_size_wanted() -> None:
    assert "/250x250-" in deezer_sized(DEEZER_URL, 250)
    assert "/1000x1000-" in deezer_sized(DEEZER_URL, None)
    # Clamped to what the CDN draws well.
    assert "/1000x1000-" in deezer_sized(DEEZER_URL, 4000)


def test_a_compilation_shelf_is_not_an_artist(tmp_path: Path) -> None:
    assert is_compilation("Various Artists", [])
    shelf = _album(tmp_path, "Absolute Music", album_artist="Various Artists")
    assert is_compilation("Absolute Music", [shelf])
    assert not is_compilation("Coldplay", [_album(tmp_path, "Coldplay", album_artist="Coldplay")])


def test_local_image_is_the_file_in_the_artist_folder(tmp_path: Path) -> None:
    album = _album(tmp_path, "Coldplay")
    assert local_image([album]) is None
    (tmp_path / "Coldplay" / "artist.jpg").write_bytes(_jpeg())
    assert local_image([album]) == tmp_path / "Coldplay" / "artist.jpg"


def test_read_artist_mbid_from_an_m4a_freeform_tag(tmp_path: Path) -> None:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not on PATH")
    track = tmp_path / "one.m4a"
    subprocess.run(
        ["ffmpeg", "-y", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc", "-t", "0.2", str(track)],
        check=True,
    )
    tagged = MP4(track)
    tagged["----:com.apple.iTunes:MusicBrainz Artist Id"] = [MP4FreeForm(MBID.encode())]
    tagged.save()
    assert read_artist_mbid([_album(tmp_path, "Coldplay", track=track)]) == MBID


# -- the online sources ---------------------------------------------------------------------


def test_deezer_takes_the_exact_name_and_skips_an_empty_photo() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn-images.dzcdn.net":
            return httpx.Response(200, content=_jpeg())
        assert request.url.params["q"] == "AC-DC"
        return httpx.Response(
            200,
            json={
                "data": [
                    {"name": "AC/DC Tribute", "nb_fan": 9, "picture_xl": DEEZER_URL},
                    {
                        "name": "AC/DC",
                        "nb_fan": 5,
                        "picture_xl": "https://cdn-images.dzcdn.net/images/artist//1000x1000.jpg",
                    },
                    {"name": "AC/DC", "nb_fan": 4, "picture_xl": DEEZER_URL},
                ]
            },
        )

    assert _lookups(handler).deezer("AC-DC") == DEEZER_URL


def test_deezer_answers_none_when_no_name_matches() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"name": "Coldplay Piano Covers", "picture_xl": DEEZER_URL}]})

    assert _lookups(handler).deezer("Coldplay") is None


def test_deezer_skips_a_photo_the_cdn_redirects_to_its_placeholder() -> None:
    silhouette = "https://cdn-images.dzcdn.net/images/artist/7a512c41/56x56-000000-80-0-0.jpg"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "cdn-images.dzcdn.net":
            assert str(request.url) == silhouette
            return httpx.Response(
                302, headers={"location": "/images/artist/d41d8cd98f00b204e9800998ecf8427e/56x56-000000-80-0-0.jpg"}
            )
        return httpx.Response(
            200,
            json={"data": [{"name": "Bria Valente", "picture_xl": DEEZER_URL, "picture_small": silhouette}]},
        )

    assert _lookups(handler).deezer("Bria Valente") is None


def test_wikimedia_follows_wikidata_to_the_commons_photo_and_its_credit() -> None:
    picture = _jpeg()

    def handler(request: httpx.Request) -> httpx.Response:
        params = request.url.params
        if request.url.host == "www.wikidata.org" and params.get("list") == "search":
            assert params["srsearch"] == f"haswbstatement:P434={MBID}"
            return httpx.Response(200, json={"query": {"search": [{"title": "Q45188"}]}})
        if request.url.host == "www.wikidata.org":
            assert params["entity"] == "Q45188"
            return httpx.Response(
                200, json={"claims": {"P18": [{"mainsnak": {"datavalue": {"value": "Coldplay 2021.jpg"}}}]}}
            )
        if request.url.host == "commons.wikimedia.org":
            assert params["titles"] == "File:Coldplay 2021.jpg"
            return httpx.Response(
                200,
                json={
                    "query": {
                        "pages": {
                            "1": {
                                "imageinfo": [
                                    {
                                        "url": "https://upload.wikimedia.org/full.jpg",
                                        "thumburl": "https://upload.wikimedia.org/thumb.jpg",
                                        "descriptionurl": "https://commons.wikimedia.org/wiki/File:Coldplay_2021.jpg",
                                        "extmetadata": {
                                            "Artist": {"value": '<a href="/wiki/User:X">Jane &amp; Doe</a>'},
                                            "LicenseShortName": {"value": "CC BY-SA 4.0"},
                                        },
                                    }
                                ]
                            }
                        }
                    }
                },
            )
        assert str(request.url) == "https://upload.wikimedia.org/thumb.jpg"
        return httpx.Response(200, content=picture, headers={"content-type": "image/jpeg"})

    found = _lookups(handler).wikimedia(MBID)
    assert found is not None
    data, mime, credit = found
    assert data == picture
    assert mime == "image/jpeg"
    assert credit == ImageCredit(
        author="Jane & Doe",
        license="CC BY-SA 4.0",
        page="https://commons.wikimedia.org/wiki/File:Coldplay_2021.jpg",
    )


def test_wikimedia_answers_none_when_wikidata_has_no_photo() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("list") == "search":
            return httpx.Response(200, json={"query": {"search": [{"title": "Q1"}]}})
        return httpx.Response(200, json={"claims": {}})

    assert _lookups(handler).wikimedia(MBID) is None


# -- the background pass --------------------------------------------------------------------


class _FakeLookups(Lookups):
    def __init__(self, *, wikimedia: bool = False, deezer: bool = False) -> None:
        self.found_wikimedia = wikimedia
        self.found_deezer = deezer
        self.asked: list[str] = []

    def wikimedia(self, mbid: str) -> tuple[bytes, str, ImageCredit] | None:
        self.asked.append(f"wikimedia:{mbid}")
        if not self.found_wikimedia:
            return None
        return _jpeg(), "image/jpeg", ImageCredit(author="Jane", license="CC BY 4.0", page="https://example.org")

    def deezer(self, name: str) -> str | None:
        self.asked.append(f"deezer:{name}")
        return DEEZER_URL if self.found_deezer else None


def _pass(tmp_path: Path, albums: list[LibraryAlbum], lookups: Lookups, **kwargs: object) -> ArtistImages:
    images = ArtistImages(tmp_path, online=True, lookups=lookups, **kwargs)  # type: ignore[arg-type]
    artists = {artist_id(a.artist_dir): [a] for a in albums}
    names = {artist_id(a.artist_dir): a.artist_dir for a in albums}
    images.run_pass(artists, names)
    return images


def test_a_pass_stores_a_commons_photo_with_its_credit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("maneki.audio.serve.artist_images.read_artist_mbid", lambda _albums: MBID)
    images = _pass(tmp_path, [_album(tmp_path, "Coldplay")], _FakeLookups(wikimedia=True, deezer=True))
    entry = images.entry(artist_id("Coldplay"))
    assert entry is not None
    assert entry.source == "wikimedia"
    assert entry.mbid == MBID
    assert images.stored_file(entry) is not None
    # The index survives a restart.
    reloaded = ArtistImages(tmp_path, online=False)
    assert reloaded.entry(artist_id("Coldplay")) == entry


def test_a_pass_keeps_only_the_deezer_url(tmp_path: Path) -> None:
    images = _pass(tmp_path, [_album(tmp_path, "Coldplay")], _FakeLookups(deezer=True))
    entry = images.entry(artist_id("Coldplay"))
    assert entry == ArtistImage(source="deezer", url=DEEZER_URL, checked_at=entry.checked_at if entry else 0)
    stored = [path.name for path in (tmp_path / ".maneki" / "artist-images").iterdir()]
    assert stored == ["index.json"]


def test_a_pass_skips_compilations_and_artists_with_their_own_file(tmp_path: Path) -> None:
    own = _album(tmp_path, "Coldplay")
    (tmp_path / "Coldplay" / "artist.jpg").write_bytes(_jpeg())
    shelf = _album(tmp_path, "Various Artists")
    lookups = _FakeLookups(deezer=True)
    _pass(tmp_path, [own, shelf], lookups)
    assert lookups.asked == []


def test_a_miss_is_not_asked_again_until_it_is_stale(tmp_path: Path) -> None:
    now = [1_000_000.0]
    album = _album(tmp_path, "Nobody")
    lookups = _FakeLookups()
    images = _pass(tmp_path, [album], lookups, clock=lambda: now[0])
    assert lookups.asked == ["deezer:Nobody"]
    artists = {artist_id("Nobody"): [album]}
    names = {artist_id("Nobody"): "Nobody"}
    assert images.run_pass(artists, names) == 0
    now[0] += 31 * 24 * 3600
    assert images.run_pass(artists, names) == 1


def test_refresh_does_nothing_with_lookups_off(tmp_path: Path) -> None:
    lookups = _FakeLookups(deezer=True)
    images = ArtistImages(tmp_path, online=False, lookups=lookups)
    album = _album(tmp_path, "Coldplay")
    images.refresh({artist_id("Coldplay"): [album]}, {artist_id("Coldplay"): "Coldplay"})
    assert lookups.asked == []
    assert not (tmp_path / ".maneki" / "artist-images").exists()


# -- the endpoints --------------------------------------------------------------------------


def _params(**extra: str | int) -> dict[str, str | int]:
    return {"u": "mort", "p": "secret", "f": "json", **extra}


def _client(tmp_path: Path, albums: list[LibraryAlbum], *, online: bool) -> tuple[TestClient, ArtistImages]:
    app = create_app(root=tmp_path, cfg=ServeConfig(username="mort", password="secret"))
    app.state.cache._reindex(LibraryIndex(root=tmp_path, albums=albums))  # noqa: SLF001
    images = ArtistImages(tmp_path, online=online)
    app.state.artist_images = images
    return TestClient(app, follow_redirects=False), images


def _seed(tmp_path: Path, entries: dict[str, ArtistImage]) -> None:
    folder = tmp_path / ".maneki" / "artist-images"
    folder.mkdir(parents=True, exist_ok=True)
    payload = {key: value.model_dump(exclude_none=True) for key, value in entries.items()}
    (folder / "index.json").write_text(json.dumps(payload), encoding="utf-8")


def test_cover_art_serves_the_artists_own_file(tmp_path: Path) -> None:
    album = _album(tmp_path, "Coldplay")
    (tmp_path / "Coldplay" / "artist.jpg").write_bytes(_jpeg(80))
    client, _ = _client(tmp_path, [album], online=False)
    response = client.get("/rest/getCoverArt", params=_params(id=artist_id("Coldplay"), size=40))
    assert response.status_code == 200
    with Image.open(io.BytesIO(response.content)) as img:
        assert max(img.size) <= 40


def test_cover_art_redirects_to_deezer_at_the_size_asked(tmp_path: Path) -> None:
    ar_id = artist_id("Coldplay")
    _seed(tmp_path, {ar_id: ArtistImage(source="deezer", url=DEEZER_URL, checked_at=1.0)})
    client, _ = _client(tmp_path, [_album(tmp_path, "Coldplay")], online=True)
    response = client.get("/rest/getCoverArt", params=_params(id=ar_id, size=300))
    assert response.status_code == 307
    assert "/300x300-" in response.headers["location"]


def test_cover_art_sends_nobody_to_deezer_with_lookups_off(tmp_path: Path) -> None:
    ar_id = artist_id("Coldplay")
    _seed(tmp_path, {ar_id: ArtistImage(source="deezer", url=DEEZER_URL, checked_at=1.0)})
    client, _ = _client(tmp_path, [_album(tmp_path, "Coldplay")], online=False)
    response = client.get("/rest/getCoverArt", params=_params(id=ar_id))
    # The first-album fallback: this album has no cover, so the drawn placeholder.
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg")


def test_artist_info_carries_the_deezer_urls_and_the_mbid(tmp_path: Path) -> None:
    ar_id = artist_id("Coldplay")
    _seed(tmp_path, {ar_id: ArtistImage(source="deezer", url=DEEZER_URL, mbid=MBID, checked_at=1.0)})
    client, _ = _client(tmp_path, [_album(tmp_path, "Coldplay")], online=True)
    info = client.get("/rest/getArtistInfo2", params=_params(id=ar_id)).json()["subsonic-response"]["artistInfo2"]
    assert info["musicBrainzId"] == MBID
    assert "/1000x1000-" in info["largeImageUrl"]
    assert "/250x250-" in info["smallImageUrl"]
    assert "imageCredit" not in info


def test_artist_info_carries_the_credit_of_a_stored_photo(tmp_path: Path) -> None:
    ar_id = artist_id("Coldplay")
    credit = ImageCredit(author="Jane", license="CC BY 4.0", page="https://example.org")
    _seed(tmp_path, {ar_id: ArtistImage(source="wikimedia", file=f"{ar_id}.jpg", credit=credit, checked_at=1.0)})
    (tmp_path / ".maneki" / "artist-images" / f"{ar_id}.jpg").write_bytes(_jpeg())
    client, _ = _client(tmp_path, [_album(tmp_path, "Coldplay")], online=False)
    info = client.get("/rest/getArtistInfo2", params=_params(id=ar_id)).json()["subsonic-response"]["artistInfo2"]
    assert info["imageCredit"] == credit.model_dump()
    assert info["largeImageUrl"] == ""
    cover = client.get("/rest/getCoverArt", params=_params(id=ar_id))
    assert cover.status_code == 200
    assert cover.headers["content-type"] == "image/jpeg"
