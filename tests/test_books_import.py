"""Books import end to end on real (tiny) MP3s: probe, plan, write, duplicates, and the CLI."""

from __future__ import annotations

from pathlib import Path

import pytest
from mutagen.id3 import ID3
from typer.testing import CliRunner

from maneki.books.catalog import BookCatalog
from maneki.books.models import CatalogBook, CatalogChapters, Chapter, ChapterSource
from maneki.books.pipeline import format_duration, import_books, separate_books
from maneki.books.probe import discover, load_book, natural_key, probe_file
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
    make_silent_mp3(library / "Stephen King" / "It" / "It.mp3", 1.0)
    [report] = import_books(inbox, library, catalog=None, remove_source=True)
    assert report.status == "skip"
    assert "already in the library" in report.notes[-1]
    assert (inbox / "Stephen King - It.mp3").exists()  # a skip never costs the source


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


# --- collections: one folder is not always one book ----------------------------


def _folder(root: Path, name: str, files: dict[str, float]) -> Path:
    for filename, seconds in files.items():
        make_silent_mp3(root / name / filename, seconds)
    return root / name


def test_a_collection_of_folders_yields_a_book_each(tmp_path: Path) -> None:
    """`Harry Potter 1-7/Book 01 .../*.mp3`: each folder inside is its own book."""
    for book in ("Book 01 - Philosopher's Stone", "Book 02 - Chamber of Secrets"):
        make_silent_mp3(tmp_path / "Harry Potter 1-7" / book / "01.mp3", 0.5)
    (tmp_path / "Harry Potter 1-7" / "Info.txt").write_text("rip notes")
    assert [p.name for p in discover(tmp_path)] == ["Book 01 - Philosopher's Stone", "Book 02 - Chamber of Secrets"]


def test_a_collection_of_collections_is_followed_down(tmp_path: Path) -> None:
    """`Dune Collection/07 - Great Schools/01. Sisterhood/` is still one book."""
    make_silent_mp3(tmp_path / "Dune Collection" / "07 - Great Schools" / "01. Sisterhood" / "01.mp3", 0.5)
    assert [p.name for p in discover(tmp_path)] == ["01. Sisterhood"]


def test_disc_folders_stay_one_book(tmp_path: Path) -> None:
    for disc in ("CD1", "CD2"):
        make_silent_mp3(tmp_path / "The Martian" / disc / "01.mp3", 0.5)
    assert [p.name for p in discover(tmp_path)] == ["The Martian"]


def test_parts_of_one_recording_stay_one_book(tmp_path: Path) -> None:
    """`Pt 01 Of 66` beside `Pt 02 Of 66`: one name, one book."""
    folder = _folder(
        tmp_path,
        "Hitchhikers Guide",
        {"001 - Hitchhikers Guide Pt 01 Of 66.mp3": 1.0, "002 - Hitchhikers Guide Pt 02 Of 66.mp3": 1.0},
    )
    assert [b.path for b in separate_books(load_book(folder))] == [folder]


def test_files_named_only_by_number_stay_one_book(tmp_path: Path) -> None:
    """`1-01 1a` beside `1-02 1b`: numbering, not titles."""
    folder = _folder(tmp_path, "Foundation", {"1-01 1a.mp3": 1.0, "1-02 1b.mp3": 1.0})
    assert [b.path for b in separate_books(load_book(folder))] == [folder]


def test_short_files_with_different_names_stay_one_book(tmp_path: Path) -> None:
    """Chapters titled by name are still one book: they run minutes, not hours."""
    folder = _folder(tmp_path, "Some Book", {"01 - The Beginning.mp3": 1.0, "02 - The Middle.mp3": 1.0})
    assert [b.path for b in separate_books(load_book(folder))] == [folder]


