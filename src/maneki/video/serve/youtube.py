"""YouTube channel listing + stream resolution via yt-dlp.

maneki's video pipeline is otherwise local-filesystem only. This module is the
single bridge to YouTube: it turns a channel URL into a browsable list of
videos, and a video id into the direct googlevideo URLs ffmpeg streams from.
Everything downstream (the HLS segment transcoder, the player) treats a YouTube
video exactly like a local file — see `sources.RemoteSource`.

Two operations, two cost tiers:

- `list_channel` uses yt-dlp's *flat* extraction (`extract_flat`): one request
  per channel, no per-video resolution. Cheap enough to call on a channel open.
  Capped to the most recent `limit` uploads and cached briefly.
- `resolve_stream` does a full per-video extraction to get the signed
  googlevideo URLs. We prefer an H.264 (avc1) video + m4a audio so the
  transcode decodes cheaply (AV1/VP9 software decode is the expensive path).
  The signed URLs expire (~6h), so the result is cached for less than that.

All yt-dlp calls are blocking, so the async wrappers run them in a worker
thread to keep the event loop free.

Known limitation (documented, not solved here): a watch that outlives the
cached URL's expiry will start failing segment transcodes. Re-resolving on a
segment ffmpeg failure is a follow-up.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from threading import RLock
from typing import Any, Literal

import yt_dlp
from pydantic import BaseModel, ConfigDict
from yt_dlp.utils import DownloadError

log = logging.getLogger(__name__)

# yt-dlp ships partial, awkward type hints. Pin the one class we use to `Any` so
# the (untyped) options dict and the dynamically-shaped info dict it returns
# don't fight the type checkers — the data shape is validated into our own
# Pydantic models right after extraction anyway.
_YoutubeDL: Any = yt_dlp.YoutubeDL

# Most-recent uploads to list per channel. A channel can have thousands of
# videos; flat extraction still paginates them all without a cap, which is slow
# and not what "browse the channel" wants.
DEFAULT_CHANNEL_LIMIT = 60

# A channel surfaces three content tabs we care about. yt-dlp lists each from
# the corresponding URL tab: `/videos`, `/shorts`, `/streams` (the last holds
# live + past/recorded live streams).
ChannelTab = Literal["videos", "shorts", "streams"]
CHANNEL_TABS: tuple[ChannelTab, ...] = ("videos", "shorts", "streams")

# Map a tab to the per-item kind we tag results with, so the UI can label /
# group them without re-deriving from the tab.
_TAB_KIND: dict[ChannelTab, str] = {"videos": "video", "shorts": "short", "streams": "live"}

# Channel sub-paths we strip to recover the bare channel URL before appending
# the tab we actually want to list.
_CHANNEL_SUBPATHS = ("/videos", "/shorts", "/streams", "/featured", "/playlists", "/community", "/podcasts")

# Cache TTLs (seconds). Channel listings change slowly (a new upload now and
# then) so a short cache spares repeated multi-second extractions. Stream URLs
# are signed and expire in roughly 6h, so we cache them for comfortably less.
_CHANNEL_TTL_S = 30 * 60
_STREAM_TTL_S = 5 * 60 * 60

# Allowed quality caps (max output height). The UI picks one; the resolver
# selects the best stream at or below it.
DEFAULT_MAX_HEIGHT = 1080
QUALITY_HEIGHTS: tuple[int, ...] = (480, 720, 1080, 1440, 2160)


def _format_for(max_height: int) -> str:
    """yt-dlp format string capped at `max_height`.

    Prefer H.264 (cheap to decode) + AAC audio, then any codec at that cap,
    then a muxed single stream. The transcoder re-encodes to H.264/AAC anyway,
    but an avc1 source keeps decode cheap.
    """
    h = max_height
    return (
        f"bestvideo[height<={h}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/"
        f"bestvideo[height<={h}][vcodec^=avc1]+bestaudio/"
        f"bestvideo[height<={h}]+bestaudio/"
        f"best[height<={h}]/best"
    )


class YouTubeError(RuntimeError):
    """A yt-dlp extraction failed (bad URL, removed video, network, ...)."""


class ChannelVideo(BaseModel):
    """One item in a channel listing (from flat extraction — no stream URLs).

    `kind` is the content type (video / short / live) derived from which tab it
    came from. `is_live` flags an item that is currently broadcasting — those
    have no fixed duration and won't play through the VOD HLS pipeline yet
    (recorded/past lives do, and look like ordinary videos).
    """

    model_config = ConfigDict(frozen=True)

    id: str
    title: str
    duration_s: float | None
    thumbnail_url: str
    kind: str = "video"
    is_live: bool = False
    upload_date: str | None = None


class ChannelInfo(BaseModel):
    """Identity of a subscribed channel. `id` is the stable `UC...` channel id."""

    model_config = ConfigDict(frozen=True)

    id: str
    title: str
    url: str
    handle: str | None = None
    thumbnail_url: str | None = None


class ChannelListing(BaseModel):
    """A channel's identity plus its recent videos — the cache unit."""

    model_config = ConfigDict(frozen=True)

    channel: ChannelInfo
    videos: list[ChannelVideo]


