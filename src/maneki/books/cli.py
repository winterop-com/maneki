"""`maneki books`: import audiobook rips from an inbox folder into the library."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from maneki.audio.cover import DEFAULT_MAX_EDGE
from maneki.books.pipeline import BookReport, format_duration, import_books

app = typer.Typer(
    name="books",
    no_args_is_help=True,
    rich_markup_mode="rich",
    help="Audiobooks: import rips into `<library>/<Author>/<Title>/` with chapters, tags and a cover.",
)

_STATUS_STYLE = {"ok": "[green]ok[/green]", "plan": "[cyan]plan[/cyan]", "skip": "[yellow]skip[/yellow]"}


@app.command("import")
def import_cmd(
    inbox: Annotated[
        Path,
        typer.Argument(
            exists=True, file_okay=False, resolve_path=True, help="Folder of raw books: one folder or file each."
        ),
    ],
    library: Annotated[
        Path,
        typer.Argument(resolve_path=True, help="The audiobook library, e.g. `/Volumes/T9/Media/Audiobooks`."),
    ],
    dry_run: Annotated[bool, typer.Option("--dry-run", help="Identify and plan, but write nothing.")] = False,
    enrich: Annotated[
        bool | None,
        typer.Option(
            "--enrich/--no-enrich",
            help="Look books up on Audible and iTunes. Default: on when Audible is reachable.",
        ),
    ] = None,
    overwrite: Annotated[
        bool, typer.Option("--overwrite", help="Replace a book that is already in the library.")
    ] = False,
    remove_source: Annotated[
        bool, typer.Option("--remove-source", help="Delete each book from the inbox once it is imported.")
    ] = False,
    cover_max_edge: Annotated[
        int, typer.Option("--cover-max-edge", min=128, help="Longest cover edge, in pixels.")
    ] = DEFAULT_MAX_EDGE,
) -> None:
    """Identify every book in INBOX, then copy and tag it into LIBRARY. The audio is never re-encoded."""
    from maneki.audio.enrich._http import is_online
    from maneki.books.catalog import BookCatalog

    console = Console()
    online = enrich if enrich is not None else is_online(host="api.audible.com")
    if enrich is None and not online:
        console.print("[dim]offline: naming books from their files (use `--enrich` to force a lookup)[/dim]")
    catalog = BookCatalog() if online else None
    try:
        with console.status("Reading books") as status:
            reports = import_books(
                inbox,
                library,
                catalog=catalog,
                dry_run=dry_run,
                overwrite=overwrite,
                remove_source=remove_source,
                cover_max_edge=cover_max_edge,
                on_book=lambda path: status.update(f"Reading {path.name}"),
            )
    finally:
        if catalog is not None:
            catalog.close()
    if not reports:
        console.print(f"[yellow]No books in {inbox}")
        return
    console.print(_summary(reports, dry_run=dry_run))
    if any(r.status == "fail" for r in reports):
        raise typer.Exit(code=1)


def _summary(reports: list[BookReport], *, dry_run: bool) -> Table:
    table = Table(title="Books import - plan" if dry_run else "Books import", show_lines=False)
    for column in ("Status", "Author", "Title", "Narrator", "Length", "Chapters", "Cover", "Notes"):
        table.add_column(column, justify="right" if column in ("Length", "Chapters") else "left")
    for r in reports:
        chapters = f"{r.chapters} ({r.chapter_source.value})" if r.chapters else "none"
        notes = "; ".join(r.notes)
        if r.status == "fail":
            notes = f"[red]{notes}[/red]"
        table.add_row(
            _STATUS_STYLE.get(r.status, "[red]fail[/red]"),
            r.author or r.source.name,
            r.title,
            r.narrator or "",
            format_duration(r.duration_s) if r.duration_s else "",
            chapters,
            r.cover,
            notes,
        )
    return table