def test_book_length_files_with_different_names_are_separate_books(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`01. Dune.m4b` beside `02. Dune Messiah.m4b`: six novels in one folder, not one book."""
    folder = _folder(tmp_path, "Dune Saga", {"01. Dune.mp3": 1.0, "02. Dune Messiah.mp3": 1.0})
    book = load_book(folder)
    # Stand the test files in for book-length recordings.
    long_files = [f.model_copy(update={"duration_s": 8 * 3600}) for f in book.files]
    separated = separate_books(book.model_copy(update={"files": long_files}))
    assert [b.path.name for b in separated] == ["01. Dune.mp3", "02. Dune Messiah.mp3"]


def test_remove_source_takes_the_emptied_collection_folder_with_it(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Orwell Collection" / "Animal Farm" / "01.mp3", 1.0)
    (inbox / "Orwell Collection" / "cover.jpg").write_bytes(jpeg_bytes(80))

    [report] = import_books(inbox, library, catalog=None, remove_source=True)

    assert report.status == "ok"
    assert not (inbox / "Orwell Collection").exists()  # the rip's leftovers went with it
    assert inbox.is_dir()


def test_remove_source_keeps_a_collection_with_books_still_in_it(tmp_path: Path) -> None:
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Orwell Collection" / "Animal Farm" / "01.mp3", 1.0)
    make_silent_mp3(inbox / "Orwell Collection" / "1984" / "01.mp3", 1.0)
    # Already imported, so this one is skipped and its source stays.
    make_silent_mp3(library / "Unknown Author" / "1984" / "1984.mp3", 1.0)

    import_books(inbox, library, catalog=None, remove_source=True)

    assert (inbox / "Orwell Collection" / "1984").exists()
    assert not (inbox / "Orwell Collection" / "Animal Farm").exists()


def test_a_chapterised_book_stays_one_book(tmp_path: Path) -> None:
    """Harry Potter 5 arrives as 38 chapter files, some of them long. Still one book."""
    files = {f"Chapter {n:02d} - Something Happens.mp3": 1.0 for n in range(1, 39)}
    folder = _folder(tmp_path, "Order of the Phoenix", files)
    book = load_book(folder)
    long_files = [f.model_copy(update={"duration_s": 50 * 60}) for f in book.files]
    assert [b.path for b in separate_books(book.model_copy(update={"files": long_files}))] == [folder]


def test_a_few_long_differently_named_files_still_split(tmp_path: Path) -> None:
    """Six novels in one folder are six books; the chapter rules must not swallow them."""
    folder = _folder(tmp_path, "Dune Saga", {"01. Dune.mp3": 1.0, "02. Dune Messiah.mp3": 1.0})
    book = load_book(folder)
    long_files = [f.model_copy(update={"duration_s": 8 * 3600}) for f in book.files]
    assert len(separate_books(book.model_copy(update={"files": long_files}))) == 2


def test_an_m4b_that_already_has_tags_can_be_written(tmp_path: Path) -> None:
    """Every m4b from a shop arrives tagged; adding a second tag set is an error."""
    import subprocess

    from mutagen.mp4 import MP4

    src = tmp_path / "in" / "book.m4a"
    src.parent.mkdir(parents=True)
    make_silent_mp3(tmp_path / "in" / "seed.mp3", 1.0)
    subprocess.run(
        ["ffmpeg", "-y", "-nostdin", "-loglevel", "error", "-i", str(tmp_path / "in" / "seed.mp3")]
        + ["-c:a", "aac", "-metadata", "album=Old Album", str(src)],
        check=True,
    )
    assert MP4(src).tags is not None  # the fixture really is tagged

    tags = BookTags(title="Atomic Habits", author="James Clear", narrator="James Clear")
    [out] = write_book(tmp_path / "lib" / "James Clear" / "Atomic Habits", [src], tags, [])

    written = MP4(out)
    assert written.tags is not None
    assert written.tags["\xa9alb"] == ["Atomic Habits"]
    assert written.tags["stik"] == [2]  # marked as an audiobook


def test_a_destination_with_no_audio_is_not_a_book(tmp_path: Path) -> None:
    """A failed write leaves an empty folder; skipping on it loses the book for good.

    A drive that goes away mid-copy leaves the destination behind and takes
    the cleanup with it. Every later run then read that folder as "already in
    the library", and a source deleted on that word is gone.
    """
    inbox, library = tmp_path / "inbox", tmp_path / "Audiobooks"
    make_silent_mp3(inbox / "Stephen King - It.mp3", 1.0)
    wreckage = library / "Stephen King" / "It"
    wreckage.mkdir(parents=True)
    (wreckage / "cover.jpg").write_bytes(jpeg_bytes(80))

    [report] = import_books(inbox, library, catalog=None, remove_source=True)

    assert report.status == "ok"
    assert any(p.suffix == ".mp3" for p in wreckage.iterdir())
    assert not (inbox / "Stephen King - It.mp3").exists()
