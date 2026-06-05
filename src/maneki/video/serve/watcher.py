"""Filesystem watcher — auto-trigger a rescan when video files change.

Drop a new movie / episode into the library root, the index rescans within
a few seconds and the SPA sees the new entry on its next listing fetch
without needing `POST /api/scan` or a `serve` restart. Powered by
`watchdog`.

Debounced: any FS event resets a timer, the rescan runs once when no events
have arrived for `debounce_s`. A bulk drop of 50 files only triggers one
rescan, not 50. The default 5s window is generous enough to cover a slow
USB / network copy without firing mid-transfer.

Bridges the threaded watchdog handler to the FastAPI asyncio loop via
`asyncio.run_coroutine_threadsafe` — the rescan itself is async (it calls
`prewarm_scan` which uses asyncio.gather for parallel ffprobes) and lives
on the same event loop the request handlers run on.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from maneki.video.serve.scan import VIDEO_EXTENSIONS

log = logging.getLogger(__name__)

DEFAULT_DEBOUNCE_S = 5.0


class VideoLibraryWatcher:
    """Watch the library root and trigger debounced rescans on FS changes.

    The watcher itself runs on a watchdog-owned thread; rescans are async
    coroutines dispatched onto the FastAPI event loop captured at
    `start()` time via `asyncio.run_coroutine_threadsafe`. Concurrent
    debounce timer firings while a rescan is still running are no-ops:
    the rescan coroutine self-guards on the scan_tracker's phase.
    """

    def __init__(
        self,
        root: Path,
        rescan: Callable[[], Coroutine[object, object, None]],
        *,
        debounce_s: float = DEFAULT_DEBOUNCE_S,
    ) -> None:
        self._root = root
        self._rescan = rescan
        self._debounce_s = debounce_s
        self._observer: Any = None  # watchdog's Observer is a factory; runtime type
        self._timer: threading.Timer | None = None
        self._timer_lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        """Begin watching the root. Captures the loop coroutines will run on."""
        if self._observer is not None:
            return
        if not self._root.exists():
            log.warning("video watcher: %s does not exist; not starting", self._root)
            return
        self._loop = loop
        handler = _Handler(self._on_event)
        self._observer = Observer()
        self._observer.schedule(handler, str(self._root), recursive=True)
        self._observer.start()
        log.info("video watcher: watching %s (debounce=%.1fs)", self._root, self._debounce_s)

    def stop(self) -> None:
        """Stop the observer + cancel any pending debounce timer."""
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=2.0)
            self._observer = None

    def _on_event(self, path: Path) -> None:
        """Called per relevant FS event (from a watchdog thread)."""
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self._debounce_s, self._dispatch_rescan)
            self._timer.daemon = True
            self._timer.start()
        log.debug("video watcher: change detected at %s; debouncing", path)

    def _dispatch_rescan(self) -> None:
        """Hand the async rescan coroutine to the FastAPI event loop."""
        if self._loop is None or self._loop.is_closed():
            # Previously a silent no-op. If a file change arrives during
            # shutdown the user got no signal that the rescan didn't
            # happen — surface it so they can tell apart "watcher
            # disabled" from "watcher silently broke".
            log.warning(
                "video watcher: event loop is closed; rescan for %s not dispatched",
                self._root,
            )
            return
        log.info("video watcher: debounce elapsed; dispatching rescan")
        asyncio.run_coroutine_threadsafe(self._rescan(), self._loop)


class _Handler(FileSystemEventHandler):
    """Forward only video-file-relevant events to the debounce timer."""

    def __init__(self, on_event_cb: Callable[[Path], None]) -> None:
        super().__init__()
        self._cb = on_event_cb

    def on_any_event(self, event: FileSystemEvent) -> None:
        # Directories: only act on create/delete/move. A "modified" event on
        # a dir fires whenever ANY file inside changes (including .DS_Store
        # writes), which would defeat the video-extension filter below.
        if event.is_directory:
            if event.event_type not in ("created", "deleted", "moved"):
                return
            self._cb(Path(str(event.src_path)))
            return
        # Files: only video extensions matter — skip .DS_Store, poster
        # cache writes, subtitle sidecar shuffles, etc.
        candidates: list[Path] = []
        if event.src_path:
            candidates.append(Path(str(event.src_path)))
        dest_path = getattr(event, "dest_path", None)
        if dest_path:
            candidates.append(Path(str(dest_path)))
        for path in candidates:
            # Skip dot-prefixed files. macOS AppleDouble `._<name>` sidecars
            # carry the real file's extension (`._Movie.mkv`) but hold no
            # media, and the OS rewrites them constantly on FAT/exFAT/SMB
            # volumes — without this guard every `._*` churn event passes the
            # extension filter and fires a spurious debounced rescan. Matches
            # the dot-prefix guard the scanner / browse walks already apply.
            if not path.name.startswith(".") and path.suffix.lower() in VIDEO_EXTENSIONS:
                self._cb(path)
                return
