"""Import every book waiting in an inbox folder into the library.

For each book: probe the files, guess what it is from its tags or name,
look it up in the catalog, pick its chapters, then copy and tag it into
`<library>/<Author>/<Title>/`. Chapters come from, best first:

1. the file itself (m4b chapters, ID3 `CHAP`, Vorbis `CHAPTERxxx`);
2. the catalog, when this recording's length matches an edition's;
3. one chapter per file, for a book split into several files.

Two inbox copies of the same book import once: the copy whose chapters are
known wins, so a rip that matches the Audible edition beats one that does
not. A book already in the library is left alone unless `overwrite` is set.
"""

from __future__ import annotations

import io
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
from maneki.books.probe import ProbeError, discover, load_book
from maneki.books.write import BookTags, book_dir, write_book, writes_chapters

UNKNOWN_AUTHOR = "Unknown Author"
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
        plans.append(plan_book(book, library, catalog=catalog))

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


def guess_book(book: SourceBook) -> NameGuess:
    """The book's own tags when every file agrees on a title and an author, else its name."""
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
    if plan.dest.exists() and not overwrite:
        return _report(plan, "skip", [f"already in the library at {plan.dest}"])
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
    return _report(plan, "ok", [], cover=cover_label)


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
