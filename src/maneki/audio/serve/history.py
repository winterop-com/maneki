"""Per-user listening history at `<root>/.maneki/users/<name>/history.db`.

A small SQLite table of play events (track ID + timestamp + whether it's a
"now playing" probe or a finished-play submission). It powers per-user
recently-played / most-played album lists, play counts, and the cross-user
`getNowPlaying` ("who's listening"). SQLite (not TOML) because plays accumulate
unbounded and need ordering / aggregation.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from threading import RLock

_SCHEMA = """
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL,
  played_at REAL NOT NULL,
  submission INTEGER NOT NULL  -- 1 = finished play, 0 = now-playing probe
);
CREATE INDEX IF NOT EXISTS idx_plays_track ON plays(track_id);
CREATE INDEX IF NOT EXISTS idx_plays_time ON plays(played_at);
"""

# A now-playing probe counts as "current" for this long after it fires.
NOW_PLAYING_WINDOW_S = 600


class HistoryStore:
    """Append-only play log + the per-user aggregations clients ask for."""

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

    def record(self, track_id: str, *, submission: bool, now: float | None = None) -> None:
        """Append a play event for `track_id`."""
        ts = now if now is not None else time.time()
        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT INTO plays(track_id, played_at, submission) VALUES (?, ?, ?)",
                (track_id, ts, int(submission)),
            )

    def now_playing(self, *, now: float | None = None) -> tuple[str, float] | None:
        """The track from the most recent now-playing probe within the window, or None."""
        cutoff = (now if now is not None else time.time()) - NOW_PLAYING_WINDOW_S
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT track_id, played_at FROM plays WHERE submission=0 AND played_at>=? "
                "ORDER BY played_at DESC LIMIT 1",
                (cutoff,),
            ).fetchone()
        return (row[0], row[1]) if row else None

    def recent_track_ids(self, limit: int) -> list[str]:
        """Distinct finished-play track IDs, most-recently-played first."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT track_id, MAX(played_at) AS t FROM plays WHERE submission=1 "
                "GROUP BY track_id ORDER BY t DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [r[0] for r in rows]

    def frequent_track_ids(self, limit: int) -> list[str]:
        """Distinct track IDs ordered by finished-play count, descending."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT track_id, COUNT(*) AS c FROM plays WHERE submission=1 "
                "GROUP BY track_id ORDER BY c DESC, MAX(played_at) DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [r[0] for r in rows]

    def play_count(self, track_id: str) -> int:
        """Number of finished plays recorded for `track_id`."""
        with self._lock, self._conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM plays WHERE track_id=? AND submission=1",
                (track_id,),
            ).fetchone()
        return int(row[0]) if row else 0
