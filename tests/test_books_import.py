"""Books import end to end on real (tiny) MP3s: probe, plan, write, duplicates, and the CLI."""

from __future__ import annotations

from pathlib import Path

import pytest
from mutagen.id3 import ID3
from typer.testing import CliRunner

from maneki.books.catalog import BookCatalog
from maneki.books.models import CatalogBook, CatalogChapters, Chapter, ChapterSource
from maneki.books.pipeline import format_duration, import_books
from maneki.books.probe import discover, natural_key, probe_file
from maneki.books.write import BookTags, file_names, write_book
from maneki.cli import app
from tests.conftest import audio_md5, jpeg_bytes, make_silent_mp3, require_ffmpeg


@pytest.fixture(autouse=True)
def _need_ffmpeg() -> None:
    require_ffmpeg()


class _FakeCatalog(BookCatalog):
    """The catalog's surface with canned answers and no network."""

    def __init__(self, editions: list[CatalogBook], chapters: dict[str, CatalogChapters]) -> None:
        self.editions = editions
        self.listings = chapters
        self.image = jpeg_bytes()

    def audible_search(self, terms: str) -> list[CatalogBook]:
        return list(self.editions)

    def itunes_search(self, terms: str) -> list[CatalogBook]:
        return []

    def chapters(self, asin: str) -> CatalogChapters | None:
        return self.listings.get(asin)

    def details(self, book: CatalogBook) -> CatalogBook:
        return book

    def fetch_image(self, url: str) -> bytes | None:
        return self.image

    def close(self) -> None:
        pass


# --- probe ---------------------------------------------------------------------


def test_discover_finds_folders_and_loose_files_and_skips_dot_files(tmp_path: Path) -> None:
    make_silent_mp3(tmp_path / "Book A" / "01.mp3", 0.5)
    make_silent_mp3(tmp_path / "Book B.mp3", 0.5)
    (tmp_path / "notes").mkdir()
    (tmp_path / "._Book C.mp3").write_bytes(b"\x00" * 16)
    assert [p.name for p in discover(tmp_path)] == ["Book A", "Book B.mp3"]


def test_natural_order_puts_part_2_before_part_10() -> None:
    names = [Path("Part 10.mp3"), Path("Part 2.mp3"), Path("Part 1.mp3")]
    assert [p.name for p in sorted(names, key=natural_key)] == ["Part 1.mp3", "Part 2.mp3", "Part 10.mp3"]


def test_probe_reads_length_and_tags(tmp_path: Path) -> None:
    probed = probe_file(make_silent_mp3(tmp_path / "a.mp3", 2.0, title="Hello"))
    assert probed.duration_s == pytest.approx(2.0, abs=0.1)
    assert probed.tags["title"] == "Hello"
    assert probed.chapters == []


# --- write ---------------------------------------------------------------------


def test_write_book_tags_and_chapters_without_touching_the_audio(tmp_path: Path) -> None:
    src = make_silent_mp3(tmp_path / "in" / "rip.mp3", 6.0, title="junk")
    before = audio_md5(src)
    chapters = [
        Chapter(title="Opening Credits", start_s=0.0, end_s=2.0),
        Chapter(title="1. The Characters of the Story", start_s=2.0, end_s=6.0),
    ]
    tags = BookTags(
        title="Thinking, Fast and Slow",
        author="Daniel Kahneman",
        narrator="Patrick Egan",
        year="2011",
        asin="B005TKKCWC",
        cover_jpeg=jpeg_bytes(),
    )
    [out] = write_book(tmp_path / "lib" / "Daniel Kahneman" / "Thinking, Fast and Slow", [src], tags, chapters)

    assert out.name == "Thinking, Fast and Slow.mp3"
    assert audio_md5(out) == before
    probed = probe_file(out)
    assert [(c.title, c.start_s) for c in probed.chapters] == [
        ("Opening Credits", 0.0),
        ("1. The Characters of the Story", 2.0),
    ]
    id3 = ID3(out)
    assert str(id3["TALB"]) == "Thinking, Fast and Slow"
    assert str(id3["TPE1"]) == "Daniel Kahneman"
    assert str(id3["TCOM"]) == "Patrick Egan"
    assert str(id3["TCON"]) == "Audiobook"
    assert str(id3["TXXX:ASIN"]) == "B005TKKCWC"
    assert id3.getall("APIC")
    assert (out.parent / "cover.jpg").exists()
    assert audio_md5(src) == before  # the source is only read


def test_multi_file_names_drop_the_rip_numbering() -> None:
    names = file_names("Book", [Path("CD1 - Track 01.mp3"), Path("02 Chapter Two.mp3"), Path("03.mp3")])
    assert names == ["01 - Track 01.mp3", "02 - Chapter Two.mp3", "03 - Part 3.mp3"]


# --- import --------------------------------------------------------------------


def _edition(asin: str, runtime_s: float) -> CatalogBook:
    return CatalogBook(
        source="audible",
        asin=asin,
        title="Thinking, Fast and Slow",
        authors=["Daniel Kahneman"],
        narrators=["Patrick Egan"],
        year="2011",
        runtime_s=runtime_s,
        cover_url="https://example.invalid/cover.jpg",
    )


