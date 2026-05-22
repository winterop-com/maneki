"""TranscodeBudget scheduling semantics: foreground always wins."""

from __future__ import annotations

import asyncio

import pytest

from maneki.video.serve.transcode_budget import TranscodeBudget, default_workers


def test_default_workers_is_sane() -> None:
    n = default_workers()
    assert 1 <= n <= 8


@pytest.mark.asyncio
async def test_background_slot_runs_when_idle() -> None:
    """No foreground in flight -> background tasks run immediately."""
    budget = TranscodeBudget(max_workers=2)
    counter = 0

    async def work() -> None:
        nonlocal counter
        async with budget.background_slot():
            counter += 1

    await asyncio.gather(work(), work(), work())
    assert counter == 3


@pytest.mark.asyncio
async def test_foreground_blocks_background_until_done() -> None:
    """A pending background task waits while foreground is active."""
    # quiet_after_fg_s=0 so this test exercises the priority semantics
    # only - the post-foreground quiet period gets its own test below.
    budget = TranscodeBudget(max_workers=2, quiet_after_fg_s=0)
    timeline: list[str] = []

    async def background() -> None:
        async with budget.background_slot():
            timeline.append("bg-start")
            await asyncio.sleep(0)
            timeline.append("bg-end")

    async def foreground() -> None:
        async with budget.foreground():
            timeline.append("fg-start")
            # Hold the foreground long enough for the background to be
            # ready and queued.
            await asyncio.sleep(0.05)
            timeline.append("fg-end")

    # Start foreground first, then background. Background must wait.
    fg_task = asyncio.create_task(foreground())
    await asyncio.sleep(0)  # yield so fg can grab the marker
    bg_task = asyncio.create_task(background())
    await asyncio.gather(fg_task, bg_task)

    # Foreground must finish before background even starts.
    assert timeline == ["fg-start", "fg-end", "bg-start", "bg-end"]


@pytest.mark.asyncio
async def test_background_yields_to_late_arriving_foreground() -> None:
    """When fg arrives WHILE bg is queued at the semaphore, bg still waits."""
    budget = TranscodeBudget(max_workers=1, quiet_after_fg_s=0)
    timeline: list[str] = []

    # Saturate the one worker slot with a slow background task.
    saturate_done = asyncio.Event()

    async def slow_bg() -> None:
        async with budget.background_slot():
            timeline.append("slow-bg-start")
            await asyncio.sleep(0.05)
            timeline.append("slow-bg-end")
            saturate_done.set()

    async def queued_bg() -> None:
        async with budget.background_slot():
            timeline.append("queued-bg-start")
            timeline.append("queued-bg-end")

    async def foreground() -> None:
        async with budget.foreground():
            timeline.append("fg-start")
            await asyncio.sleep(0.02)
            timeline.append("fg-end")

    slow_task = asyncio.create_task(slow_bg())
    await asyncio.sleep(0)  # let slow_bg grab the slot
    queued_task = asyncio.create_task(queued_bg())  # blocked on semaphore
    await asyncio.sleep(0)
    # Foreground arrives while queued_bg is waiting on the semaphore.
    fg_task = asyncio.create_task(foreground())

    await asyncio.gather(slow_task, queued_task, fg_task)

    # The queued background must not have run between slow-bg-end and
    # fg-end - it must wait for the foreground to release.
    fg_end = timeline.index("fg-end")
    queued_start = timeline.index("queued-bg-start")
    assert queued_start > fg_end


@pytest.mark.asyncio
async def test_quiet_period_delays_background_after_foreground() -> None:
    """After foreground finishes, background waits quiet_after_fg_s before starting.

    The whole point: pausing playback shouldn't immediately wake up
    the prewarm queue. If the user pauses and the queued background
    tasks fire 0ms later, the laptop fan kicks on and the user
    rightfully complains.
    """
    import time

    budget = TranscodeBudget(max_workers=2, quiet_after_fg_s=0.5)
    bg_started_at: list[float] = []
    fg_ended_at: list[float] = []

    async def foreground() -> None:
        async with budget.foreground():
            await asyncio.sleep(0.05)
        fg_ended_at.append(time.monotonic())

    async def background() -> None:
        async with budget.background_slot():
            bg_started_at.append(time.monotonic())

    fg_task = asyncio.create_task(foreground())
    await asyncio.sleep(0)
    # Background queued immediately, but shouldn't run for ~0.5s after
    # the foreground task finishes.
    bg_task = asyncio.create_task(background())
    await asyncio.gather(fg_task, bg_task)

    waited = bg_started_at[0] - fg_ended_at[0]
    # Sane bounds - we asked for 0.5s, allow event-loop slop.
    assert waited >= 0.45, f"bg started too soon ({waited:.3f}s after fg)"


