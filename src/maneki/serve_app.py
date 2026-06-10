"""Combined audio + video FastAPI app for `maneki serve`.

URL layout (each kind-prefix only exists when that kind has content):

    GET  /capabilities         server identity + what's mounted
    POST /auth/login           exchange username + password for a bearer token
    GET  /auth/me              echo back the authed user (requires bearer)
    /audio/rest/*              Subsonic (mounted when audio files are present)
    /video/api/*               Maneki native video API (mounted when video files are present)
    /video/                    throwaway demo HTML page (retired when SPA lands)

The single library root is scanned for both kinds at startup. The Subsonic
mount appears only if the scan finds audio files; the video mount appears
only if it finds video files; pointing at an empty directory yields just
`/capabilities` and the auth endpoints.

Auth is opt-in: pass `enable_auth=True` (CLI: `maneki serve --auth`) to
require a bearer token on /video/* (and future Maneki-native endpoints).
The audio (Subsonic) mount always uses its own salt-token auth and is
unaffected by this flag.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
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
from maneki.auth import Token, TokenStore
from maneki.library import has_audio, has_video

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from maneki.audio.serve.config import ServeConfig
    from maneki.audio.serve.users import UserRegistry

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
    files is simply not mounted (no Subsonic routes if no audio, no video
    routes if no video files).

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
            watcher = VideoLibraryWatcher(video_sub.state.library_root, _rescan_callback)
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
        return {
            "server": "maneki",
            "version": __version__,
            "audio": audio_present,
            "video": video_present,
            "auth_required": enable_auth,
            "endpoints": {
                "audio_subsonic": "/audio/rest" if audio_present else None,
                "video_api": "/video/api" if video_present else None,
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
            protected_prefixes=("/video/",),
        )

    if audio_present:
        _mount_audio(combined, root, use_cache=audio_use_cache, cfg=cfg, users=users)

    if video_present:
        _mount_video(combined, root, workers=transcode_workers, no_cover_images=no_cover_images, users=users)

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


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Require a valid bearer token for any request whose path starts with a protected prefix."""

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
            if not header.lower().startswith("bearer "):
                return JSONResponse(
                    {"detail": "missing Authorization: Bearer <token>"},
                    status_code=401,
                )
            token = self.token_store.validate(header[7:].strip())
            if token is None:
                return JSONResponse(
                    {"detail": "invalid or expired token"},
                    status_code=401,
                )
            # Expose the authenticated account to video endpoints (per-user
            # video data scopes off this once it exists).
            request.state.username = token.username
        return await call_next(request)


def _mount_audio(
    combined: FastAPI,
    library_root: Path,
    *,
    use_cache: bool,
    cfg: ServeConfig,
    users: UserRegistry,
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
    """
    from maneki.audio.serve import create_app as create_audio_app

    audio_app = create_audio_app(root=library_root, cfg=cfg, use_cache=use_cache, users=users)
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
    """Mount the React SPA (desktop/react/) at the application root.

    Must be the LAST mount registered - StaticFiles at "/" catches every
    path not already claimed by a higher-priority route (/capabilities,
    /auth/*, /audio/*, /video/*), so those must be in place before this
    runs. `html=True` serves index.html for "/" and the matching file
    for asset paths like "/src/app.jsx".

    Looks for desktop/react/ relative to this file's repo location, or
    accepts an explicit ui_dir override. Raises at startup so a missing
    tree is surfaced immediately rather than as a 404 wall later.
    """
    chosen = ui_dir if ui_dir is not None else _discover_react_dir()
    if chosen is None or not (chosen / "index.html").is_file():
        raise RuntimeError(
            "--ui requested but no built SPA found. The SPA is a Vite build now — "
            "build it first: `make desktop-build-frontend` (or "
            "`cd desktop/react && bun install && bun run build`), which produces "
            "desktop/react/dist/. (Installed wheels bundle it automatically.)"
        )
    combined.mount("/", _SPAStaticFiles(directory=chosen, html=True), name="spa")


def _discover_react_dir() -> Path | None:
    """Locate the built SPA, preferring the wheel-bundled copy.

    Two layouts must work:

    - Installed wheel: `scripts/copy_ui_static.py` copies the Vite build
      into `maneki/_ui_static/` at build time, so it sits right next to
      this module. This is the only copy that exists in a PyPI/uv install.
    - Dev checkout: `_ui_static` is gitignored and may be stale or absent,
      so fall back to `desktop/react/dist/` relative to the repo root.
    """
    bundled = Path(__file__).resolve().parent / "_ui_static"
    if (bundled / "index.html").is_file():
        return bundled
    repo_root = Path(__file__).resolve().parents[2]
    candidate = repo_root / "desktop" / "react" / "dist"
    return candidate if candidate.exists() else None