class ResolvedStream(BaseModel):
    """Direct googlevideo URLs for one video, ready to hand to ffmpeg.

    `video_url` and `audio_url` are separate DASH streams; they're equal only in
    the rare muxed-format fallback.
    """

    model_config = ConfigDict(frozen=True)

    video_id: str
    title: str
    duration_s: float
    video_url: str
    audio_url: str
    # Per-request HTTP headers (notably User-Agent) yt-dlp resolved for these
    # URLs. googlevideo 403s if ffmpeg fetches without them, so they ride along
    # to the RemoteSource and get replayed on every ffmpeg input.
    http_headers: dict[str, str] = {}
    # Actual height of the chosen video stream, so the transcoder sizes its
    # bitrate to the real output resolution.
    height: int | None = None


def canonical_channel_url(channel_id: str, tab: ChannelTab = "videos") -> str:
    """The URL for a `UC...` channel id's `tab` (stable, what we list from)."""
    return f"https://www.youtube.com/channel/{channel_id}/{tab}"


def thumbnail_url(video_id: str) -> str:
    """Derive a video's thumbnail straight from its id (no fetch needed)."""
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def poster_url(video_id: str) -> str:
    """Larger thumbnail for the player poster."""
    return f"https://i.ytimg.com/vi/{video_id}/maxresdefault.jpg"


class _QuietLogger:
    """Route yt-dlp's chatter into our logger instead of stderr.

    yt-dlp prints warnings/errors straight to stderr even with `quiet`; for an
    embedded library that's console spam (e.g. the benign "channel does not
    have a shorts tab"). Demote everything to our debug stream.
    """

    def debug(self, msg: str) -> None: ...
    def info(self, msg: str) -> None: ...
    def warning(self, msg: str) -> None: ...

    def error(self, msg: str) -> None:
        log.debug("yt-dlp: %s", msg)


# yt-dlp shared options. `no_warnings` mutes the noisy JS-challenge / "some
# formats may be missing" lines; `quiet` mutes progress; the custom logger
# keeps the rest off stderr. We never download.
_BASE_OPTS: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "skip_download": True,
    "noplaylist": False,
    "logger": _QuietLogger(),
}


class _TTLCache:
    """Tiny thread-safe TTL cache (monotonic clock, no background eviction)."""

    def __init__(self, ttl_s: float) -> None:
        self._ttl = ttl_s
        self._lock = RLock()
        self._items: dict[str, tuple[float, object]] = {}

    def get(self, key: str) -> object | None:
        with self._lock:
            hit = self._items.get(key)
            if hit is None:
                return None
            expires_at, value = hit
            if time.monotonic() >= expires_at:
                del self._items[key]
                return None
            return value

    def set(self, key: str, value: object) -> None:
        with self._lock:
            self._items[key] = (time.monotonic() + self._ttl, value)

    def drop(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)


