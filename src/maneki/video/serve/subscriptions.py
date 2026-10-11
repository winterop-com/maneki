"""Per-user YouTube channel subscriptions at `<root>/.maneki/users/<name>/youtube.db`.

A user subscribes to a channel by URL; we store the stable `UC...` channel id
(not the URL — handles and vanity URLs change, the id doesn't) with the time it
was subscribed. The channel's title / avatar / video list are *not* stored:
they're fetched on demand from `youtube.list_channel` (cached).

ONE KIND OF STORE PER USER. A user's books, videos, history and bookmarks are
SQLite files in their own directory; subscriptions were the one TOML file among
them. They are SQLite now too, the same shape as `books.progress.ProgressStore`:
a connection per call, a lock around it, the schema made on first use.

A `youtube.toml` from before is taken in once, the first time the store is
opened beside it, and renamed to `youtube.toml.imported` so it is kept but never
read again: an unsubscribe is not undone by the next start.
"""

from __future__ import annotations

import logging
import sqlite3
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from maneki.video.serve.progress import open_user_db

log = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS channels (
    channel_id     TEXT PRIMARY KEY,
    subscribed_at  TEXT NOT NULL
);
"""


class SubscriptionStore:
    """Read / mutate one user's `youtube.db`."""

    def __init__(self, path: Path, *, legacy: Path | None = None) -> None:
        """Build a store backed by the SQLite file at `path`, taking in `legacy` TOML once."""
        self._path = path
        self._lock = RLock()
        self._ready = False
        if legacy is not None:
            self._import(legacy)

    @property
    def path(self) -> Path:
        """File location backing this store."""
        return self._path

    def _conn(self) -> sqlite3.Connection:
        conn = open_user_db(self._path, _SCHEMA, ready=self._ready)
        self._ready = True
        return conn

    def add(self, channel_id: str, *, at: str | None = None) -> None:
        """Subscribe to `channel_id` if not already. Idempotent."""
        with self._lock, self._conn() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO channels(channel_id, subscribed_at) VALUES (?, ?)",
                (channel_id, at or _now_iso()),
            )

    def remove(self, channel_id: str) -> None:
        """Unsubscribe `channel_id`. Idempotent."""
        with self._lock, self._conn() as conn:
            conn.execute("DELETE FROM channels WHERE channel_id = ?", (channel_id,))

    def contains(self, channel_id: str) -> bool:
        """True iff currently subscribed to `channel_id`."""
        with self._lock, self._conn() as conn:
            row = conn.execute("SELECT 1 FROM channels WHERE channel_id = ?", (channel_id,)).fetchone()
        return row is not None

    def all_ids(self) -> dict[str, str]:
        """Snapshot of `channel_id -> subscribed_at`, newest first."""
        with self._lock, self._conn() as conn:
            rows = conn.execute(
                "SELECT channel_id, subscribed_at FROM channels ORDER BY subscribed_at DESC, channel_id"
            ).fetchall()
        return {str(channel_id): str(at) for channel_id, at in rows}

    def _import(self, legacy: Path) -> None:
        """Take in a `youtube.toml` from before, then set it aside. Best-effort."""
        if not legacy.is_file():
            return
        try:
            with legacy.open("rb") as f:
                data = tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError) as exc:
            log.warning("subscriptions: could not read %s (%s); left in place", legacy, exc)
            return
        items = data.get("channels")
        if isinstance(items, dict):
            for channel_id, at in items.items():
                self.add(str(channel_id), at=str(at))
        try:
            legacy.replace(legacy.with_name(legacy.name + ".imported"))
        except OSError as exc:  # pragma: no cover - read-only mount
            log.warning("subscriptions: imported %s but could not set it aside (%s)", legacy, exc)


def _now_iso() -> str:
    """UTC `now()` as ISO 8601 (e.g. 2026-06-10T10:30:00Z)."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
