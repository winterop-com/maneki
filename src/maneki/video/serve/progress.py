"""Where each user stopped in each video: `<root>/.maneki/users/<name>/videos.db`.

Forty minutes into an episode, closing the tab and opening it again has to
resume, so the position lives on the server rather than in one browser --
the same argument the audiobook store is built on, and the same shape. It
is one offset in seconds into the file, which is all a video needs: unlike
a book, nothing here is split across several of them.

The store is per user and beside the other per-user data, so it survives an
index rebuild. The video ids it is keyed by are the scan's, derived from
the path under the library root, so a file renamed on disk starts again --
which is the right answer, since a renamed file is not obviously the same
episode to anything here.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, ConfigDict

_SCHEMA = """
CREATE TABLE IF NOT EXISTS progress (
  video_id    TEXT PRIMARY KEY,
  position_s  REAL NOT NULL,
  finished    INTEGER NOT NULL DEFAULT 0,
  updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_progress_updated ON progress(updated_at);
"""

# A video counts as finished once the position is within this much of its end.
# Television closes on credits nobody watches through, and a viewer who got
# that far has seen the episode. Capped at a fraction of the file so the rule
# cannot swallow a short one whole.
FINISHED_TAIL_S = 90.0
FINISHED_TAIL_RATIO = 0.03


class VideoProgress(BaseModel):
    """One user's position in one video."""

    model_config = ConfigDict(frozen=True)

    video_id: str
    position_s: float
    finished: bool
    updated_at: float


class VideoProgressStore:
    """One user's watching positions, keyed by video id."""

    def __init__(self, path: Path) -> None:
        """Build a store backed by the SQLite file at `path`."""
        self._path = path
        self._lock = RLock()
        self._ready = False

    def _conn(self) -> sqlite3.Connection:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._path, check_same_thread=False, isolation_level=None)
        if not self._ready:
            conn.executescript(_SCHEMA)
            self._ready = True
        return conn

    def get(self, video_id: str) -> VideoProgress | None:
        """Where the user stopped in `video_id`, or None if they never started it."""
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT video_id, position_s, finished, updated_at FROM progress WHERE video_id = ?",
                (video_id,),
            ).fetchone()
        return _row(row) if row else None

    def all(self) -> list[VideoProgress]:
        """Every video the user has started, most recently watched first."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT video_id, position_s, finished, updated_at FROM progress ORDER BY updated_at DESC"
            ).fetchall()
        return [_row(r) for r in rows]

    def save(
        self,
        video_id: str,
        position_s: float,
        *,
        duration_s: float | None = None,
        finished: bool | None = None,
        now: float | None = None,
    ) -> VideoProgress:
        """Record the position. Passing the file's length marks the tail as finished.

        Safe to call on a timer: one row per video, written in place, so a
        player reporting every ten seconds for an hour leaves one row
        behind rather than three hundred and sixty.
        """
        position = max(0.0, position_s)
        if duration_s:
            position = min(position, duration_s)
        if finished is None:
            finished = bool(duration_s) and position >= (duration_s or 0.0) - _finished_tail(duration_s or 0.0)
        entry = VideoProgress(
            video_id=video_id,
            position_s=position,
            finished=finished,
            updated_at=now if now is not None else time.time(),
        )
        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT INTO progress(video_id, position_s, finished, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(video_id) DO UPDATE SET position_s = ?, finished = ?, updated_at = ?",
                (
                    entry.video_id,
                    entry.position_s,
                    int(entry.finished),
                    entry.updated_at,
                    entry.position_s,
                    int(entry.finished),
                    entry.updated_at,
                ),
            )
        return entry

    def delete(self, video_id: str) -> None:
        """Forget the position, so the video starts from the beginning again."""
        with self._lock, self._conn() as conn:
            conn.execute("DELETE FROM progress WHERE video_id = ?", (video_id,))


def _finished_tail(duration_s: float) -> float:
    """How much of the end counts as watched: ninety seconds, or 3% of a short one."""
    return min(FINISHED_TAIL_S, duration_s * FINISHED_TAIL_RATIO)


def _row(row: tuple[str, float, int, float]) -> VideoProgress:
    return VideoProgress(video_id=row[0], position_s=row[1], finished=bool(row[2]), updated_at=row[3])
