"""Tracks progress of the background video-library scan.

The video scan walks the library root, then ffprobes each file to fill in
duration. On a large library this can take several seconds; until it
finishes the SPA only knows "loading...". The tracker exposes
`scanned / total / phase` so the client can render a real progressbar
while it waits.

One tracker per video sub-app; held on `app.state.scan_tracker`. A single
background task (kicked off in the parent app's lifespan) walks the
library and reports progress through `set_total` / `tick` / `finish`.
The `/api/scan_status` endpoint returns `snapshot()` as JSON.

Asyncio-single-threaded; we don't need a lock — `tick` only mutates ints
and only the prewarm task writes.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

ScanPhase = Literal["idle", "walking", "probing", "done"]


class ScanState(BaseModel):
    """Snapshot of the current scan progress, safe to JSON-serialise.

    `total` is best-effort — it's only known after the initial directory
    walk finishes, so the probing phase reports a real ratio while the
    walking phase reports `total=0` (the SPA treats that as indeterminate
    on the progressbar fill, but still surfaces `walked` as a live
    "discovered N files" counter so the user sees forward motion).
    """

    model_config = ConfigDict(frozen=True)

    scanning: bool
    phase: ScanPhase
    total: int
    scanned: int
    walked: int


class VideoScanTracker:
    """Mutable counter wrapped around `ScanState` snapshots.

    The lifespan prewarm calls `.set_total(N)` once the walk is done, then
    `.tick()` per probed file, then `.finish()`. The SPA polls
    `.snapshot()` via the `/api/scan_status` endpoint.
    """

    def __init__(self) -> None:
        self._phase: ScanPhase = "idle"
        self._total: int = 0
        self._scanned: int = 0
        self._walked: int = 0

    def begin_walk(self) -> None:
        """Mark the scan as started; total is not known yet."""
        self._phase = "walking"
        self._total = 0
        self._scanned = 0
        self._walked = 0

    def walk_tick(self, n: int = 1) -> None:
        """Increment the live walk-phase counter.

        Called from the directory walker as files are discovered so the
        SPA can render "discovering: 1247 files" while the total is still
        unknown. On a large library with deep folder trees the walk
        itself takes several seconds; without this counter the SPA
        renders an indeterminate pulse with no signal of forward motion.
        """
        self._walked += n

    def set_total(self, total: int) -> None:
        """Switch to the probing phase once the file list is known."""
        self._phase = "probing"
        self._total = total

    def tick(self) -> None:
        """Increment `scanned` by one (call per probed file)."""
        self._scanned += 1

    def finish(self) -> None:
        """Mark the scan complete. `scanned == total` after this."""
        self._phase = "done"
        if self._total == 0:
            self._total = self._scanned

    def snapshot(self) -> ScanState:
        return ScanState(
            scanning=self._phase in ("walking", "probing"),
            phase=self._phase,
            total=self._total,
            scanned=self._scanned,
            walked=self._walked,
        )
