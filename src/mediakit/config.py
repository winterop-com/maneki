"""Top-level mediakit user config at ~/.config/mediakit/mediakit.toml.

Distinct from the audio-specific `mediakit.audio.config.MediakitConfig` (which
handles Subsonic server credentials, AcoustID keys, etc). This module owns the
cross-cutting config sections — chiefly the list of library roots.

Schema:

    [libraries]
    locations = [
      "~/Downloads/library",
      "/Volumes/NAS/media",
    ]

Both audio-specific and top-level configs read the same TOML file so users have
one place to edit. Audio config ignores unknown keys; top-level config ignores
audio-specific keys; they coexist.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "mediakit"
CONFIG_PATH = CONFIG_DIR / "mediakit.toml"


def config_path() -> Path:
    """Return the absolute path the config is loaded from."""
    return CONFIG_PATH


def load_library_locations() -> list[Path]:
    """Read the configured library roots from `[libraries].locations`.

    Returns an empty list if the config file does not exist or has no
    `[libraries]` section. Tilde-expansion is applied so users can write
    `~/Downloads/library` and have it resolve to their home directory.
    """
    if not CONFIG_PATH.exists():
        return []
    with CONFIG_PATH.open("rb") as fh:
        data = tomllib.load(fh)
    raw = data.get("libraries", {}).get("locations", [])
    return [Path(str(loc)).expanduser() for loc in raw]
