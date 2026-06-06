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
from typing import Literal

from pydantic import BaseModel, ConfigDict

# Background work lanes, each with a different quiet-window before it yields
# the CPU back to itself after foreground activity. See `background_slot`.
Lane = Literal["prewarm", "ondemand", "prefetch"]

# After the last foreground request finishes, background workers wait
# this long before resuming. Without it, pausing playback would cause
# the queued prewarm tasks to immediately race for CPU - the user
# pauses, the budget's idle_event fires, and 10-15s of ffmpeg activity
# kicks in for videos the user hasn't even opened. With this gate,
# pausing means quiet; if the user unpauses inside the window we start
# the clock over.
DEFAULT_QUIET_AFTER_FG_S: float = 30.0

# Shorter quiet period for on-demand "ondemand"-lane background work
# (row thumbnails / posters). Steady-state playback fires a new
# foreground HLS segment every ~6s; with a 3s threshold, the system
# rarely stays quiet long enough between segments for this work to
# acquire a slot mid-playback. When the user pauses for 3+ seconds, the
# budget releases and queued thumbnails fill in.
DEFAULT_ONDEMAND_QUIET_S: float = 3.0

# Near-zero quiet period for the HLS forward-prefetch lane. Unlike
# prewarm/on-demand work, prefetch MUST run *during* continuous playback:
# it transcodes segments ahead of the playhead so a high-latency client
# doesn't outrun the encoder. A foreground HLS segment lands every ~6s and
# each takes well under a second, so a ~0.5s threshold lets prefetch fill
# the gaps between segments while still yielding instantly to a new
# foreground request (the foreground semaphore + OS-idle priority on the
# prefetch ffmpeg keep playback first). Not literally 0 so a micro-pause
# between back-to-back segment fetches doesn't thrash the encoder.
DEFAULT_PREFETCH_QUIET_S: float = 0.5


def default_workers() -> int:
    """Default background worker count: half CPU count, min 1, max 8.

    Each ffmpeg spawns its own thread pool internally (libx264 typically
    uses ~4 threads), so on a vanilla 8-core box N=4 workers can already
    saturate. But modern M-series Macs have 8-12 performance cores and
    the prewarm path is bottlenecked on ffmpeg startup + disk seeks per
    poster (9 separate frame ffmpegs), so a higher cap meaningfully
    helps cold-cache rebuilds. Foreground player requests always
    preempt background work, so over-provisioning here only costs
    fan noise during prewarm. Override with `--workers N`.
    """
    cpu = os.cpu_count() or 4
    return max(1, min(8, cpu // 2))


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
        max_foreground: int = 3,
        quiet_after_fg_s: float = DEFAULT_QUIET_AFTER_FG_S,
        ondemand_quiet_s: float = DEFAULT_ONDEMAND_QUIET_S,
        prefetch_quiet_s: float = DEFAULT_PREFETCH_QUIET_S,
    ) -> None:
        workers = max_workers if max_workers is not None and max_workers > 0 else default_workers()
        self._max_workers = workers
        self._background_sem = asyncio.Semaphore(workers)
        # Cap on concurrent foreground transcodes too. Without this, a
        # rapid-seek storm (e.g. 18 scrubs in 9s) spawns 18 simultaneous
        # ffmpegs all reading the same source — disk I/O contention
        # makes each take ~15s instead of the usual ~200ms, and the
        # browser's HLS engine doesn't cancel old segment fetches on
        # seek so they all run to completion while the player waits
        # for the *latest* one. With cap=3 the queue stays short and
        # the player gets fresh segments quickly.
        self._foreground_sem = asyncio.Semaphore(max(1, max_foreground))
        self._max_foreground = max(1, max_foreground)
        self._foreground_count = 0
        self._background_count = 0
        # Initially the system is idle (no foreground in flight).
        self._idle_event = asyncio.Event()
        self._idle_event.set()
        self._quiet_after_fg_s = quiet_after_fg_s
        self._ondemand_quiet_s = ondemand_quiet_s
        self._prefetch_quiet_s = prefetch_quiet_s
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
        """Wrap a foreground transcode. Background workers pause for the duration.

        Acquires the foreground semaphore — at most `max_foreground`
        transcodes run concurrently. The (max_foreground+1)th waits in
        queue; the browser's HLS engine doesn't cancel queued segment
        fetches on seek, so they'll still run, but only after the
        currently-running transcodes free a slot. Net effect on a
        rapid-seek storm: short queue, full CPU per transcode, fast
        completion (vs. 18 concurrent ffmpegs sharing disk I/O and
        each taking ~15s).
        """
        async with self._foreground_sem:
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

    async def _wait_for_quiet(self, quiet_window_s: float | None = None) -> None:
        """Sleep until both idle_event is set AND the quiet period has elapsed.

        Resets the wait if a new foreground request kicks `last_foreground_at`
        forward while we're sleeping (e.g. user unpauses).

        `quiet_window_s` overrides the default per-budget quiet window;
        used by `background_slot(lane="ondemand")` to wait the shorter
        on-demand window (a few seconds) instead of the full prewarm
        window (~30s) so row icons fill in faster after a pause.
        """
        window = self._quiet_after_fg_s if quiet_window_s is None else quiet_window_s
        while True:
            await self._idle_event.wait()
            quiet_for = time.monotonic() - self._last_foreground_at
            remaining = window - quiet_for
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
    async def background_slot(self, *, lane: Lane = "prewarm") -> AsyncGenerator[None, None]:
        """Acquire a background worker slot, yielding to foreground first.

        Order: wait for idle (+ quiet window) -> acquire semaphore ->
        re-check idle. The re-check matters because a foreground request
        can arrive while we're queued on the semaphore; without it a
        background transcode would start anyway and compete for ffmpeg
        CPU.

        Three lanes, each with its own quiet window:

        - `"prewarm"` (default) waits the full `quiet_after_fg_s` (~30s)
          after the last foreground request. Right for speculative prewarm
          (seg-0 fill, posters): a paused user who scrubs again shouldn't
          trigger a flurry of ffmpegs.

        - `"ondemand"` waits the shorter `ondemand_quiet_s` (~3s). Right for
          user-driven work (row thumbnails, clicked posters): the user is
          waiting on the result, so resume as soon as playback genuinely
          pauses. Steady-state HLS playback (a foreground segment every ~6s)
          keeps the system out of the 3s window, so this still holds off
          during continuous playback - icons fill in once the user pauses.

        - `"prefetch"` waits only `prefetch_quiet_s` (~0.5s). The forward-
          prefetch lane MUST run *during* playback to stay ahead of the
          playhead, so it fills the sub-second gaps between foreground
          segments while still yielding instantly to a new foreground
          request (foreground semaphore + OS-idle priority keep playback
          first).
        """
        quiet_window = {
            "prewarm": self._quiet_after_fg_s,
            "ondemand": self._ondemand_quiet_s,
            "prefetch": self._prefetch_quiet_s,
        }[lane]
        await self._wait_for_quiet(quiet_window)
        async with self._background_sem:
            # Foreground may have arrived while we were waiting on the
            # semaphore. Re-check using the same quiet window.
            while not self._idle_event.is_set() or time.monotonic() - self._last_foreground_at < quiet_window:
                await self._wait_for_quiet(quiet_window)
            self._background_count += 1
            try:
                yield
            finally:
                self._background_count -= 1
