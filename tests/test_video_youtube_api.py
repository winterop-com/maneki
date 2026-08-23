"""YouTube channel endpoints: subscription CRUD + listing, with yt-dlp mocked.

These never touch the network — `youtube.list_channel` / `resolve_stream` are
patched so the tests exercise the endpoint wiring, per-user store, and HLS
hand-off, not yt-dlp itself.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette

from maneki.audio.serve.users import ResolvedUser, UserRegistry
from maneki.video.serve import create_app, youtube
from maneki.video.serve.sources import RemoteSource


@pytest.fixture
def client_and_registry() -> tuple[TestClient, UserRegistry]:
    root = Path(tempfile.mkdtemp())
    (root / "videos").mkdir()
    registry = UserRegistry(root, [ResolvedUser(name="mike", password="x", admin=True)])
    return TestClient(create_app(root, users=registry)), registry


_LISTING = youtube.ChannelListing(
    channel=youtube.ChannelInfo(
        id="UCrlm",
        title="RedLetterMedia",
        url="https://www.youtube.com/channel/UCrlm/videos",
        handle="@RedLetterMedia",
    ),
    videos=[
        youtube.ChannelVideo(
            id="aaa",
            title="Half in the Bag",
            duration_s=2862.0,
            thumbnail_url="https://i.ytimg.com/vi/aaa/hqdefault.jpg",
        ),
        youtube.ChannelVideo(
            id="bbb",
            title="Best of the Worst",
            duration_s=3915.0,
            thumbnail_url="https://i.ytimg.com/vi/bbb/hqdefault.jpg",
        ),
    ],
)


def test_add_list_remove_channel(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    client, registry = client_and_registry

    async def fake_list(
        url: str, *, tab: str = "videos", limit: int = 60, force: bool = False
    ) -> youtube.ChannelListing:
        return _LISTING

    monkeypatch.setattr(youtube, "list_channel", fake_list)

    # Subscribe by URL -> 201 + the resolved channel identity.
    r = client.post("/api/youtube/channels", json={"url": "https://www.youtube.com/@RedLetterMedia"})
    assert r.status_code == 201
    assert r.json()["id"] == "UCrlm"
    assert r.json()["handle"] == "@RedLetterMedia"

    # Persisted to the per-user store.
    assert registry.subscriptions_for("mike").contains("UCrlm")

    # Listed back with live identity.
    r = client.get("/api/youtube/channels")
    assert [c["title"] for c in r.json()] == ["RedLetterMedia"]

    # Channel videos come from the (mocked) flat listing.
    r = client.get("/api/youtube/channels/UCrlm/videos")
    assert [v["id"] for v in r.json()] == ["aaa", "bbb"]

    # Unsubscribe is idempotent.
    assert client.delete("/api/youtube/channels/UCrlm").json() == {"removed": "UCrlm"}
    assert client.delete("/api/youtube/channels/UCrlm").json() == {"removed": "UCrlm"}
    assert client.get("/api/youtube/channels").json() == []


def test_channel_videos_tab_is_passed_through(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    client, _ = client_and_registry
    seen: dict[str, str] = {}

    async def fake_list(
        url: str, *, tab: str = "videos", limit: int = 60, force: bool = False
    ) -> youtube.ChannelListing:
        seen["tab"] = tab
        return _LISTING

    monkeypatch.setattr(youtube, "list_channel", fake_list)
    assert client.get("/api/youtube/channels/UCrlm/videos?tab=shorts").status_code == 200
    assert seen["tab"] == "shorts"
    # An unknown tab is rejected before any extraction.
    assert client.get("/api/youtube/channels/UCrlm/videos?tab=bogus").status_code == 400


def test_channel_counts_capped(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    """Counts come from the capped per-tab listing; a tab at the cap reports
    capped=True, a missing tab reports 0."""
    client, _ = client_and_registry

    def listing_with(n: int) -> youtube.ChannelListing:
        return youtube.ChannelListing(
            channel=youtube.ChannelInfo(id="UCx", title="X", url="u"),
            videos=[youtube.ChannelVideo(id=f"v{i}", title="t", duration_s=1.0, thumbnail_url="x") for i in range(n)],
        )

    async def fake_list(
        url: str, *, tab: str = "videos", limit: int = 60, force: bool = False
    ) -> youtube.ChannelListing:
        return {"videos": listing_with(60), "shorts": listing_with(3), "streams": listing_with(0)}[tab]

    monkeypatch.setattr(youtube, "list_channel", fake_list)
    body = client.get("/api/youtube/channels/UCx/counts").json()
    assert body["videos"] == 60 and body["videos_capped"] is True
    assert body["shorts"] == 3 and body["shorts_capped"] is False
    assert body["live"] == 0 and body["live_capped"] is False


def test_refresh_forces_listing(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    """?refresh=1 threads force=True into list_channel."""
    client, _ = client_and_registry
    seen: dict[str, bool] = {}

    async def fake_list(
        url: str, *, tab: str = "videos", limit: int = 60, force: bool = False
    ) -> youtube.ChannelListing:
        seen["force"] = force
        return _LISTING

    monkeypatch.setattr(youtube, "list_channel", fake_list)
    client.get("/api/youtube/channels/UCrlm/videos?refresh=1")
    assert seen["force"] is True


def test_add_channel_surfaces_resolver_error(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    client, _ = client_and_registry

    async def boom(url: str, *, tab: str = "videos", limit: int = 60, force: bool = False) -> youtube.ChannelListing:
        raise youtube.YouTubeError("nope")

    monkeypatch.setattr(youtube, "list_channel", boom)
    r = client.post("/api/youtube/channels", json={"url": "https://www.youtube.com/@whatever"})
    assert r.status_code == 502


def test_video_metadata_endpoint(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    client, _ = client_and_registry

    async def fake_resolve(video_id: str, *, max_height: int = 1080) -> youtube.ResolvedStream:
        return youtube.ResolvedStream(
            video_id=video_id,
            title="A Video",
            duration_s=123.0,
            video_url="https://v.example/x",
            audio_url="https://a.example/x",
        )

    monkeypatch.setattr(youtube, "resolve_stream", fake_resolve)
    r = client.get("/api/youtube/videos/zzz")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "zzz"
    assert body["duration_s"] == 123.0
    assert body["thumbnail_url"] == "https://i.ytimg.com/vi/zzz/hqdefault.jpg"


def test_youtube_hls_manifest_via_remote_source(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    """The HLS manifest for a YouTube video is synthesized from the resolved
    duration and the session is keyed `yt:<id>` with a RemoteSource — no ffmpeg
    runs because the manifest is built from duration alone."""
    client, _ = client_and_registry

    async def fake_resolve(video_id: str, *, max_height: int = 1080) -> youtube.ResolvedStream:
        return youtube.ResolvedStream(
            video_id=video_id,
            title="A Video",
            duration_s=18.0,  # 3 x 6s segments
            video_url="https://v.example/x",
            audio_url="https://a.example/x",
        )

    monkeypatch.setattr(youtube, "resolve_stream", fake_resolve)
    r = client.get("/api/youtube/videos/zzz/hls/index.m3u8")
    assert r.status_code == 200
    body = r.text
    assert "#EXT-X-ENDLIST" in body
    assert body.count("seg-") == 3  # 18s / 6s

    # Session is keyed by id + quality cap so different qualities don't share a cache.
    session = cast(Starlette, client.app).state.hls_manager.get("yt:zzz@1080")
    assert session is not None
    assert isinstance(session.source, RemoteSource)
    assert session.source.video_url == "https://v.example/x"


def test_youtube_hls_quality_cap_routed(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    """`?h=720` selects the 720p cap: resolve is called with it and the session
    is keyed separately so qualities don't collide."""
    client, _ = client_and_registry
    seen: dict[str, int] = {}

    async def fake_resolve(video_id: str, *, max_height: int = 1080) -> youtube.ResolvedStream:
        seen["max_height"] = max_height
        return youtube.ResolvedStream(
            video_id=video_id,
            title="V",
            duration_s=12.0,
            video_url="https://v/720",
            audio_url="https://a/720",
            height=720,
        )

    monkeypatch.setattr(youtube, "resolve_stream", fake_resolve)
    assert client.get("/api/youtube/videos/zzz/hls/index.m3u8?h=720").status_code == 200
    assert seen["max_height"] == 720
    assert cast(Starlette, client.app).state.hls_manager.get("yt:zzz@720") is not None