@pytest.mark.asyncio
async def test_quiet_period_resets_on_unpause() -> None:
    """A second foreground request inside the quiet window restarts the clock."""
    import time

    budget = TranscodeBudget(max_workers=2, quiet_after_fg_s=0.4)
    bg_started_at: list[float] = []
    last_fg_ended_at: list[float] = []

    async def short_fg() -> None:
        async with budget.foreground():
            await asyncio.sleep(0.02)
        last_fg_ended_at.append(time.monotonic())

    async def background() -> None:
        async with budget.background_slot():
            bg_started_at.append(time.monotonic())

    # FG #1
    await short_fg()
    # Queue BG right after FG #1 finished
    bg_task = asyncio.create_task(background())
    # Inside the quiet window, fire FG #2 - should reset the clock.
    await asyncio.sleep(0.15)
    await short_fg()
    await bg_task

    waited_from_last_fg = bg_started_at[0] - last_fg_ended_at[-1]
    assert waited_from_last_fg >= 0.35, f"bg started {waited_from_last_fg:.3f}s after most recent fg, expected >= 0.35"


@pytest.mark.asyncio
async def test_background_slot_quiet_false_uses_short_window() -> None:
    """`quiet=False` (on-demand row thumbnails / posters) yields to in-flight
    foreground AND waits the shorter on-demand quiet window before resuming.

    Steady-state HLS playback fires foreground segments every ~6s; with a
    sub-segment on-demand quiet window, the budget keeps holding background
    work off during continuous playback. The on-demand window is much
    shorter than the prewarm `quiet_after_fg_s` so the icons fill in
    quickly once the user actually pauses.
    """
    import time

    budget = TranscodeBudget(
        max_workers=2,
        quiet_after_fg_s=2.0,
        ondemand_quiet_s=0.3,
    )
    bg_started_at: list[float] = []
    fg_ended_at: list[float] = []

    async def foreground() -> None:
        async with budget.foreground():
            await asyncio.sleep(0.05)
        fg_ended_at.append(time.monotonic())

    async def on_demand() -> None:
        async with budget.background_slot(quiet=False):
            bg_started_at.append(time.monotonic())

    fg_task = asyncio.create_task(foreground())
    await asyncio.sleep(0)
    bg_task = asyncio.create_task(on_demand())
    await asyncio.gather(fg_task, bg_task)

    # Yielded to fg (so started after fg ended)...
    assert bg_started_at[0] >= fg_ended_at[0]
    gap = bg_started_at[0] - fg_ended_at[0]
    # ...respected the on-demand quiet window of 0.3s...
    assert gap >= 0.25, f"on-demand started {gap:.3f}s after fg; expected >= 0.25 (the on-demand window)"
    # ...but did NOT wait the longer 2s prewarm window.
    assert gap < 1.0, f"on-demand waited {gap:.3f}s after fg; the prewarm window shouldn't have applied"


@pytest.mark.asyncio
async def test_state_reflects_in_flight_counts() -> None:
    budget = TranscodeBudget(max_workers=2)
    assert budget.state().foreground_in_flight == 0
    assert budget.state().background_in_flight == 0

    started = asyncio.Event()
    release = asyncio.Event()

    async def fg_holder() -> None:
        async with budget.foreground():
            started.set()
            await release.wait()

    task = asyncio.create_task(fg_holder())
    await started.wait()

    assert budget.state().foreground_in_flight == 1
    release.set()
    await task
    assert budget.state().foreground_in_flight == 0
