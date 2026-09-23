"""Combined audio + video FastAPI app for `maneki serve`.

URL layout (each kind-prefix exists when that kind has content, or when a
remote source hosted on that mount is available):

    GET  /capabilities         server identity + what's mounted
    POST /auth/login           exchange username + password for a bearer token
    GET  /auth/me              echo back the authed user (requires bearer)
    /audio/rest/*              Subsonic (local audio and/or internet radio)
    /video/api/*               Maneki native video API (local video and/or YouTube)
    /video/                    throwaway demo HTML page (retired when SPA lands)

The single library root is scanned for both kinds at startup. Both mounts
also host a remote source that needs nothing on disk — internet radio on
the Subsonic mount, YouTube on the native one — so both are present even
for an empty root; only their local-library halves are empty there.

Auth is opt-in: pass `enable_auth=True` (CLI: `maneki serve --auth`) to
require a bearer token on /video/* (and future Maneki-native endpoints).
The media routes underneath those prefixes also take that token as
`?token=`, because a media element's URL cannot carry a header — see
`BearerAuthMiddleware`. The audio (Subsonic) mount always uses its own
salt-token auth and is unaffected by this flag.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections.abc import MutableMapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from maneki import __version__
from maneki.audio.radio import load_stations
from maneki.auth import Token, TokenStore
from maneki.library import has_audio, has_video

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from maneki.audio.serve.config import ServeConfig
    from maneki.audio.serve.users import UserRegistry
    from maneki.books.library import BooksIndex

_log = logging.getLogger(__name__)


class LoginRequest(BaseModel):
    """Body of POST /auth/login."""

    username: str
    password: str


class LoginResponse(BaseModel):
    """Returned by POST /auth/login on success."""

    token: str
    username: str
    expires_at: str


class WhoAmI(BaseModel):
    """Returned by GET /auth/me."""

    username: str
    expires_at: str


def create_combined_app(
    *,
    root: Path,
    enable_auth: bool = False,
    enable_ui: bool = False,
    ui_dir: Path | None = None,
    audio_use_cache: bool = True,
    audio_cfg: ServeConfig | None = None,
    transcode_workers: int | None = None,
    rescan: bool = False,
    prewarm_cache: bool = False,
    no_cover_images: bool = False,
) -> FastAPI:
    """Build a FastAPI app that auto-mounts whichever kinds are present at root.

    The whole library lives under a single `root` directory. Audio and video
    are detected by file extension anywhere under that root — there is no
    `audio/`/`videos/` subdirectory convention. A kind with zero matching
    files still gets its mount when that mount hosts a remote source
    (internet radio on /audio, YouTube on /video); only the local-library
    half is empty then.

    Args:
        root: library root. Scanned recursively for both audio and video files.
        enable_auth: if True, require Authorization: Bearer <token> on
            /video/* (Subsonic at /audio/rest/* keeps its own auth). Default
            False so the existing demo page keeps working unchanged.
        enable_ui: if True, mount the React SPA at /. The SPA lives at
            desktop/react/ in the repo tree.
        ui_dir: explicit path to the SPA directory. Default: auto-discover
            desktop/react/ relative to the repo root.
        audio_use_cache: forwarded to the audio Subsonic app's SQLite index cache.
        audio_cfg: explicit ServeConfig for credentials. When None (the default),
            credentials are resolved from ~/.config/maneki/maneki.toml,
            falling back to admin/admin. Tests pass this explicitly to avoid
            leaking state from shared class-level config caches.
        transcode_workers: cap on concurrent background ffmpeg jobs
            (prewarm, neighbour prefetch, poster generation). None uses
            the TranscodeBudget default (cpu_count // 2, capped at 4).
            Foreground player requests always preempt background work.
        rescan: when True, wipe the on-disk thumbnail / poster cache
            before startup so the next browse / prewarm regenerates
            everything. Use after files change underneath the server
            (renames, edits) so cached cover sheets get refreshed.
            Default False keeps prior runs' work.
        prewarm_cache: when True, generate every video's row thumbnail
            and contact-sheet poster during startup (heavy: ~1-2s per
            thumbnail + ~3-5s per poster, niced + 1-thread so it
            doesn't fight foreground playback). Default False -- thumbs
            generate on first SPA browse, posters on first /poster
            request. Pair with --rescan when you actually want every
            asset rebuilt; without --rescan, prewarm-cache skips files
            whose cache already exists, so it's idempotent and cheap on
            a second run.
        no_cover_images: when True, skip contact-sheet poster generation
            in both on-demand and prewarm paths. /poster endpoints fall
            back to the cheap row-thumbnail (one frame, no contact
            sheet). Useful on slow disks or huge libraries where the
            9-frame contact sheet isn't worth the wait.
    """
    audio_present = has_audio(root)
    video_present = has_video(root)
    # YouTube is a remote source: it needs nothing on disk (yt-dlp is a hard
    # dependency, ffmpeg is assumed), so it's always available on a maneki
    # server. The native (video) app hosts its endpoints, so that app is
    # mounted whenever EITHER local video files exist OR YouTube is available
    # (i.e. always) — letting YouTube work on audio-only / empty libraries.
    youtube_present = True
    # Internet radio is the audio-side equivalent: the station list is baked
    # into the code (plus the user's ~/.config/maneki/radio.toml), so it needs
    # nothing on disk either. The Subsonic (audio) app hosts
    # getInternetRadioStations, radioStream and the ICY proxy, so that app is
    # mounted whenever EITHER local audio files exist OR stations resolve
    # (i.e. always, since DEFAULT_STATIONS is non-empty) — letting radio work
    # on video-only / empty libraries. The local-library scan stays gated on
    # `audio_present` (see `_mount_audio`), so a radio-only mount costs no
    # walk and writes no index.db.
    radio_present = bool(load_stations())
    # Audiobooks: the root's top-level `Audiobooks/` folder, which the music
    # and video walks skip (`maneki.library`), gets its own `/books` mount.
    from maneki.books.library import BooksIndex, books_dir

    books_present = books_dir(root) is not None
    # One index, shared by the /books API and the Subsonic mount that browses
    # books as their own music folder.
    books_index = BooksIndex(root, use_cache=audio_use_cache) if books_present else None
    cfg = _resolve_cfg(audio_cfg)
    token_store = TokenStore()
    # Accounts for the native (video) bearer login. Multi-user when [[users]]
    # is configured, else a single admin honouring --user/--password.
    from maneki.audio.serve.users import UserRegistry
    from maneki.settings import get_settings

    users = UserRegistry.from_settings(root) if get_settings().users else UserRegistry.single_user(root, cfg)

    # Lifespan: orphan-cleanup pass on startup, no eager prewarm.
    #
    # The old code spawned a poster-thumbnail prewarm task AND an HLS
    # seg-0 prewarm task that walked the entire library and produced
    # ffmpeg jobs for every file. Fine on a 10-video test library;
    # on a real ~10000-file library this peg the CPU for hours with
    # 10000 queued background ffmpegs (even with the budget cap of 4
    # concurrent, that's 4 ffmpegs continuously for a long time and
    # the laptop fan never spins down).
    #
    # New shape: do nothing at startup beyond the cheap orphan-cache
    # sweep. Posters generate on the first /poster request; HLS
    # segments transcode on first /hls/seg-N.ts request. The user
    # pays a one-time ~1-3s cold-play latency for a video they've
    # never opened, in exchange for the library scan + background
    # workers staying out of the way until something is actually used.
    #
    # The orphan sweep itself is cheap (stat-only walk; no ffprobe)
    # and runs in a worker thread so the startup remains non-blocking.
    @contextlib.asynccontextmanager
    async def _lifespan(app: FastAPI):  # type: ignore[no-untyped-def]
        import shutil
        from typing import cast

        from starlette.routing import Mount

        # Mount.app is typed as the generic ASGI callable; we know
        # the /video mount holds a FastAPI sub-app with our custom
        # `state` attributes attached in _mount_video. Cast so
        # mypy lets us reach into it.
        video_sub_app: FastAPI | None = next(
            (cast(FastAPI, r.app) for r in app.routes if isinstance(r, Mount) and r.path == "/video"),
            None,
        )
        # VideoLibraryWatcher uses a deferred import so the heavy
        # `watchdog` dependency only loads when a video mount is
        # actually present. video_index is the persistent SQLite cache
        # of file metadata — opened once at startup, shared across the
        # initial scan and every watcher-triggered rescan.
        watcher: Any = None
        video_index: Any = None

        # The audio index was built synchronously in `_mount_audio`; the
        # watcher keeps it current from here on, so an album dropped into
        # the library shows up without a `startScan` or a restart. Radio-only
        # mounts (`audio_present` False) have no library to watch.
        # ONE FILESYSTEM OBSERVER FOR THE WHOLE ROOT. Music, books and video all watch the
        # same folder, and macOS refuses a second observer on a path it already has --
        # "already scheduled", and the loser's thread dies quietly. The observer is started
        # here and every watcher schedules on it; watchdog attaches a watch scheduled after
        # the start to the running observer, which is what the video one, started later
        # from the background task, relies on.
        from watchdog.observers import Observer

        observer: Any = Observer()
        observer.start()

        audio_watcher: Any = None
        audio_sub_app: FastAPI | None = next(
            (cast(FastAPI, r.app) for r in app.routes if isinstance(r, Mount) and r.path == "/audio"),
            None,
        )
        if audio_present and audio_sub_app is not None:
            from maneki.audio.serve.watcher import LibraryWatcher

            audio_watcher = LibraryWatcher(audio_sub_app.state.cache, observer=observer)
            audio_watcher.start()

        # Books: scan in the background (warm starts reuse the index rows),
        # then watch the folder so an imported book appears on its own.
        books_watcher: Any = None
        books_sub_app: FastAPI | None = next(
            (cast(FastAPI, r.app) for r in app.routes if isinstance(r, Mount) and r.path == "/books"),
            None,
        )
        if books_sub_app is not None:
            from maneki.audio.serve.watcher import LibraryWatcher

            books_index = books_sub_app.state.books_index
            books_index.start_background_rescan()
            books_watcher = LibraryWatcher(books_index, observer=observer)
            books_watcher.start()

        async def _do_scan(*, do_prewarm_cache: bool) -> None:
            """One pass of library scan + orphan sweep + optional image prewarm.

            Re-entry guard: skips when the tracker already reports
            scanning=True. asyncio is single-threaded so the check + the
            subsequent `prewarm_scan` (which calls `begin_walk` before
            its first await) execute atomically; a second concurrent
            caller can't race past the guard.
            """
            if video_sub_app is None or not hasattr(video_sub_app.state, "poster_manager"):
                return
            video_sub = video_sub_app
            if video_sub.state.scan_tracker.snapshot().scanning:
                _log.info("scan: already in progress, skipping")
                return

            from maneki.video.serve.scan import prewarm_scan

            videos = await prewarm_scan(
                video_sub.state.library_root,
                video_sub.state.scan_tracker,
                index=video_index,
                on_changed=video_sub.state.poster_manager.invalidate,
            )
            video_sub.state.video_cache = videos
            live_ids = {v.id for v in videos}
            video_sub.state.poster_manager.clean_orphans(live_ids)
            video_sub.state.hls_manager.clean_orphans(live_ids)
            video_sub.state.subtitle_cache.clean_orphans(live_ids)

            if do_prewarm_cache:
                _log.info(
                    "prewarm-cache: starting %s generation for %d videos",
                    "thumbnail" if no_cover_images else "thumbnail/poster",
                    len(videos),
                )
                await video_sub.state.poster_manager.prewarm(
                    [v.model_dump() for v in videos],
                    skip_posters=no_cover_images,
                )
                _log.info("prewarm-cache: done")

        async def _rescan_callback() -> None:
            """Watcher / endpoint entry point. Honours --prewarm-cache for follow-ups."""
            await _do_scan(do_prewarm_cache=prewarm_cache)

        async def _background_startup() -> None:
            # Only the local-video library needs scanning / prewarm / a file
            # watcher. The native app may be mounted purely for YouTube (no
            # local video), in which case there's nothing on disk to index.
            if not video_present:
                return
            if video_sub_app is None or not hasattr(video_sub_app.state, "poster_manager"):
                return
            video_sub = video_sub_app

            # Open the persistent SQLite index. From here on every
            # call into _do_scan reuses already-probed rows; ffprobe
            # only runs for new or changed files. Lifespan owns the
            # connection — closed in the finally block below.
            from maneki.video.serve.scan_cache import VideoIndex

            nonlocal video_index
            video_index = VideoIndex(video_sub.state.library_root)

            # --rescan: blow away the on-disk thumbnail + poster cache so
            # the next prewarm / on-demand request regenerates everything,
            # AND wipe every row in the video index so the upcoming
            # prewarm_scan re-ffprobes the whole tree. Subtitle + HLS
            # caches stay (those are content-addressed and don't go
            # stale the same way a poster does when a user re-encodes
            # or re-edits a file).
            if rescan:
                cache_dir = video_sub.state.poster_manager.cache_dir
                if cache_dir.is_dir():
                    _log.info("rescan: wiping poster/thumbnail cache at %s", cache_dir)
                    shutil.rmtree(cache_dir, ignore_errors=True)
                _log.info("rescan: wiping persistent video index")
                video_index.clear()

            # Initial library scan. _do_scan also drives subsequent
            # watcher-triggered rescans, so any change here is shared.
            await _do_scan(do_prewarm_cache=prewarm_cache)

            # Expose the rescan trigger to the video sub-app so POST
            # /api/scan can fire it without reaching across the mount.
            video_sub.state.trigger_rescan = _rescan_callback

            # Start the filesystem watcher so a new file dropped under
            # the library root triggers a debounced rescan within ~5s,
            # no SPA action / server restart required.
            from maneki.video.serve.watcher import VideoLibraryWatcher

            nonlocal watcher
            watcher = VideoLibraryWatcher(video_sub.state.library_root, _rescan_callback, observer=observer)
            watcher.start(asyncio.get_running_loop())

        startup_task = asyncio.create_task(_background_startup())
        try:
            yield
        finally:
            if not startup_task.done():
                startup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await startup_task
            if watcher is not None:
                with contextlib.suppress(Exception):
                    watcher.stop()
            if audio_watcher is not None:
                with contextlib.suppress(Exception):
                    audio_watcher.stop()
            if books_watcher is not None:
                with contextlib.suppress(Exception):
                    books_watcher.stop()
            with contextlib.suppress(Exception):
                observer.stop()
                observer.join(timeout=2.0)
            if video_index is not None:
                with contextlib.suppress(Exception):
                    video_index.close()

    combined = FastAPI(title="maneki", version=__version__, lifespan=_lifespan)

    # Allow the desktop wrappers (Tauri serves the SPA from
    # http://tauri.localhost, Electron from a file:// origin) and
    # any other cross-origin caller to talk to the API. The Subsonic
    # sub-app already does this for /audio/rest/*; the top-level
    # routes (/capabilities, /auth/login, /video/api/*) need the
    # same treatment or fetch() from a wrapper webview gets a CORS
    # null response and the SPA reports "couldn't reach the server"
    # even though the server is up and curl works fine.
    #
    # `allow_origins=["*"]` matches the self-hosted single-user
    # threat model. The real security boundary is the bearer token
    # at /auth/login when --auth is on; CORS is a browser convenience
    # not an authorisation layer.
    combined.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @combined.get("/capabilities")
    def capabilities() -> dict[str, object]:
        # `audio` / `video` describe the LOCAL LIBRARY; the `endpoints` map
        # describes WHAT IS MOUNTED. Those are no longer the same question,
        # because both mounts also host a remote source (radio on /audio,
        # YouTube on /video). Keeping the two apart is what lets a
        # radio-only server be honest: `audio: false` tells a client "do not
        # bother browsing artists/albums, there are none", while a non-null
        # `audio_subsonic` still points at the mount that serves the radio
        # endpoints. Reporting `audio: true` instead would send every
        # Subsonic client off to browse an empty library.
        return {
            "server": "maneki",
            "version": __version__,
            "audio": audio_present,
            "video": video_present,
            "youtube": youtube_present,
            "radio": radio_present,
            "books": books_present,
            "auth_required": enable_auth,
            "endpoints": {
                # Mounted whenever local audio OR radio is on, so the Subsonic
                # base is available in both cases (radio lives on it).
                "audio_subsonic": "/audio/rest" if (audio_present or radio_present) else None,
                # The native app is mounted whenever video OR YouTube is on, so
                # its API base is available in both cases.
                "video_api": "/video/api" if (video_present or youtube_present) else None,
                "books_api": "/books/api" if books_present else None,
                "auth_login": "/auth/login",
            },
        }

    @combined.post("/auth/login", response_model=LoginResponse)
    def login(body: LoginRequest) -> LoginResponse:
        account = users.get(body.username)
        if account is None or account.password != body.password:
            raise HTTPException(status_code=401, detail="invalid credentials")
        token = token_store.issue(body.username)
        return LoginResponse(
            token=token.value,
            username=token.username,
            expires_at=token.expires_at.isoformat(),
        )

    @combined.get("/auth/me", response_model=WhoAmI)
    def me(request: Request) -> WhoAmI:
        token = _token_from_request(request, token_store)
        return WhoAmI(username=token.username, expires_at=token.expires_at.isoformat())

    if enable_auth:
        combined.add_middleware(
            BearerAuthMiddleware,
            token_store=token_store,
            protected_prefixes=("/video/", "/books/"),
        )

    if audio_present or radio_present:
        # Mounted even with no local audio so the internet-radio endpoints
        # exist; `scan_library` keeps the (blocking) library scan gated on
        # `audio_present`, so a video-only / empty library pays no scan cost
        # and gets no `.maneki/index.db` written into it. Dropping audio into
        # such a root later needs a restart (or a Subsonic `startScan`) to
        # index it — same as before this mount existed.
        _mount_audio(
            combined,
            root,
            use_cache=audio_use_cache,
            cfg=cfg,
            users=users,
            scan_library=audio_present,
            books=books_index,
        )

    if video_present or youtube_present:
        # Mounted even with no local video so the YouTube endpoints exist; the
        # local-library scan/prewarm/watcher in the lifespan stays gated on
        # `video_present`, so an audio-only library pays no scan cost.
        _mount_video(combined, root, workers=transcode_workers, no_cover_images=no_cover_images, users=users)

    if books_index is not None:
        from maneki.books.serve import create_books_app

        # The index starts empty and fills from a background scan in the
        # lifespan, so a large book library never delays startup.
        combined.mount("/books", create_books_app(books_index, users=users))

    if enable_ui:
        # Mount the SPA at "/" LAST. FastAPI/Starlette match routes in
        # registration order, so /capabilities, /auth/*, /audio/*, and
        # /video/* already registered above keep priority. Every other
        # path falls through to StaticFiles, which (html=True) serves
        # index.html for "/" and the matching file for "/src/...". No
        # redirect needed - visiting http://host:port/ lands on the SPA.
        _mount_ui(combined, ui_dir)

    return combined


def _resolve_cfg(audio_cfg: ServeConfig | None) -> ServeConfig:
    if audio_cfg is not None:
        return audio_cfg
    from maneki.audio.serve.config import resolve_credentials

    cfg, _ = resolve_credentials(cli_user=None, cli_password=None)
    return cfg


def _token_from_request(request: Request, store: TokenStore) -> Token:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing Authorization: Bearer <token>")
    raw = header[7:].strip()
    token = store.validate(raw)
    if token is None:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    return token


#: The query parameter a media URL carries its bearer token in.
MEDIA_TOKEN_PARAM = "token"

# The routes a media element or an EventSource fetches directly — the ones
# whose URL is handed to the browser rather than to `fetch`, so no header can
# ride along. Everything else, the JSON APIs included, is absent on purpose.
#
# A video id is a slug with every "/" replaced (see video.serve.scan), and a
# book id is a hash, so one path segment is always exactly one id.
_MEDIA_TOKEN_PATHS: tuple[re.Pattern[str], ...] = (
    # <video src>, and the poster / thumbnail <img src> behind and beside it.
    re.compile(r"^/video/api/videos/[^/]+/(?:stream|play|poster|thumbnail)$"),
    # The HLS manifest and every segment it names, local files and YouTube alike.
    re.compile(r"^/video/api/videos/[^/]+/hls/[^/]+$"),
    re.compile(r"^/video/api/youtube/videos/[^/]+/hls/[^/]+$"),
    # <track src>: one subtitle track as WebVTT. The listing above it
    # (/subtitles, no key) is JSON and stays on the header.
    re.compile(r"^/video/api/videos/[^/]+/subtitles/[^/]+$"),
    # The stats EventSource, which cannot set a header either.
    re.compile(r"^/video/api/stats/stream$"),
    # <img src> for a book's cover and <audio src> for its files.
    re.compile(r"^/books/api/books/[^/]+/cover$"),
    re.compile(r"^/books/api/books/[^/]+/files/[^/]+$"),
)


def accepts_media_token(method: str, path: str) -> bool:
    """Whether `?token=` is a valid way to authenticate this request.

    Reads only — a GET or its HEAD. Nothing that changes state is reachable
    with a token out of a URL, so a link somebody pasted somewhere can at
    worst be read with.
    """
    return method in {"GET", "HEAD"} and any(pattern.match(path) for pattern in _MEDIA_TOKEN_PATHS)


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid bearer token for any request whose path starts with a protected prefix.

    TWO WAYS TO PRESENT THE SAME TOKEN, AND ONE OF THEM IS THE URL. `fetch`
    can set `Authorization: Bearer <token>` and every JSON call does. A
    `<video src>`, an `<img src>`, a `<track src>`, an `<audio src>` and an
    `EventSource` cannot: the browser issues those requests itself and there
    is no hook to put a header on them. Without a second way to present the
    token, `--auth` would leave the app signed in and every picture, stream
    and subtitle 401 -- the library would be readable and unplayable.

    So a GET of a media route may carry the token as `?token=<token>`
    instead, validated by exactly the same `TokenStore.validate` the header
    is. The header wins where both are present.

    WHY ONLY THOSE ROUTES. A token in a URL is a token in a browser history,
    a referer and anything that copies a link; the header is the safer
    grammar and stays mandatory wherever it can be used. `_MEDIA_TOKEN_PATHS`
    is therefore the exact list of paths a media element or an EventSource
    fetches, and the JSON APIs are not on it -- `?token=` alone on one of
    those is still a 401.

    WHAT REACHES THE LOGS. `maneki.access_log` writes `request.url.path` and
    never the query string, which is what keeps this token, Subsonic's `p=`
    password and its `t=` challenge out of the access log line -- three
    secrets, one rule, stated there so it survives the next edit. Nothing
    else in the stack logs a URL: uvicorn's own access log is silenced by
    `configure_logging()`.
    """

    def __init__(
        self,
        app: object,
        *,
        token_store: TokenStore,
        protected_prefixes: tuple[str, ...],
    ) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self.token_store = token_store
        self.protected_prefixes = protected_prefixes

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        path = request.url.path
        if any(path.startswith(p) for p in self.protected_prefixes):
            header = request.headers.get("authorization", "")
            presented = header[7:].strip() if header.lower().startswith("bearer ") else None
            from_url = False
            if presented is None and accepts_media_token(request.method, path):
                presented = request.query_params.get(MEDIA_TOKEN_PARAM) or None
                from_url = presented is not None
            if presented is None:
                return JSONResponse(
                    {"detail": "missing Authorization: Bearer <token>"},
                    status_code=401,
                )
            token = self.token_store.validate(presented)
            if token is None:
                return JSONResponse(
                    {"detail": "invalid or expired token"},
                    status_code=401,
                )
            # Expose the authenticated account to video endpoints (per-user
            # video data scopes off this once it exists).
            request.state.username = token.username
            if from_url:
                # An HLS manifest names its segments relatively, and a relative
                # URL does not inherit the query of the document it was found
                # in -- so the video app has to stamp the token onto each
                # segment URI itself. What it stamps is this, a token this
                # middleware has already validated, and never the raw query.
                request.state.media_token = presented
        return await call_next(request)


def _mount_audio(
    combined: FastAPI,
    library_root: Path,
    *,
    use_cache: bool,
    cfg: ServeConfig,
    users: UserRegistry,
    scan_library: bool = True,
    books: BooksIndex | None = None,
) -> None:
    """Mount the Subsonic app under /audio against the shared library root.

    Triggers the initial library scan synchronously so the first /audio/rest/*
    request hits a populated IndexCache. Mounting the audio sub-app means we
    drive the rebuild here (the IndexCache is created at create_app time but
    its content isn't populated until rebuild() runs).

    The audio scanner walks `library_root` recursively for audio extensions,
    so passing the library root (rather than a subdirectory) is what makes
    single-library mode work — video subtrees are naturally skipped because
    they contain no audio files.

    `scan_library=False` mounts the app but skips that rebuild: the caller
    already knows the root holds no audio and the mount exists only to host
    the internet-radio endpoints. A freshly constructed IndexCache is a valid
    empty index (every lookup map starts empty), so browse endpoints return
    empty lists rather than erroring — and skipping the rebuild avoids both a
    pointless second walk of the tree and creating `<root>/.maneki/index.db`
    in a library that has no audio to index.
    """
    from maneki.audio.serve import create_app as create_audio_app

    audio_app = create_audio_app(root=library_root, cfg=cfg, use_cache=use_cache, users=users, books=books)
    if scan_library:
        audio_app.state.cache.rebuild()
    combined.mount("/audio", audio_app)


def _mount_video(
    combined: FastAPI,
    library_root: Path,
    *,
    workers: int | None,
    no_cover_images: bool,
    users: UserRegistry,
) -> None:
    """Mount the video app under /video.

    `workers` controls the shared TranscodeBudget's background worker
    count. None = use the budget's default (cpu_count // 2, capped 4).
    `users` is the shared account registry, passed through so the video
    app's YouTube endpoints can scope subscriptions per user.
    """
    from maneki.video.serve import create_app as create_video_app
    from maneki.video.serve.transcode_budget import TranscodeBudget

    budget = TranscodeBudget(max_workers=workers) if workers is not None else None
    video_app = create_video_app(library_root, budget=budget, no_cover_images=no_cover_images, users=users)
    combined.mount("/video", video_app)


class _SPAStaticFiles(StaticFiles):
    """StaticFiles that makes the SPA shell always-revalidate.

    Vite emits content-hashed asset filenames (`index-<hash>.js`), so those are
    safe to cache forever. But `index.html` (which references the current
    hashes) must NOT be cached, or a browser keeps loading an old build's
    assets after a redeploy — the classic "I rebuilt but the UI is stale until
    a hard refresh" trap. Mark the HTML shell `no-cache` (revalidate every
    load) and the hashed assets `immutable`.
    """

    async def get_response(self, path: str, scope: MutableMapping[str, Any]) -> Response:
        response = await super().get_response(path, scope)
        media_type = getattr(response, "media_type", None) or ""
        if media_type.startswith("text/html"):
            response.headers["Cache-Control"] = "no-cache"
        elif path.startswith("assets/") or "/assets/" in path:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def _mount_ui(combined: FastAPI, ui_dir: Path | None) -> None:
    """Mount the built clients: the current one at "/", the one it replaces at "/classic".

    Must be the LAST mount registered - StaticFiles at "/" catches every
    path not already claimed by a higher-priority route (/capabilities,
    /auth/*, /audio/*, /video/*), so those must be in place before this
    runs. `html=True` serves index.html for "/" and the matching file
    for asset paths.

    TWO CLIENTS, BECAUSE ONE OF THEM CAN STILL DO SOMETHING THE OTHER CANNOT.
    The current client has the library, the radio and the books; the one it
    replaces still has the video and YouTube screens. Serving both costs one
    mount and means the newer client can land before it has grown everything,
    without anybody losing a screen they were using.
    """
    chosen = ui_dir if ui_dir is not None else _discover_ui_dir()
    if chosen is None or not (chosen / "index.html").is_file():
        raise RuntimeError(
            "--ui requested but no built client found. Build it first: `make app` "
            "(or `cd desktop/app && bun install && bun run build`), which produces "
            "desktop/app/dist/. (Installed wheels bundle it automatically.)"
        )
    classic = _discover_classic_dir()
    if classic is not None:
        combined.mount("/classic", _SPAStaticFiles(directory=classic, html=True), name="spa-classic")
    combined.mount("/", _SPAStaticFiles(directory=chosen, html=True), name="spa")


def _discover_ui_dir() -> Path | None:
    """Locate the built client, preferring the wheel-bundled copy.

    Two layouts must work:

    - Installed wheel: `scripts/copy_ui_static.py` copies the build into
      `maneki/_ui_static/` at build time, so it sits right next to this
      module. This is the only copy that exists in a PyPI/uv install.
    - Dev checkout: `_ui_static` is gitignored and may be stale or absent,
      so fall back to `desktop/app/dist/` relative to the repo root.
    """
    return _bundled_or_built("_ui_static", ("desktop", "app", "dist"))


def _discover_classic_dir() -> Path | None:
    """The client this one replaces, which still carries the video screens."""
    return _bundled_or_built("_ui_static_classic", ("desktop", "react", "dist"))


def _bundled_or_built(bundled_name: str, built: tuple[str, ...]) -> Path | None:
    """The wheel's copy of one client, else the repo's own build of it, else nothing."""
    bundled = Path(__file__).resolve().parent / bundled_name
    if (bundled / "index.html").is_file():
        return bundled
    candidate = Path(__file__).resolve().parents[2].joinpath(*built)
    return candidate if (candidate / "index.html").is_file() else None
