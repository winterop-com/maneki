"""Foreground-priority transcode budget shared across the video pipeline.

Three flavours of work compete for ffmpeg CPU:

1. **Foreground** - a player request needs a segment right now.
2. **Prefetch** - small forward / backward neighbour transcodes kicked off
   after a foreground request, expecting the user's next scrub.
3. **Prewarm** - the startup pass that fills `seg-0` (+ posters /
   thumbnails) for every video in the library.

Without coordination, a foreground request can land behind a prefetch
or prewarm ffmpeg and wait for that to finish - the player perceives a
hang even though there's plenty of CPU available, because the queued
foreground work is blocked.

`TranscodeBudget` fixes this with two primitives:

- `foreground()` - context manager that marks a foreground transcode
  active. While the count is non-zero, background workers pause.
- `background_slot()` - context manager that acquires a background
  worker slot. Yields to foreground first AND re-checks after the slot
  acquire (in case foreground arrived while we waited).

A single budget is created in serve_app.py and handed to
HLSManager / PosterManager / SubtitleCache. Configure the worker count
via `--workers` on `maneki serve`.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import time
from collections.abc import AsyncGenerator

from pydantic import BaseModel, ConfigDict

# After the last foreground request finishes, background workers wait
# this long before resuming. Without it, pausing playback would cause
# the queued prewarm tasks to immediately race for CPU - the user
# pauses, the budget's idle_event fires, and 10-15s of ffmpeg activity
# kicks in for videos the user hasn't even opened. With this gate,
# pausing means quiet; if the user unpauses inside the window we start
# the clock over.
DEFAULT_QUIET_AFTER_FG_S: float = 30.0


def default_workers() -> int:
    """Conservative default: half the CPU count, min 1, max 4.

    Each ffmpeg spawns its own thread pool internally (libx264 typically
    uses ~4 threads), so N=2 workers already saturates an 8-core laptop
    for background work. Higher values risk thrashing during foreground
    playback. Users with bigger boxes can bump it via `--workers N`.
    """
    cpu = os.cpu_count() or 4
    return max(1, min(4, cpu // 2))


class BudgetState(BaseModel):
    """Snapshot for diagnostics / tests."""

    model_config = ConfigDict(frozen=True)

    max_workers: int
    foreground_in_flight: int
    background_in_flight: int


class TranscodeBudget:
    """Foreground-wins-always scheduler shared by every transcode-class call.

    Not thread-safe - assumes a single asyncio event loop.
    """

    def __init__(
        self,
        max_workers: int | None = None,
        *,
        quiet_after_fg_s: float = DEFAULT_QUIET_AFTER_FG_S,
    ) -> None:
        workers = max_workers if max_workers is not None and max_workers > 0 else default_workers()
        self._max_workers = workers
        self._background_sem = asyncio.Semaphore(workers)
        self._foreground_count = 0
        self._background_count = 0
        # Initially the system is idle (no foreground in flight).
        self._idle_event = asyncio.Event()
        self._idle_event.set()
        self._quiet_after_fg_s = quiet_after_fg_s
        # Monotonic timestamp of the last foreground request that
        # finished. -inf means "no foreground has ever happened" -
        # background work can start immediately on a fresh server
        # (typical at startup, when prewarm should run flat-out).
        self._last_foreground_at: float = float("-inf")

    @property
    def max_workers(self) -> int:
        return self._max_workers

    def state(self) -> BudgetState:
        return BudgetState(
            max_workers=self._max_workers,
            foreground_in_flight=self._foreground_count,
            background_in_flight=self._background_count,
        )

    @contextlib.asynccontextmanager
    async def foreground(self) -> AsyncGenerator[None, None]:
        """Wrap a foreground transcode. Background workers pause for the duration."""
        self._foreground_count += 1
        self._idle_event.clear()
        try:
            yield
        finally:
            self._foreground_count -= 1
            if self._foreground_count == 0:
                # Stamp the moment the foreground request finished so
                # background_slot can honour the quiet period.
                self._last_foreground_at = time.monotonic()
                self._idle_event.set()

    async def _wait_for_quiet(self) -> None:
        """Sleep until both idle_event is set AND the quiet period has elapsed.

        Resets the wait if a new foreground request kicks `last_foreground_at`
        forward while we're sleeping (e.g. user unpauses).
        """
        while True:
            await self._idle_event.wait()
            quiet_for = time.monotonic() - self._last_foreground_at
            remaining = self._quiet_after_fg_s - quiet_for
            if remaining <= 0:
                return
            # Sleep for the shorter of (remaining quiet time, until
            # foreground clears again). If foreground re-fires during
            # the sleep, idle_event will be cleared and we loop.
            try:
                await asyncio.wait_for(
                    self._wait_for_foreground_arrival(),
                    timeout=remaining,
                )
                # Foreground arrived - loop and wait for it to clear.
            except asyncio.TimeoutError:
                # Quiet period satisfied without interruption.
                return

    async def _wait_for_foreground_arrival(self) -> None:
        """Wait until foreground starts again. Returns when idle_event clears."""
        while self._idle_event.is_set():
            # Short poll - cheap because asyncio sleeps cooperatively.
            await asyncio.sleep(0.25)

    @contextlib.asynccontextmanager
    async def background_slot(self, *, quiet: bool = True) -> AsyncGenerator[None, None]:
        """Acquire a background worker slot, yielding to foreground first.

        Order: wait for idle (+ quiet period when `quiet=True`) -> acquire
        semaphore -> re-check idle. The re-check matters because a foreground
        request can arrive while we're queued on the semaphore; without it
        a background transcode would start anyway and compete for ffmpeg CPU.

        `quiet=True` (default) is for speculative work like prewarm and
        prefetch: after a foreground request finishes the slot waits the
        full quiet period before starting, so a paused user who scrubs
        again doesn't trigger a flurry of ffmpegs.

        `quiet=False` is for user-driven on-demand work (row thumbnails,
        clicked posters): the user is actively waiting on the result, so
        yield to in-flight foreground but resume as soon as it clears —
        a 30s gap before the row icons appear feels broken.
        """
        if quiet:
            await self._wait_for_quiet()
        else:
            await self._idle_event.wait()
        async with self._background_sem:
            # Foreground may have arrived while we were waiting on the
            # semaphore. Re-check; honour the quiet period only when asked.
            while not self._idle_event.is_set() or (
                quiet and time.monotonic() - self._last_foreground_at < self._quiet_after_fg_s
            ):
                if quiet:
                    await self._wait_for_quiet()
                else:
                    await self._idle_event.wait()
            self._background_count += 1
            try:
                yield
            finally:
                self._background_count -= 1
