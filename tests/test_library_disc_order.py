"""An album's tracks are in disc and track order, whatever their files are called."""

from __future__ import annotations

import shutil
from pathlib import Path

from mutagen.flac import FLAC

from maneki.audio.library.scan import _scan_album


def _tagged(template: Path, dst: Path, title: str, disc: int, track: int) -> None:
    shutil.copy2(template, dst)
    tags = FLAC(dst)
    tags["title"] = title
    tags["album"] = "Clubland"
    tags["discnumber"] = str(disc)
    tags["tracknumber"] = str(track)
    tags.save()


def test_discs_in_one_folder_play_in_order(silent_flac_template: Path, tmp_path: Path) -> None:
    """A multi-disc album kept in one folder was read in file-name order, so the discs played
    interleaved: disc 3, 1, 2, 4, 1, 2 ..."""
    album = tmp_path / "Various" / "Clubland"
    album.mkdir(parents=True)
    _tagged(silent_flac_template, album / "a.flac", "Two-One", disc=2, track=1)
    _tagged(silent_flac_template, album / "b.flac", "One-Two", disc=1, track=2)
    _tagged(silent_flac_template, album / "c.flac", "One-One", disc=1, track=1)
    _tagged(silent_flac_template, album / "d.flac", "Two-Two", disc=2, track=2)

    scanned = _scan_album(album)

    assert [t.title for t in scanned.tracks] == ["One-One", "One-Two", "Two-One", "Two-Two"]


def test_the_order_survives_the_saved_index(silent_flac_template: Path, tmp_path: Path) -> None:
    """The index loaded its tracks back by file name, which undid the order on every start."""
    from maneki.audio import library

    album = tmp_path / "Various" / "Clubland"
    album.mkdir(parents=True)
    _tagged(silent_flac_template, album / "a.flac", "Two-One", disc=2, track=1)
    _tagged(silent_flac_template, album / "b.flac", "One-Two", disc=1, track=2)
    _tagged(silent_flac_template, album / "c.flac", "One-One", disc=1, track=1)

    library.load_or_scan(tmp_path)  # writes the index
    reloaded = library.load_or_scan(tmp_path)  # reads it back

    [loaded] = [a for a in reloaded.albums if a.album_dir == "Clubland"]
    assert [t.title for t in loaded.tracks] == ["One-One", "One-Two", "Two-One"]
