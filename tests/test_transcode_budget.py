"""TranscodeBudget scheduling semantics: foreground always wins."""

from __future__ import annotations

import asyncio

import pytest

from mediakit.video.serve.transcode_budget import TranscodeBudget, default_workers


pytestmark = pytest.mark.asyncio


def test_default_workers_is_sane() -> None:
    n = default_workers()
    assert 1 <= n <= 4


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


async def test_foreground_blocks_background_until_done() -> None:
    """A pending background task waits while foreground is active."""
    budget = TranscodeBudget(max_workers=2)
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


async def test_background_yields_to_late_arriving_foreground() -> None:
    """When fg arrives WHILE bg is queued at the semaphore, bg still waits."""
    budget = TranscodeBudget(max_workers=1)
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
