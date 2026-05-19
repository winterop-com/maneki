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
via `--workers` on `mediakit serve`.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import AsyncIterator

from pydantic import BaseModel, ConfigDict


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

    def __init__(self, max_workers: int | None = None) -> None:
        workers = max_workers if max_workers is not None and max_workers > 0 else default_workers()
        self._max_workers = workers
        self._background_sem = asyncio.Semaphore(workers)
        self._foreground_count = 0
        self._background_count = 0
        # Initially the system is idle (no foreground in flight).
        self._idle_event = asyncio.Event()
        self._idle_event.set()

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
    async def foreground(self) -> AsyncIterator[None]:
        """Wrap a foreground transcode. Background workers pause for the duration."""
        self._foreground_count += 1
        self._idle_event.clear()
        try:
            yield
        finally:
            self._foreground_count -= 1
            if self._foreground_count == 0:
                self._idle_event.set()

    @contextlib.asynccontextmanager
    async def background_slot(self) -> AsyncIterator[None]:
        """Acquire a background worker slot, yielding to foreground first.

        Order: wait for idle -> acquire semaphore -> re-check idle.
        The re-check matters because a foreground request can arrive
        while we're queued on the semaphore; without it a background
        transcode would start anyway and compete for ffmpeg CPU.
        """
        await self._idle_event.wait()
        async with self._background_sem:
            # Foreground may have arrived while we were waiting on the
            # semaphore. Loop until idle again, then start.
            while not self._idle_event.is_set():
                await self._idle_event.wait()
            self._background_count += 1
            try:
                yield
            finally:
                self._background_count -= 1
