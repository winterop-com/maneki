"""User accounts + per-user data stores.

A `UserRegistry` is built once per server from the consolidated settings (one
`[[users]]` list, or a single account synthesized from `[server]`). It resolves
incoming Subsonic credentials to an account and hands out per-user stores —
each user's stars (and, later, playlists / history) live under
`<root>/.maneki/users/<safe-name>/`, keyed to the authenticated username.

The index DB, posters, and subtitle caches stay GLOBAL — they're derived from
the library, not owned by a user.
"""

from __future__ import annotations

import hashlib
import logging
import re
import unicodedata
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

from maneki.audio.serve.config import ServeConfig
from maneki.audio.serve.history import HistoryStore
from maneki.audio.serve.playlists import PlaylistStore
from maneki.audio.serve.stars import StarStore

if TYPE_CHECKING:
    from maneki.video.serve.subscriptions import SubscriptionStore

log = logging.getLogger(__name__)


class ResolvedUser(BaseModel):
    """An authenticated account. Password is plaintext (Subsonic token auth)."""

    model_config = ConfigDict(frozen=True)

    name: str
    password: str
    admin: bool = False


def sanitize_username(name: str) -> str:
    """Map a username to a filesystem-safe, collision-free directory name.

    Lowercase + NFC-normalize, keep only `[a-z0-9_-]`, then suffix a short hash
    of the *raw* name so two different usernames can never land on the same
    directory (and `../` style names are neutralized).
    """
    norm = unicodedata.normalize("NFC", name).strip().lower()
    slug = re.sub(r"[^a-z0-9_-]+", "_", norm).strip("._-") or "user"
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]  # noqa: S324 - dir naming, not security
    return f"{slug}-{digest}"


class UserRegistry:
    """Resolved accounts + lazily-built, cached per-user stores."""

    def __init__(self, root: Path, users: list[ResolvedUser]) -> None:
        """Build a registry rooted at `root` with the given accounts."""
        self._root = root
        self._users: dict[str, ResolvedUser] = {u.name: u for u in users}
        self._lock = RLock()
        self._stars: dict[str, StarStore] = {}
        self._playlists: dict[str, PlaylistStore] = {}
        self._history: dict[str, HistoryStore] = {}
        # YouTube subscriptions are video-side data; the store is imported
        # lazily in `subscriptions_for` so the audio package doesn't pull the
        # video module (and yt-dlp) at import time.
        self._subscriptions: dict[str, SubscriptionStore] = {}

    @classmethod
    def from_settings(cls, root: Path) -> UserRegistry:
        """Build from `maneki.settings` (the `[[users]]` list or `[server]` fallback)."""
        from maneki.settings import get_settings

        accounts = [ResolvedUser(name=a.name, password=a.password, admin=a.admin) for a in get_settings().accounts()]
        return cls(root, accounts)

    @classmethod
    def single_user(cls, root: Path, cfg: ServeConfig) -> UserRegistry:
        """A one-account registry from a resolved `ServeConfig` (tests / fallback)."""
        return cls(root, [ResolvedUser(name=cfg.username, password=cfg.password, admin=True)])

    # -- lookups -------------------------------------------------------------

    def get(self, name: str) -> ResolvedUser | None:
        """Return the account named `name`, or None."""
        return self._users.get(name)

    def all(self) -> list[ResolvedUser]:
        """All accounts, in config order."""
        return list(self._users.values())

    # -- per-user stores -----------------------------------------------------

    def user_dir(self, name: str) -> Path:
        """`<root>/.maneki/users/<safe-name>/` for the account."""
        return self._root / ".maneki" / "users" / sanitize_username(name)

    def stars_for(self, name: str) -> StarStore:
        """The account's `StarStore`, built once and cached."""
        with self._lock:
            store = self._stars.get(name)
            if store is None:
                store = StarStore(self.user_dir(name) / "stars.toml")
                self._stars[name] = store
            return store

    def playlists_for(self, name: str) -> PlaylistStore:
        """The account's `PlaylistStore`, built once and cached."""
        with self._lock:
            store = self._playlists.get(name)
            if store is None:
                store = PlaylistStore(self.user_dir(name) / "playlists", owner=name)
                self._playlists[name] = store
            return store

    def history_for(self, name: str) -> HistoryStore:
        """The account's `HistoryStore`, built once and cached."""
        with self._lock:
            store = self._history.get(name)
            if store is None:
                store = HistoryStore(self.user_dir(name) / "history.db")
                self._history[name] = store
            return store

    def subscriptions_for(self, name: str) -> SubscriptionStore:
        """The account's YouTube `SubscriptionStore`, built once and cached."""
        from maneki.video.serve.subscriptions import SubscriptionStore

        with self._lock:
            store = self._subscriptions.get(name)
            if store is None:
                store = SubscriptionStore(self.user_dir(name) / "youtube.toml")
                self._subscriptions[name] = store
            return store


def migrate_global_stars(root: Path, registry: UserRegistry) -> Path | None:
    """Move a legacy global `<root>/.maneki/stars.toml` into the admin's dir.

    Pre-multi-user, all stars lived in one global file. On first multi-user
    boot, move that file under the primary admin so their favourites survive.
    Idempotent: only moves when the destination doesn't already exist. Returns
    the destination path if a move happened, else None.
    """
    legacy = root / ".maneki" / "stars.toml"
    if not legacy.exists():
        return None
    admin = next((u for u in registry.all() if u.admin), None) or (registry.all()[0] if registry.all() else None)
    if admin is None:
        return None
    dest = registry.user_dir(admin.name) / "stars.toml"
    if dest.exists():
        return None
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        legacy.replace(dest)
    except OSError as exc:  # pragma: no cover - read-only mount
        log.warning("users: could not migrate global stars %s -> %s (%s)", legacy, dest, exc)
        return None
    log.info("users: migrated global stars.toml into %s's per-user store", admin.name)
    return dest
