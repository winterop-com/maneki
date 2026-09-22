"""Import every book waiting in an inbox folder into the library.

For each book: probe the files, guess what it is from its tags or name,
look it up in the catalog, pick its chapters, then copy and tag it into
`<library>/<Author>/<Title>/`. Chapters come from, best first:

1. the file itself (m4b chapters, ID3 `CHAP`, Vorbis `CHAPTERxxx`);
2. the catalog, when this recording's length matches an edition's;
3. one chapter per file, for a book split into several files.

Two inbox copies of the same book import once: the copy whose chapters are
known wins, so a rip that matches the Audible edition beats one that does
not. A book already in the library is left alone unless `overwrite` is set; a
destination holding no audio is wreckage from a failed write, not a book,
and is written over.
"""

from __future__ import annotations

import io
import re
import shutil
from collections.abc import Callable
from pathlib import Path

from PIL import Image
from pydantic import BaseModel

from maneki.audio.cover import DEFAULT_MAX_EDGE, CoverCandidate, CoverSource, normalize
from maneki.books.catalog import BookCatalog, align_chapters, choose, runtime_matches
from maneki.books.library import file_chapters, majority
from maneki.books.models import CatalogBook, Chapter, ChapterSource, NameGuess, SourceBook
from maneki.books.names import clean_title, guess_from_name
from maneki.books.probe import ProbeError, discover, is_audio, load_book
from maneki.books.write import BookTags, book_dir, part_title, write_book, writes_chapters

UNKNOWN_AUTHOR = "Unknown Author"
# A file at least this long, in a folder of files with unrelated names, is a
# book of its own rather than a part: chapters run minutes, books run hours.
SPLIT_MIN_DURATION_S = 45 * 60
# A flat folder holding more files than this is a book in pieces, not that many
# whole books side by side. A chapterised book runs to dozens of files, each
# named for its chapter and some of them long.
SPLIT_MAX_FILES = 12
# Names that say "part of something" outright.
_CHAPTER_NAME_RE = re.compile(r"\b(?:chapter|chap|part|pt|track|disc|cd|side)\b[\s._-]*\d+", re.IGNORECASE)
_CHAPTER_NAME_SHARE = 0.8
# A name that is nothing but numbering once the digits come off ("1-01 1a").
_NAME_RESIDUE_MIN = 3
_NUMBERS_RE = re.compile(r"\d+")
_NOT_WORD_RE = re.compile(r"[^a-z]+")
# Editions whose chapter lists are fetched when looking for one that lines up.
_MAX_CHAPTER_LOOKUPS = 3
_FOLDER_COVER_NAMES = ("cover", "folder", "front")
_IMAGE_SUFFIXES = frozenset({".jpg", ".jpeg", ".png"})


class BookReport(BaseModel):
    """What happened to one inbox book. `status` is `ok`, `plan` (dry run), `skip` or `fail`."""

    source: Path
    status: str
    author: str = ""
    title: str = ""
    narrator: str | None = None
    year: str | None = None
    duration_s: float = 0.0
    files: int = 0
    chapters: int = 0
    chapter_source: ChapterSource = ChapterSource.NONE
    cover: str = "none"
    matched: str | None = None
    dest: Path | None = None
    notes: list[str] = []


class BookPlan(BaseModel):
    """One inbox book, identified, before anything is written."""

    book: SourceBook
    tags: BookTags
    chapters: list[Chapter]
    chapter_source: ChapterSource
    match: CatalogBook | None
    dest: Path
    notes: list[str]


def import_books(
    inbox: Path,
    library: Path,
    *,
    catalog: BookCatalog | None,
    dry_run: bool = False,
    overwrite: bool = False,
    remove_source: bool = False,
    cover_max_edge: int = DEFAULT_MAX_EDGE,
    on_book: Callable[[Path], None] | None = None,
) -> list[BookReport]:
    """Import every book in `inbox` into `library`. `catalog=None` imports offline, by name only."""
    reports: dict[Path, BookReport] = {}
    plans: list[BookPlan] = []
    order: list[Path] = []
    for path in discover(inbox):
        order.append(path)
        if on_book is not None:
            on_book(path)
        try:
            book = load_book(path)
        except ProbeError as exc:
            reports[path] = BookReport(source=path, status="fail", notes=[str(exc)])
            continue
        for one in separate_books(book):
            order.append(one.path)
            plans.append(plan_book(one, library, catalog=catalog))
        order.remove(path)

    kept, dropped = _resolve_duplicates(plans)
    for plan, winner in dropped:
        reports[plan.book.path] = _report(plan, "skip", [f"another copy is imported instead: {winner}"])
    for plan in kept:
        reports[plan.book.path] = _run(
            plan,
            catalog=catalog,
            dry_run=dry_run,
            overwrite=overwrite,
            remove_source=remove_source,
            inbox=inbox,
            cover_max_edge=cover_max_edge,
        )
    return [reports[path] for path in order if path in reports]