def test_youtube_manifest_stamps_quality_on_segments(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry]
) -> None:
    """Segment URIs in the manifest must carry ?h=<cap>. They're relative, so a
    query on the manifest URL isn't inherited — without the stamp every segment
    would route to the default-quality session and quality switching would do
    nothing."""
    client, _ = client_and_registry

    async def fake_resolve(video_id: str, *, max_height: int = 1080) -> youtube.ResolvedStream:
        return youtube.ResolvedStream(
            video_id=video_id,
            title="V",
            duration_s=18.0,
            video_url="https://v",
            audio_url="https://a",
            height=max_height,
        )

    monkeypatch.setattr(youtube, "resolve_stream", fake_resolve)
    body = client.get("/api/youtube/videos/zzz/hls/index.m3u8?h=720").text
    seg_lines = [ln for ln in body.splitlines() if ln.startswith("seg-")]
    assert seg_lines, "manifest had no segment lines"
    assert all(ln.endswith(".ts?h=720") for ln in seg_lines), seg_lines


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "https://youtube.com.evil.test/@x",
        "https://evil.test/youtube.com/@x",
        "https://youtube.com@evil.test/@x",
        "file:///etc/passwd",
        "ftp://evil.test/x",
        "not a url",
        "",
    ],
)
def test_add_channel_rejects_non_youtube_url(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry], url: str
) -> None:
    """A non-YouTube URL is refused with 422 and never reaches yt-dlp.

    The route hands its URL to yt-dlp, whose generic extractor fetches
    arbitrary hosts, so an unvalidated value is an SSRF primitive — and the
    route is unauthenticated unless the server was started with --auth.
    """
    client, _ = client_and_registry
    called = False

    async def fake_list(
        url: str, *, tab: str = "videos", limit: int = 60, force: bool = False
    ) -> youtube.ChannelListing:
        nonlocal called
        called = True
        return _LISTING

    monkeypatch.setattr(youtube, "list_channel", fake_list)
    assert client.post("/api/youtube/channels", json={"url": url}).status_code == 422
    assert called is False, "extraction must not run for a rejected URL"


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/@RedLetterMedia",
        "https://youtube.com/channel/UCrlm",
        "https://m.youtube.com/@x/shorts",
        "https://music.youtube.com/channel/UCrlm",
        "https://youtu.be/@x",
        "  https://www.youtube.com/@x  ",
    ],
)
def test_add_channel_accepts_youtube_hosts(
    monkeypatch: pytest.MonkeyPatch, client_and_registry: tuple[TestClient, UserRegistry], url: str
) -> None:
    """Real YouTube channel URLs still subscribe, whitespace included."""
    client, _ = client_and_registry

    async def fake_list(
        url: str, *, tab: str = "videos", limit: int = 60, force: bool = False
    ) -> youtube.ChannelListing:
        return _LISTING

    monkeypatch.setattr(youtube, "list_channel", fake_list)
    assert client.post("/api/youtube/channels", json={"url": url}).status_code == 201


async def test_list_channel_guards_the_sink() -> None:
    """`list_channel` refuses a non-YouTube host even when called directly.

    Defence in depth: the request boundary rejects first, but the sink is what
    actually reaches yt-dlp, so it validates too.
    """
    with pytest.raises(youtube.YouTubeError, match="refusing to fetch non-YouTube URL"):
        await youtube.list_channel("http://169.254.169.254/latest/meta-data/")


def test_is_allowed_channel_url_matches_host_exactly() -> None:
    """Host matching is exact — no substring or suffix passes."""
    assert youtube.is_allowed_channel_url("https://www.youtube.com/@x")
    assert not youtube.is_allowed_channel_url("https://notyoutube.com/@x")
    assert not youtube.is_allowed_channel_url("https://youtube.com.evil.test/@x")
    assert not youtube.is_allowed_channel_url("https://evil.test/?u=youtube.com")
