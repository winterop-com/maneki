# `maneki books import`

Identifies every audiobook waiting in an inbox folder and copies it into the library as `<library>/<Author>/<Title>/`, with tags, chapters and a `cover.jpg`. The audio is copied byte for byte: only the tags change, and nothing is re-encoded.

```
uvx maneki books import INBOX LIBRARY [...flags]
```

On a combined library served from one root, the inbox is `inbox/books/` and the library is `Audiobooks/`. `maneki serve` keeps both out of the music library (see [`maneki serve`](serve-unified.md#auto-detection)):

```
maneki books import /Volumes/T9/Media/inbox/books /Volumes/T9/Media/Audiobooks --dry-run
```

## What counts as a book

Each entry directly in `INBOX` is one book:

- a folder holding audio at any depth, played in natural order (`Part 2` before `Part 10`, `CD1/` before `CD2/`);
- a single audio file.

Loose files from several books must not share one folder: with no tags, nothing tells their parts apart. Put each book in its own folder first; the folder's name can be anything.

## How a book is identified

1. **Its own tags**, when every file agrees on an album (the book's title) and an artist (its author).
2. **Otherwise its name.** Rip names follow no single convention, so the name is split on ` - ` and read both ways: `Thinking, Fast and Slow - Daniel Kahneman` and `Kahneman Daniel - Thinking, Fast and Slow(Egan Patrick) - 2011(80bps)` both work. A trailing parenthetical naming a person is taken as the narrator (`(read by Andy Serkis)`), a four-digit year as the year, and rip details (`(Unabridged)`, `[MP3 64kbps]`) are dropped.
3. **The catalog** settles it. Audible's catalog is searched with the cleaned name, and each edition is scored by how much of its title and author the name contains, so a swapped `Title - Author` still matches. Summaries and reviews of a book are never taken for the book. When Audible has nothing, the iTunes Search API is tried.

Offline, or with `--no-enrich`, the book is named from step 1 or 2 alone.

## Chapters

Chapters come from, best first:

1. **The file**: m4b / m4a chapter tracks, MP3 ID3 `CHAP` frames, Ogg and FLAC `CHAPTERxxx` comments.
2. **The catalog**, from [Audnexus](https://github.com/laxamentumtech/audnexus) (the chapter source Audiobookshelf uses), only when this recording's length matches an Audible edition's to within 3 seconds. Audible releases open with a few seconds of branding and close with a few more, which rips often drop; the match allows for either being cut. When a cut intro and a cut outro explain the length equally well, the chapters are placed at the earlier of the two positions, so a jump lands a few seconds early rather than after a chapter's first words.
3. **One chapter per file**, for a book split into several files.

A recording whose length matches no edition keeps the book's title, author and cover, but not the edition's narrator, ASIN or chapters: it may be a different reading of the same book.

## Two copies of one book

When two inbox entries identify as the same book, one is imported: the copy with known chapters first, then the one whose length matches an edition, then the higher bit rate. The other is reported as a skip, and stays in the inbox.

## What is written

| | MP3 | M4B / M4A | FLAC / Ogg / Opus |
|---|---|---|---|
| Title / author | `TALB` / `TPE1` + `TPE2` | `©alb` / `©ART` + `aART` | `album` / `artist` + `albumartist` |
| Narrator | `TCOM` | `©wrt` | `composer` |
| Genre | `Audiobook` | `Audiobook`, media kind audiobook | `Audiobook` |
| Description, ASIN | `COMM`, `TXXX:ASIN` | `desc` / `ldes`, `ASIN` | `description`, `asin` |
| Chapters | `CHAP` / `CTOC` frames | kept when already in the file | `CHAPTERxxx` / `CHAPTERxxxNAME` |
| Cover | `APIC` + `cover.jpg` | `covr` + `cover.jpg` | `cover.jpg` |

These follow the conventions Audiobookshelf reads. A one-file book is named after its title (`Thinking, Fast and Slow.mp3`); the parts of a multi-file book are `NN - <part>.mp3`, without the rip's own numbering. mutagen cannot write new chapters into an m4b, so catalog chapters for one are reported and left out.

The cover is the catalog's full-size art, else an image in the book's folder (`cover`, `folder` and `front` first), else one embedded in the audio, resized to `--cover-max-edge`.

## All flags

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | off | Identify and plan every book, write nothing. The table shows what would happen. |
| `--enrich` / `--no-enrich` | on when Audible is reachable | Look books up on Audible, Audnexus and iTunes. |
| `--overwrite` | off | Replace a book already in the library. Without it, such a book is skipped. |
| `--remove-source` | off | Delete each book from the inbox once it is imported. Skipped and failed books stay. |
| `--cover-max-edge` | 1000 | Longest cover edge, in pixels. |

The command exits non-zero when a book fails; skips are not failures.
