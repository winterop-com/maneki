"""Seek-cancellation tests for OnDemandHLS.

When the player seeks, the segment request jumps far from the previous one.
`note_active` must cancel the foreground transcode and prefetch tasks the
player has left behind so the segment the user actually wants doesn't queue
behind abandoned ffmpegs - while leaving normal linear-playback buffering
(a window of nearby segments) untouched. These exercise that logic directly
with synthetic pending tasks; no real ffmpeg runs.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path

import pytest

from maneki.video.serve.hls import OnDemandHLS
from maneki.video.serve.transcode_budget import TranscodeBudget


def _session(tmp_path: Path) -> OnDemandHLS:
    # 600s / 6s = 100 segments; no real file needed for note_active logic.
    return OnDemandHLS(
        "vid",
        tmp_path / "in.mkv",
        duration_s=600.0,
        session_dir=tmp_path / "sess",
        budget=TranscodeBudget(),
    )


async def _pending_path() -> Path:
    await asyncio.Event().wait()  # never set: stays pending until cancelled
    return Path()  # pragma: no cover - unreachable


async def _pending_none() -> None:
    await asyncio.Event().wait()  # pragma: no cover - unreachable


async def _drain(*tasks: asyncio.Task[object]) -> None:
    for task in tasks:
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


@pytest.mark.asyncio
async def test_note_active_cancels_distant_prefetch(tmp_path: Path) -> None:
    """A seek cancels prefetch tasks left behind at the old position."""
    session = _session(tmp_path)
    far = asyncio.create_task(_pending_none())
    near = asyncio.create_task(_pending_none())
    session._prefetch_tasks[10] = far  # noqa: SLF001 - old position
    session._prefetch_tasks[81] = near  # noqa: SLF001 - inside the new window

    session.note_active(80)  # seek to segment 80

    with contextlib.suppress(asyncio.CancelledError):
        await far
    assert far.cancelled()
    assert not near.cancelled() and not near.done()
    await _drain(near)


@pytest.mark.asyncio
async def test_note_active_keeps_linear_playback_window(tmp_path: Path) -> None:
    """Advancing one segment at a time never cancels the nearby buffer-fill tasks."""
    session = _session(tmp_path)
    behind = asyncio.create_task(_pending_none())
    ahead = asyncio.create_task(_pending_none())
    session._prefetch_tasks[10] = behind  # noqa: SLF001 - one behind
    session._prefetch_tasks[12] = ahead  # noqa: SLF001 - one ahead

    session.note_active(11)  # player advanced to the next segment

    await asyncio.sleep(0)
    assert not behind.cancelled() and not behind.done()
    assert not ahead.cancelled() and not ahead.done()
    await _drain(behind, ahead)


@pytest.mark.asyncio
async def test_note_active_cancels_abandoned_foreground(tmp_path: Path) -> None:
    """A seek kills an in-flight foreground transcode the client didn't abort."""
    session = _session(tmp_path)
    abandoned = asyncio.create_task(_pending_path())
    session.register_foreground(10, abandoned)

    session.note_active(500)  # large jump away from segment 10

    with contextlib.suppress(asyncio.CancelledError):
        await abandoned
    assert abandoned.cancelled()


@pytest.mark.asyncio
async def test_register_foreground_self_prunes_on_completion(tmp_path: Path) -> None:
    """A finished foreground transcode removes itself from the in-flight map."""
    session = _session(tmp_path)

    async def _done() -> Path:
        return Path("seg")

    task = asyncio.create_task(_done())
    session.register_foreground(7, task)
    await task
    await asyncio.sleep(0)  # let the done-callback run
    assert 7 not in session._inflight_fg  # noqa: SLF001


@pytest.mark.asyncio
async def test_register_foreground_cleanup_guards_on_identity(tmp_path: Path) -> None:
    """Re-registering the same index, then finishing the old task, keeps the new one."""
    session = _session(tmp_path)
    old = asyncio.create_task(_pending_path())
    session.register_foreground(3, old)
    new = asyncio.create_task(_pending_path())
    session.register_foreground(3, new)  # replaces `old` at index 3

    await _drain(old)  # old finishes (cancelled); its callback must not evict `new`
    await asyncio.sleep(0)
    assert session._inflight_fg.get(3) is new  # noqa: SLF001
    await _drain(new)
