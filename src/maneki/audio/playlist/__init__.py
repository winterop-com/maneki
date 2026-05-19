"""Automatic playlist generation — public API.

`generate(index, seed, target_minutes)` produces a coherent listening
session anchored to a seed track. `write_m3u8()` / `read_m3u8()` handle
disk I/O in standard extended M3U format so any player (Subsonic
clients, VLC) can open the result.

This module deliberately uses only the data already in the SQLite index
(tag-based similarity, no audio-feature analysis). Audio fingerprinting
is a separate, much larger feature.
"""

from __future__ import annotations

from maneki.audio.playlist.build import PlaylistResult, generate
from maneki.audio.playlist.io import read_m3u8, write_m3u8
from maneki.audio.playlist.similarity import score

__all__ = ["PlaylistResult", "generate", "read_m3u8", "score", "write_m3u8"]
