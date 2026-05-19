"""Combined audio + video FastAPI app for the unified `mediakit serve`.

URL layout:

    GET  /capabilities         server identity + what's mounted
    POST /auth/login           exchange username + password for a bearer token
    GET  /auth/me              echo back the authed user (requires bearer)
    /audio/rest/*              Subsonic (Stage 1 audio code, mounted under /audio)
    /video/api/*               MediaKit native video API
    /video/                    throwaway demo HTML page (retired when SPA lands)

Both audio and video sub-apps are mounted with their existing factories - no
changes to either kind's standalone behaviour. `mediakit audio serve` and
`mediakit video serve` keep working as before, exposing routes at root.

Auth is opt-in: pass `enable_auth=True` (CLI: `mediakit serve --auth`) to
require a bearer token on /video/* (and future MediaKit-native endpoints).
The audio (Subsonic) mount always uses its own salt-token auth and is
unaffected by this flag.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from mediakit import __version__
from mediakit.auth import Token, TokenStore
from mediakit.library import find_audio_dir
from mediakit.video.serve.scan import find_videos_dir

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
    enable_audio: bool = True,
    enable_video: bool = True,
    enable_auth: bool = False,
    enable_ui: bool = False,
    ui_dir: Path | None = None,
    audio_use_cache: bool = True,
    audio_cfg: ServeConfig | None = None,
) -> FastAPI:
    """Build a FastAPI app that mounts whichever kinds are present at root.

    Args:
        root: library root containing audio/ and/or videos/ subdirectories.
        enable_audio: if False, skip audio mount even if <root>/audio/ exists.
        enable_video: if False, skip video mount even if <root>/videos/ exists.
        enable_auth: if True, require Authorization: Bearer <token> on
            /video/* (Subsonic at /audio/rest/* keeps its own auth). Default
            False so the existing demo page keeps working unchanged.
        enable_ui: if True, mount the React SPA at /ui/. The SPA lives at
            desktop/react/ in the repo tree (lifted MusicKit + soon video).
        ui_dir: explicit path to the SPA directory. Default: auto-discover
            desktop/react/ relative to the repo root.
        audio_use_cache: forwarded to the audio Subsonic app's SQLite index cache.
        audio_cfg: explicit ServeConfig for credentials. When None (the default),
            credentials are resolved from ~/.config/mediakit/mediakit.toml,
            falling back to admin/admin. Tests pass this explicitly to avoid
            leaking state from shared class-level config caches.
    """
    audio_dir = find_audio_dir(root) if enable_audio else None
    video_dir = find_videos_dir(root) if enable_video else None
    cfg = _resolve_cfg(audio_cfg)
    token_store = TokenStore()

    combined = FastAPI(title="mediakit", version=__version__)

    @combined.get("/capabilities")
    def capabilities() -> dict[str, object]:
        return {
            "server": "mediakit",
            "version": __version__,
            "audio": audio_dir is not None,
            "video": video_dir is not None,
            "auth_required": enable_auth,
            "endpoints": {
                "audio_subsonic": "/audio/rest" if audio_dir is not None else None,
                "video_api": "/video/api" if video_dir is not None else None,
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

    if audio_dir is not None:
        _mount_audio(combined, audio_dir, use_cache=audio_use_cache, cfg=cfg)

    if video_dir is not None:
        _mount_video(combined, root)

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


def _mount_audio(combined: FastAPI, audio_root: Path, *, use_cache: bool, cfg: ServeConfig) -> None:
    """Mount the Subsonic app under /audio.

    Triggers the initial library scan synchronously so the first /audio/rest/*
    request hits a populated IndexCache. Standalone `mediakit audio serve`
    does this in its CLI; mounting the same app as a sub-app means we have
    to drive the rebuild ourselves (the IndexCache is created at create_app
    time but its content isn't populated until rebuild() runs).
    """
    from mediakit.audio.serve import create_app as create_audio_app

    audio_app = create_audio_app(root=audio_root, cfg=cfg, use_cache=use_cache)
    audio_app.state.cache.rebuild()
    combined.mount("/audio", audio_app)


def _mount_video(combined: FastAPI, library_root: Path) -> None:
    """Mount the video app under /video."""
    from mediakit.video.serve import create_app as create_video_app

    video_app = create_video_app(library_root)
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