_channel_cache = _TTLCache(_CHANNEL_TTL_S)
_stream_cache = _TTLCache(_STREAM_TTL_S)


def _auth_opts() -> dict[str, Any]:
    """yt-dlp cookie options, to dodge YouTube's "confirm you're not a bot".

    Reads flat env vars first (`MANEKI_YT_COOKIES_FROM_BROWSER`,
    `MANEKI_YT_COOKIEFILE`), falling back to the `[media]` config. Cookies from a
    logged-in browser profile make extraction reliable under load; without them,
    repeated requests from one IP eventually get rate-limited.
    """
    browser = os.environ.get("MANEKI_YT_COOKIES_FROM_BROWSER")
    cookiefile = os.environ.get("MANEKI_YT_COOKIEFILE")
    if not browser and not cookiefile:
        try:
            from maneki.settings import get_settings

            media = get_settings().media
            browser = media.youtube_cookies_from_browser
            cookiefile = media.youtube_cookiefile
        except Exception:  # noqa: BLE001 - settings are best-effort here
            pass
    opts: dict[str, Any] = {}
    if browser:
        # yt-dlp wants a tuple: (browser, profile?, keyring?, container?).
        opts["cookiesfrombrowser"] = (browser.strip().lower(),)
    if cookiefile:
        opts["cookiefile"] = cookiefile
    return opts


def _channel_base(url: str) -> str:
    """Strip a trailing tab segment to recover the bare channel URL.

    Accepts the forms users paste (`.../@handle`, `.../@handle/shorts`,
    `.../channel/UC...`, `.../c/Name`, `.../user/Name`) and returns the URL
    without its content-tab suffix so the caller can append the tab it wants.
    """
    u = url.strip().rstrip("/")
    lowered = u.lower()
    for sub in _CHANNEL_SUBPATHS:
        if lowered.endswith(sub):
            return u[: -len(sub)]
    return u


def _channel_stub(base_url: str) -> ChannelInfo:
    """Minimal ChannelInfo from a base URL, for the empty/missing-tab case.

    Recovers a `UC...` id when the base is a `/channel/<id>` URL (the form we
    construct internally); otherwise leaves id empty. Callers that hit this
    path (a tab a channel doesn't have) only read `.videos`, so the identity
    is best-effort.
    """
    marker = "/channel/"
    channel_id = base_url.split(marker, 1)[1].split("/", 1)[0] if marker in base_url else ""
    return ChannelInfo(id=channel_id, title=channel_id or base_url, url=base_url)


def _list_channel_sync(url: str, tab: ChannelTab, limit: int) -> ChannelListing:
    opts = {
        **_BASE_OPTS,
        **_auth_opts(),
        "extract_flat": "in_playlist",
        "playlist_items": f"1:{limit}",
    }
    base = _channel_base(url)
    target = f"{base}/{tab}"
    try:
        with _YoutubeDL(opts) as ydl:
            info = ydl.extract_info(target, download=False)
    except DownloadError as exc:
        # A channel simply not having a shorts/streams tab is not an error —
        # surface it as an empty listing so the UI shows "none" rather than a
        # failure. yt-dlp phrases this as "does not have a <tab> tab".
        if "does not have a" in str(exc).lower():
            return ChannelListing(channel=_channel_stub(base), videos=[])
        raise YouTubeError(f"could not list channel {url!r}: {exc}") from exc
    if info is None:
        raise YouTubeError(f"could not list channel {url!r}")

    channel_id = info.get("channel_id") or info.get("uploader_id") or info.get("id") or ""
    # `extract_flat` titles the playlist "<Name> - Videos"; the uploader field
    # holds the clean channel name.
    title = info.get("uploader") or info.get("channel") or info.get("title") or url
    thumbs = info.get("thumbnails") or []
    avatar = thumbs[-1]["url"] if thumbs and isinstance(thumbs[-1], dict) and thumbs[-1].get("url") else None
    channel = ChannelInfo(
        id=str(channel_id),
        title=str(title),
        url=canonical_channel_url(str(channel_id)) if channel_id else target,
        handle=info.get("uploader_id"),
        thumbnail_url=avatar,
    )

    kind = _TAB_KIND[tab]
    videos: list[ChannelVideo] = []
    for e in info.get("entries") or []:
        if not e or not e.get("id"):
            continue
        vid = str(e["id"])
        dur = e.get("duration")
        # `live_status` is "is_live" / "is_upcoming" while broadcasting, and
        # "was_live" / "post_live" once recorded. Only the still-broadcasting
        # ones lack a usable duration for the VOD pipeline.
        live_status = e.get("live_status")
        videos.append(
            ChannelVideo(
                id=vid,
                title=str(e.get("title") or vid),
                duration_s=float(dur) if isinstance(dur, (int, float)) else None,
                thumbnail_url=thumbnail_url(vid),
                kind=kind,
                is_live=live_status in ("is_live", "is_upcoming"),
                upload_date=e.get("upload_date"),
            )
        )
    return ChannelListing(channel=channel, videos=videos)