def _listing(runtime_s: float) -> CatalogChapters:
    return CatalogChapters(
        runtime_s=runtime_s,
        chapters=[
            Chapter(title="Opening Credits", start_s=0.0, end_s=2.0),
            Chapter(title="Part I. Two Systems", start_s=2.0, end_s=runtime_s),
        ],
    )


def test_the_copy_matching_the_edition_wins_and_gets_its_chapters(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Kahneman Daniel - Thinking, Fast and Slow(Egan Patrick) - 2011(80bps).mp3", 6.0)
    make_silent_mp3(inbox / "Thinking, Fast and Slow - Daniel Kahneman.mp3", 9.0)
    duration = probe_file(next(inbox.glob("Kahneman*"))).duration_s
    catalog = _FakeCatalog([_edition("B005TKKCWC", duration)], {"B005TKKCWC": _listing(duration)})

    reports = import_books(inbox, library, catalog=catalog)

    by_name = {r.source.name: r for r in reports}
    kept = by_name["Kahneman Daniel - Thinking, Fast and Slow(Egan Patrick) - 2011(80bps).mp3"]
    dropped = by_name["Thinking, Fast and Slow - Daniel Kahneman.mp3"]
    assert kept.status == "ok"
    assert (kept.chapters, kept.chapter_source) == (2, ChapterSource.CATALOG)
    assert kept.narrator == "Patrick Egan"
    assert kept.cover.endswith("(online)")
    assert dropped.status == "skip"
    assert "another copy is imported instead" in dropped.notes[-1]
    book = library / "Daniel Kahneman" / "Thinking, Fast and Slow"
    assert sorted(p.name for p in book.iterdir()) == ["Thinking, Fast and Slow.mp3", "cover.jpg"]
    assert len(probe_file(book / "Thinking, Fast and Slow.mp3").chapters) == 2


def test_a_recording_no_edition_matches_keeps_the_book_but_not_the_edition(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Thinking, Fast and Slow - Daniel Kahneman.mp3", 3.0)
    catalog = _FakeCatalog([_edition("B005TKKCWC", 1000.0)], {"B005TKKCWC": _listing(1000.0)})

    [report] = import_books(inbox, library, catalog=catalog)

    assert report.status == "ok"
    assert (report.author, report.title) == ("Daniel Kahneman", "Thinking, Fast and Slow")
    assert report.chapters == 0
    assert report.narrator is None
    assert "no edition's chapters match" in report.notes[0]
    written = ID3(library / "Daniel Kahneman" / "Thinking, Fast and Slow" / "Thinking, Fast and Slow.mp3")
    assert not written.getall("TXXX:ASIN")


def test_offline_import_names_the_book_from_its_file(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Stephen King - It (Unabridged) [MP3 64kbps].mp3", 1.0)
    [report] = import_books(inbox, library, catalog=None)
    assert report.status == "ok"
    assert report.dest == library / "Stephen King" / "It"


def test_a_folder_of_parts_gets_one_chapter_per_file(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    for n in (1, 2, 10):
        make_silent_mp3(inbox / "Andy Weir - Project Hail Mary" / f"Part {n}.mp3", 1.0)
    [report] = import_books(inbox, library, catalog=None)
    assert (report.chapters, report.chapter_source) == (3, ChapterSource.FILES)
    names = sorted(p.name for p in (library / "Andy Weir" / "Project Hail Mary").iterdir())
    assert names == ["01 - Part 1.mp3", "02 - Part 2.mp3", "03 - Part 10.mp3"]


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Stephen King - It.mp3", 1.0)
    [report] = import_books(inbox, library, catalog=None, dry_run=True)
    assert report.status == "plan"
    assert not library.exists()


def test_a_book_already_in_the_library_is_left_alone(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Stephen King - It.mp3", 1.0)
    (library / "Stephen King" / "It").mkdir(parents=True)
    [report] = import_books(inbox, library, catalog=None)
    assert report.status == "skip"
    assert "already in the library" in report.notes[-1]


def test_remove_source_deletes_an_imported_book(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    src = make_silent_mp3(inbox / "Stephen King - It.mp3", 1.0)
    [report] = import_books(inbox, library, catalog=None, remove_source=True)
    assert report.status == "ok"
    assert not src.exists()
    assert inbox.is_dir()


def test_cli_dry_run_offline(tmp_path: Path) -> None:
    inbox = tmp_path / "inbox"
    make_silent_mp3(inbox / "Stephen King - It.mp3", 1.0)
    result = CliRunner().invoke(
        app, ["books", "import", str(inbox), str(tmp_path / "Audiobooks"), "--dry-run", "--no-enrich"]
    )
    assert result.exit_code == 0, result.output
    assert "Stephen King" in result.output
    assert not (tmp_path / "Audiobooks").exists()


def test_format_duration() -> None:
    assert format_duration(72130.09) == "20h 02m"
    assert format_duration(42 * 60) == "42m"