def plan_book(book: SourceBook, library: Path, *, catalog: BookCatalog | None) -> BookPlan:
    """Identify one book and decide its chapters and destination. Writes nothing."""
    guess = guess_book(book)
    duration = book.duration_s
    notes: list[str] = []
    chapters, chapter_source = file_chapters(book)

    match: CatalogBook | None = None
    if catalog is not None:
        candidates = choose(guess, duration, catalog.audible_search(guess.terms))
        if not candidates:
            candidates = choose(guess, duration, catalog.itunes_search(guess.terms))
        if candidates:
            match = candidates[0]
            if chapter_source is ChapterSource.NONE:
                match, chapters, chapter_source, note = _catalog_chapters(catalog, candidates, book)
                if note:
                    notes.append(note)
            if match.source == "audible":
                match = catalog.details(match)
        else:
            notes.append("no catalog match; named from the file name")

    author = (match.authors[0] if match and match.authors else guess.author) or UNKNOWN_AUTHOR
    title = (match.title if match else guess.title) or book.name
    # Narrator and ASIN describe one edition's recording; a rip whose length
    # matches no edition may be another recording of the same book.
    same_recording = match is not None and (chapter_source is ChapterSource.CATALOG or runtime_matches(match, duration))
    narrator = ", ".join(match.narrators) if match and same_recording and match.narrators else guess.narrator
    if author == UNKNOWN_AUTHOR:
        notes.append("author unknown")
    tags = BookTags(
        title=title,
        author=author,
        narrator=narrator,
        year=(match.year if match else None) or guess.year,
        description=match.description if match else None,
        asin=match.asin if match and same_recording else None,
        series=match.series if match else None,
        series_position=match.series_position if match else None,
    )
    return BookPlan(
        book=book,
        tags=tags,
        chapters=chapters,
        chapter_source=chapter_source,
        match=match,
        dest=book_dir(library, author, title),
        notes=notes,
    )