def _resolve_stream_sync(video_id: str, max_height: int) -> ResolvedStream:
    opts = {**_BASE_OPTS, **_auth_opts(), "format": _format_for(max_height)}
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        with _YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except DownloadError as exc:
        raise YouTubeError(f"could not resolve video {video_id!r}: {exc}") from exc
    if info is None:
        raise YouTubeError(f"could not resolve video {video_id!r}")

    requested = info.get("requested_formats")
    if requested and len(requested) >= 2:
        video_fmt = requested[0]
        video_url = video_fmt["url"]
        audio_url = requested[1]["url"]
        headers = video_fmt.get("http_headers") or {}
        height = video_fmt.get("height")
    else:
        # Muxed single-format fallback: same URL feeds both ffmpeg inputs.
        single = info.get("url")
        if not single:
            raise YouTubeError(f"no playable format for video {video_id!r}")
        video_url = audio_url = single
        headers = info.get("http_headers") or {}
        height = info.get("height")

    dur = info.get("duration")
    if not isinstance(dur, (int, float)) or dur <= 0:
        raise YouTubeError(f"video {video_id!r} has no usable duration")

    return ResolvedStream(
        video_id=video_id,
        http_headers={str(k): str(v) for k, v in headers.items()},
        height=int(height) if isinstance(height, (int, float)) else None,
        title=str(info.get("title") or video_id),
        duration_s=float(dur),
        video_url=video_url,
        audio_url=audio_url,
    )


async def list_channel(
    url: str,
    *,
    tab: ChannelTab = "videos",
    limit: int = DEFAULT_CHANNEL_LIMIT,
) -> ChannelListing:
    """Flat-list a channel `tab` (videos / shorts / streams). Cached per tab."""
    key = f"{_channel_base(url)}#{tab}#{limit}"
    cached = _channel_cache.get(key)
    if isinstance(cached, ChannelListing):
        return cached
    listing = await asyncio.to_thread(_list_channel_sync, url, tab, limit)
    _channel_cache.set(key, listing)
    return listing


async def resolve_stream(video_id: str, *, max_height: int = DEFAULT_MAX_HEIGHT) -> ResolvedStream:
    """Resolve a video to direct stream URLs at <= `max_height`. Cached per cap."""
    key = f"{video_id}@{max_height}"
    cached = _stream_cache.get(key)
    if isinstance(cached, ResolvedStream):
        return cached
    resolved = await asyncio.to_thread(_resolve_stream_sync, video_id, max_height)
    _stream_cache.set(key, resolved)
    return resolved


def invalidate_stream(video_id: str, *, max_height: int = DEFAULT_MAX_HEIGHT) -> None:
    """Drop a cached resolution (e.g. after its URLs are seen to have expired)."""
    _stream_cache.drop(f"{video_id}@{max_height}")
