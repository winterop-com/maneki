"""Per-user playlists at `<root>/.maneki/users/<name>/playlists/`.

Each playlist is one TOML file (`<id>.toml`) holding its name, timestamps,
owner, and an ordered list of Subsonic track IDs (`tr_*`). Track IDs are stable
across library re-scans (sha1 of the track path), exactly like stars — so a
playlist survives a `library index drop`. Entries that no longer resolve
against the live cache are silently dropped when the playlist is read, so the
client never sees broken songs.

This is separate from the CLI's M3U8 generator (`audio/playlist/`), which writes
library-wide `.m3u8` files for external players; these are the per-user,
Subsonic-API playlists.
"""

from __future__ import annotations

import logging
import secrets
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from pydantic import BaseModel, ConfigDict

from maneki.audio import _toml_dump

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class Playlist(BaseModel):
    """A stored playlist: metadata + ordered Subsonic track IDs."""

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    owner: str
    created: str
    changed: str
    track_ids: tuple[str, ...] = ()


class PlaylistStore:
    """Read / mutate a user's playlist TOML files with file-level locking."""

    def __init__(self, directory: Path, owner: str) -> None:
        """Build a store over `directory` owned by `owner`."""
        self._dir = directory
        self._owner = owner
        self._lock = RLock()

    def _path(self, pid: str) -> Path:
        return self._dir / f"{pid}.toml"

    def all(self) -> list[Playlist]:
        """All of the user's playlists, newest-changed first."""
        with self._lock:
            if not self._dir.exists():
                return []
            out = [pl for p in sorted(self._dir.glob("pl_*.toml")) if (pl := self._read(p)) is not None]
        return sorted(out, key=lambda pl: pl.changed, reverse=True)

    def get(self, pid: str) -> Playlist | None:
        """The playlist with `pid`, or None."""
        with self._lock:
            return self._read(self._path(pid))

    def create(self, name: str, track_ids: list[str]) -> Playlist:
        """Create a playlist and return it."""
        now = _now_iso()
        pid = f"pl_{secrets.token_hex(8)}"
        pl = Playlist(
            id=pid, name=name or "Untitled", owner=self._owner, created=now, changed=now, track_ids=tuple(track_ids)
        )
        with self._lock:
            self._write(pl)
        return pl

    def update(
        self,
        pid: str,
        *,
        name: str | None = None,
        set_ids: list[str] | None = None,
        add_ids: list[str] | None = None,
        remove_indices: list[int] | None = None,
    ) -> Playlist | None:
        """Rename and/or change tracks; returns the updated playlist or None.

        `set_ids` replaces the whole list; otherwise `remove_indices` are dropped
        then `add_ids` appended.
        """
        with self._lock:
            current = self._read(self._path(pid))
            if current is None:
                return None
            if set_ids is not None:
                ids = list(set_ids)
            else:
                ids = list(current.track_ids)
                for i in sorted(remove_indices or [], reverse=True):
                    if 0 <= i < len(ids):
                        del ids[i]
                ids.extend(add_ids or [])
            updated = current.model_copy(
                update={
                    "name": name if name is not None else current.name,
                    "track_ids": tuple(ids),
                    "changed": _now_iso(),
                }
            )
            self._write(updated)
            return updated

    def delete(self, pid: str) -> bool:
        """Delete the playlist; True if it existed."""
        with self._lock:
            path = self._path(pid)
            if not path.exists():
                return False
            try:
                path.unlink()
            except OSError as exc:  # pragma: no cover - read-only mount
                log.warning("playlists: failed to delete %s (%s)", path, exc)
                return False
            return True

    # -- file I/O ------------------------------------------------------------

    def _read(self, path: Path) -> Playlist | None:
        if not path.exists():
            return None
        try:
            with path.open("rb") as f:
                data = tomllib.load(f)
            return Playlist.model_validate(data)
        except (OSError, tomllib.TOMLDecodeError, ValueError) as exc:
            log.warning("playlists: skipping unreadable %s (%s)", path, exc)
            return None

    def _write(self, pl: Playlist) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "id": pl.id,
                "name": pl.name,
                "owner": pl.owner,
                "created": pl.created,
                "changed": pl.changed,
                "track_ids": list(pl.track_ids),
            }
            tmp = self._path(pl.id).with_suffix(".toml.tmp")
            tmp.write_text(_toml_dump.dumps(payload), encoding="utf-8")
            tmp.replace(self._path(pl.id))
        except OSError as exc:  # pragma: no cover - read-only mount
            log.warning("playlists: failed to write %s (%s)", self._path(pl.id), exc)