def separate_books(book: SourceBook) -> list[SourceBook]:
    """`book`, or one book per file when a folder turned out to hold several.

    A collection sometimes arrives as one folder of whole books
    (`01. Dune.m4b` beside `02. Dune Messiah.m4b`) rather than as a folder
    per book. Everything has to point that way before they are split: a
    handful of files rather than dozens, no name saying "chapter" or "part",
    names that differ once their numbering is stripped, and files that run
    as long as books do. A chapterised book fails the first two, a book in
    numbered parts the third, and a folder of short pieces the fourth.
    """
    if book.path.is_file() or len(book.files) < 2:
        return [book]
    # Files spread across subfolders are the discs of one recording.
    if any(f.path.parent != book.path for f in book.files):
        return [book]
    if len(book.files) > SPLIT_MAX_FILES:
        return [book]
    named_parts = sum(bool(_CHAPTER_NAME_RE.search(f.path.stem)) for f in book.files)
    if named_parts >= len(book.files) * _CHAPTER_NAME_SHARE:
        return [book]
    residues = [_name_residue(f.path.stem) for f in book.files]
    if len(set(residues)) == 1 or all(len(r) < _NAME_RESIDUE_MIN for r in residues):
        return [book]
    lengths = sorted(f.duration_s for f in book.files)
    median = lengths[len(lengths) // 2]
    if median < SPLIT_MIN_DURATION_S:
        return [book]
    return [SourceBook(path=f.path, files=[f]) for f in book.files]


def _name_residue(stem: str) -> str:
    """What is left of a file name once its numbering and punctuation come off."""
    return _NOT_WORD_RE.sub("", _NUMBERS_RE.sub("", stem).casefold())


def guess_book(book: SourceBook) -> NameGuess:
    """What this book is, from its tags and its name.

    A book that is one file says what it is in that file's title tag. Its
    album tag often names the collection it was ripped from ("The New Dune
    Chronicles" across nine novels), so a differing title tag wins: without
    that, nine books identify as one and eight are dropped as copies.
    """
    if book.path.is_file():
        return _guess_one_file(book)
    album = majority(f.tags.get("album") for f in book.files)
    author = majority(f.tags.get("album_artist") or f.tags.get("artist") for f in book.files)
    if album and author:
        title = clean_title(album)
        date = majority(f.tags.get("date") for f in book.files)
        return NameGuess(
            terms=f"{author} {title}",
            title=title,
            author=author,
            narrator=majority(f.tags.get("composer") for f in book.files),
            year=date[:4] if date and date[:4].isdigit() else None,
        )
    return guess_from_name(book.name)


def _guess_one_file(book: SourceBook) -> NameGuess:
    """Identify a book that arrived as a single file."""
    tags = book.files[0].tags
    from_name = guess_from_name(part_title(book.path.name))
    title_tag = clean_title(tags.get("title", ""))
    album_tag = clean_title(tags.get("album", ""))
    # The album names the collection when the title disagrees with it.
    title = (title_tag if title_tag and title_tag != album_tag else album_tag) or from_name.title or book.name
    author = tags.get("album_artist") or tags.get("artist") or from_name.author
    if not author:
        # The folder a loose file sits in usually names its author.
        author = guess_from_name(book.path.parent.name).author
    date = tags.get("date")
    return NameGuess(
        terms=" ".join(p for p in (author, title) if p) or book.name,
        title=title,
        author=author,
        narrator=tags.get("composer") or from_name.narrator,
        year=(date[:4] if date and date[:4].isdigit() else None) or from_name.year,
    )


def format_duration(seconds: float) -> str:
    """`20h 02m` for a book, `42m` under an hour."""
    minutes = round(seconds / 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes:02d}m" if hours else f"{minutes}m"


def _catalog_chapters(
    catalog: BookCatalog, candidates: list[CatalogBook], book: SourceBook
) -> tuple[CatalogBook, list[Chapter], ChapterSource, str | None]:
    """The first edition whose chapter list lines up with this recording, with those chapters."""
    duration = book.duration_s
    for edition in [c for c in candidates if c.asin and runtime_matches(c, duration)][:_MAX_CHAPTER_LOOKUPS]:
        assert edition.asin is not None
        listed = catalog.chapters(edition.asin)
        aligned = align_chapters(listed, duration) if listed else None
        if aligned:
            if not writes_chapters(book.files[0].path):
                note = f"catalog chapters found, but they cannot be written into {book.files[0].path.suffix} yet"
                return edition, [], ChapterSource.NONE, note
            return edition, aligned, ChapterSource.CATALOG, None
    runtimes = ", ".join(format_duration(c.runtime_s) for c in candidates[:3] if c.runtime_s)
    note = f"no edition's chapters match this recording ({format_duration(duration)}"
    note += f"; catalog: {runtimes})" if runtimes else ")"
    return candidates[0], [], ChapterSource.NONE, note


def _resolve_duplicates(plans: list[BookPlan]) -> tuple[list[BookPlan], list[tuple[BookPlan, str]]]:
    """Keep one plan per destination: known chapters first, then a runtime match, then bit rate."""
    groups: dict[str, list[int]] = {}
    for index, plan in enumerate(plans):
        groups.setdefault(str(plan.dest).casefold(), []).append(index)
    kept: list[int] = []
    dropped: list[tuple[BookPlan, str]] = []
    for group in groups.values():
        ranked = sorted(group, key=lambda i: _rank(plans[i]), reverse=True)
        kept.append(ranked[0])
        dropped.extend((plans[i], plans[ranked[0]].book.path.name) for i in ranked[1:])
    return [plans[i] for i in sorted(kept)], dropped


def _rank(plan: BookPlan) -> tuple[bool, bool, int, int]:
    rates = [f.bit_rate for f in plan.book.files if f.bit_rate]
    return (
        plan.chapter_source in (ChapterSource.CATALOG, ChapterSource.FILE),
        bool(plan.match and runtime_matches(plan.match, plan.book.duration_s)),
        len(plan.chapters),
        round(sum(rates) / len(rates)) if rates else 0,
    )


def _run(
    plan: BookPlan,
    *,
    catalog: BookCatalog | None,
    dry_run: bool,
    overwrite: bool,
    remove_source: bool,
    inbox: Path,
    cover_max_edge: int,
) -> BookReport:
    if _holds_audio(plan.dest) and not overwrite:
        return _report(plan, "skip", [f"already in the library at {plan.dest}"])
    if plan.dest.exists():
        # A folder with no audio in it is the wreckage of a write that failed
        # part way (a drive that went away mid-copy leaves one behind, since
        # the cleanup cannot reach it either). Treating that as "already
        # imported" is how a book gets skipped for good and then dropped with
        # its source, so it is cleared and the book written again.
        shutil.rmtree(plan.dest, ignore_errors=True)
    if dry_run:
        cover = "online" if plan.match and plan.match.cover_url else _local_cover_label(plan.book)
        return _report(plan, "plan", [], cover=cover)
    try:
        cover_bytes, cover_label = _cover(plan, catalog, cover_max_edge)
        if plan.dest.exists():
            shutil.rmtree(plan.dest)
        tags = plan.tags.model_copy(update={"cover_jpeg": cover_bytes})
        write_book(plan.dest, [f.path for f in plan.book.files], tags, plan.chapters)
    except Exception as exc:  # noqa: BLE001 - one bad book must not stop the batch
        return _report(plan, "fail", [f"{type(exc).__name__}: {exc}"])
    if remove_source and plan.book.path != inbox:
        if plan.book.path.is_dir():
            shutil.rmtree(plan.book.path)
        else:
            plan.book.path.unlink()
        _prune(plan.book.path.parent, inbox)
    return _report(plan, "ok", [], cover=cover_label)


def _holds_audio(folder: Path) -> bool:
    """True when `folder` actually has a book in it, not just a cover or nothing."""
    return folder.is_dir() and any(is_audio(p) for p in folder.rglob("*"))


def _prune(folder: Path, inbox: Path) -> None:
    """Drop a collection folder the imported books have emptied.

    A collection arrives as one folder of books; taking its books leaves the
    folder behind with the rip's cover scan and notes in it. A folder with no
    audio left anywhere beneath it holds nothing worth keeping, so it goes,
    and its parent is considered in turn. The inbox itself always stays.
    """
    while folder != inbox and inbox in folder.parents:
        if any(is_audio(p) for p in folder.rglob("*")):
            return
        shutil.rmtree(folder, ignore_errors=True)
        folder = folder.parent


def _report(plan: BookPlan, status: str, extra: list[str], *, cover: str = "none") -> BookReport:
    return BookReport(
        source=plan.book.path,
        status=status,
        author=plan.tags.author,
        title=plan.tags.title,
        narrator=plan.tags.narrator,
        year=plan.tags.year,
        duration_s=plan.book.duration_s,
        files=len(plan.book.files),
        chapters=len(plan.chapters),
        chapter_source=plan.chapter_source,
        cover=cover,
        matched=f"{plan.match.source} {plan.match.asin or ''}".strip() if plan.match else None,
        dest=plan.dest,
        notes=plan.notes + extra,
    )


def _cover(plan: BookPlan, catalog: BookCatalog | None, max_edge: int) -> tuple[bytes | None, str]:
    """The best cover as JPEG bytes: the catalog's, then a folder image, then one embedded in the audio."""
    candidates: list[CoverCandidate] = []
    if catalog is not None and plan.match and plan.match.cover_url:
        data = catalog.fetch_image(plan.match.cover_url)
        if data:
            candidates.append(CoverCandidate(source=CoverSource.ONLINE, data=data))
    if not candidates:
        candidates.extend(_folder_covers(plan.book))
    if not candidates:
        candidates.extend(_embedded_cover(plan.book))
    for candidate in candidates:
        try:
            cover = normalize(candidate, max_edge=max_edge)
        except OSError:
            continue
        data = cover.data if cover.mime == "image/jpeg" else _to_jpeg(cover.data)
        return data, f"{cover.width}x{cover.height} ({candidate.source.value})"
    return None, "none"


def _folder_covers(book: SourceBook) -> list[CoverCandidate]:
    if not book.path.is_dir():
        return []
    images = [p for p in book.path.iterdir() if p.suffix.lower() in _IMAGE_SUFFIXES and not p.name.startswith(".")]
    images.sort(key=lambda p: (p.stem.casefold() not in _FOLDER_COVER_NAMES, -p.stat().st_size))
    return [CoverCandidate(source=CoverSource.FOLDER, data=p.read_bytes(), label=p.name) for p in images[:1]]


def _embedded_cover(book: SourceBook) -> list[CoverCandidate]:
    from maneki.audio.metadata import read_source

    try:
        source = read_source(book.files[0].path)
    except Exception:  # noqa: BLE001 - an unreadable tag just means no embedded cover
        return []
    if not source.embedded_picture:
        return []
    return [CoverCandidate(source=CoverSource.EMBEDDED, data=source.embedded_picture)]


def _local_cover_label(book: SourceBook) -> str:
    if _folder_covers(book):
        return "folder"
    return "none"


def _to_jpeg(data: bytes) -> bytes:
    image = Image.open(io.BytesIO(data))
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()
