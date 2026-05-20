"""Persistent SQLite-backed index of the video library scan.

The previous implementation walked the filesystem and ffprobe'd every
file on every server start. On a 10k-file library that's tens of
seconds before the first byte is served. This module persists the
scan result inside the same `<root>/.maneki/index.db` the audio side
already maintains so a warm server starts essentially instantly:

  1. Load all rows from SQLite -> in-memory dict of `VideoEntry`.
  2. Walk the filesystem (fast: stat-only).
  3. For each file, compare (mtime, size) against the cached
     fingerprint. Unchanged -> reuse the cached entry; changed or
     new -> ffprobe and upsert.
  4. Delete rows for files no longer present on disk.

Coexistence with the audio index: we share `<root>/.maneki/index.db`
but own a separate `videos` table and namespaced `meta` keys
(`video_schema_version`, `video_library_root_abs`). `CREATE TABLE IF
NOT EXISTS` keeps both apps from stepping on each other when opening
the file. Note: audio's own schema-version bump still unlinks the
whole file (today), which would nuke our `videos` table too — at
which point the next prewarm rebuilds from filesystem (~tens of
seconds on a big library). Acceptable for now; future work could
make the audio side namespace-aware so it only rewrites its own
tables.

WAL mode + reasonable PRAGMAs keep concurrent reads (e.g., listing
endpoints) and writes (e.g., an in-progress rescan) from blocking
each other.

Subtitle metadata is stored as JSON inline rather than a side table.
Sidecars and embedded tracks are cheap to re-discover at probe time;
the JSON column is read-only for the listing endpoints, never queried.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from maneki.video.serve.scan import SubtitleSummary, VideoEntry

log = logging.getLogger(__name__)

INDEX_DIR_NAME: Final[str] = ".maneki"
# Shared with the audio side's library cache. We coexist via
# `CREATE TABLE IF NOT EXISTS` and namespaced meta keys.
INDEX_DB_NAME: Final[str] = "index.db"

# Bump on any incompatible change to the `videos` table or its meta
# keys. open() detects the mismatch via `video_schema_version` and
# rebuilds just our tables — audio's tables alongside are untouched.
SCHEMA_VERSION: Final[int] = 1

# Namespaced so both apps can store their own version + root markers
# in the shared `meta` table without colliding.
_VIDEO_SCHEMA_VERSION_KEY: Final[str] = "video_schema_version"
_VIDEO_LIBRARY_ROOT_KEY: Final[str] = "video_library_root_abs"

# `IF NOT EXISTS` so opening a file that audio already created
# (with its own `meta` row + albums / tracks tables) doesn't fail.
# The meta table is shared; we add our own keys to it.
_SCHEMA: Final[str] = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
    -- `id` matches `_make_id(rel_path)` so the same path always
    -- resolves to the same id across runs (PosterManager, HLSManager,
    -- and SubtitleCache all key off this).
    id              TEXT PRIMARY KEY,
    rel_path        TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    duration_s      REAL,
    -- mtime + size_bytes together are the cache invalidation key.
    -- A file that hasn't changed on disk reuses its cached row;
    -- anything else gets re-probed.
    mtime           REAL NOT NULL,
    subtitles_json  TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS videos_rel_path ON videos(rel_path);
"""

_PRAGMAS: Final[tuple[str, ...]] = (
    "journal_mode = WAL",
    "synchronous = NORMAL",
    "temp_store = MEMORY",
    "mmap_size = 67108864",  # 64 MiB
)


def db_path(root: Path) -> Path:
    """Return `<root>/.maneki/index.db` (shared with the audio side)."""
    return root / INDEX_DIR_NAME / INDEX_DB_NAME


