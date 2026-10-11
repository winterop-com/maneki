"""A user's YouTube channels, kept in their own `youtube.db`."""

from __future__ import annotations

from pathlib import Path

from maneki.audio.serve.users import ResolvedUser, UserRegistry
from maneki.video.serve.subscriptions import SubscriptionStore


def test_channels_are_kept_in_a_database(tmp_path: Path) -> None:
    store = SubscriptionStore(tmp_path / "youtube.db")
    store.add("UC_one")
    store.add("UC_two")
    store.add("UC_one")  # idempotent
    assert store.contains("UC_one")
    assert set(store.all_ids()) == {"UC_one", "UC_two"}
    store.remove("UC_one")
    assert not store.contains("UC_one")
    assert (tmp_path / "youtube.db").is_file()
    # A fresh store on the same file sees what the last one wrote.
    assert set(SubscriptionStore(tmp_path / "youtube.db").all_ids()) == {"UC_two"}


def test_newest_first(tmp_path: Path) -> None:
    store = SubscriptionStore(tmp_path / "youtube.db")
    store.add("UC_old", at="2026-01-01T00:00:00Z")
    store.add("UC_new", at="2026-06-01T00:00:00Z")
    assert list(store.all_ids()) == ["UC_new", "UC_old"]


def test_a_toml_from_before_is_taken_in_once(tmp_path: Path) -> None:
    """Channels subscribed before the database are not lost, and the old file is not read twice."""
    legacy = tmp_path / "youtube.toml"
    legacy.write_text('[channels]\nUC_kept = "2025-12-01T10:00:00Z"\n', encoding="utf-8")
    store = SubscriptionStore(tmp_path / "youtube.db", legacy=legacy)
    assert store.all_ids() == {"UC_kept": "2025-12-01T10:00:00Z"}
    assert not legacy.exists()
    assert (tmp_path / "youtube.toml.imported").is_file()
    store.remove("UC_kept")
    # The renamed file is left alone: removing a channel is not undone by the next start.
    assert SubscriptionStore(tmp_path / "youtube.db", legacy=legacy).all_ids() == {}


def test_each_account_has_its_own_youtube_db(tmp_path: Path) -> None:
    users = UserRegistry(tmp_path, [ResolvedUser(name="ada", password="pw", admin=True)])
    store = users.subscriptions_for("ada")
    store.add("UC_x")
    assert store.path == users.user_dir("ada") / "youtube.db"
    assert store.path.is_file()
