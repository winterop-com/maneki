"""Combined audio + video FastAPI app for the unified `mediakit serve`.

URL layout:

    GET /capabilities         server identity + what's mounted
    /audio/rest/*             Subsonic (Stage 1 audio code, mounted under /audio)
    /video/api/*              MediaKit native video API
    /video/                   throwaway demo HTML page (retired when SPA lands)

Both audio and video sub-apps are mounted with their existing factories - no
changes to either kind's standalone behaviour. `mediakit audio serve` and
`mediakit video serve` keep working as before, exposing routes at root.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI

from mediakit import __version__
from mediakit.library import find_audio_dir
from mediakit.video.serve.scan import find_videos_dir

if TYPE_CHECKING:
    from mediakit.audio.serve.config import ServeConfig


def create_combined_app(
    *,
    root: Path,
    enable_audio: bool = True,
    enable_video: bool = True,
    audio_use_cache: bool = True,
    audio_cfg: ServeConfig | None = None,
) -> FastAPI:
    """Build a FastAPI app that mounts whichever kinds are present at root.

    Args:
        root: library root containing audio/ and/or videos/ subdirectories.
        enable_audio: if False, skip audio mount even if <root>/audio/ exists.
        enable_video: if False, skip video mount even if <root>/videos/ exists.
        audio_use_cache: forwarded to the audio Subsonic app's SQLite index cache.
        audio_cfg: explicit ServeConfig for the audio Subsonic mount. When None
            (the default), credentials are resolved from
            ~/.config/mediakit/mediakit.toml, falling back to admin/admin.
            Tests pass this explicitly to avoid leaking state from shared
            class-level config caches.

    Mounting both at sub-paths means external clients see:
        Subsonic clients   -> set base URL to https://host:port/audio
        MediaKit clients   -> read /capabilities, then hit /video/api/* or /audio/rest/*
    """
    audio_dir = find_audio_dir(root) if enable_audio else None
    video_dir = find_videos_dir(root) if enable_video else None

    combined = FastAPI(title="mediakit", version=__version__)

    @combined.get("/capabilities")
    def capabilities() -> dict[str, object]:
        return {
            "server": "mediakit",
            "version": __version__,
            "audio": audio_dir is not None,
            "video": video_dir is not None,
            "endpoints": {
                "audio_subsonic": "/audio/rest" if audio_dir is not None else None,
                "video_api": "/video/api" if video_dir is not None else None,
            },
        }

    if audio_dir is not None:
        _mount_audio(combined, audio_dir, use_cache=audio_use_cache, cfg=audio_cfg)

    if video_dir is not None:
        _mount_video(combined, root)

    return combined


def _mount_audio(combined: FastAPI, audio_root: Path, *, use_cache: bool, cfg: ServeConfig | None) -> None:
    """Mount the Subsonic app under /audio.

    Audio's create_app expects `root` to be the artist-containing dir; with
    the new convention that's `<library_root>/audio/`. After mounting under
    `/audio`, audio's `/rest/*` routes resolve at `/audio/rest/*`.
    """
    from mediakit.audio.serve import create_app as create_audio_app
    from mediakit.audio.serve.config import resolve_credentials

    if cfg is None:
        cfg, _ = resolve_credentials(cli_user=None, cli_password=None)
    audio_app = create_audio_app(root=audio_root, cfg=cfg, use_cache=use_cache)
    combined.mount("/audio", audio_app)


def _mount_video(combined: FastAPI, library_root: Path) -> None:
    """Mount the video app under /video.

    Video's create_app takes the library root and finds <root>/videos/ itself,
    so we pass library_root (not the videos dir).
    """
    from mediakit.video.serve import create_app as create_video_app

    video_app = create_video_app(library_root)
    combined.mount("/video", video_app)
