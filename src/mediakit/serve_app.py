"""Combined audio + video FastAPI app for `mediakit serve`.

URL layout (each kind-prefix only exists when that kind has content):

    GET  /capabilities         server identity + what's mounted
    POST /auth/login           exchange username + password for a bearer token
    GET  /auth/me              echo back the authed user (requires bearer)
    /audio/rest/*              Subsonic (mounted when audio files are present)
    /video/api/*               MediaKit native video API (mounted when video files are present)
    /video/                    throwaway demo HTML page (retired when SPA lands)

The single library root is scanned for both kinds at startup. The Subsonic
mount appears only if the scan finds audio files; the video mount appears
only if it finds video files; pointing at an empty directory yields just
`/capabilities` and the auth endpoints.

Auth is opt-in: pass `enable_auth=True` (CLI: `mediakit serve --auth`) to
require a bearer token on /video/* (and future MediaKit-native endpoints).
The audio (Subsonic) mount always uses its own salt-token auth and is
unaffected by this flag.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from mediakit import __version__
from mediakit.auth import Token, TokenStore
from mediakit.library import has_audio, has_video
from mediakit.video.serve.scan import scan_videos

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from mediakit.audio.serve.config import ServeConfig


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
            credentials are resolved from ~/.config/mediakit/mediakit.toml,
            falling back to admin/admin. Tests pass this explicitly to avoid
            leaking state from shared class-level config caches.
        transcode_workers: cap on concurrent background ffmpeg jobs
            (prewarm, neighbour prefetch, poster generation). None uses
            the TranscodeBudget default (cpu_count // 2, capped at 4).
            Foreground player requests always preempt background work.
    """
    audio_present = has_audio(root)
    video_present = has_video(root)
    cfg = _resolve_cfg(audio_cfg)
    token_store = TokenStore()

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
        async def _background_startup() -> None:
            video_sub = next((r.app for r in app.routes if getattr(r, "path", "") == "/video"), None)
            if video_sub is None or not hasattr(video_sub.state, "poster_manager"):
                return
            # Cheap inventory: file list only, no ffprobe (probe=False).
            videos = await asyncio.to_thread(
                lambda: list(scan_videos(video_sub.state.library_root, probe=False))
            )
            live_ids = {v["id"] for v in videos}
            video_sub.state.poster_manager.clean_orphans(live_ids)
            video_sub.state.hls_manager.clean_orphans(live_ids)
            video_sub.state.subtitle_cache.clean_orphans(live_ids)

        startup_task = asyncio.create_task(_background_startup())
        try:
            yield
        finally:
            if not startup_task.done():
                startup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await startup_task

    combined = FastAPI(title="mediakit", version=__version__, lifespan=_lifespan)

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
            "server": "mediakit",
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
        if body.username != cfg.username or body.password != cfg.password:
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
        _mount_audio(combined, root, use_cache=audio_use_cache, cfg=cfg)

    if video_present:
        _mount_video(combined, root, workers=transcode_workers)

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
    from mediakit.audio.serve.config import resolve_credentials

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
            if self.token_store.validate(header[7:].strip()) is None:
                return JSONResponse(
                    {"detail": "invalid or expired token"},
                    status_code=401,
                )
        return await call_next(request)


def _mount_audio(combined: FastAPI, library_root: Path, *, use_cache: bool, cfg: ServeConfig) -> None:
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
    from mediakit.audio.serve import create_app as create_audio_app

    audio_app = create_audio_app(root=library_root, cfg=cfg, use_cache=use_cache)
    audio_app.state.cache.rebuild()
    combined.mount("/audio", audio_app)


def _mount_video(combined: FastAPI, library_root: Path, *, workers: int | None) -> None:
    """Mount the video app under /video.

    `workers` controls the shared TranscodeBudget's background worker
    count. None = use the budget's default (cpu_count // 2, capped 4).
    """
    from mediakit.video.serve import create_app as create_video_app
    from mediakit.video.serve.transcode_budget import TranscodeBudget

    budget = TranscodeBudget(max_workers=workers) if workers is not None else None
    video_app = create_video_app(library_root, budget=budget)
    combined.mount("/video", video_app)


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
            f"--ui requested but no SPA at {chosen}. The SPA lives at desktop/react/ in the source tree."
        )
    combined.mount("/", StaticFiles(directory=chosen, html=True), name="spa")


def _discover_react_dir() -> Path | None:
    """Find desktop/react/ relative to this file's repo location."""
    repo_root = Path(__file__).resolve().parents[2]
    candidate = repo_root / "desktop" / "react"
    return candidate if candidate.exists() else None