class VideoIndex:
    """SQLite-backed cache of `VideoEntry` rows keyed by stable id.

    Open the index once at server start, hand it to `prewarm_scan`,
    keep it for the lifetime of the process. Concurrent reads (e.g.
    `/api/videos` while a rescan is in progress) are safe under WAL.

    Shares `<root>/.maneki/index.db` with the audio side's library
    cache. Audio owns the `albums`, `tracks`, `track_genres`, and
    `album_warnings` tables plus the `schema_version` / `library_root_abs`
    meta keys; we own the `videos` table plus the `video_schema_version`
    / `video_library_root_abs` meta keys. `CREATE TABLE IF NOT EXISTS`
    keeps the open path idempotent regardless of which app touched the
    file first.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = db_path(root)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        for pragma in _PRAGMAS:
            self._conn.execute(f"PRAGMA {pragma}")
        # Always make sure our tables exist — the file may have been
        # created by audio with its own schema and no `videos` table yet,
        # or by a previous video run.
        self._conn.executescript(_SCHEMA)
        if not self._video_schema_matches():
            # Our version / root markers don't match. Wipe just the
            # videos table (audio's data is preserved) and rewrite
            # the markers for a clean re-probe.
            log.info("video index: schema or root mismatch in %s; resetting videos table", self.path)
            self._conn.execute("DROP TABLE IF EXISTS videos")
            self._conn.executescript(_SCHEMA)
            self._write_video_markers()
        else:
            # First-time setup on a file audio created — markers are
            # missing; write them so subsequent opens hit the fast path.
            self._write_video_markers()

    def _video_schema_matches(self) -> bool:
        rows = self._conn.execute(
            "SELECT key, value FROM meta WHERE key IN (?, ?)",
            (_VIDEO_SCHEMA_VERSION_KEY, _VIDEO_LIBRARY_ROOT_KEY),
        ).fetchall()
        meta = {row["key"]: row["value"] for row in rows}
        # First open on a brand new file: markers don't exist yet
        # (and there's nothing in `videos` to invalidate anyway).
        if not meta:
            return True
        if meta.get(_VIDEO_SCHEMA_VERSION_KEY) != str(SCHEMA_VERSION):
            return False
        return meta.get(_VIDEO_LIBRARY_ROOT_KEY) == str(self.root.resolve())

    def _write_video_markers(self) -> None:
        self._conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_VIDEO_SCHEMA_VERSION_KEY, str(SCHEMA_VERSION)),
        )
        self._conn.execute(
            "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_VIDEO_LIBRARY_ROOT_KEY, str(self.root.resolve())),
        )

    def close(self) -> None:
        self._conn.close()

    # -- Read path ------------------------------------------------------

    def load_all(self) -> dict[str, VideoEntry]:
        """Return every cached row keyed by id. Used to seed the live cache."""
        from maneki.video.serve.scan import SubtitleSummary, VideoEntry  # circular

        rows = self._conn.execute(
            "SELECT id, rel_path, name, path, size_bytes, duration_s, subtitles_json FROM videos"
        ).fetchall()
        out: dict[str, VideoEntry] = {}
        for row in rows:
            try:
                subtitles_raw = json.loads(row["subtitles_json"])
            except (TypeError, ValueError, json.JSONDecodeError):
                subtitles_raw = []
            subtitles: list[SubtitleSummary] = [
                SubtitleSummary(lang=str(s.get("lang", "und")), format=str(s.get("format", "srt")))
                for s in subtitles_raw
                if isinstance(s, dict)
            ]
            out[row["id"]] = VideoEntry(
                id=row["id"],
                name=row["name"],
                path=row["path"],
                size_bytes=int(row["size_bytes"]),
                rel_path=row["rel_path"],
                duration_s=row["duration_s"],
                subtitles=subtitles,
            )
        return out

    def fingerprints(self) -> dict[str, tuple[float, int]]:
        """Return {id: (mtime, size_bytes)} so the scanner can diff against disk."""
        rows = self._conn.execute("SELECT id, mtime, size_bytes FROM videos").fetchall()
        return {row["id"]: (float(row["mtime"]), int(row["size_bytes"])) for row in rows}

    # -- Write path -----------------------------------------------------

    def upsert(self, entry: VideoEntry, mtime: float) -> None:
        """Insert or replace a single row. Caller passes the on-disk mtime."""
        subtitles_json = json.dumps(
            [{"lang": s["lang"], "format": s["format"]} for s in entry["subtitles"]],
            separators=(",", ":"),
        )
        self._conn.execute(
            """
            INSERT INTO videos(id, rel_path, name, path, size_bytes, duration_s, mtime, subtitles_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                rel_path = excluded.rel_path,
                name = excluded.name,
                path = excluded.path,
                size_bytes = excluded.size_bytes,
                duration_s = excluded.duration_s,
                mtime = excluded.mtime,
                subtitles_json = excluded.subtitles_json
            """,
            (
                entry["id"],
                entry["rel_path"],
                entry["name"],
                entry["path"],
                entry["size_bytes"],
                entry["duration_s"],
                mtime,
                subtitles_json,
            ),
        )

    def delete_missing(self, live_ids: set[str]) -> int:
        """Drop rows whose id is no longer in `live_ids`. Returns count removed."""
        cached = set(self._conn.execute("SELECT id FROM videos").fetchall())
        cached_ids = {row["id"] for row in cached}
        stale = cached_ids - live_ids
        if not stale:
            return 0
        self._conn.executemany(
            "DELETE FROM videos WHERE id = ?",
            [(vid,) for vid in stale],
        )
        return len(stale)

    def clear(self) -> None:
        """Wipe every row. Used by `--rescan` for a full rebuild."""
        self._conn.execute("DELETE FROM videos")
