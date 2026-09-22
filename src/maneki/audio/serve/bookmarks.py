"""Per-user Subsonic bookmarks at `<root>/.maneki/users/<name>/bookmarks.db`.

A bookmark is a position inside one track, which is how Subsonic clients
resume a long recording: Symfonium, Amperfy and play:Sub all save one on
pause. Kept per account beside the favourites and the play history, in
SQLite because clients rewrite the position every few seconds.

The books API has its own store for a whole book's position
(`maneki.books.progress`); this one answers the Subsonic grammar, keyed by
track id.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, ConfigDict

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bookmarks (
  track_id    TEXT PRIMARY KEY,
  position_ms INTEGER NOT NULL,
  comment     TEXT NOT NULL DEFAULT '',
  created_at  REAL NOT NULL,
  changed_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_changed ON bookmarks(changed_at);
"""


class Bookmark(BaseModel):
    """One saved position inside a track."""

    model_config = ConfigDict(frozen=True)

    track_id: str
    position_ms: int
    comment: str
    created_at: float
    changed_at: float


class BookmarkStore:
    """One account's bookmarks, keyed by track id."""

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

    def all(self) -> list[Bookmark]:
        """Every bookmark, most recently changed first."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT track_id, position_ms, comment, created_at, changed_at FROM bookmarks ORDER BY changed_at DESC"
            ).fetchall()
        return [_row(r) for r in rows]

    def get(self, track_id: str) -> Bookmark | None:
        """The bookmark for `track_id`, or None."""
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT track_id, position_ms, comment, created_at, changed_at FROM bookmarks WHERE track_id = ?",
                (track_id,),
            ).fetchone()
        return _row(row) if row else None

    def save(self, track_id: str, position_ms: int, *, comment: str = "", now: float | None = None) -> Bookmark:
        """Record a position. Re-bookmarking a track keeps its original creation time."""
        stamp = now if now is not None else time.time()
        position = max(0, position_ms)
        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT INTO bookmarks(track_id, position_ms, comment, created_at, changed_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(track_id) DO UPDATE SET position_ms = ?, comment = ?, changed_at = ?",
                (track_id, position, comment, stamp, stamp, position, comment, stamp),
            )
        saved = self.get(track_id)
        assert saved is not None
        return saved

    def delete(self, track_id: str) -> None:
        """Remove the bookmark for `track_id`. Silent when there is none."""
        with self._lock, self._conn() as conn:
            conn.execute("DELETE FROM bookmarks WHERE track_id = ?", (track_id,))


def _row(row: tuple[str, int, str, float, float]) -> Bookmark:
    return Bookmark(track_id=row[0], position_ms=row[1], comment=row[2], created_at=row[3], changed_at=row[4])
