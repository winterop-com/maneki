"""Self-hosted media toolkit — audio (and video, planned).

The top-level package exposes only the version. Audio capabilities live
under `mediakit.audio.*`; video capabilities will live under
`mediakit.video.*` once they land.
"""

from __future__ import annotations

try:
    from importlib.metadata import version as _get_version

    __version__ = _get_version("mediakit")
except Exception:  # pragma: no cover - uninstalled / dev tree
    __version__ = "unknown"
