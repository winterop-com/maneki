"""Per-user YouTube channel subscriptions at `<root>/.maneki/users/<name>/youtube.toml`.

A user subscribes to a channel by URL; we store the stable `UC...` channel id
(not the URL — handles and vanity URLs change, the id doesn't) mapped to the
subscribe timestamp. The channel's title / avatar / video list are *not* stored:
they're fetched on demand from `youtube.list_channel` (cached), so the file
stays a tiny, hand-editable record of "what am I subscribed to".

Modeled directly on `audio.serve.stars.StarStore` — same TOML shape, same
file-level locking, same best-effort write on read-only mounts.
"""

from __future__ import annotations

import logging
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from maneki.audio import _toml_dump

log = logging.getLogger(__name__)


class SubscriptionStore:
    """Read / mutate `<root>/.maneki/users/<name>/youtube.toml` with locking."""

    def __init__(self, path: Path) -> None:
        """Build a store backed by the `youtube.toml` file at `path`."""
        self._path = path
        self._lock = RLock()
        # `_items` maps channel id (`UC...`) -> ISO 8601 subscribed-at timestamp.
        self._items: dict[str, str] = {}
        self._load()

    @property
    def path(self) -> Path:
        """File location backing this store."""
        return self._path

    def add(self, channel_id: str) -> None:
        """Subscribe to `channel_id` if not already. Idempotent."""
        with self._lock:
            if channel_id in self._items:
                return
            self._items[channel_id] = _now_iso()
            self._save()

    def remove(self, channel_id: str) -> None:
        """Unsubscribe `channel_id`. Idempotent."""
        with self._lock:
            if channel_id not in self._items:
                return
            del self._items[channel_id]
            self._save()

    def contains(self, channel_id: str) -> bool:
        """True iff currently subscribed to `channel_id`."""
        with self._lock:
            return channel_id in self._items

    def all_ids(self) -> dict[str, str]:
        """Snapshot copy of `channel_id -> subscribed_at`, newest first."""
        with self._lock:
            return dict(sorted(self._items.items(), key=lambda kv: kv[1], reverse=True))

    # ------------------------------------------------------------------
    # File I/O
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Read `youtube.toml`. Missing file or parse error -> empty store."""
        if not self._path.exists():
            return
        try:
            with self._path.open("rb") as f:
                data = tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError) as exc:
            log.warning("subscriptions: failed to read %s (%s); starting empty", self._path, exc)
            return
        items = data.get("channels")
        if isinstance(items, dict):
            self._items = {str(k): str(v) for k, v in items.items()}

    def _save(self) -> None:
        """Atomic-write the current state. Best-effort on read-only mounts."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(_toml_dump.dumps({"channels": self._items}), encoding="utf-8")
            tmp.replace(self._path)
        except OSError as exc:  # pragma: no cover — read-only mount
            log.warning("subscriptions: failed to write %s (%s); changes lost on restart", self._path, exc)


def _now_iso() -> str:
    """UTC `now()` as ISO 8601 (e.g. 2026-06-10T10:30:00Z)."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
