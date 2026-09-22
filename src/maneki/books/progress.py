"""Where each user stopped in each book: `<root>/.maneki/users/<name>/books.db`.

An hour into a book, closing the app and opening it again has to resume,
so the position lives on the server rather than in one browser. It is a
single offset in seconds on the book's own timeline, which keeps it
meaningful for a book split across many files: the player maps the offset
back to a file with the offsets the books API reports.

SQLite, like the play history, and beside the other per-user stores so it
survives an index rebuild.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, ConfigDict

_SCHEMA = """
CREATE TABLE IF NOT EXISTS progress (
  book_id     TEXT PRIMARY KEY,
  position_s  REAL NOT NULL,
  finished    INTEGER NOT NULL DEFAULT 0,
  updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at);
"""

# A book counts as finished once the position is within this much of its end:
# most books close with credits nobody listens through. Capped at a fraction
# of the book so the rule cannot swallow a short one whole.
FINISHED_TAIL_S = 60.0
FINISHED_TAIL_RATIO = 0.02


class BookProgress(BaseModel):
    """One user's position in one book."""

    model_config = ConfigDict(frozen=True)

    book_id: str
    position_s: float
    finished: bool
    updated_at: float


class ProgressStore:
    """One user's listening positions, keyed by book id."""

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

    def get(self, book_id: str) -> BookProgress | None:
        """Where the user stopped in `book_id`, or None if they never started it."""
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT book_id, position_s, finished, updated_at FROM progress WHERE book_id = ?",
                (book_id,),
            ).fetchone()
        return _row(row) if row else None

    def all(self) -> list[BookProgress]:
        """Every book the user has started, most recently played first."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT book_id, position_s, finished, updated_at FROM progress ORDER BY updated_at DESC"
            ).fetchall()
        return [_row(r) for r in rows]

    def save(
        self,
        book_id: str,
        position_s: float,
        *,
        duration_s: float | None = None,
        finished: bool | None = None,
        now: float | None = None,
    ) -> BookProgress:
        """Record the position. Passing the book's length marks the tail as finished."""
        position = max(0.0, position_s)
        if duration_s:
            position = min(position, duration_s)
        if finished is None:
            finished = bool(duration_s) and position >= (duration_s or 0.0) - _finished_tail(duration_s or 0.0)
        entry = BookProgress(
            book_id=book_id,
            position_s=position,
            finished=finished,
            updated_at=now if now is not None else time.time(),
        )
        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT INTO progress(book_id, position_s, finished, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(book_id) DO UPDATE SET position_s = ?, finished = ?, updated_at = ?",
                (
                    entry.book_id,
                    entry.position_s,
                    int(entry.finished),
                    entry.updated_at,
                    entry.position_s,
                    int(entry.finished),
                    entry.updated_at,
                ),
            )
        return entry

    def delete(self, book_id: str) -> None:
        """Forget the position, so the book starts from the beginning again."""
        with self._lock, self._conn() as conn:
            conn.execute("DELETE FROM progress WHERE book_id = ?", (book_id,))


def _finished_tail(duration_s: float) -> float:
    """How much of the end counts as finished: a minute, or 2% of a short book."""
    return min(FINISHED_TAIL_S, duration_s * FINISHED_TAIL_RATIO)


def _row(row: tuple[str, float, int, float]) -> BookProgress:
    return BookProgress(book_id=row[0], position_s=row[1], finished=bool(row[2]), updated_at=row[3])
