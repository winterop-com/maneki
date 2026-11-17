"""CUE-sheet disc images: parsing, matching the image, and splitting it in convert."""

from __future__ import annotations

from pathlib import Path

import pytest
from rich.console import Console

from maneki.audio import cue, pipeline
from maneki.audio.convert import OutputFormat
from maneki.audio.metadata import read_source
from tests.conftest import make_silent_flac

SHEET = """REM GENRE Jazz
REM DATE 1988
REM COMMENT "ExactAudioCopy v1.5"
TITLE "The Essence"
PERFORMER "Miles Davis"
FILE "Image.flac" WAVE
  TRACK 01 AUDIO
    TITLE "'Round Midnight"
    PERFORMER "Miles Davis"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Café Walkin'"
    INDEX 00 00:00:70
    INDEX 01 00:01:00
  TRACK 03 AUDIO
    TITLE "So What"
    PERFORMER "Guest"
    INDEX 01 00:02:37
"""


def _write_sheet(path: Path, text: str = SHEET, *, encoding: str = "utf-8") -> Path:
    path.write_bytes(text.replace("\n", "\r\n").encode(encoding))
    return path


def test_parse_cue_reads_disc_and_track_fields(tmp_path: Path) -> None:
    sheet = cue.parse_cue(_write_sheet(tmp_path / "Image.cue"))
    assert sheet is not None
    assert (sheet.title, sheet.performer, sheet.date, sheet.genre, sheet.file) == (
        "The Essence",
        "Miles Davis",
        "1988",
        "Jazz",
        "Image.flac",
    )
    assert [t.number for t in sheet.tracks] == [1, 2, 3]
    assert [t.title for t in sheet.tracks] == ["'Round Midnight", "Café Walkin'", "So What"]
    # INDEX 01 is the start, not INDEX 00 (the pregap); frames are 1/75 s.
    assert sheet.tracks[1].start_s == pytest.approx(1.0)
    assert sheet.tracks[2].start_s == pytest.approx(2 + 37 / 75)
    assert sheet.tracks[1].performer is None


def test_parse_cue_falls_back_to_windows_1252(tmp_path: Path) -> None:
    sheet = cue.parse_cue(_write_sheet(tmp_path / "Image.cue", encoding="cp1252"))
    assert sheet is not None
    assert sheet.tracks[1].title == "Café Walkin'"


def test_parse_cue_ignores_sheets_of_already_split_rips(tmp_path: Path) -> None:
    text = (
        'FILE "01.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n'
        'FILE "02.flac" WAVE\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n'
    )
    assert cue.parse_cue(_write_sheet(tmp_path / "split.cue", text)) is None


@pytest.mark.parametrize("cue_name", ["Image.cue", "Image.flac.cue", "whatever.cue"])
def test_find_cue_images_matches_sheet_to_image(tmp_path: Path, cue_name: str) -> None:
    image = tmp_path / "Image.flac"
    image.write_bytes(b"")
    _write_sheet(tmp_path / cue_name)
    found = cue.find_cue_images([image])
    assert [f.image for f in found] == [image]


def test_find_cue_images_skips_unrelated_audio(tmp_path: Path) -> None:
    other = tmp_path / "Other.flac"
    other.write_bytes(b"")
    _write_sheet(tmp_path / "Image.cue")
    assert cue.find_cue_images([other]) == []


@pytest.fixture
def image_album(tmp_path: Path) -> Path:
    """input/Miles Davis - The Essence (1988)/Image.flac (3 s) + Image.flac.cue."""
    from mutagen.flac import FLAC

    album = tmp_path / "input" / "Miles Davis - The Essence (1988)"
    album.mkdir(parents=True)
    image = make_silent_flac(album / "Image.flac", duration=3.0)
    flac = FLAC(image)
    flac["ALBUM"] = "The Essence"
    flac["ARTIST"] = "Miles Davis"
    flac["LABEL"] = "Columbia"
    flac["CUESHEET"] = SHEET
    flac.save()
    _write_sheet(album / "Image.flac.cue")
    return tmp_path


def test_convert_splits_cue_image_into_tagged_tracks(image_album: Path) -> None:
    out_root = image_album / "output"
    reports = pipeline.run(
        image_album / "input",
        out_root,
        fmt=OutputFormat.ALAC,
        enrich=False,
        console=Console(record=True, width=120),
    )
    assert len(reports) == 1 and reports[0].ok, reports[0].error
    assert reports[0].track_count == 3

    album_dir = out_root / "Miles Davis" / "1988 - The Essence"
    files = sorted(p for p in album_dir.iterdir() if p.suffix == ".m4a")
    assert [p.name for p in files] == ["01 - 'Round Midnight.m4a", "02 - Café Walkin'.m4a", "03 - So What.m4a"]

    tracks = [read_source(p) for p in files]
    assert [t.track_no for t in tracks] == [1, 2, 3]
    assert {t.album for t in tracks} == {"The Essence"}
    assert {t.album_artist for t in tracks} == {"Miles Davis"}
    # A track without its own PERFORMER takes the disc's; one with its own keeps it.
    assert [t.artist for t in tracks] == ["Miles Davis", "Miles Davis", "Guest"]
    assert tracks[0].label == "Columbia"
    durations = [t.duration_s or 0 for t in tracks]
    assert durations == pytest.approx([1.0, 2 + 37 / 75 - 1.0, 3.0 - (2 + 37 / 75)], abs=0.05)
    # The source image is left alone.
    assert (image_album / "input" / "Miles Davis - The Essence (1988)" / "Image.flac").exists()


def test_dry_run_plans_the_image_without_splitting(image_album: Path) -> None:
    reports = pipeline.run(
        image_album / "input",
        image_album / "output",
        fmt=OutputFormat.ALAC,
        enrich=False,
        dry_run=True,
        console=Console(record=True, width=120),
    )
    assert len(reports) == 1
    assert any("splits it into 3 tracks" in w for w in reports[0].warnings)
    assert not (image_album / "output").exists()
