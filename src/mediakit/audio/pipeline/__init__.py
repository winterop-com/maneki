"""Orchestrator: per-album discover → cover → convert → tag → report.

Public surface re-exported here so callers keep using
`from mediakit import pipeline` / `from mediakit.audio.pipeline import …`.
The names with leading underscores are still package-private but are
re-exported because tests import them directly.
"""

from __future__ import annotations

from mediakit.audio.pipeline.dedupe import _dedupe_duplicate_tracks
from mediakit.audio.pipeline.filenames import _humanise_slug
from mediakit.audio.pipeline.footprint import _input_footprint
from mediakit.audio.pipeline.report import AlbumReport
from mediakit.audio.pipeline.run import default_workers, run

__all__ = [
    "AlbumReport",
    "_dedupe_duplicate_tracks",
    "_humanise_slug",
    "_input_footprint",
    "default_workers",
    "run",
]
